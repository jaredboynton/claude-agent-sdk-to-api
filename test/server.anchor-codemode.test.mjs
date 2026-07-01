// Integration tests for anchor editing in CODE MODE:
//   - dispatchCodeWave translates anchor-shaped Edit args to native old_string
//   - native old_string args pass through untranslated (no regression)
//   - resolveCodeModeToolResults exposes a `.anchored` view for Read results
//     while keeping `.text` clean
//
// Run: node --test test/server.anchor-codemode.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  dispatchCodeWave,
  resolveCodeModeToolResults,
  buildParkingMcpServer,
  initMessageProjection,
} from "../src/server.mjs";
import { createAnchorState, annotateReadResult } from "../src/anchor-edit.mjs";

const OPEN = "\u27e6";
const CLOSE = "\u27e7";

function gutter(lines, startLine = 1) {
  return lines.map((l, i) => `${String(i + startLine).padStart(6)}\u2192${l}`).join("\n");
}
function anchorsOf(text) {
  return [...text.matchAll(/\u27e6([a-z0-9]+)\u27e7/g)].map((m) => m[1]);
}

function codeSession(overrides = {}) {
  return {
    key: "k",
    bucket: "b",
    anchorState: createAnchorState(),
    clientTools: new Map([["Edit", { description: "edit", input_schema: { type: "object", properties: {} } }], ["Read", { description: "read", input_schema: { type: "object", properties: {} } }]]),
    inputParsers: new Map(), // no parser => translated args pass straight through
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

function freshRun(codeId = "toolu_code_x") {
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

test("dispatchCodeWave translates anchor-shaped Edit args to native old_string", () => {
  const session = codeSession();
  // Seed the snapshot the way a prior Read wave would have.
  const { text: annotated } = annotateReadResult(session.anchorState, "/a.js", gutter(["alpha", "  beta;", "gamma"]));
  const [, mid] = anchorsOf(annotated);
  session.codeRun = freshRun();

  // Not awaited: validation runs synchronously and sets currentWave before waiting for a turn.
  dispatchCodeWave(session, session.codeRun.codeId, 1, [
    { name: "Edit", args: { file_path: "/a.js", start_anchor: `${OPEN}${mid}${CLOSE}`, end_anchor: `${OPEN}${mid}${CLOSE}`, new_string: "  BETA;" } },
  ]);

  const wave = session.codeRun.currentWave;
  assert.ok(wave, "wave assigned to currentWave");
  const call = wave.calls[0];
  assert.equal(call.inlineError, null);
  assert.deepEqual(call.args, { file_path: "/a.js", old_string: "  beta;", new_string: "  BETA;" });
});

test("dispatchCodeWave passes native old_string args through untranslated", () => {
  const session = codeSession();
  annotateReadResult(session.anchorState, "/a.js", gutter(["alpha", "  beta;", "gamma"]));
  session.codeRun = freshRun();

  dispatchCodeWave(session, session.codeRun.codeId, 1, [
    { name: "Edit", args: { file_path: "/a.js", old_string: "  beta;", new_string: "  BETA;" } },
  ]);

  const call = session.codeRun.currentWave.calls[0];
  assert.equal(call.inlineError, null);
  assert.deepEqual(call.args, { file_path: "/a.js", old_string: "  beta;", new_string: "  BETA;" });
});

test("dispatchCodeWave returns inline error when anchors are unknown", async () => {
  const session = codeSession();
  session.codeRun = freshRun();

  const results = await dispatchCodeWave(session, session.codeRun.codeId, 1, [
    { name: "Edit", args: { file_path: "/missing.js", start_anchor: "zzzz", end_anchor: "zzzz", new_string: "x" } },
  ]);
  // All calls inline-errored => dispatchCodeWave resolves immediately.
  assert.equal(results.length, 1);
  assert.equal(results[0].isError, true);
  assert.match(results[0].text, /anchor edit translation failed/);
});

test("resolveCodeModeToolResults exposes .anchored for a Read result, .text stays clean", () => {
  const session = codeSession();
  const run = freshRun();
  session.codeRun = run;
  const synId = "toolu_code_x_w1_0";
  const readText = gutter(["const a = 1;", "const b = 2;"]);
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
  run.currentWave = wave;
  session.syntheticToCode.set(synId, run.codeId);

  resolveCodeModeToolResults(session, [
    { tool_use_id: synId, content: [{ type: "text", text: readText }] },
  ]);

  const r = wave.results[0];
  assert.equal(r.text, readText, ".text stays the clean Read output");
  assert.ok(r.anchored, ".anchored view present");
  assert.equal(anchorsOf(r.anchored).length, 2);
  // And the snapshot was cached so a later Edit can resolve anchors.
  assert.ok(session.anchorState.files.has("/r.js"));
});

test("code-mode reconcile: a confirmed Edit result updates the cached snapshot", () => {
  const session = codeSession({
    currentTurn: { resolve: () => {} },
    res: { writableEnded: false, write: () => {} },
  });
  initMessageProjection(session);
  const run = freshRun();
  session.codeRun = run;
  const { text: annotated } = annotateReadResult(session.anchorState, "/a.js", gutter(["one", "two", "three"]));
  const anchors = anchorsOf(annotated);

  dispatchCodeWave(session, run.codeId, 1, [
    { name: "Edit", args: { file_path: "/a.js", start_anchor: `${OPEN}${anchors[0]}${CLOSE}`, end_anchor: `${OPEN}${anchors[0]}${CLOSE}`, new_string: "ONE\ninserted" } },
  ]);
  const wave = run.currentWave;
  const synId = wave.calls[0].syntheticId;
  assert.ok(wave.calls[0].anchorPlan, "reconcile plan attached to the call");
  assert.ok(session.syntheticToCode.has(synId), "fabrication registered synthetic id");

  // Client confirms success -> resolveCodeModeToolResults reconciles.
  resolveCodeModeToolResults(session, [
    { tool_use_id: synId, content: [{ type: "text", text: "ok" }] },
  ]);
  assert.deepEqual(session.anchorState.files.get("/a.js").lines, ["ONE", "inserted", "two", "three"]);
  // Original "three" anchor still resolves after the shift.
  assert.equal(session.anchorState.files.get("/a.js").lineByCore.has(anchors[2]), true);
});

test("code-mode buildParkingMcpServer merges anchor fields into Edit signature", () => {
  let captured = null;
  const session = codeSession({ clientTools: new Map() });
  buildParkingMcpServer(
    [
      { name: "Edit", description: "Edit a file", input_schema: { type: "object", properties: { file_path: { type: "string" }, old_string: { type: "string" }, new_string: { type: "string" } }, required: ["file_path", "old_string", "new_string"] } },
      { name: "Read", description: "Read a file", input_schema: { type: "object", properties: { file_path: { type: "string" } } } },
    ],
    session,
    (config) => { captured = config; return { ok: true }; },
  );
  const editMeta = session.clientTools.get("Edit");
  assert.ok(editMeta.input_schema.properties.start_anchor, "anchor fields merged");
  assert.ok(editMeta.input_schema.properties.old_string, "native old_string preserved");
  assert.match(editMeta.description, /ANCHORED EDITING/);
});
