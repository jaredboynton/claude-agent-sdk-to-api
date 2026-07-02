// Debug-ring capture in the code-mode wave engine: dispatch records tool_use,
// resolve records tool_result, inline errors are flagged.
// Run: node --test test/server.debug-ring.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

import { dispatchCodeWave, resolveCodeModeToolResults } from "../src/server.mjs";
import { recentDebug, _resetDebugRingForTests } from "../src/debug-ring.mjs";

function codeSession(overrides = {}) {
  return {
    key: "k",
    bucket: "b",
    clientTools: new Map([["Read", { description: "read", input_schema: { type: "object", properties: {} } }]]),
    inputParsers: new Map(),
    syntheticToCode: new Map(),
    codeDriving: true,
    pendingTools: new Map(),
    resolvedResults: new Map(),
    orphanResolvers: [],
    streamedToolUses: [],
    toolUseAccum: new Map(),
    currentTurn: null,
    res: null,
    nonStream: null,
    codeSubCalls: 0,
    turnMetrics: null,
    ...overrides,
  };
}

function freshRun(codeId = "toolu_code_ring") {
  return {
    codeId,
    aborted: false,
    currentWave: null,
    waveSeq: 0,
    waveCount: 0,
    callCount: 0,
    preamble: null,
    settled: false,
  };
}

test("dispatchCodeWave records tool_use; resolveCodeModeToolResults records tool_result", () => {
  _resetDebugRingForTests();
  const session = codeSession();
  session.codeRun = freshRun();

  dispatchCodeWave(session, session.codeRun.codeId, 1, [
    { name: "Read", args: { file_path: "/r.js" } },
  ]);

  const uses = recentDebug(10).filter((e) => e.kind === "tool_use");
  assert.equal(uses.length, 1);
  assert.equal(uses[0].tool, "Read");
  assert.equal(uses[0].bucket, "b");
  assert.match(uses[0].head, /\/r\.js/);
  assert.ok(!uses[0].isError);

  // Resolve path: a live wave carries its own routing state (built when the
  // wave is fabricated into a real stream), so construct it directly.
  const synId = "toolu_code_ring_w1_0";
  const wave = {
    waveNum: 1,
    calls: [{ syntheticId: synId, tool: "Read", args: { file_path: "/r.js" }, inlineError: null }],
    fabricatable: [{ syntheticId: synId }],
    results: [null],
    pending: new Set([synId]),
    dispatched: true,
    resolve: () => {},
    reject: () => {},
  };
  session.codeRun.currentWave = wave;
  session.syntheticToCode.set(synId, session.codeRun.codeId);
  resolveCodeModeToolResults(session, [
    { tool_use_id: synId, content: [{ type: "text", text: "file body" }] },
  ]);

  const results = recentDebug(10).filter((e) => e.kind === "tool_result");
  assert.equal(results.length, 1);
  assert.equal(results[0].tool, "Read");
  assert.equal(results[0].id, synId);
  assert.equal(results[0].head, "file body");
  _resetDebugRingForTests();
});

test("inline-errored calls (unknown tool) are recorded with isError", async () => {
  _resetDebugRingForTests();
  const session = codeSession();
  session.codeRun = freshRun();

  const results = await dispatchCodeWave(session, session.codeRun.codeId, 1, [
    { name: "NoSuchTool", args: {} },
  ]);
  assert.equal(results.length, 1);
  assert.equal(results[0].isError, true);

  const uses = recentDebug(10).filter((e) => e.kind === "tool_use");
  assert.equal(uses.length, 1);
  assert.equal(uses[0].tool, "NoSuchTool");
  assert.equal(uses[0].isError, true);
  _resetDebugRingForTests();
});
