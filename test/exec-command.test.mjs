// exec-command unit tests: quoting round-trips through real bash, extension
// inference, command composition limits, and shell-tool detection.
// Run: node --test test/exec-command.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { dirname } from "node:path";
import { tmpdir } from "node:os";

import { shQuote, inferExt, buildExecCommand, pickShellTool } from "../src/exec-command.mjs";

function runBash(command) {
  return execFileSync("/bin/bash", ["-c", command], { encoding: "utf8" });
}

test("shQuote round-trips hostile bytes through bash", () => {
  const hostile = `a'b "c" $[x] $(y) \\back \`tick\` 日本語 %s`;
  assert.equal(runBash(`printf '%s' ${shQuote(hostile)}`), hostile);
});

test("inferExt: node ESM/CJS sniff, python, sh, override, validation", () => {
  assert.equal(inferExt("node", "console.log(1)"), ".cjs");
  assert.equal(inferExt("node", "import fs from 'node:fs';\nconsole.log(1)"), ".mjs");
  assert.equal(inferExt("node", "const fs = require('fs')"), ".cjs");
  assert.equal(inferExt("/usr/bin/python3", "print(1)"), ".py");
  assert.equal(inferExt("bash", "echo hi"), ".sh");
  assert.equal(inferExt("node", "x", "ts"), ".ts");
  assert.throws(() => inferExt("node", "x", "../evil"), /invalid ext/);
});

test("buildExecCommand rejects empty and oversized source", () => {
  assert.throws(() => buildExecCommand({ source: "   " }), /empty/);
  assert.throws(() => buildExecCommand({ source: "x".repeat(300000) }), /too large/);
});

test("node source with $[ and quotes survives bash exactly, args included", () => {
  const src = `console.log(["h['x-access']", "$[ok]", process.argv[2], process.argv[3], process.argv[4]].join("|"));`;
  const cmd = buildExecCommand({ source: src, args: ["A B", "$[nope]", "back\\slash"] });
  assert.equal(runBash(cmd), "h['x-access']|$[ok]|A B|$[nope]|back\\slash\n");
});

test("interpreter exit status is preserved", () => {
  const cmd = buildExecCommand({ source: "process.exit(7);" });
  try {
    runBash(cmd);
    assert.fail("expected non-zero exit");
  } catch (e) {
    assert.equal(e.status, 7);
  }
});

test("temp script dir is cleaned up after the run", () => {
  const cmd = buildExecCommand({ source: "console.log(process.argv[1]);" });
  const scriptPath = runBash(cmd).trim();
  assert.ok(scriptPath.endsWith(".cjs"));
  assert.ok(!existsSync(scriptPath));
  assert.ok(!existsSync(dirname(scriptPath)));
});

test("cwd runs in a subshell and does not leak", () => {
  const dir = realpathSync(tmpdir());
  const cmd = buildExecCommand({ source: "console.log(process.cwd());", cwd: dir });
  assert.equal(runBash(cmd).trim(), dir);
  const after = runBash(`cd /tmp && ${cmd} && pwd`).trim().split("\n").pop();
  assert.equal(after, "/tmp");
});

test("python3 source round-trips (skipped when python3 missing)", (t) => {
  try {
    execFileSync("/bin/bash", ["-c", "command -v python3"], { encoding: "utf8" });
  } catch {
    t.skip("python3 not installed");
    return;
  }
  const cmd = buildExecCommand({ source: `print("py $[ok] 'quoted'")`, interpreter: "python3" });
  assert.equal(runBash(cmd), "py $[ok] 'quoted'\n");
});

test("pickShellTool: preferred names, docs fallback, none", () => {
  assert.equal(pickShellTool([{ name: "Execute" }, { name: "Bash" }]), "Bash");
  assert.equal(pickShellTool([{ name: "Grep" }, { name: "Execute" }]), "Execute");
  assert.equal(
    pickShellTool([{ name: "mcp__srv__run_shell", docs: "mcp__srv__run_shell(args: { command: string })" }]),
    "mcp__srv__run_shell",
  );
  assert.equal(pickShellTool([{ name: "Grep", docs: "Grep(args: { pattern: string })" }]), null);
  assert.equal(pickShellTool([]), null);
});
