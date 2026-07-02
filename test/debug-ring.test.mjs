// Debug-ring unit tests: memory ring, head capping, disk mirror, rotation.
// Run: node --test test/debug-ring.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  initDebugRing,
  recordDebug,
  recentDebug,
  debugRingPath,
  _resetDebugRingForTests,
} from "../src/debug-ring.mjs";

test("recordDebug keeps newest entries in order, memory-only without a profile dir", () => {
  _resetDebugRingForTests();
  recordDebug({ kind: "code_run", id: "a", head: "first" });
  recordDebug({ kind: "tool_use", id: "b", tool: "Read", head: "{}" });
  recordDebug({ kind: "tool_result", id: "b", tool: "Read", head: "ok" });
  assert.equal(debugRingPath(), null);
  const entries = recentDebug(10);
  assert.deepEqual(entries.map((e) => e.kind), ["code_run", "tool_use", "tool_result"]);
  assert.ok(entries.every((e) => typeof e.ts === "string"));
  assert.deepEqual(recentDebug(2).map((e) => e.id), ["b", "b"]);
});

test("recordDebug caps oversized heads but reports the uncapped byte size", () => {
  _resetDebugRingForTests();
  const big = "x".repeat(10000);
  const e = recordDebug({ kind: "code_result", head: big });
  assert.equal(e.bytes, 10000);
  assert.ok(e.head.length < 3000);
  assert.match(e.head, /\[\+\d+ bytes\]/);
  const small = recordDebug({ kind: "code_result", head: "tiny" });
  assert.equal(small.head, "tiny");
  assert.equal(small.bytes, 4);
});

test("ring evicts oldest beyond capacity", () => {
  _resetDebugRingForTests();
  for (let i = 0; i < 520; i++) recordDebug({ kind: "tool_use", id: String(i), head: "" });
  const entries = recentDebug(1000);
  assert.equal(entries.length, 500);
  assert.equal(entries[0].id, "20");
  assert.equal(entries[entries.length - 1].id, "519");
});

test("disk mirror appends JSONL and survives a re-init (restart)", () => {
  _resetDebugRingForTests();
  const dir = mkdtempSync(join(tmpdir(), "debug-ring-"));
  initDebugRing(dir);
  recordDebug({ kind: "code_run", id: "run1", head: "return 1;" });
  const file = join(dir, "debug-ring.jsonl");
  assert.equal(debugRingPath(), file);
  const lines = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].id, "run1");
  // Restart: memory ring is empty but the disk trail persists and grows.
  _resetDebugRingForTests();
  initDebugRing(dir);
  recordDebug({ kind: "code_run", id: "run2", head: "return 2;" });
  const after = readFileSync(file, "utf8").trim().split("\n");
  assert.equal(after.length, 2);
});

test("disk mirror rotates at the size cap keeping one generation", () => {
  _resetDebugRingForTests();
  const dir = mkdtempSync(join(tmpdir(), "debug-ring-rot-"));
  initDebugRing(dir, { maxFileBytes: 300 });
  for (let i = 0; i < 10; i++) recordDebug({ kind: "tool_use", id: `e${i}`, head: "y".repeat(80) });
  const file = join(dir, "debug-ring.jsonl");
  assert.ok(existsSync(file));
  assert.ok(existsSync(`${file}.1`), "rotated generation exists");
  // One .1 generation is kept: what survives is a contiguous newest suffix.
  const ids = (readFileSync(`${file}.1`, "utf8") + readFileSync(file, "utf8")).trim().split("\n").map((l) => JSON.parse(l).id);
  assert.equal(ids[ids.length - 1], "e9");
  const expectedSuffix = Array.from({ length: ids.length }, (_, i) => `e${10 - ids.length + i}`);
  assert.deepEqual(ids, expectedSuffix);
  _resetDebugRingForTests();
});

test("recordDebug never throws when the disk mirror is unwritable", () => {
  _resetDebugRingForTests();
  initDebugRing("/nonexistent-debug-ring-dir");
  const e = recordDebug({ kind: "code_run", id: "x", head: "s" });
  assert.equal(e.id, "x");
  assert.equal(recentDebug(5).length, 1);
  _resetDebugRingForTests();
});
