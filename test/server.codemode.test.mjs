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
  formatCodeError,
  ledgerEntry,
  buildCodeToolDescription,
  buildCodeToolCatalog,
  CodeValidationError,
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
  registerClientTool,
  mergeLateTool,
  appendPendingToolNotice,
  hasActiveToolRound,
  normalizeModel,
  modelObject,
  dispatchCodeWave,
  resolveCodeModeToolResults,
  notifyTurnAttached,
  startServer,
  startCodeRun,
  rememberRateLimitHeaders,
  writeEvent,
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
  ["Execute", { description: "execute", input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } }],
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

test("formatCodeResult truncates oversized output head+tail (never errors)", () => {
  const big = `START${"x".repeat(50000)}END`;
  const r = formatCodeResult(big, [], { maxBytes: 1024 });
  assert.equal(r.isError, undefined, "truncation preserves the run's work; no error");
  assert.ok(r.content[0].text.length < 50000);
  assert.match(r.content[0].text, /^START/);
  assert.match(r.content[0].text, /END/);
  assert.match(r.content[0].text, /middle omitted/);
  assert.match(r.content[0].text, /\[output truncated\]/);
});

test("formatCodeResult truncation notice points at the spilled artifact", () => {
  const big = "x".repeat(50000);
  let spilled = null;
  const r = formatCodeResult(big, [], { maxBytes: 1024, onSpill: (full) => { spilled = full; return "a1"; } });
  assert.equal(spilled, big, "onSpill receives the full untruncated text");
  assert.match(r.content[0].text, /codemode\.recall\("a1"\)/);
});

test("formatCodeResult caps output at 16KB by default", () => {
  const big = "x".repeat(200000);
  const r = formatCodeResult(big);
  assert.equal(r.isError, undefined);
  assert.ok(r.content[0].text.length < 20000);
  assert.match(r.content[0].text, /output truncated/);
});

test("formatCodeResult maxBytes 0 disables the cap", () => {
  const big = "x".repeat(200000);
  const r = formatCodeResult(big, [], { maxBytes: 0 });
  assert.equal(r.isError, undefined);
  assert.equal(r.content[0].text.length, 200000);
});

test("formatCodeResult caps oversized console lines", () => {
  const r = formatCodeResult("ok", [`L${"y".repeat(5000)}`], { maxBytes: 0 });
  assert.match(r.content[0].text, /line truncated/);
  assert.match(r.content[0].text, /output truncated/);
});

// ---------------------------------------------------------------------------
// buildCodeToolDescription (TS signature rendering — unchanged from v0.1.6)
// ---------------------------------------------------------------------------

test("buildCodeToolDescription lists client tools", () => {
  const d = buildCodeToolDescription(CLIENT_TOOLS);
  assert.match(d, /Grep/);
  assert.match(d, /Glob/);
});

