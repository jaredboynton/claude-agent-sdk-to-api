// Unit tests for daemon-side local checks (syntax verification + git snapshot).
//
// Run: node --test test/local-checks.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

import { checkerFor, containsPath, runSyntaxCheck, collectGitSnapshot } from "../src/local-checks.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function tmp() {
  // realpath: on macOS /var/folders is a symlink to /private/var; containment
  // compares realpaths, so the test cwd must already be canonical.
  return realpathSync(mkdtempSync(join(tmpdir(), "local-checks-")));
}

function hasBin(cmd) {
  try {
    execFileSync("which", [cmd], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

test("checkerFor maps extensions and rejects unknown ones", () => {
  assert.equal(checkerFor("a.mjs").id, "node");
  assert.equal(checkerFor("a.py").id, "python");
  assert.equal(checkerFor("a.json").id, "json");
  assert.equal(checkerFor("a.sh").id, "bash");
  assert.equal(checkerFor("a.rs"), null);
  assert.equal(checkerFor(""), null);
});

test("containsPath is separator-safe", () => {
  assert.equal(containsPath("/a/b", "/a/b/c.js"), true);
  assert.equal(containsPath("/a/b", "/a/b"), true);
  assert.equal(containsPath("/a/b", "/a/bc/x.js"), false);
  assert.equal(containsPath("/a/b", "/a"), false);
});

test("runSyntaxCheck: valid ESM .mjs passes node --check", async () => {
  const dir = tmp();
  writeFileSync(join(dir, "ok.mjs"), 'import { join } from "node:path";\nexport const x = join("a", "b");\n');
  const r = await runSyntaxCheck("ok.mjs", { cwd: dir });
  assert.equal(r.ok, true, r.output || r.reason);
  assert.equal(r.checker, "node");
  rmSync(dir, { recursive: true, force: true });
});

test("runSyntaxCheck: broken .mjs fails with diagnostic output", async () => {
  const dir = tmp();
  writeFileSync(join(dir, "bad.mjs"), "const x = ;\n");
  const r = await runSyntaxCheck("bad.mjs", { cwd: dir });
  assert.equal(r.ok, false);
  assert.match(r.output, /SyntaxError/);
  rmSync(dir, { recursive: true, force: true });
});

test("runSyntaxCheck: json ok and fail", async () => {
  const dir = tmp();
  writeFileSync(join(dir, "ok.json"), '{"a": 1}');
  writeFileSync(join(dir, "bad.json"), "{nope");
  assert.equal((await runSyntaxCheck("ok.json", { cwd: dir })).ok, true);
  const bad = await runSyntaxCheck("bad.json", { cwd: dir });
  assert.equal(bad.ok, false);
  assert.ok(bad.output.length > 0);
  rmSync(dir, { recursive: true, force: true });
});

test("runSyntaxCheck: broken .py reports a line number", { skip: !hasBin("python3") }, async () => {
  const dir = tmp();
  writeFileSync(join(dir, "bad.py"), "def f(:\n  pass\n");
  const r = await runSyntaxCheck("bad.py", { cwd: dir });
  assert.equal(r.ok, false);
  assert.match(r.output, /line 1/);
  rmSync(dir, { recursive: true, force: true });
});

test("runSyntaxCheck: broken .sh fails bash -n", { skip: !hasBin("bash") }, async () => {
  const dir = tmp();
  writeFileSync(join(dir, "bad.sh"), 'if [ x ]; then\necho "unclosed\n');
  const r = await runSyntaxCheck("bad.sh", { cwd: dir });
  assert.equal(r.ok, false);
  rmSync(dir, { recursive: true, force: true });
});

test("runSyntaxCheck: rejects paths escaping cwd via ..", async () => {
  const dir = tmp();
  const r = await runSyntaxCheck("../outside.js", { cwd: dir });
  assert.equal(r.ok, false);
  assert.match(r.reason || "", /outside session cwd|unresolvable/);
  rmSync(dir, { recursive: true, force: true });
});

test("runSyntaxCheck: rejects symlink escapes", async () => {
  const outer = tmp();
  const inner = join(outer, "project");
  const escapeTarget = join(outer, "secret.js");
  writeFileSync(escapeTarget, "const x = 1;\n");
  execFileSync("mkdir", ["-p", inner]);
  symlinkSync(escapeTarget, join(inner, "link.js"));
  const r = await runSyntaxCheck("link.js", { cwd: inner });
  assert.equal(r.ok, false);
  assert.match(r.reason || "", /outside session cwd/);
  rmSync(outer, { recursive: true, force: true });
});

test("runSyntaxCheck: unknown extension gets a clear reason", async () => {
  const dir = tmp();
  writeFileSync(join(dir, "a.rs"), "fn main() {}\n");
  const r = await runSyntaxCheck("a.rs", { cwd: dir });
  assert.equal(r.ok, false);
  assert.match(r.reason, /no checker/);
  rmSync(dir, { recursive: true, force: true });
});

test("collectGitSnapshot returns branch info inside a repo", { skip: !hasBin("git") }, async () => {
  const snap = await collectGitSnapshot(REPO_ROOT);
  assert.ok(snap, "repo root should produce a snapshot");
  assert.ok(typeof snap.branch === "string" && snap.branch.length > 0);
  assert.ok(Array.isArray(snap.changes));
  assert.ok(Array.isArray(snap.recentCommits) && snap.recentCommits.length > 0);
  assert.ok(typeof snap.capturedAt === "string");
});

test("collectGitSnapshot returns null outside a repo", { skip: !hasBin("git") }, async () => {
  const dir = tmp();
  assert.equal(await collectGitSnapshot(dir), null);
  rmSync(dir, { recursive: true, force: true });
});

test("collectGitSnapshot returns null for missing cwd", async () => {
  assert.equal(await collectGitSnapshot(""), null);
});
