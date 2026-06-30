// Code mode unit tests — dynamic runner, validation, sandbox, wave engine.
// Run: node --test test/server.codemode.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  validateCodeInput,
  runCodeScriptDynamic,
  formatCodeResult,
  buildCodeToolDescription,
  CodeValidationError,
} from "../src/code-mode.mjs";
import {
  toolInputShape,
  abandonToolRound,
  persistResumeIndex,
  createSession,
  startCodeRun,
  dispatchCodeWave,
  maybeDispatchQueuedWave,
  resolveCodeModeToolResults,
  projectEvent,
  initMessageProjection,
  clearAllCodeState,
  clearCodeRun,
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
  buildParkingMcpServer,
  hasActiveToolRound,
  normalizeModel,
  modelObject,
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

function fakeCodeSession(overrides = {}) {
  return {
    key: "k-test",
    bucket: "b-test",
    codeMode: true,
    clientTools: CLIENT_TOOLS,
    codeRun: null,
    syntheticToCode: new Map(),
    codeDriving: false,
    suppressEndTurn: false,
    pendingTools: new Map(),
    resolvedResults: new Map(),
    orphanResolvers: [],
    streamedToolUses: [],
    toolUseAccum: new Map(),
    inputParsers: new Map(),
    originalNames: new Set(["code"]),
    res: null,
    nonStream: null,
    currentTurn: null,
    codeCalls: 0,
    codeSubCalls: 0,
    codeErrors: 0,
    codeWaves: 0,
    turnMetrics: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// validateCodeInput (script-only)
// ---------------------------------------------------------------------------

test("validateCodeInput accepts a valid script string", () => {
  const { script } = validateCodeInput({ script: "return 1;" });
  assert.equal(script, "return 1;");
});

test("validateCodeInput rejects missing/empty/non-string script", () => {
  assert.throws(() => validateCodeInput({}), CodeValidationError);
  assert.throws(() => validateCodeInput({ script: "" }), CodeValidationError);
  assert.throws(() => validateCodeInput({ script: 123 }), CodeValidationError);
  // Extra fields (like legacy calls[]) are ignored, not rejected.
  const { script } = validateCodeInput({ calls: [], script: "x" });
  assert.equal(script, "x");
  assert.throws(() => validateCodeInput(null), CodeValidationError);
});

// ---------------------------------------------------------------------------
// formatCodeResult
// ---------------------------------------------------------------------------

test("formatCodeResult pretty-prints objects", () => {
  const r = formatCodeResult({ a: 1 }, ["log line"]);
  assert.match(r.content[0].text, /"a": 1/);
  assert.match(r.content[0].text, /\[console\]/);
});

test("formatCodeResult rejects oversized script output", () => {
  const r = formatCodeResult("abcdef", [], { maxBytes: 3 });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /exceeded 3 bytes/);
});

// ---------------------------------------------------------------------------
// buildCodeToolDescription (TS signature rendering — unchanged from v0.1.6)
// ---------------------------------------------------------------------------

test("buildCodeToolDescription lists client tools", () => {
  const d = buildCodeToolDescription(CLIENT_TOOLS);
  assert.match(d, /Grep/);
  assert.match(d, /Glob/);
});

test("buildCodeToolDescription emits typed signatures with required/optional and enums", () => {
  const d = buildCodeToolDescription(CLIENT_TOOLS);
  assert.match(d, /pattern: string/);
  assert.match(d, /path: string/);
  assert.match(d, /output_mode\?: "content" \| "files_with_matches" \| "count"/);
  assert.match(d, /case_sensitive\?: boolean/);
  assert.doesNotMatch(d, /pattern\?:/);
  assert.doesNotMatch(d, /folder\?:/);
  assert.match(d, /### Grep/);
  assert.match(d, /Grep\(args: \{/);
  assert.match(d, /Return only the conclusion/);
});

test("buildCodeToolDescription renders the exact arg type that previously misfired (string, not object)", () => {
  const tools = new Map([
    ["AskUser", {
      description: "Ask the user a question",
      input_schema: {
        type: "object",
        properties: { questionnaire: { type: "string", description: "the question text" } },
        required: ["questionnaire"],
      },
    }],
  ]);
  const d = buildCodeToolDescription(tools);
  assert.match(d, /### AskUser/);
  assert.match(d, /Ask the user a question/);
  assert.match(d, /\/\/ the question text/);
  assert.match(d, /questionnaire: string;/);
  assert.doesNotMatch(d, /questionnaire\?:/);
});

test("buildCodeToolDescription does not hardcode client-specific DSLs", () => {
  const tools = new Map([
    ["AskUser", {
      description: "Ask the user a question",
      input_schema: {
        type: "object",
        properties: { questionnaire: { type: "string" } },
        required: ["questionnaire"],
      },
    }],
  ]);
  const d = buildCodeToolDescription(tools);
  assert.match(d, /questionnaire: string/);
  assert.doesNotMatch(d, /\[question\]/);
});

test("buildCodeToolDescription propagates generic schema metadata", () => {
  const tools = new Map([
    ["Constrained", {
      description: "Uses constraints from the client schema.",
      input_schema: {
        type: "object",
        properties: {
          mode: { type: "string", enum: ["fast", "safe"], default: "safe", description: "Execution mode", examples: ["safe"] },
          name: { type: "string", pattern: "^[a-z]+$", minLength: 2 },
        },
        required: ["name"],
      },
    }],
  ]);
  const d = buildCodeToolDescription(tools);
  assert.match(d, /\/\/ Execution mode/);
  assert.match(d, /\/\/ Default: "safe"/);
  assert.match(d, /\/\/ Examples: "safe"/);
  assert.match(d, /\/\/ Pattern: \^\[a-z\]\+\$/);
  assert.match(d, /\/\/ Minimum length: 2/);
  assert.match(d, /mode\?: "fast" \| "safe"/);
  assert.match(d, /name: string/);
});

test("buildCodeToolDescription describes nested object and array arg types", () => {
  const tools = new Map([
    ["Batch", {
      description: "batch",
      input_schema: {
        type: "object",
        properties: {
          items: { type: "array", items: { type: "string" } },
          opts: { type: "object", properties: { a: { type: "number" } } },
        },
      },
    }],
  ]);
  const d = buildCodeToolDescription(tools);
  assert.match(d, /items\?: Array<string>/);
  assert.match(d, /opts\?: \{ a\?: number; \}/);
});

test("buildCodeToolDescription script-first guidance mentions tools.X and Promise.all", () => {
  const d = buildCodeToolDescription(new Map());
  assert.match(d, /await tools\.<Name>\(args\)/);
  assert.match(d, /Promise\.all/);
  assert.match(d, /Bake branching/);
  assert.match(d, /order-dependent/);
});

// ---------------------------------------------------------------------------
// runCodeScriptDynamic (Worker-contained runner)
// ---------------------------------------------------------------------------

test("runCodeScriptDynamic: pure script, no tool calls", async () => {
  const r = await runCodeScriptDynamic("return 1 + 2;", {
    toolNames: [],
    dispatchWave: async () => [],
    timeoutMs: 5000,
  });
  assert.equal(r.value, 3);
  assert.equal(r.waves, 0);
  assert.equal(r.calls, 0);
});

test("runCodeScriptDynamic: one tool call (one wave)", async () => {
  const r = await runCodeScriptDynamic(
    "const r = await tools.Grep({ pattern: 'x', path: '/r' }); return r.text.toUpperCase();",
    {
      toolNames: ["Grep"],
      dispatchWave: async (w, calls) => calls.map(c => ({ text: `out:${c.args.pattern}`, raw: null, isError: false })),
      timeoutMs: 5000,
    },
  );
  assert.equal(r.value, "OUT:X");
  assert.equal(r.waves, 1);
  assert.equal(r.calls, 1);
});

test("runCodeScriptDynamic: two sequential awaits (two waves)", async () => {
  const r = await runCodeScriptDynamic(
    "const a = await tools.A({}); const b = await tools.B({}); return a.text + b.text;",
    {
      toolNames: ["A", "B"],
      dispatchWave: async (w, calls) => calls.map(c => ({ text: c.name, raw: null, isError: false })),
      timeoutMs: 5000,
    },
  );
  assert.equal(r.value, "AB");
  assert.equal(r.waves, 2);
  assert.equal(r.calls, 2);
});

test("runCodeScriptDynamic: Promise.all batches into one wave", async () => {
  const r = await runCodeScriptDynamic(
    "const [a, b] = await Promise.all([tools.A({}), tools.B({})]); return a.text + b.text;",
    {
      toolNames: ["A", "B"],
      dispatchWave: async (w, calls) => calls.map(c => ({ text: c.name, raw: null, isError: false })),
      timeoutMs: 5000,
    },
  );
  assert.equal(r.value, "AB");
  assert.equal(r.waves, 1);
  assert.equal(r.calls, 2);
});

test("runCodeScriptDynamic: branching dependent on a result", async () => {
  const r = await runCodeScriptDynamic(
    "const a = await tools.Check({ n: 5 }); if (a.text === 'big') { const b = await tools.Big({}); return b.text; } return 'small';",
    {
      toolNames: ["Check", "Big"],
      dispatchWave: async (w, calls) => calls.map(c => ({ text: c.args.n >= 5 ? 'big' : 'small', raw: null, isError: false })),
      timeoutMs: 5000,
    },
  );
  assert.equal(r.value, "small");
  assert.equal(r.waves, 2);
});

test("runCodeScriptDynamic: tool error surfaced as isError (resolves, not rejects)", async () => {
  const r = await runCodeScriptDynamic(
    "const r = await tools.X({}); return r.isError;",
    {
      toolNames: ["X"],
      dispatchWave: async (w, calls) => calls.map(c => ({ text: "boom", raw: null, isError: true })),
      timeoutMs: 5000,
    },
  );
  assert.equal(r.value, true);
});

test("runCodeScriptDynamic: timeout terminates the worker", async () => {
  const r = await runCodeScriptDynamic("await new Promise(()=>{});", {
    toolNames: [],
    dispatchWave: async () => [],
    timeoutMs: 300,
  });
  assert.equal(r.timedOut, true);
  assert.ok(r.error.match(/did not complete|timed out/));
});

test("runCodeScriptDynamic: maxWaves limit returns isError per call", async () => {
  const r = await runCodeScriptDynamic(
    "const rs = []; for (let i = 0; i < 10; i++) rs.push(await tools.A({})); return rs.map(r => r.isError).filter(Boolean).length;",
    {
      toolNames: ["A"],
      dispatchWave: async (w, calls) => calls.map(c => ({ text: "ok", raw: null, isError: false })),
      timeoutMs: 5000,
      maxWaves: 3,
    },
  );
  // Waves 4-10 return isError, so 7 errors out of 10 calls.
  assert.equal(r.value, 7);
});

test("runCodeScriptDynamic: callTool generic form works", async () => {
  const r = await runCodeScriptDynamic(
    "const r = await callTool('Grep', { pattern: 'x', path: '/r' }); return r.text;",
    {
      toolNames: ["Grep"],
      dispatchWave: async (w, calls) => calls.map(c => ({ text: `out:${c.args.pattern}`, raw: null, isError: false })),
      timeoutMs: 5000,
    },
  );
  assert.equal(r.value, "out:x");
});

test("runCodeScriptDynamic: console.log captured", async () => {
  const r = await runCodeScriptDynamic("console.log('hello', 'world'); return 42;", {
    toolNames: [],
    dispatchWave: async () => [],
    timeoutMs: 5000,
  });
  assert.equal(r.value, 42);
  assert.deepEqual(r.logs, ["hello world"]);
});

test("runCodeScriptDynamic: denies require/process/setTimeout", async () => {
  for (const script of ["require('fs')", "process.exit(1)", "setTimeout(()=>{},0)"]) {
    const r = await runCodeScriptDynamic(script, { toolNames: [], dispatchWave: async () => [], timeoutMs: 2000 });
    assert.ok(r.error, `${script} should have errored`);
  }
});

test("runCodeScriptDynamic: denies dynamic import() with a clean error (no crash)", async () => {
  const r = await runCodeScriptDynamic("const fs = await import('node:fs'); return 'reached';", {
    toolNames: [], dispatchWave: async () => [], timeoutMs: 2000,
  });
  assert.match(r.error, /dynamic import\(\) is denied/);
  assert.equal(r.value, null);
});

test("runCodeScriptDynamic: script can catch a denied import and recover", async () => {
  const r = await runCodeScriptDynamic("try { await import('node:fs'); return 'imported'; } catch { return 'recovered'; }", {
    toolNames: [], dispatchWave: async () => [], timeoutMs: 2000,
  });
  assert.equal(r.value, "recovered");
});

// ---------------------------------------------------------------------------
// syntheticIdFor (wave-component aware)
// ---------------------------------------------------------------------------

test("syntheticIdFor includes wave sequence", () => {
  const id = syntheticIdFor("toolu_abc12345", 1, 0);
  assert.match(id, /toolu_code_abc12345_w1_0/);
});

// ---------------------------------------------------------------------------
// normalizeModel / modelObject (Claude Code [1m] suffix + /v1/models catalog)
// ---------------------------------------------------------------------------

test("normalizeModel strips Claude Code context-window suffix", () => {
  assert.equal(normalizeModel("claude-opus-4-8[1m]"), "claude-opus-4-8");
  assert.equal(normalizeModel("claude-opus-4-8"), "claude-opus-4-8");
  assert.equal(normalizeModel("claude-sonnet-4-6 [1m]"), "claude-sonnet-4-6");
  assert.equal(normalizeModel(undefined), undefined);
});

test("modelObject preserves the requested id and reports a clean display name", () => {
  const o = modelObject("claude-opus-4-8[1m]");
  assert.equal(o.type, "model");
  assert.equal(o.id, "claude-opus-4-8[1m]");
  assert.equal(o.display_name, "claude-opus-4-8");
});

// ---------------------------------------------------------------------------
// buildParkingMcpServer
// ---------------------------------------------------------------------------

test("buildParkingMcpServer exposes code plus original tools in code mode", () => {
  const session = fakeCodeSession({ inputParsers: new Map() });
  let captured = null;
  buildParkingMcpServer(
    [
      { name: "Grep", description: "grep", input_schema: GREP_SCHEMA },
      { name: "AskUser", description: "ask", input_schema: { type: "object", properties: { questionnaire: { type: "string" } }, required: ["questionnaire"] } },
    ],
    session,
    (config) => { captured = config; return { ok: true }; },
  );
  const names = captured.tools.map((t) => t.name);
  assert.deepEqual(names, ["code", "Grep", "AskUser"]);
  assert.equal(session.clientTools.has("Grep"), true);
  assert.equal(session.clientTools.has("AskUser"), true);
  assert.equal(session.inputParsers.has("Grep"), true);
});

// ---------------------------------------------------------------------------
// projectEvent (buffered projection while codeDriving)
// ---------------------------------------------------------------------------

test("projectEvent suppresses SDK events while codeDriving", () => {
  const events = [];
  const session = fakeCodeSession({
    codeDriving: true,
    codeRun: { codeId: "c1", preamble: [] },
    res: { writableEnded: false, write: (s) => { const m = s.match(/^data: (.+)\n\n$/m); if (m) events.push(JSON.parse(m[1])); } },
  });
  initMessageProjection(session);
  projectEvent(session, { type: "message_start", message: { role: "assistant" } });
  projectEvent(session, { type: "content_block_start", index: 0, content_block: { type: "text", text: "hi" } });
  projectEvent(session, { type: "content_block_stop", index: 0 });
  projectEvent(session, { type: "message_stop", message: { stop_reason: "end_turn" } });
  // Nothing should reach the client while codeDriving.
  assert.equal(events.length, 0);
  // Preamble should have captured the text block.
  assert.equal(session.codeRun.preamble.length, 1);
  assert.equal(session.codeRun.preamble[0].text, "hi");
});

test("projectEvent projects normally when not codeDriving (no code block)", () => {
  const events = [];
  const session = fakeCodeSession({
    res: { writableEnded: false, write: (s) => { const m = s.match(/^data: (.+)\n\n$/m); if (m) events.push(JSON.parse(m[1])); } },
  });
  initMessageProjection(session);
  projectEvent(session, { type: "message_start", message: { role: "assistant" } });
  projectEvent(session, { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
  projectEvent(session, { type: "content_block_stop", index: 0 });
  const starts = events.filter((e) => e.type === "content_block_start");
  assert.equal(starts.length, 1);
  assert.equal(starts[0].content_block.type, "text");
});

// ---------------------------------------------------------------------------
// abandonToolRound / clearAllCodeState
// ---------------------------------------------------------------------------

test("abandonToolRound clears code run and maps", () => {
  const session = fakeCodeSession({ suppressEndTurn: true, codeDriving: true });
  session.codeRun = { codeId: "x", aborted: false, reject: () => {} };
  session.syntheticToCode.set("y", "x");
  abandonToolRound(session);
  assert.equal(session.codeRun, null);
  assert.equal(session.syntheticToCode.size, 0);
  assert.equal(session.codeDriving, false);
  assert.equal(session.suppressEndTurn, false);
});

test("hasActiveToolRound includes code run and codeDriving", () => {
  const session = fakeCodeSession({ currentTurn: null });
  assert.equal(hasActiveToolRound(session), false);
  session.codeRun = { codeId: "c1" };
  assert.equal(hasActiveToolRound(session), true);
  session.codeRun = null;
  session.codeDriving = true;
  assert.equal(hasActiveToolRound(session), true);
  clearAllCodeState(session);
  assert.equal(hasActiveToolRound(session), false);
});

// ---------------------------------------------------------------------------
// persistResumeIndex (no-op for code mode)
// ---------------------------------------------------------------------------

test("persistResumeIndex is no-op for code-mode sessions", () => {
  const session = { codeMode: true, sdkSessionId: "sdk-1", seenCount: 2, seenHash: "abc" };
  persistResumeIndex(session, "model", "sys", []);
});

// ---------------------------------------------------------------------------
// findSession with synthetic tool blocks (multi-wave)
// ---------------------------------------------------------------------------

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
      content: [{ type: "tool_use", id: "toolu_code_ab_w1_0", name: "Grep", input: { pattern: "x", path: "/r" } }],
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "toolu_code_ab_w1_0", content: [{ type: "text", text: "ok" }] }],
    },
  ];
  const found = findSession(extended, sys);
  assert.ok(found);
  sessions.clear();
});
