// Unit tests for the pure read/edit failure-recovery planning module.
//
// Run: node --test test/read-recovery.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  classifyToolFailure,
  verifyEditsOnDisk,
  planFreshnessWindow,
  planChunkedRead,
  stitchReadResults,
  CHUNK_MAX_LINES,
  CHUNK_BYTE_TARGET,
  MAX_READ_CHUNKS,
} from "../src/read-recovery.mjs";

// The exact client error texts observed in the 2026-07-01 forensic session.
// These are fixtures pinning Claude Code's current wording: if a future client
// release rewords them, recovery silently degrades to passthrough — update the
// regexes AND these fixtures together, deliberately.
const STALE_READ_ERR = "<tool_use_error>File has been modified since read, either by the user or by a linter. Read it again before attempting to write it.</tool_use_error>";
const NOT_READ_ERR = "<tool_use_error>File has not been read yet. Read it first before writing to it.</tool_use_error>";
const TOO_LARGE_ERR = "File content (29916 tokens) exceeds maximum allowed tokens (25000). Use offset and limit parameters to read specific portions of the file, or search for specific content instead of reading the whole file.";

function tmp() {
  return mkdtempSync(join(tmpdir(), "read-recovery-"));
}

// ---------------------------------------------------------------------------
// classifyToolFailure
// ---------------------------------------------------------------------------

test("classifyToolFailure matches the forensic stale-read text for edit tools", () => {
  for (const tool of ["Edit", "MultiEdit", "Write"]) {
    assert.deepEqual(classifyToolFailure(tool, STALE_READ_ERR), { kind: "stale-read" });
  }
});

test("classifyToolFailure matches the not-read variant", () => {
  assert.deepEqual(classifyToolFailure("Edit", NOT_READ_ERR), { kind: "not-read" });
});

test("classifyToolFailure matches read-too-large with token counts", () => {
  const c = classifyToolFailure("Read", TOO_LARGE_ERR);
  assert.equal(c.kind, "read-too-large");
  assert.equal(c.actualTokens, 29916);
  assert.equal(c.capTokens, 25000);
});

test("classifyToolFailure returns null for other errors and mismatched tools", () => {
  assert.equal(classifyToolFailure("Edit", "old_string not found in file"), null);
  assert.equal(classifyToolFailure("Read", STALE_READ_ERR), null);
  assert.equal(classifyToolFailure("Bash", TOO_LARGE_ERR), null);
  assert.equal(classifyToolFailure("Edit", ""), null);
  assert.equal(classifyToolFailure("Edit", null), null);
});

// ---------------------------------------------------------------------------
// verifyEditsOnDisk
// ---------------------------------------------------------------------------

test("verifyEditsOnDisk: unique match returns ok with 1-based line", () => {
  const dir = tmp();
  const file = join(dir, "a.js");
  writeFileSync(file, "line one\nline two\nline three\n");
  const r = verifyEditsOnDisk({ filePath: file, edits: [{ old_string: "line two", new_string: "LINE 2" }] });
  assert.equal(r.ok, true);
  assert.equal(r.line, 2);
  rmSync(dir, { recursive: true, force: true });
});

test("verifyEditsOnDisk: missing old_string fails with reason", () => {
  const dir = tmp();
  const file = join(dir, "a.js");
  writeFileSync(file, "alpha\nbeta\n");
  const r = verifyEditsOnDisk({ filePath: file, edits: [{ old_string: "gamma", new_string: "x" }] });
  assert.equal(r.ok, false);
  assert.match(r.reason, /not found/);
  rmSync(dir, { recursive: true, force: true });
});

test("verifyEditsOnDisk: ambiguous old_string fails unless replace_all", () => {
  const dir = tmp();
  const file = join(dir, "a.js");
  writeFileSync(file, "dup\nmid\ndup\n");
  const noFlag = verifyEditsOnDisk({ filePath: file, edits: [{ old_string: "dup", new_string: "x" }] });
  assert.equal(noFlag.ok, false);
  assert.match(noFlag.reason, /2 times/);
  const withFlag = verifyEditsOnDisk({ filePath: file, edits: [{ old_string: "dup", new_string: "x", replace_all: true }] });
  assert.equal(withFlag.ok, true);
  rmSync(dir, { recursive: true, force: true });
});

test("verifyEditsOnDisk: MultiEdit chain applies sequentially", () => {
  const dir = tmp();
  const file = join(dir, "a.js");
  writeFileSync(file, "first\nsecond\n");
  // Edit 2's old_string only exists AFTER edit 1 has been applied.
  const r = verifyEditsOnDisk({
    filePath: file,
    edits: [
      { old_string: "first", new_string: "premier" },
      { old_string: "premier\nsecond", new_string: "done" },
    ],
  });
  assert.equal(r.ok, true);
  assert.equal(r.line, 1);
  rmSync(dir, { recursive: true, force: true });
});

test("verifyEditsOnDisk: unreadable file fails safely", () => {
  const r = verifyEditsOnDisk({ filePath: "/nonexistent/nope.js", edits: [{ old_string: "a", new_string: "b" }] });
  assert.equal(r.ok, false);
  assert.match(r.reason, /unreadable/);
});