test("buildCodeToolCatalog exposes focused tool docs", () => {
  const c = buildCodeToolCatalog(CLIENT_TOOLS);
  // Byte-stable ordering: entries are sorted by name regardless of client order.
  assert.deepEqual(c.map((t) => t.path), ["tools.Execute", "tools.Glob", "tools.Grep"]);
  const grep = c.find((t) => t.name === "Grep");
  assert.match(grep.summary, /grep/);
  assert.match(grep.docs, /Grep\(args: \{/);
  assert.match(grep.docs, /pattern: string/);
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
  assert.match(d, /Return a compact decision-ready object/);
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
  assert.match(d, /ToolResult/);
  assert.match(d, /codemode\.batch/);
  assert.match(d, /codemode\.search/);
  assert.match(d, /codemode\.describe/);
  assert.match(d, /Push branching, loops, retries, and aggregation/);
  assert.match(d, /ordered side effects/);
});

test("buildCodeToolDescription includes compact logic and anchored-edit guidance", () => {
  const d = buildCodeToolDescription(new Map());
  assert.match(d, /Favor intelligent logic, batching, and parallelism/);
  assert.match(d, /no time, wave, or call limit by default/);
  assert.match(d, /retr/i);
  assert.match(d, /dependent steps/);
  assert.match(d, /exact bytes from the read result/);
  assert.match(d, /start_anchor\/end_anchor/);
  assert.match(d, /never parallelize multiple edits to the same file/);
});

test("buildCodeToolDescription includes output mechanics", () => {
  const d = buildCodeToolDescription(new Map());
  assert.match(d, /Return a compact decision-ready object/);
  assert.match(d, /status, counts, paths with line numbers/);
  assert.match(d, /Keep raw reads, full diffs, test logs, and large arrays inside local variables/);
});

test("buildCodeToolDescription includes dependency guard, JS guard, and compact returns", () => {
  const d = buildCodeToolDescription(new Map());
  assert.match(d, /Only batch independent calls/);
  assert.match(d, /If B's args depend on A's result/);
  assert.match(d, /write executable JavaScript, not TypeScript syntax/);
  assert.match(d, /Schema descriptions, defaults, examples, formats, and patterns are authoritative/);
  assert.match(d, /exact snippets needed for the next step/);
  assert.doesNotMatch(d, /Phased gather/);
  assert.doesNotMatch(d, /git fetch --all --tags --prune/);
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

test("runCodeScriptDynamic: tool result behaves like a string while preserving metadata", async () => {
  const r = await runCodeScriptDynamic(
    `
      const content = await tools.Read({ path: "x" });
      return {
        instance: content instanceof ToolResult,
        includes: content.includes("beta"),
        split: content.split("\\n").length,
        match: content.match(/beta/)[0],
        replace: content.replace("beta", "BETA"),
        length: content.length,
        string: String(content),
        template: \`\${content}\`,
        text: content.text,
        isError: content.isError,
        anchored: content.anchored
      };
    `,
    {
      toolNames: ["Read"],
      dispatchWave: async () => [{ text: "alpha\nbeta", raw: { ok: true }, isError: false, anchored: "a1:a2" }],
      timeoutMs: 5000,
    },
  );
  assert.deepEqual(r.value, {
    instance: true,
    includes: true,
    split: 2,
    match: "beta",
    replace: "alpha\nBETA",
    length: 10,
    string: "alpha\nbeta",
    template: "alpha\nbeta",
    text: "alpha\nbeta",
    isError: false,
    anchored: "a1:a2",
  });
});

test("runCodeScriptDynamic: ToolResult constructor is script-visible", async () => {
  const r = await runCodeScriptDynamic(
    "const r = new ToolResult({ text: 'x', raw: { a: 1 }, isError: true }); return { instance: r instanceof ToolResult, text: `${r}`, raw: r.raw.a, isError: r.isError };",
    {
      toolNames: [],
      dispatchWave: async () => [],
      timeoutMs: 5000,
    },
  );
  assert.deepEqual(r.value, { instance: true, text: "x", raw: 1, isError: true });
});

test("runCodeScriptDynamic: tool result has json and lines helpers", async () => {
  const r = await runCodeScriptDynamic(
    `
      const data = await tools.Json({});
      const lines = await tools.Lines({});
      return { ok: data.json().ok, lines: lines.lines({ trim: true, nonEmpty: true }) };
    `,
    {
      toolNames: ["Json", "Lines"],
      dispatchWave: async (w, calls) => calls.map((c) => (
        c.name === "Json"
          ? { text: '{"ok":true}', raw: null, isError: false }
          : { text: " a\n\n b ", raw: null, isError: false }
      )),
      timeoutMs: 5000,
    },
  );
  assert.deepEqual(r.value, { ok: true, lines: ["a", "b"] });
});

test("runCodeScriptDynamic: codemode.batch batches tuple calls into one wave", async () => {
  const waves = [];
  const r = await runCodeScriptDynamic(
    `
      const [a, b] = await codemode.batch([["A", { x: 1 }], ["B", { y: 2 }]]);
      return a + b;
    `,
    {
      toolNames: ["A", "B"],
      dispatchWave: async (w, calls) => {
        waves.push(calls);
        return calls.map((c) => ({ text: c.name, raw: null, isError: false }));
      },
      timeoutMs: 5000,
    },
  );
  assert.equal(r.value, "AB");
  assert.equal(r.waves, 1);
  assert.equal(waves[0].length, 2);
});

test("runCodeScriptDynamic: batch handles already-started tool promises", async () => {
  const waves = [];
  const r = await runCodeScriptDynamic(
    `
      const [a, b] = await batch([tools.A({}), tools.B({})]);
      return a.text + b.text;
    `,
    {
      toolNames: ["A", "B"],
      dispatchWave: async (w, calls) => {
        waves.push(calls);
        return calls.map((c) => ({ text: c.name, raw: null, isError: false }));
      },
      timeoutMs: 5000,
    },
  );
  assert.equal(r.value, "AB");
  assert.equal(r.waves, 1);
  assert.equal(waves[0].length, 2);
});

test("runCodeScriptDynamic: codemode.search and describe expose focused tool docs", async () => {
  const r = await runCodeScriptDynamic(
    `
      const hits = codemode.search("grep pattern");
      return { first: hits[0].path, docs: codemode.describe(hits[0].path) };
    `,
    {
      toolNames: ["Grep"],
      toolDocs: [{
        name: "Grep",
        path: "tools.Grep",
        summary: "grep files by pattern",
        docs: "### Grep\nGrep(args: { pattern: string; path: string; })",
      }],
      dispatchWave: async () => [],
      timeoutMs: 5000,
    },
  );
  assert.equal(r.value.first, "tools.Grep");
  assert.match(r.value.docs, /pattern: string/);
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

test("writeEvent injects latest rate-limit headers before first SSE chunk", () => {
  const chunks = [];
  const session = fakeCodeSession({
    res: {
      headersSent: false,
      writableEnded: false,
      statusCode: null,
      headers: null,
      writeHead(status, headers) {
        this.headersSent = true;
        this.statusCode = status;
        this.headers = headers;
      },
      write(chunk) { chunks.push(chunk); return true; },
    },
  });
  rememberRateLimitHeaders(session, {
    five_hour: { utilization: 23.5, resets_at: 1782878400 },
    seven_day: { utilization: 0.412, resets_at: 1782878400 },
  });

  writeEvent(session, { type: "message_stop" });

  assert.equal(session.res.statusCode, 200);
  assert.equal(session.res.headers["content-type"], "text/event-stream");
  assert.equal(session.res.headers["anthropic-ratelimit-unified-5h-utilization"], "0.235");
  assert.equal(session.res.headers["anthropic-ratelimit-unified-5h-reset"], "1782878400");
  assert.equal(session.res.headers["anthropic-ratelimit-unified-7d-utilization"], "0.412");
  assert.equal(session.res.headers["anthropic-ratelimit-unified-7d-reset"], "1782878400");
  assert.match(chunks[0], /^event: message_stop\n/);
});

test("rememberRateLimitHeaders merges partial get_usage windows across turns", () => {
  const session = fakeCodeSession();
  rememberRateLimitHeaders(session, { five_hour: { utilization: 39, resets_at: 1782878400 } });
  rememberRateLimitHeaders(session, { seven_day: { utilization: 51, resets_at: 1782878400 } });

  assert.deepEqual(session.rateLimitHeaders, {
    "anthropic-ratelimit-unified-5h-utilization": "0.39",
    "anthropic-ratelimit-unified-5h-reset": "1782878400",
    "anthropic-ratelimit-unified-7d-utilization": "0.51",
    "anthropic-ratelimit-unified-7d-reset": "1782878400",
  });
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

test("dispatchCodeWave resolves a final errored tool_result without wedging", async () => {
  const session = fakeCodeSession({
    model: "claude-opus-4-8",
    currentTurn: { resolve: () => {} },
    res: { writableEnded: false, write: () => {} },
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
    { name: "Execute", args: { command: "cd /tmp/missing" } },
  ]);

  await resolveCodeModeToolResults(session, [
    { tool_use_id: syn0, content: [{ type: "text", text: "Command failed (exit code: 1)" }], is_error: true },
  ]);
  const results = await resultPromise;
  assert.equal(results[0].text, "Command failed (exit code: 1)");
  assert.equal(results[0].isError, true);
  assert.equal(session.codeRun.currentWave, null);
  assert.equal(session.syntheticToCode.size, 0);
});

test("dispatchCodeWave stays pending when the final tool_result id is unmatched (wedge repro)", async () => {
  const session = fakeCodeSession({
    model: "claude-opus-4-8",
    currentTurn: { resolve: () => {} },
    res: { writableEnded: false, write: () => {} },
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
    { name: "Execute", args: { command: "cd /tmp/missing" } },
  ]);

  let settled = false;
  resultPromise.then(
    () => { settled = true; },
    () => { settled = true; },
  );

  await resolveCodeModeToolResults(session, [
    { tool_use_id: "toolu_code_wrong_w1_0", content: [{ type: "text", text: "Command failed (exit code: 1)" }], is_error: true },
  ]);
  await Promise.resolve();

  assert.equal(settled, false);
  assert.equal(session.codeRun.currentWave?.pending.has(syn0), true);
  assert.equal(session.syntheticToCode.get(syn0), codeId);

  clearAllCodeState(session);
  const results = await resultPromise;
  assert.equal(results[0].text, "code round abandoned");
  assert.equal(results[0].isError, true);
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

test("clearAllCodeState aborts the active code worker immediately", async () => {
  const session = fakeCodeSession({ clientTools: new Map() });
  startCodeRun(session, "toolu_code_abort", { script: "return await new Promise(() => {});" });
  const run = session.codeRun;
  assert.ok(run?.abortController?.signal, "code run has an abort signal");

  clearAllCodeState(session);

  assert.equal(run.abortController.signal.aborted, true);
  const outcome = await Promise.race([
    run.promise.then(() => "resolved", (e) => String(e?.message || e)),
    new Promise((resolve) => setTimeout(() => resolve("timeout"), 1000)),
  ]);
  assert.match(outcome, /aborted/);
  assert.equal(session.codeRun, null);
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

// ---------------------------------------------------------------------------
// formatCodeError (structured script-error result: ledger + console)
// ---------------------------------------------------------------------------

test("formatCodeError includes completed-work evidence", () => {
  const ledger = [
    ledgerEntry("Read", { file_path: "/a.txt" }, false),
    ledgerEntry("Edit", { file_path: "/a.txt", old_string: "x".repeat(200) }, true),
  ];
  const r = formatCodeError("boom (at code-mode-script.vm:3)", { ledger, logs: ["step 1 done"], waves: 2, calls: 2 });
  assert.equal(r.isError, true);
  const t = r.content[0].text;
  assert.match(t, /code script error: boom/);
  assert.match(t, /completed before failure: waves=2 calls=2/);
  assert.match(t, /do NOT repeat/);
  assert.match(t, /ok  Read\(\{"file_path":"\/a\.txt"\}\)/);
  assert.match(t, /ERR Edit\(/);
  assert.ok(!t.includes("x".repeat(100)), "args previews are capped");
  assert.match(t, /\[console\]\nstep 1 done/);
});

test("formatCodeError caps the ledger at 30 entries", () => {
  const ledger = Array.from({ length: 40 }, (_, i) => ledgerEntry("Read", { i }, false));
  const t = formatCodeError("boom", { ledger }).content[0].text;
  assert.match(t, /\(\+10 more\)/);
});

// ---------------------------------------------------------------------------
// persistent `state` global (round-trips parent <-> worker, survives errors)
// ---------------------------------------------------------------------------

test("runCodeScriptDynamic: state round-trips across runs", async () => {
  const opts = { toolNames: [], dispatchWave: async () => [], timeoutMs: 5000 };
  const r1 = await runCodeScriptDynamic("state.count = (state.count || 0) + 1; return state.count;", { ...opts, state: {} });
  assert.equal(r1.value, 1);
  assert.equal(r1.state.count, 1);
  const r2 = await runCodeScriptDynamic("state.count += 10; return state.count;", { ...opts, state: r1.state });
  assert.equal(r2.value, 11);
  assert.equal(r2.state.count, 11);
});

test("runCodeScriptDynamic: state survives a script error", async () => {
  const r = await runCodeScriptDynamic(
    "state.progress = 'half-done'; throw new Error('midway');",
    { toolNames: [], dispatchWave: async () => [], timeoutMs: 5000, state: {} },
  );
  assert.match(r.error, /midway/);
  assert.equal(r.state.progress, "half-done");
});

test("runCodeScriptDynamic: script error reports the failing line", async () => {
  const r = await runCodeScriptDynamic(
    "const a = 1;\nconst b = 2;\nthrow new Error('line3');",
    { toolNames: [], dispatchWave: async () => [], timeoutMs: 5000 },
  );
  assert.match(r.error, /line3/);
  assert.match(r.error, /code-mode-script\.vm:3/);
});

// ---------------------------------------------------------------------------
// sleep / codemode.retry / TextEncoder in the sandbox
// ---------------------------------------------------------------------------

test("runCodeScriptDynamic: sleep is available and awaitable", async () => {
  const r = await runCodeScriptDynamic("await sleep(10); return 'woke';", {
    toolNames: [],
    dispatchWave: async () => [],
    timeoutMs: 5000,
  });
  assert.equal(r.value, "woke");
});

test("runCodeScriptDynamic: codemode.retry retries an isError tool result", async () => {
  let attempts = 0;
  const r = await runCodeScriptDynamic(
    "const out = await codemode.retry(() => tools.Flaky({}), { attempts: 3, delayMs: 1 }); return out.text;",
    {
      toolNames: ["Flaky"],
      dispatchWave: async (w, calls) => {
        attempts++;
        return calls.map(() => (attempts < 3
          ? { text: "transient", raw: null, isError: true }
          : { text: "recovered", raw: null, isError: false }));
      },
      timeoutMs: 5000,
    },
  );
  assert.equal(r.value, "recovered");
  assert.equal(attempts, 3);
});

test("runCodeScriptDynamic: TextEncoder is available", async () => {
  const r = await runCodeScriptDynamic("return new TextEncoder().encode('abc').length;", {
    toolNames: [],
    dispatchWave: async () => [],
    timeoutMs: 5000,
  });
  assert.equal(r.value, 3);
});

// ---------------------------------------------------------------------------
// description mentions the new runtime surface (Release A batch)
// ---------------------------------------------------------------------------

test("buildCodeToolDescription documents state, recall, sleep, retry", () => {
  const d = buildCodeToolDescription(CLIENT_TOOLS);
  assert.match(d, /`state` is a persistent object/);
  assert.match(d, /codemode\.recall\(id\)/);
  assert.match(d, /sleep\(ms\)/);
  assert.match(d, /codemode\.retry\(fn/);
});

test("buildCodeToolDescription is byte-stable across client tool order", () => {
  const a = new Map([["B", { description: "b", input_schema: { type: "object", properties: {} } }], ["A", { description: "a", input_schema: { type: "object", properties: {} } }]]);
  const b = new Map([["A", { description: "a", input_schema: { type: "object", properties: {} } }], ["B", { description: "b", input_schema: { type: "object", properties: {} } }]]);
  assert.equal(buildCodeToolDescription(a), buildCodeToolDescription(b));
});

// ---------------------------------------------------------------------------
// codemode.recall — resolved inline from the session artifact store
// ---------------------------------------------------------------------------

test("dispatchCodeWave resolves __recall inline from session artifacts (no client turn)", async () => {
  const session = fakeCodeSession({
    codeArtifacts: new Map([["a1", { text: "the full spilled text", ts: 1 }]]),
    codeRun: { codeId: "c1", aborted: false, currentWave: null, waveSeq: 0, waveCount: 0, callCount: 0, ledger: [] },
  });
  const results = await dispatchCodeWave(session, "c1", 1, [
    { name: "__recall", args: { id: "a1" } },
    { name: "__recall", args: { id: "missing" } },
  ]);
  assert.equal(results[0].isError, false);
  assert.equal(results[0].text, "the full spilled text");
  assert.equal(results[1].isError, true);
  assert.match(results[1].text, /no artifact "missing"/);
  assert.equal(session.codeRun.currentWave, null, "no wave was fabricated");
});

test("codemode.recall round-trips worker -> dispatchCodeWave -> script", async () => {
  const session = fakeCodeSession({
    codeArtifacts: new Map([["a7", { text: "spilled payload 12345", ts: 1 }]]),
    codeRun: { codeId: "c9", aborted: false, currentWave: null, waveSeq: 0, waveCount: 0, callCount: 0, ledger: [] },
  });
  const r = await runCodeScriptDynamic(
    "const full = await codemode.recall('a7'); return `got:${full.text}`;",
    {
      toolNames: [...CLIENT_TOOLS.keys()],
      dispatchWave: (w, calls) => dispatchCodeWave(session, "c9", w, calls),
      timeoutMs: 5000,
    },
  );
  assert.equal(r.error, undefined);
  assert.equal(r.value, "got:spilled payload 12345");
});

// ---------------------------------------------------------------------------
// Frozen toolsets + late-tool merge (tool mutability without cache busts)
// ---------------------------------------------------------------------------

test("buildParkingMcpServer reuses frozen toolset bytes on warm resume", () => {
  const session = fakeCodeSession({ clientTools: new Map(), inputParsers: new Map() });
  const frozen = {
    description: "FROZEN DESCRIPTION BYTES (from an earlier release)",
    tools: [{ name: "Grep", description: "grep", input_schema: GREP_SCHEMA }],
  };
  let captured = null;
  buildParkingMcpServer(
    [{ name: "Grep", description: "grep NEWER PROSE", input_schema: GREP_SCHEMA }],
    session,
    (config) => { captured = config; return { ok: true }; },
    frozen,
  );
  // The cached-prefix bytes must be the persisted ones, not a re-render.
  assert.equal(captured.tools[0].description, frozen.description);
  assert.equal(session.codeDescription, frozen.description);
  assert.match(session.descHash, /^[0-9a-f]{12}$/);
  // Runtime seeded from the frozen raw tools, not the incoming ones.
  assert.equal(session.clientTools.get("Grep").description.includes("NEWER PROSE"), false);
  assert.equal(session.inputParsers.has("Grep"), true);
});

test("buildParkingMcpServer renders live when no frozen toolset is supplied", () => {
  const session = fakeCodeSession({ clientTools: new Map(), inputParsers: new Map() });
  let captured = null;
  buildParkingMcpServer(
    [{ name: "Grep", description: "grep", input_schema: GREP_SCHEMA }],
    session,
    (config) => { captured = config; return { ok: true }; },
  );
  assert.equal(captured.tools[0].description, session.codeDescription);
  assert.ok(session.codeDescription.includes("Grep"));
  assert.deepEqual(session.toolsetRawTools.map((t) => t.name), ["Grep"]);
});

test("mergeLateTool makes a late tool callable and queues an announcement", () => {
  const session = fakeCodeSession({ clientTools: new Map(), inputParsers: new Map(), toolsetRawTools: [] });
  mergeLateTool(session, {
    name: "WebFetch",
    description: "fetch a url",
    input_schema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
  });
  assert.equal(session.clientTools.has("WebFetch"), true);
  assert.equal(session.inputParsers.has("WebFetch"), true);
  assert.deepEqual(session.toolsetRawTools.map((t) => t.name), ["WebFetch"]);
  assert.equal(session.lateTools.has("WebFetch"), true);
  assert.equal(session.pendingToolNotice.has("WebFetch"), true);
});

test("appendPendingToolNotice announces once then clears the queue", () => {
  const session = fakeCodeSession({ pendingToolNotice: new Set(["Zeta", "Alpha"]) });
  const collapsed = { content: [{ type: "text", text: "result body" }] };
  appendPendingToolNotice(session, collapsed);
  const text = collapsed.content[0].text;
  assert.ok(text.startsWith("result body"));
  assert.ok(text.includes("new tools available"));
  assert.ok(text.indexOf("Alpha") < text.indexOf("Zeta"));
  assert.equal(session.pendingToolNotice, null);
  const again = { content: [{ type: "text", text: "next" }] };
  appendPendingToolNotice(session, again);
  assert.equal(again.content[0].text, "next");
});

