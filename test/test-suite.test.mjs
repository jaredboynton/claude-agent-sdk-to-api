import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  hotspotSummary,
  impactedTestsForChanges,
  parseShard,
  shardFiles,
} from "../scripts/test-suite.mjs";

function tempRoot() {
  const root = mkdtempSync(join(tmpdir(), "test-suite-runner-"));
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "test"), { recursive: true });
  return root;
}

function write(root, rel, text) {
  writeFileSync(join(root, rel), text);
}

test("parseShard rejects invalid shard ranges", () => {
  assert.deepEqual(parseShard("2/4"), { index: 2, total: 4 });
  assert.throws(() => parseShard("0/4"), /invalid shard/);
  assert.throws(() => parseShard("5/4"), /invalid shard/);
  assert.throws(() => parseShard("x"), /invalid shard/);
});

test("shardFiles partitions tests deterministically without dropping files", () => {
  const root = tempRoot();
  try {
    write(root, "test/a.test.mjs", "test('a', () => {});\n");
    write(root, "test/b.test.mjs", `${"// b\n".repeat(25)}test('b', () => {});\n`);
    write(root, "test/c.test.mjs", `${"// c\n".repeat(5)}test('c', () => {});\n`);
    write(root, "test/d.test.mjs", `${"// d\n".repeat(15)}test('d', () => {});\n`);

    const files = ["test/a.test.mjs", "test/b.test.mjs", "test/c.test.mjs", "test/d.test.mjs"];
    const s1 = shardFiles(files, parseShard("1/2"), { root });
    const s2 = shardFiles(files, parseShard("2/2"), { root });
    assert.deepEqual([...s1, ...s2].sort(), files);
    assert.equal(s1.some((file) => s2.includes(file)), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("impactedTestsForChanges selects importing tests and falls back for broad-impact files", () => {
  const root = tempRoot();
  try {
    write(root, "src/a.mjs", "export const a = 1;\n");
    write(root, "src/b.mjs", "export const b = 2;\n");
    write(root, "test/a.test.mjs", 'import "../src/a.mjs";\ntest("a", () => {});\n');
    write(root, "test/b.test.mjs", 'import "../src/b.mjs";\ntest("b", () => {});\n');

    const tests = ["test/a.test.mjs", "test/b.test.mjs"];
    assert.deepEqual(
      impactedTestsForChanges(["src/a.mjs"], tests, { root }),
      { files: ["test/a.test.mjs"], reason: "dependency-selected tests" },
    );
    assert.deepEqual(
      impactedTestsForChanges(["src/server.mjs"], tests, { root }),
      { files: tests, reason: "broad-impact file changed; full suite fallback" },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("hotspotSummary reports scanned slow-risk evidence", () => {
  const root = tempRoot();
  try {
    write(root, "test/fs.test.mjs", 'import { mkdtempSync } from "node:fs";\ntest("fs", () => mkdtempSync("/tmp/x-"));\n');
    write(root, "test/net.test.mjs", 'import http from "node:http";\ntest("net", () => http.createServer());\n');
    write(root, "test/exec.test.mjs", 'import { execFileSync } from "node:child_process";\ntest("exec", () => execFileSync("true"));\n');
    write(root, "test/timer.test.mjs", 'test("timer", () => setTimeout(() => {}, 1));\n');

    const summary = hotspotSummary([
      "test/fs.test.mjs",
      "test/net.test.mjs",
      "test/exec.test.mjs",
      "test/timer.test.mjs",
    ], { root });
    assert.deepEqual(summary.counts, {
      files: 4,
      tests: 4,
      tmpFiles: 1,
      networkOrServerFiles: 1,
      childProcessFiles: 1,
      timerFiles: 1,
    });
    assert.equal(summary.candidates.length, 4);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("package scripts route normal, profile, changed, and hotspot test modes through the runner", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.scripts.test, "node scripts/test-suite.mjs");
  assert.equal(pkg.scripts["test:profile"], "node scripts/test-suite.mjs --profile");
  assert.equal(pkg.scripts["test:changed"], "node scripts/test-suite.mjs --changed");
  assert.equal(pkg.scripts["test:hotspots"], "node scripts/test-suite.mjs --hotspots");
  assert.equal(pkg.scripts.prepublishOnly, "node scripts/test-suite.mjs");
});
