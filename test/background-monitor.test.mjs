// Pure helpers behind codemode.monitor() and the worker auto-monitor.
// Run: node --test test/background-monitor.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  parseBackgroundBanner,
  parseCompletion,
  looksRunning,
  pickMonitorStrategy,
  stripReadGutter,
  nextPollDelay,
  TASK_BLOCK_TIMEOUT_MS,
} from "../src/background-monitor.mjs";

test("parseBackgroundBanner: Claude Code Bash shape (id only)", () => {
  assert.deepEqual(
    parseBackgroundBanner("Command running in background with ID: bash_3"),
    { id: "bash_3", outputPath: null },
  );
});

test("parseBackgroundBanner: task-harness shape with output path and trailing periods", () => {
  const b = parseBackgroundBanner(
    "Command running in background with ID: bht7u80j4. Output is being written to: /tmp/tasks/bht7u80j4.output. You will be notified when it completes.",
  );
  assert.equal(b.id, "bht7u80j4");
  assert.equal(b.outputPath, "/tmp/tasks/bht7u80j4.output");
});

test("parseBackgroundBanner: non-banner text returns null", () => {
  assert.equal(parseBackgroundBanner("all tests pass"), null);
  assert.equal(parseBackgroundBanner(""), null);
  assert.equal(parseBackgroundBanner(null), null);
});

test("parseCompletion: exit-code and status markers across clients", () => {
  assert.deepEqual(parseCompletion("done\n[Process exited with code 2]"), { done: true, exitCode: 2 });
  assert.deepEqual(parseCompletion("<status>completed</status>"), { done: true, exitCode: 0 });
  assert.deepEqual(parseCompletion("x<exit_code>0</exit_code>"), { done: true, exitCode: 0 });
  assert.deepEqual(parseCompletion("status: failed"), { done: true, exitCode: null });
  assert.deepEqual(parseCompletion("Error: Command failed (exit code: 1)"), { done: true, exitCode: 1 });
  assert.deepEqual(parseCompletion("still going"), { done: false, exitCode: null });
});

test("looksRunning matches running markers only", () => {
  assert.equal(looksRunning("<status>running</status>"), true);
  assert.equal(looksRunning("status: running"), true);
  assert.equal(looksRunning("task is still running"), true);
  assert.equal(looksRunning("ran to completion"), false);
});

const docs = (...names) => names.map((n) => ({ name: n }));
const banner = { id: "t1", outputPath: "/tmp/t1.out" };

test("pickMonitorStrategy prefers blocking TaskOutput, then BashOutput, then Read", () => {
  assert.equal(pickMonitorStrategy(docs("Read", "BashOutput", "TaskOutput"), banner).tool, "TaskOutput");
  assert.equal(pickMonitorStrategy(docs("Read", "BashOutput"), banner).tool, "BashOutput");
  assert.equal(pickMonitorStrategy(docs("Read"), banner).tool, "Read");
  assert.equal(pickMonitorStrategy(docs("Grep"), banner), null);
});

test("Read strategy requires a reported output path", () => {
  assert.equal(pickMonitorStrategy(docs("Read"), { id: "x", outputPath: null }), null);
});

test("TaskOutput blocks with a clamped timeout", () => {
  const s = pickMonitorStrategy(docs("TaskOutput"), banner);
  assert.equal(s.kind, "task");
  const a = s.buildArgs(10 * 60 * 1000);
  assert.equal(a.task_id, "t1");
  assert.equal(a.block, true);
  assert.ok(a.timeout <= TASK_BLOCK_TIMEOUT_MS && a.timeout >= 5_000);
  assert.equal(s.buildArgs(1).timeout, 5_000);
});

test("tool override bypasses catalog membership", () => {
  assert.equal(pickMonitorStrategy([], banner, "BashOutput").tool, "BashOutput");
  assert.equal(pickMonitorStrategy([], banner, "NoSuch"), null);
});

test("stripReadGutter strips guttered lines, leaves plain text alone", () => {
  const guttered = "     1→alpha\n     2→beta";
  assert.equal(stripReadGutter(guttered), "alpha\nbeta");
  assert.equal(stripReadGutter("plain\ntext"), "plain\ntext");
});

test("nextPollDelay backs off 1.5x and caps", () => {
  assert.equal(nextPollDelay(0, 1000, 15000), 1000);
  assert.equal(nextPollDelay(1, 1000, 15000), 1500);
  assert.equal(nextPollDelay(20, 1000, 15000), 15000);
});
