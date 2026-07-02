// Worker auto-monitor + codemode.monitor(): a client that backgrounds a shell
// command must not wake the model - the run keeps watching it in client-side
// waves and the original await resolves with the finished output.
// Run: node --test test/code-monitor.test.mjs

// Millisecond cadence for tests; the worker thread inherits this env at spawn.
process.env.CODE_MONITOR_POLL_MS = "25";
process.env.CODE_MONITOR_POLL_MAX_MS = "50";

import { test } from "node:test";
import assert from "node:assert/strict";

import { runCodeScriptDynamic } from "../src/code-mode.mjs";

const BANNER = "Command running in background with ID: task_9. Output is being written to: /tmp/mon-test.output. You will be notified when it completes.";
const DOCS = [{ name: "Bash" }, { name: "TaskOutput" }, { name: "Read" }];
const NAMES = ["Bash", "TaskOutput", "Read"];

test("auto-monitor: backgrounded Bash resolves with the finished output via blocking TaskOutput", async () => {
  const dispatched = [];
  const r = await runCodeScriptDynamic(
    "const r = await tools.Bash({ command: 'npm test' }); return { text: r.text, raw: r.raw, notes: r.notes || [] };",
    {
      toolNames: NAMES,
      toolDocs: DOCS,
      dispatchWave: async (_wave, calls) => {
        dispatched.push(...calls.map((c) => ({ name: c.name, args: c.args })));
        const c = calls[0];
        if (c.name === "Bash") return [{ text: BANNER, raw: null, isError: false }];
        const nth = dispatched.filter((d) => d.name === "TaskOutput").length;
        if (nth === 1) return [{ text: "status: running\n(no new output)", raw: null, isError: false }];
        return [{ text: "ALL TESTS PASS\n\n[Process exited with code 0]", raw: null, isError: false }];
      },
    },
  );
  assert.equal(r.error, undefined);
  assert.match(r.value.text, /ALL TESTS PASS/);
  assert.doesNotMatch(r.value.text, /running in background/);
  assert.equal(r.value.raw.monitored, true);
  assert.equal(r.value.raw.exitCode, 0);
  assert.deepEqual(dispatched.map((d) => d.name), ["Bash", "TaskOutput", "TaskOutput"]);
  assert.equal(dispatched[1].args.task_id, "task_9");
  assert.equal(dispatched[1].args.block, true);
  assert.ok(r.value.notes.some((n) => /finished|exit 0/.test(n)), "monitor note surfaces on the result");
  assert.ok(r.logs.some((l) => /\[monitor\]/.test(l)), "monitor activity lands in [console] logs");
});

test("run_in_background: true opts out - the handle comes back untouched", async () => {
  const dispatched = [];
  const r = await runCodeScriptDynamic(
    "const r = await tools.Bash({ command: 'sleep 99', run_in_background: true }); return r.text;",
    {
      toolNames: NAMES,
      toolDocs: DOCS,
      dispatchWave: async (_wave, calls) => {
        dispatched.push(...calls.map((c) => c.name));
        return [{ text: BANNER, raw: null, isError: false }];
      },
    },
  );
  assert.equal(r.error, undefined);
  assert.match(r.value, /running in background with ID: task_9/);
  assert.deepEqual(dispatched, ["Bash"], "no monitor waves were issued");
});

test("codemode.monitor: explicit attach via Read fallback strips gutter and carries the exit code", async () => {
  const dispatched = [];
  const r = await runCodeScriptDynamic(
    `const h = await tools.Bash({ command: 'make', run_in_background: true });
const done = await codemode.monitor(h, { maxMs: 10000 });
return { text: done.text, raw: done.raw, isError: done.isError };`,
    {
      toolNames: ["Bash", "Read"],
      toolDocs: [{ name: "Bash" }, { name: "Read" }],
      dispatchWave: async (_wave, calls) => {
        dispatched.push(...calls.map((c) => ({ name: c.name, args: c.args })));
        const c = calls[0];
        if (c.name === "Bash") return [{ text: BANNER, raw: null, isError: false }];
        const nth = dispatched.filter((d) => d.name === "Read").length;
        if (nth === 1) return [{ text: "     1→building...", raw: null, isError: false }];
        return [{ text: "     1→building...\n     2→done\n     3→[Process exited with code 2]", raw: null, isError: false }];
      },
    },
  );
  assert.equal(r.error, undefined);
  assert.match(r.value.text, /^building\.\.\.\ndone/m);
  assert.doesNotMatch(r.value.text, /→/, "Read gutter is stripped");
  assert.equal(r.value.raw.exitCode, 2);
  assert.equal(r.value.isError, true, "nonzero exit surfaces as isError");
  assert.equal(dispatched[1].args.file_path, "/tmp/mon-test.output");
});

test("no monitor-capable tool: the banner passes through untouched", async () => {
  const r = await runCodeScriptDynamic(
    "const r = await tools.Bash({ command: 'x' }); return r.text;",
    {
      toolNames: ["Bash", "Grep"],
      toolDocs: [{ name: "Bash" }, { name: "Grep" }],
      dispatchWave: async () => [{ text: "Command running in background with ID: lone_1", raw: null, isError: false }],
    },
  );
  assert.equal(r.error, undefined);
  assert.match(r.value, /running in background with ID: lone_1/);
});
