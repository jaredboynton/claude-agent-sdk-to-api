// Code mode unit tests — dynamic runner, validation, sandbox, wave engine.
// Run: node --test test/server.codemode.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  validateCodeInput,
  runCodeScriptDynamic,
  formatCodeResult,
  buildCodeToolDescription,
  CodeValidationError,
  CODE_MODE_APPEND,
} from "../src/code-mode.mjs";
import {
  abandonToolRound,
  persistResumeIndex,
  projectEvent,
  initMessageProjection,
  clearAllCodeState,
  syntheticIdFor,
  findSession,
  markSeen,
  sessions,
  bucketKey,
  hashMessages,
  buildParkingMcpServer,
  hasActiveToolRound,
  normalizeModel,
  modelObject,
  dispatchCodeWave,
  resolveCodeModeToolResults,
  notifyTurnAttached,
  startServer,
} from "../src/server.mjs";

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

test("formatCodeResult does not cap output by default (no truncation)", () => {
  const big = "x".repeat(200000); // ~200KB, far over the old 32KB cap
  const r = formatCodeResult(big);
  assert.equal(r.isError, undefined);
  assert.equal(r.content[0].text.length, 200000);
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
  assert.match(d, /DECISION RULE/);
});

test("buildCodeToolDescription includes intelligent-logic and anchored-edit guidance", () => {
  const d = buildCodeToolDescription(new Map());
  // core principle: always favor logic + batching/parallelism, no caps
  assert.match(d, /ALWAYS favor intelligent logic/);
  assert.match(d, /maximum batching and parallelism/);
  assert.match(d, /no time, wave, or call limit/);
  // logic: real control flow, not one await per script
  assert.match(d, /Write real logic/);
  assert.match(d, /retry/i);
  assert.match(d, /fan-out\+reduce/);
  assert.match(d, /not one await per script/);
  // dependent steps: script them rather than splitting into more code calls
  assert.match(d, /DEPENDS on a tool's result/);
  assert.match(d, /feed one call's output into the next/);
  // editing: anchored search/replace, verbatim old_string, smallest unique snippet
  assert.match(d, /anchored search\/replace/);
  assert.match(d, /copy old_string VERBATIM/);
  assert.match(d, /smallest unique snippet/);
  assert.match(d, /avoid full-file or whole-line rewrites/);
});

test("buildCodeToolDescription includes decision rule, read-only carve-out, dependency guard, JS guard, compact returns", () => {
  const d = buildCodeToolDescription(new Map());
  // pre-wave decision rule: write B's args before A returns
  assert.match(d, /DECISION RULE/);
  assert.match(d, /before each wave, list all calls needed/i);
  assert.match(d, /write B's args before A returns/);
  // read-only fan-out carve-out
  assert.match(d, /Read-only commands and tools/);
  assert.match(d, /gh release view/);
  assert.match(d, /always one wave/);
  // dependency guard
  assert.match(d, /Only batch calls that are independent/);
  assert.match(d, /git add` → `git commit`/);
  // JavaScript-not-TypeScript guard
  assert.match(d, /write executable JavaScript, not TypeScript syntax/);
  // compact returns
  assert.match(d, /verdict\/summary\/fields/);
});

test("CODE_MODE_APPEND has decision rule, read-only carve-out, dependency guard, JS guard, expanded example", () => {
  const a = CODE_MODE_APPEND;
  // stronger parallel phrasing
  assert.match(a, /Maximize parallelism/);
  assert.match(a, /Err on the side of maximizing parallel calls/);
  // pre-wave decision rule
  assert.match(a, /<decision_rule>/);
  assert.match(a, /Can I write call B's arguments before call A returns\?/);
  // read-only carve-out
  assert.match(a, /Read-only operations/);
  assert.match(a, /Batch all reads for a phase in one wave/);
  // dependency guard
  assert.match(a, /Only batch calls that are independent/);
  assert.match(a, /git add` → `git commit`/);
  // JavaScript guard
  assert.match(a, /<language>/);
  assert.match(a, /do not use type annotations, interfaces, or generics/);
  // expanded example: git fetch phase boundary + gh release view + node --test
  assert.match(a, /git fetch --all --tags --prune/);
  assert.match(a, /gh release view/);
  assert.match(a, /node --test/);
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

test("buildParkingMcpServer exposes only code while preserving script tool catalog", () => {
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
  assert.deepEqual(names, ["code"]);
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

test("dispatchCodeWave emits immediately on the attached HTTP turn", async () => {
  const events = [];
  let resolvedTurn = false;
  const session = fakeCodeSession({
    model: "claude-opus-4-8",
    currentTurn: { resolve: () => { resolvedTurn = true; } },
    res: { writableEnded: false, write: (s) => { const m = s.match(/^data: (.+)\n\n$/m); if (m) events.push(JSON.parse(m[1])); } },
  });
  initMessageProjection(session);
  const codeId = "toolu_code_main";
  const syn0 = syntheticIdFor(codeId, 1, 0);
  session.codeRun = {
    codeId,
    aborted: false,
    currentWave: null,
    preamble: null,
    waveSeq: 0,
    waveCount: 0,
    callCount: 0,
  };

  const resultPromise = dispatchCodeWave(session, codeId, 1, [
    { name: "Grep", args: { pattern: "x", path: "/r" } },
  ]);

  assert.equal(resolvedTurn, true, "HTTP turn closed so the client can execute the tool");
  assert.equal(session.codeRun.currentWave?.waveNum, 1);
  assert.equal(session.codeRun.currentWave?.dispatched, true);
  assert.equal(session.codeRun.currentWave?.pending.has(syn0), true);
  const tu = events.find((e) => e.type === "content_block_start" && e.content_block?.type === "tool_use");
  assert.equal(tu?.content_block?.id, syn0);
  assert.equal(tu?.content_block?.name, "Grep");

  await resolveCodeModeToolResults(session, [
    { tool_use_id: syn0, content: [{ type: "text", text: "ok" }] },
  ]);
  const results = await resultPromise;
  assert.equal(results[0].text, "ok");
});

test("dispatchCodeWave waits for HTTP turn attachment then fabricates", async () => {
  const events = [];
  let resolvedTurn = false;
  const session = fakeCodeSession({
    model: "claude-opus-4-8",
    currentTurn: null,
    res: { writableEnded: false, write: (s) => { const m = s.match(/^data: (.+)\n\n$/m); if (m) events.push(JSON.parse(m[1])); } },
  });
  initMessageProjection(session);
  const codeId = "toolu_code_main";
  const syn0 = syntheticIdFor(codeId, 1, 0);
  session.codeRun = {
    codeId,
    aborted: false,
    currentWave: null,
    preamble: null,
    waveSeq: 0,
    waveCount: 0,
    callCount: 0,
  };

  const p = dispatchCodeWave(session, codeId, 1, [
    { name: "Grep", args: { pattern: "x", path: "/r" } },
  ]);
  assert.equal(events.length, 0, "blocks until an HTTP turn attaches");
  assert.ok(session.turnWaiters?.length, "registers a turn waiter");
  assert.equal(session.codeRun.currentWave?.waveNum, 1);

  session.currentTurn = { resolve: () => { resolvedTurn = true; } };
  notifyTurnAttached(session);

  assert.equal(resolvedTurn, true, "HTTP turn closed so the client can execute the tool");
  const tu = events.find((e) => e.type === "content_block_start" && e.content_block?.type === "tool_use");
  assert.equal(tu?.content_block?.id, syn0);

  await resolveCodeModeToolResults(session, [
    { tool_use_id: syn0, content: [{ type: "text", text: "done" }] },
  ]);
  const results = await p;
  assert.equal(results[0].text, "done");
});

test("notifyTurnAttached waits for a response sink before fabricating", async () => {
  const events = [];
  let resolvedTurn = false;
  const session = fakeCodeSession({
    model: "claude-opus-4-8",
    currentTurn: null,
    res: null,
    nonStream: null,
  });
  initMessageProjection(session);
  const codeId = "toolu_code_main";
  const syn0 = syntheticIdFor(codeId, 1, 0);
  session.codeRun = {
    codeId,
    aborted: false,
    currentWave: null,
    preamble: null,
    waveSeq: 0,
    waveCount: 0,
    callCount: 0,
  };

  const p = dispatchCodeWave(session, codeId, 1, [
    { name: "Grep", args: { pattern: "x", path: "/r" } },
  ]);
  session.currentTurn = { resolve: () => { resolvedTurn = true; } };
  notifyTurnAttached(session);

  assert.equal(session.codeRun.currentWave?.dispatched, false);
  assert.equal(resolvedTurn, false);

  session.res = { writableEnded: false, write: (s) => { const m = s.match(/^data: (.+)\n\n$/m); if (m) events.push(JSON.parse(m[1])); } };
  notifyTurnAttached(session);

  assert.equal(resolvedTurn, true);
  const tu = events.find((e) => e.type === "content_block_start" && e.content_block?.type === "tool_use");
  assert.equal(tu?.content_block?.id, syn0);

  await resolveCodeModeToolResults(session, [
    { tool_use_id: syn0, content: [{ type: "text", text: "done" }] },
  ]);
  const results = await p;
  assert.equal(results[0].text, "done");
});

test("fabricated wave message_start carries a usage object (no undefined input_tokens)", () => {
  const events = [];
  const session = fakeCodeSession({
    model: "claude-opus-4-8",
    currentTurn: { resolve: () => {} },
    res: { writableEnded: false, write: (s) => { const m = s.match(/^data: (.+)\n\n$/m); if (m) events.push(JSON.parse(m[1])); } },
  });
  initMessageProjection(session);
  const codeId = "toolu_code_main";
  const syn0 = syntheticIdFor(codeId, 1, 0);
  session.codeRun = {
    codeId,
    aborted: false,
    currentWave: null,
    preamble: null,
    waveSeq: 0,
    waveCount: 0,
    callCount: 0,
  };
  dispatchCodeWave(session, codeId, 1, [
    { name: "Grep", args: { pattern: "x", path: "/r" } },
  ]);
  const start = events.find((e) => e.type === "message_start");
  assert.ok(start, "should emit a fabricated message_start");
  assert.ok(start.message, "message_start has a message object");
  assert.ok(start.message.usage, "message has usage");
  assert.equal(typeof start.message.usage.input_tokens, "number");
  assert.equal(start.message.role, "assistant");
  assert.equal(start.message.model, "claude-opus-4-8");
  // message_delta also carries usage.output_tokens
  const delta = events.find((e) => e.type === "message_delta");
  assert.ok(delta?.usage, "message_delta has usage");
  assert.equal(typeof delta.usage.output_tokens, "number");
  // and the synthetic Grep tool_use was emitted
  const tu = events.find((e) => e.type === "content_block_start" && e.content_block?.type === "tool_use");
  assert.equal(tu.content_block.name, "Grep");
});

test("fabricated wave reuses last real upstream usage instead of zeros (no statusbar bounce)", () => {
  const events = [];
  const session = fakeCodeSession({
    model: "claude-opus-4-8",
    currentTurn: { resolve: () => {} },
    res: { writableEnded: false, write: (s) => { const m = s.match(/^data: (.+)\n\n$/m); if (m) events.push(JSON.parse(m[1])); } },
    lastRawUsage: {
      input_tokens: 1234,
      output_tokens: 56,
      cache_creation_input_tokens: 100000,
      cache_read_input_tokens: 90000,
      service_tier: "standard",
      cache_creation: { ephemeral_1h_input_tokens: 100000, ephemeral_5m_input_tokens: 0 },
    },
  });
  initMessageProjection(session);
  const codeId = "toolu_code_main";
  const syn0 = syntheticIdFor(codeId, 1, 0);
  session.codeRun = {
    codeId,
    aborted: false,
    currentWave: null,
    preamble: null,
    waveSeq: 0,
    waveCount: 0,
    callCount: 0,
  };
  dispatchCodeWave(session, codeId, 1, [
    { name: "Grep", args: { pattern: "x", path: "/r" } },
  ]);
  const start = events.find((e) => e.type === "message_start");
  assert.ok(start?.message?.usage, "fabricated message_start has usage");
  // Reuses the real upstream input tokens — does NOT reset to 0.
  assert.equal(start.message.usage.input_tokens, 1234);
  assert.equal(start.message.usage.cache_read_input_tokens, 90000);
  // Preserves extra fields Claude Code's statusbar may read.
  assert.equal(start.message.usage.service_tier, "standard");
  const delta = events.find((e) => e.type === "message_delta");
  assert.equal(delta?.usage?.output_tokens, 56, "delta reuses last known output tokens");
});

test("fabricated wave falls back to a complete zeroed usage when no upstream usage has arrived yet", () => {
  const events = [];
  const session = fakeCodeSession({
    model: "claude-opus-4-8",
    currentTurn: { resolve: () => {} },
    res: { writableEnded: false, write: (s) => { const m = s.match(/^data: (.+)\n\n$/m); if (m) events.push(JSON.parse(m[1])); } },
    lastRawUsage: null,
  });
  initMessageProjection(session);
  const codeId = "toolu_code_main";
  const syn0 = syntheticIdFor(codeId, 1, 0);
  session.codeRun = {
    codeId,
    aborted: false,
    currentWave: null,
    preamble: null,
    waveSeq: 0,
    waveCount: 0,
    callCount: 0,
  };
  dispatchCodeWave(session, codeId, 1, [
    { name: "Grep", args: { pattern: "x", path: "/r" } },
  ]);
  const start = events.find((e) => e.type === "message_start");
  assert.ok(start?.message?.usage, "fabricated message_start has usage");
  // Crash protection: the four canonical fields exist and are numbers.
  assert.equal(typeof start.message.usage.input_tokens, "number");
  assert.equal(start.message.usage.input_tokens, 0);
  assert.equal(typeof start.message.usage.cache_read_input_tokens, "number");
  const delta = events.find((e) => e.type === "message_delta");
  assert.equal(typeof delta?.usage?.output_tokens, "number");
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
// persistResumeIndex
// ---------------------------------------------------------------------------

test("persistResumeIndex writes code-mode resume entries", () => {
  const dir = mkdtempSync(join(tmpdir(), "claude-agent-api-resume-"));
  const indexPath = join(dir, "resume-index.json");
  const server = startServer({ port: 0, profileDir: dir });
  try {
    const messages = [{ role: "user", content: [{ type: "text", text: "start" }] }];
    const session = {
      sdkSessionId: "sdk-1",
      bucket: bucketKey("sys", messages),
      seenCount: 1,
      seenHash: hashMessages(messages, 1),
    };
    persistResumeIndex(session, "model", "sys", messages, indexPath);
    const parsed = JSON.parse(readFileSync(indexPath, "utf8"));
    assert.equal(parsed.entries.length, 1);
    assert.equal(parsed.entries[0].sdkSessionId, "sdk-1");
    assert.equal(parsed.entries[0].codeMode, true);
  } finally {
    server.close();
  }
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
