// Parallel large-Read regression (2026-07-01 session: two ~540-line files read
// in one wave came back cut off). Covers the two layers that make big parallel
// reads safe: dispatch-time chunk planning for EVERY oversized call in a wave,
// and out-of-order part resolution stitching each call byte-complete.
// Run: node --test test/server.parallel-reads.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { dispatchCodeWave, resolveCodeModeToolResults } from "../src/server.mjs";
import { CHUNK_MAX_LINES } from "../src/read-recovery.mjs";

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

function freshRun(codeId = "toolu_code_par") {
  return { codeId, aborted: false, currentWave: null, preamble: null, waveSeq: 0, waveCount: 0, callCount: 0, ledger: [] };
}

function gutter(lines, startLine) {
  return lines.map((l, i) => `${String(startLine + i).padStart(6)}→${l}`).join("\n");
}

const N = CHUNK_MAX_LINES + 700; // over the single-Read line cap => must chunk

test("one wave with two oversized Reads plans chunks for BOTH calls", () => {
  const dir = mkdtempSync(join(tmpdir(), "par-reads-"));
  const fileA = join(dir, "a.txt");
  const fileB = join(dir, "b.txt");
  writeFileSync(fileA, Array.from({ length: N }, (_, i) => `A${i + 1}`).join("\n"));
  writeFileSync(fileB, Array.from({ length: N }, (_, i) => `B${i + 1}`).join("\n"));

  const session = codeSession({ cwd: dir });
  session.codeRun = freshRun();
  dispatchCodeWave(session, session.codeRun.codeId, 1, [
    { name: "Read", args: { file_path: fileA } },
    { name: "Read", args: { file_path: fileB } },
  ]);

  const wave = session.codeRun.currentWave;
  assert.ok(wave, "wave constructed");
  assert.equal(wave.calls.length, 2);
  for (const call of wave.calls) {
    assert.equal(call.inlineError, null);
    assert.ok(Array.isArray(call.parts) && call.parts.length >= 2, `oversized Read is chunked (got ${call.parts?.length ?? 0} parts)`);
    assert.equal(call.stitch.coversWholeFile, true);
    // Windows tile the whole file with no gap or overlap.
    let next = 1;
    for (const p of call.parts) {
      assert.equal(p.args.offset, next);
      next += p.args.limit;
    }
    assert.equal(next - 1, N);
  }
  // Chunks of one call never collide with the other's ids.
  const ids = wave.calls.flatMap((c) => c.parts.map((p) => p.syntheticId));
  assert.equal(new Set(ids).size, ids.length);
});

test("out-of-order part results stitch BOTH parallel Reads byte-complete, no cross-talk", () => {
  const session = codeSession();
  const run = freshRun();
  session.codeRun = run;

  const mkCall = (tag, k) => {
    const parts = [
      { syntheticId: `toolu_code_par_w1_${k}c0`, args: { file_path: `/${tag}.txt`, offset: 1, limit: CHUNK_MAX_LINES } },
      { syntheticId: `toolu_code_par_w1_${k}c1`, args: { file_path: `/${tag}.txt`, offset: CHUNK_MAX_LINES + 1, limit: N - CHUNK_MAX_LINES } },
    ];
    return {
      syntheticId: parts[0].syntheticId,
      tool: "Read",
      args: { file_path: `/${tag}.txt` },
      inlineError: null,
      anchorPlan: null,
      parts,
      partResults: [null, null],
      stitch: { coversWholeFile: true },
    };
  };
  const callA = mkCall("a", 0);
  const callB = mkCall("b", 1);
  const wave = {
    waveNum: 1,
    calls: [callA, callB],
    fabricatable: [callA, callB],
    results: [null, null],
    pending: new Set([...callA.parts, ...callB.parts].map((p) => p.syntheticId)),
    dispatched: true,
    resolve: () => {},
    reject: () => {},
  };
  run.currentWave = wave;
  for (const p of [...callA.parts, ...callB.parts]) session.syntheticToCode.set(p.syntheticId, run.codeId);

  const partText = (tag, part) => gutter(
    Array.from({ length: part.args.limit }, (_, i) => `${tag}${part.args.offset + i}`),
    part.args.offset,
  );
  // Resolve interleaved and out of order: B2, A2, B1, A1.
  for (const [tag, part] of [["B", callB.parts[1]], ["A", callA.parts[1]], ["B", callB.parts[0]], ["A", callA.parts[0]]]) {
    resolveCodeModeToolResults(session, [
      { tool_use_id: part.syntheticId, content: [{ type: "text", text: partText(tag, part) }] },
    ]);
  }

  for (const [idx, tag] of [[0, "A"], [1, "B"]]) {
    const r = wave.results[idx];
    assert.ok(r, `call ${tag} resolved`);
    assert.equal(r.isError, false);
    assert.ok(!r.truncated, "no truncation flag on a complete stitch");
    const lines = r.text.split("\n");
    assert.equal(lines.length, N, `call ${tag} is byte-complete (${lines.length}/${N} lines)`);
    assert.match(lines[0], new RegExp(`${tag}1$`));
    assert.match(lines[N - 1], new RegExp(`${tag}${N}$`));
    const other = tag === "A" ? "B" : "A";
    assert.ok(!r.text.includes(`${other}1\n`) && !r.text.match(new RegExp(`→${other}`)), "no cross-call contamination");
  }
});
