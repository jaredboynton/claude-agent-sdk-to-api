// Code mode unit tests — validation, sandbox, expand/collapse, lifecycle.
// Run: node --test test/server.codemode.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  validateCodeInput,
  runCodeScript,
  formatCodeResult,
  buildCodeToolDescription,
  CodeValidationError,
} from "../src/code-mode.mjs";
import {
  toolInputShape,
  abandonToolRound,
  persistResumeIndex,
  createSession,
  expandCodeToolUse,
  collapseAndResolveCode,
  resolveCodeModeToolResults,
  projectEvent,
  initMessageProjection,
  clearAllCodeState,
  syntheticIdFor,
  internalResolveCode,
  endTurn,
  resolveTool,
  writeEvent,
  accumulateStreamEvent,
  emitClientToolUse,
  findSession,
  markSeen,
  sessions,
  bucketKey,
  hashMessages,
  toCallToolResult,
} from "../src/server.mjs";
import { z } from "../src/sdk.mjs";

const GREP_SCHEMA = {
  type: "object",
  properties: {
    pattern: { type: "string" },
    path: { type: "string" },
    output_mode: { type: "string", enum: ["content", "files_with_matches", "count"], default: "content" },
  },
  required: ["pattern", "path"],
};

const GLOB_SCHEMA = {
  type: "object",
  properties: {
    pattern: { type: "string" },
    folder: { type: "string" },
    case_sensitive: { type: "boolean", default: true },
  },
  required: ["pattern", "folder"],
};

const CLIENT_TOOLS = new Map([
  ["Grep", { description: "grep", input_schema: GREP_SCHEMA }],
  ["Glob", { description: "glob", input_schema: GLOB_SCHEMA }],
]);

const deps = { toolInputShape, z };

function fakeCodeSession(overrides = {}) {
  return {
    codeMode: true,
    clientTools: CLIENT_TOOLS,
    codeExpansions: new Map(),
    syntheticToCode: new Map(),
    codePendingResults: new Map(),
    suppressEndTurn: false,
    pendingTools: new Map(),
    resolvedResults: new Map(),
    orphanResolvers: [],
    streamedToolUses: [],
    toolUseAccum: new Map(),
    originalNames: new Set(["code"]),
    res: null,
    nonStream: null,
    codeCalls: 0,
    codeSubCalls: 0,
    codeErrors: 0,
    currentTurn: { resolve: () => {} },
    ...overrides,
  };
}

test("validateCodeInput accepts valid calls and injects defaults", () => {
  const { calls, script } = validateCodeInput({
    calls: [
      { id: "grep", tool: "Grep", args: { pattern: "x", path: "/r" } },
      { id: "files", tool: "Glob", args: { pattern: "*.md", folder: "/r" } },
    ],
    script: "return results;",
  }, CLIENT_TOOLS, deps);

  assert.equal(script, "return results;");
  assert.equal(calls.length, 2);
  assert.equal(calls[0].args.output_mode, "content");
  assert.equal(calls[1].args.case_sensitive, true);
});

test("validateCodeInput rejects duplicate ids, unknown tools, bad ids, bad args", () => {
  assert.throws(
    () => validateCodeInput({ calls: [{ id: "a", tool: "Grep", args: { pattern: "x", path: "/r" } }, { id: "a", tool: "Glob", args: { pattern: "*", folder: "/r" } }], script: "x" }, CLIENT_TOOLS, deps),
    CodeValidationError,
  );
  assert.throws(
    () => validateCodeInput({ calls: [{ id: "x", tool: "Nope", args: {} }], script: "x" }, CLIENT_TOOLS, deps),
    CodeValidationError,
  );
  assert.throws(
    () => validateCodeInput({ calls: [{ id: "1bad", tool: "Grep", args: { pattern: "x", path: "/r" } }], script: "x" }, CLIENT_TOOLS, deps),
    CodeValidationError,
  );
  assert.throws(
    () => validateCodeInput({ calls: [{ id: "g", tool: "Grep", args: { pattern: "x" } }], script: "x" }, CLIENT_TOOLS, deps),
    CodeValidationError,
  );
});

test("runCodeScript binds results and calls", async () => {
  const { value } = await runCodeScript(
    "return { n: results.a.text.length, tool: calls[0].tool };",
    {
      calls: [{ id: "a", tool: "Grep", args: { pattern: "x" } }],
      results: { a: { content: [{ type: "text", text: "hello" }] } },
      timeoutMs: 2000,
    },
  );
  assert.equal(value.n, 5);
  assert.equal(value.tool, "Grep");
});