test("verifyEditsOnDisk: relative path resolves against cwd", () => {
  const dir = tmp();
  writeFileSync(join(dir, "rel.js"), "hello rel\n");
  const r = verifyEditsOnDisk({ filePath: "rel.js", cwd: dir, edits: [{ old_string: "hello rel", new_string: "x" }] });
  assert.equal(r.ok, true);
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// planFreshnessWindow
// ---------------------------------------------------------------------------

test("planFreshnessWindow anchors near the edit site and clamps at line 1", () => {
  const content = Array.from({ length: 100 }, (_, i) => `l${i + 1}`).join("\n");
  const w = planFreshnessWindow({ content, line: 2, oldString: "l2" });
  assert.equal(w.offset, 1);
  assert.ok(w.limit >= 1);
});

test("planFreshnessWindow clamps limit at EOF", () => {
  const content = "a\nb\nc";
  const w = planFreshnessWindow({ content, line: 3, oldString: "c" });
  assert.ok(w.offset >= 1);
  assert.ok(w.offset + w.limit - 1 <= 3 + 21); // small, bounded window
});

// ---------------------------------------------------------------------------
// planChunkedRead
// ---------------------------------------------------------------------------

test("planChunkedRead: small file needs no chunking", () => {
  const dir = tmp();
  const file = join(dir, "small.txt");
  writeFileSync(file, Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n"));
  assert.equal(planChunkedRead({ filePath: file }), null);
  rmSync(dir, { recursive: true, force: true });
});

test("planChunkedRead: 2761-line file chunks with full coverage, no gaps or overlaps", () => {
  const dir = tmp();
  const file = join(dir, "big.txt");
  const N = 2761;
  writeFileSync(file, Array.from({ length: N }, (_, i) => `line number ${i + 1}`).join("\n"));
  const plan = planChunkedRead({ filePath: file });
  assert.ok(plan && Array.isArray(plan.chunks) && plan.chunks.length >= 2);
  let next = 1;
  for (const c of plan.chunks) {
    assert.equal(c.offset, next, "chunks must be contiguous");
    assert.ok(c.limit <= CHUNK_MAX_LINES);
    next = c.offset + c.limit;
  }
  assert.equal(next - 1, N, "chunks must cover every line");
  rmSync(dir, { recursive: true, force: true });
});

test("planChunkedRead: long-line (minified) file chunks by capped bytes", () => {
  const dir = tmp();
  const file = join(dir, "minified.js");
  // 60 lines x 5000 chars: few lines, way over the byte target even with the
  // 2000-char client truncation cap per line.
  writeFileSync(file, Array.from({ length: 60 }, () => "x".repeat(5000)).join("\n"));
  const plan = planChunkedRead({ filePath: file });
  assert.ok(plan && plan.chunks.length >= 2);
  for (const c of plan.chunks) {
    assert.ok(c.limit * 2008 <= CHUNK_BYTE_TARGET + 2008);
  }
  rmSync(dir, { recursive: true, force: true });
});

test("planChunkedRead: beyond MAX_READ_CHUNKS returns tooLarge", () => {
  const dir = tmp();
  const file = join(dir, "huge.txt");
  const lines = MAX_READ_CHUNKS * CHUNK_MAX_LINES + 10;
  writeFileSync(file, Array.from({ length: lines }, (_, i) => `${i}`).join("\n"));
  const plan = planChunkedRead({ filePath: file });
  assert.equal(plan.tooLarge, true);
  assert.ok(plan.estTokens > 0);
  rmSync(dir, { recursive: true, force: true });
});

test("planChunkedRead: explicit offset/limit restricts the planned range", () => {
  const dir = tmp();
  const file = join(dir, "big.txt");
  writeFileSync(file, Array.from({ length: 5000 }, (_, i) => `line ${i + 1}`).join("\n"));
  const plan = planChunkedRead({ filePath: file, offset: 1000, limit: 2500 });
  assert.ok(plan && plan.chunks.length >= 2);
  assert.equal(plan.chunks[0].offset, 1000);
  const last = plan.chunks[plan.chunks.length - 1];
  assert.equal(last.offset + last.limit - 1, 3499);
  // A window that fits needs no chunking.
  assert.equal(planChunkedRead({ filePath: file, offset: 1000, limit: 100 }), null);
  rmSync(dir, { recursive: true, force: true });
});

test("planChunkedRead: unreadable path returns null (client produces the real error)", () => {
  assert.equal(planChunkedRead({ filePath: "/nonexistent/nope.txt" }), null);
});

// ---------------------------------------------------------------------------
// stitchReadResults
// ---------------------------------------------------------------------------

function gutter(lines, startLine = 1) {
  return lines.map((l, i) => `${String(i + startLine).padStart(6)}→${l}`).join("\n");
}

test("stitchReadResults drops intermediate trailers and keeps the final remainder", () => {
  const chunk1 = gutter(["alpha", "beta"], 1) + "\n\n<system-reminder>ignore me</system-reminder>";
  const chunk2 = gutter(["gamma", "delta"], 3) + "\n\n<system-reminder>keep me</system-reminder>";
  const { text, lastLine } = stitchReadResults([chunk1, chunk2]);
  assert.ok(text.includes("alpha"));
  assert.ok(text.includes("delta"));
  assert.equal(text.split("ignore me").length, 1, "intermediate trailer dropped");
  assert.ok(text.includes("keep me"), "final trailer kept");
  assert.equal(lastLine, 4);
  // Gutter numbering is continuous across the seam.
  const nums = [...text.matchAll(/^\s*(\d+)→/gm)].map((m) => Number(m[1]));
  assert.deepEqual(nums, [1, 2, 3, 4]);
});

test("stitchReadResults handles a single chunk verbatim", () => {
  const chunk = gutter(["only"], 7);
  const { text, lastLine } = stitchReadResults([chunk]);
  assert.equal(text, chunk);
  assert.equal(lastLine, 7);
});