test("runCodeScript denies require/process/setTimeout", async () => {
  await assert.rejects(() => runCodeScript("require('fs');", { timeoutMs: 500 }), /denied/);
  await assert.rejects(() => runCodeScript("process.exit(1);", { timeoutMs: 500 }), /denied/);
  await assert.rejects(() => runCodeScript("setTimeout(()=>{},0);", { timeoutMs: 500 }), /denied/);
});

test("runCodeScript times out on infinite loop", async () => {
  await assert.rejects(
    () => runCodeScript("while(true){}", { timeoutMs: 100 }),
    /did not complete|timed out/,
  );
});

test("formatCodeResult pretty-prints objects", () => {
  const r = formatCodeResult({ a: 1 }, ["log line"]);
  assert.match(r.content[0].text, /"a": 1/);
  assert.match(r.content[0].text, /\[console\]/);
});

test("buildCodeToolDescription lists client tools", () => {
  const d = buildCodeToolDescription(CLIENT_TOOLS);
  assert.match(d, /Grep/);
  assert.match(d, /Glob/);
});

test("expandCodeToolUse synthesizes N client tool_use blocks with mapping", () => {
  const events = [];
  const session = fakeCodeSession({
    res: {
      writableEnded: false,
      write: (s) => {
        const m = s.match(/^data: (.+)\n\n$/m);
        if (m) events.push(JSON.parse(m[1]));
      },
    },
  });
  initMessageProjection(session);

  const codeId = "toolu_codeMain01";
  expandCodeToolUse(session, codeId, {
    calls: [
      { id: "grep", tool: "Grep", args: { pattern: "x", path: "/r" } },
      { id: "files", tool: "Glob", args: { pattern: "*.md", folder: "/r" } },
    ],
    script: "return { ok: true };",
  });

  assert.equal(session.codeExpansions.size, 1);
  assert.equal(session.syntheticToCode.size, 2);
  const starts = events.filter((e) => e.type === "content_block_start" && e.content_block?.type === "tool_use");
  assert.equal(starts.length, 2);
  assert.equal(starts[0].index, 0);
  assert.equal(starts[1].index, 1);
  assert.equal(starts.find((s) => s.content_block.name === "code"), undefined);
  assert.equal(starts[0].content_block.name, "Grep");
  assert.equal(starts[1].content_block.name, "Glob");
});

test("projectEvent remaps indexes around suppressed code block", () => {
  const events = [];
  const session = fakeCodeSession({
    res: {
      writableEnded: false,
      write: (s) => {
        const m = s.match(/^data: (.+)\n\n$/m);
        if (m) events.push(JSON.parse(m[1]));
      },
    },
  });
  initMessageProjection(session);

  projectEvent(session, { type: "message_start", message: { role: "assistant" } });
  projectEvent(session, {
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "" },
  });
  session.toolUseAccum.set(1, { id: "toolu_c1", name: "code", partial: "" });
  projectEvent(session, {
    type: "content_block_start",
    index: 1,
    content_block: { type: "tool_use", id: "toolu_c1", name: "code", input: {} },
  });
  expandCodeToolUse(session, "toolu_c1", {
    calls: [{ id: "g", tool: "Grep", args: { pattern: "a", path: "/b" } }],
    script: "return 1;",
  });
  projectEvent(session, { type: "content_block_stop", index: 1 });
  projectEvent(session, {
    type: "content_block_start",
    index: 2,
    content_block: { type: "text", text: "" },
  });

  const starts = events.filter((e) => e.type === "content_block_start");
  const textStarts = starts.filter((e) => e.content_block?.type === "text");
  assert.equal(textStarts[0].index, 0);
  assert.equal(textStarts[1].index, 2);
});

test("collapse round-trip resolves one code result", async () => {
  const session = fakeCodeSession();
  const codeId = "toolu_main";
  const syn0 = syntheticIdFor(codeId, 0);
  const syn1 = syntheticIdFor(codeId, 1);

  session.codeExpansions.set(codeId, {
    script: "return { g: results.grep.text, f: results.files.text };",
    calls: [
      { syntheticId: syn0, userId: "grep", tool: "Grep", args: {} },
      { syntheticId: syn1, userId: "files", tool: "Glob", args: {} },
    ],
  });
  session.syntheticToCode.set(syn0, codeId);
  session.syntheticToCode.set(syn1, codeId);
  session.codePendingResults.set(codeId, new Map([
    [syn0, toCallToolResult({ content: [{ type: "text", text: "grep-out" }] })],
    [syn1, toCallToolResult({ content: [{ type: "text", text: "glob-out" }] })],
  ]));

  let resolved = null;
  session.pendingTools.set(codeId, (r) => { resolved = r; });

  await collapseAndResolveCode(session, codeId);
  assert.ok(resolved);
  assert.match(resolved.content[0].text, /grep-out/);
  assert.match(resolved.content[0].text, /glob-out/);
  assert.equal(session.codeExpansions.size, 0);
});

test("resolveCodeModeToolResults accumulates until complete", async () => {
  const session = fakeCodeSession();
  const codeId = "toolu_acc";
  const syn0 = syntheticIdFor(codeId, 0);
  const syn1 = syntheticIdFor(codeId, 1);
  session.codeExpansions.set(codeId, {
    script: "return results.a.text + results.b.text;",
    calls: [
      { syntheticId: syn0, userId: "a", tool: "Grep", args: {} },
      { syntheticId: syn1, userId: "b", tool: "Glob", args: {} },
    ],
  });
  session.syntheticToCode.set(syn0, codeId);
  session.syntheticToCode.set(syn1, codeId);

  await resolveCodeModeToolResults(session, [
    { tool_use_id: syn0, content: [{ type: "text", text: "A" }] },
  ]);
  assert.equal(session.pendingTools.size, 0);
  assert.equal(session.codePendingResults.get(codeId)?.size, 1);

  await resolveCodeModeToolResults(session, [
    { tool_use_id: syn1, content: [{ type: "text", text: "B" }] },
  ]);
  assert.equal(session.codeExpansions.size, 0);
});

test("internal continuation: invalid code sets suppressEndTurn and stashes result", () => {
  const session = fakeCodeSession();
  initMessageProjection(session);
  internalResolveCode(session, "toolu_bad", { content: [{ type: "text", text: "err" }], isError: true });
  assert.equal(session.suppressEndTurn, true);
  assert.equal(session.resolvedResults.get("toolu_bad")?.isError, true);

  session.suppressEndTurn = true;
  let ended = false;
  session.currentTurn = { resolve: () => { ended = true; } };
  endTurn(session);
  assert.equal(session.suppressEndTurn, false);
  assert.equal(ended, false);
});

test("expandCodeToolUse validation error uses internal continuation", () => {
  const session = fakeCodeSession();
  initMessageProjection(session);
  expandCodeToolUse(session, "toolu_val", { calls: [{ id: "bad!", tool: "Grep", args: {} }], script: "return 1;" });
  assert.equal(session.suppressEndTurn, true);
  assert.equal(session.codeExpansions.size, 0);
  assert.equal(session._proj.syntheticCount, 0);
});

test("abandonToolRound clears code maps", () => {
  const session = fakeCodeSession({ suppressEndTurn: true });
  session.codeExpansions.set("x", { script: "", calls: [] });
  session.syntheticToCode.set("y", "x");
  session.codePendingResults.set("x", new Map());
  abandonToolRound(session);
  assert.equal(session.codeExpansions.size, 0);
  assert.equal(session.syntheticToCode.size, 0);
  assert.equal(session.suppressEndTurn, false);
});

test("persistResumeIndex is no-op for code-mode sessions", () => {
  const session = { codeMode: true, sdkSessionId: "sdk-1", seenCount: 2, seenHash: "abc" };
  persistResumeIndex(session, "model", "sys", []);
  // no throw; guarded by codeMode check (disk write would need serverProfileDir anyway)
});

test("findSession works with synthetic tool blocks in client history", () => {
  sessions.clear();
  const sys = "sys";
  const first = { role: "user", content: [{ type: "text", text: "task" }] };
  const bucket = bucketKey(sys, [first]);
  const s = {
    key: "k1",
    bucket,
    seenCount: 0,
    seenHash: hashMessages([], 0),
    closed: false,
    currentTurn: null,
  };
  sessions.set(s.key, s);
  markSeen(s, [first]);
  const extended = [
    first,
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "toolu_code_ab_0", name: "Grep", input: { pattern: "x", path: "/r" } }],
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "toolu_code_ab_0", content: [{ type: "text", text: "ok" }] }],
    },
  ];
  const found = findSession(extended, sys);
  assert.ok(found);
  sessions.clear();
});

test("non-stream projection via accumulateStreamEvent drops code and inserts synthetic", () => {
  const blocks = [];
  const session = fakeCodeSession({ nonStream: { blocks, stopReason: "end_turn" } });
  initMessageProjection(session);

  projectEvent(session, { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_c", name: "code", input: {} } });
  expandCodeToolUse(session, "toolu_c", {
    calls: [{ id: "g", tool: "Grep", args: { pattern: "p", path: "/x" } }],
    script: "return 1;",
  });
  projectEvent(session, { type: "content_block_stop", index: 0 });

  const toolBlocks = blocks.filter(Boolean).filter((b) => b.type === "tool_use");
  assert.equal(toolBlocks.length, 1);
  assert.equal(toolBlocks[0].name, "Grep");
  assert.equal(toolBlocks.some((b) => b.name === "code"), false);
});
