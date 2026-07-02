// Pure-logic tests for the daemon auto-update poller.
// Run: node --test test/self-update.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  AutoUpdateOutcome,
  autoUpdateTick,
  backoffAllows,
  checkForUpdate,
  emptyState,
  failedAttemptsForVersion,
  globalInstallDir,
  isGlobalInstall,
  killSwitchDisabled,
  npmLatestUrl,
  planApply,
  readState,
  recordCheck,
  recordRun,
  recentlyDoneForVersion,
  shouldApply,
  writeState,
  RETRY_BACKOFF_MS,
  MAX_ATTEMPTS,
  DONE_SUPPRESS_MS,
  scheduleExitWhenIdle,
  _resetDrainGuardForTests,
} from "../src/self-update.mjs";

const PKG = "@jaredboynton/claude-agent-api";

function failedRun(version, finishedAtMs) {
  return { version, phase: "failed", startedAtMs: finishedAtMs - 1, finishedAtMs };
}
function doneRun(version, finishedAtMs) {
  return { version, phase: "done", startedAtMs: finishedAtMs - 1, finishedAtMs };
}

// --- registry check --------------------------------------------------------

test("npmLatestUrl keeps the scope slash literal", () => {
  assert.equal(
    npmLatestUrl(PKG),
    "https://registry.npmjs.org/@jaredboynton/claude-agent-api/latest"
  );
});

test("checkForUpdate returns available when registry version is newer", async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({ version: "0.2.0" }) });
  const r = await checkForUpdate({ pkgName: PKG, currentVersion: "0.1.1", fetchImpl });
  assert.equal(r.status, "available");
  assert.equal(r.latestVersion, "0.2.0");
});

test("checkForUpdate returns current when registry version equals running", async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({ version: "0.1.1" }) });
  const r = await checkForUpdate({ pkgName: PKG, currentVersion: "0.1.1", fetchImpl });
  assert.equal(r.status, "current");
});

test("checkForUpdate returns current when registry version is older", async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({ version: "0.1.0" }) });
  const r = await checkForUpdate({ pkgName: PKG, currentVersion: "0.1.1", fetchImpl });
  assert.equal(r.status, "current");
});

test("checkForUpdate reports check_failed on a non-200 response", async () => {
  const fetchImpl = async () => ({ ok: false, status: 503, json: async () => ({}) });
  const r = await checkForUpdate({ pkgName: PKG, currentVersion: "0.1.1", fetchImpl });
  assert.equal(r.status, "check_failed");
  assert.match(r.detail, /503/);
});

test("checkForUpdate reports check_failed when fetch throws (registry unreachable)", async () => {
  const fetchImpl = async () => { throw new Error("ETIMEDOUT"); };
  const r = await checkForUpdate({ pkgName: PKG, currentVersion: "0.1.1", fetchImpl });
  assert.equal(r.status, "check_failed");
  assert.match(r.detail, /ETIMEDOUT/);
});

test("checkForUpdate reports check_failed when version field is missing", async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({}) });
  const r = await checkForUpdate({ pkgName: PKG, currentVersion: "0.1.1", fetchImpl });
  assert.equal(r.status, "check_failed");
});

// --- failure / suppress accounting ----------------------------------------

test("failedAttemptsForVersion counts only matching failed runs and tracks newest finish", () => {
  const history = [
    failedRun("1.0.1", 1_000),
    failedRun("1.0.1", 3_000),
    failedRun("1.0.2", 9_000),
    doneRun("1.0.1", 5_000),
  ];
  const r = failedAttemptsForVersion(history, "1.0.1");
  assert.equal(r.count, 2);
  assert.equal(r.newestFinishedMs, 3_000);
});

test("backoffAllows true for a never-failed version", () => {
  assert.equal(backoffAllows([], "1.0.1", 10_000), true);
});

test("backoffAllows holds within the backoff window, releases after", () => {
  const history = [failedRun("1.0.1", 1_000)];
  assert.equal(backoffAllows(history, "1.0.1", 1_000 + RETRY_BACKOFF_MS - 1), false);
  assert.equal(backoffAllows(history, "1.0.1", 1_000 + RETRY_BACKOFF_MS), true);
});

test("backoffAllows parks a version after MAX_ATTEMPTS failures regardless of age", () => {
  const history = Array.from({ length: MAX_ATTEMPTS }, (_, i) => failedRun("1.0.1", 1_000 + i));
  assert.equal(
    backoffAllows(history, "1.0.1", 1_000 + RETRY_BACKOFF_MS * 100),
    false
  );
});

test("backoffAllows ignores failures for a different version", () => {
  const history = Array.from({ length: MAX_ATTEMPTS }, (_, i) => failedRun("1.0.1", 1_000 + i));
  assert.equal(backoffAllows(history, "1.0.2", 2_000), true);
});

test("recentlyDoneForVersion true inside the suppress window, false after", () => {
  const history = [doneRun("1.0.1", 1_000)];
  assert.equal(recentlyDoneForVersion(history, "1.0.1", 1_000 + DONE_SUPPRESS_MS - 1), true);
  assert.equal(recentlyDoneForVersion(history, "1.0.1", 1_000 + DONE_SUPPRESS_MS + 1), false);
});

// --- shouldApply / planApply -----------------------------------------------

test("shouldApply true for an available update with clean history", () => {
  const check = { status: "available", latestVersion: "1.0.1" };
  assert.equal(shouldApply({ check, currentVersion: "1.0.0", history: [], nowMs: 10_000 }), true);
});

test("shouldApply false when status is current", () => {
  const check = { status: "current", latestVersion: "1.0.0" };
  assert.equal(shouldApply({ check, currentVersion: "1.0.0", history: [], nowMs: 10_000 }), false);
});

test("shouldApply false when latest equals running version", () => {
  const check = { status: "available", latestVersion: "1.0.0" };
  assert.equal(shouldApply({ check, currentVersion: "1.0.0", history: [], nowMs: 10_000 }), false);
});

test("shouldApply false within the done-suppress window for the offered version", () => {
  const check = { status: "available", latestVersion: "1.0.1" };
  const history = [doneRun("1.0.1", 9_000)];
  assert.equal(shouldApply({ check, currentVersion: "1.0.0", history, nowMs: 10_000 }), false);
});

test("shouldApply true again after the done-suppress window lapses", () => {
  const check = { status: "available", latestVersion: "1.0.1" };
  const history = [doneRun("1.0.1", 100_000)];
  assert.equal(
    shouldApply({ check, currentVersion: "1.0.0", history, nowMs: 100_000 + DONE_SUPPRESS_MS + 1 }),
    true
  );
});

test("shouldApply false within the failure backoff window", () => {
  const check = { status: "available", latestVersion: "1.0.1" };
  const history = [failedRun("1.0.1", 1_000)];
  assert.equal(
    shouldApply({ check, currentVersion: "1.0.0", history, nowMs: 1_000 + RETRY_BACKOFF_MS - 1 }),
    false
  );
  assert.equal(
    shouldApply({ check, currentVersion: "1.0.0", history, nowMs: 1_000 + RETRY_BACKOFF_MS }),
    true
  );
});

test("planApply returns the version to apply when gated open", () => {
  const check = { status: "available", latestVersion: "1.0.1" };
  const plan = planApply({ check, currentVersion: "1.0.0", history: [], nowMs: 10_000 });
  assert.equal(plan.apply, true);
  assert.equal(plan.version, "1.0.1");
});

test("planApply returns reason=current when up to date", () => {
  const check = { status: "current", latestVersion: "1.0.0" };
  const plan = planApply({ check, currentVersion: "1.0.0", history: [], nowMs: 10_000 });
  assert.equal(plan.apply, false);
  assert.equal(plan.reason, "current");
});

test("planApply returns reason=gated when backoff holds", () => {
  const check = { status: "available", latestVersion: "1.0.1" };
  const history = [failedRun("1.0.1", 1_000)];
  const plan = planApply({ check, currentVersion: "1.0.0", history, nowMs: 1_000 + 1000 });
  assert.equal(plan.apply, false);
  assert.equal(plan.reason, "gated");
});

// --- install-dir gate ------------------------------------------------------

test("isGlobalInstall true when ownInstallDir matches the npm global lib path", () => {
  const prefix = "/Users/x/.local/share/fnm/node-versions/v25.9.0/installation";
  const own = globalInstallDir(PKG, prefix);
  assert.equal(isGlobalInstall(own, PKG, prefix), true);
});

test("isGlobalInstall false for a dev checkout outside the npm global lib", () => {
  const prefix = "/Users/x/.local/share/fnm/node-versions/v25.9.0/installation";
  assert.equal(isGlobalInstall("/Users/x/__devlocal/claude-agent-sdk-to-api", PKG, prefix), false);
});

test("isGlobalInstall false when npmPrefix cannot be resolved", () => {
  assert.equal(isGlobalInstall("/anywhere", PKG, null), false);
});

// --- state file ------------------------------------------------------------

test("readState self-heals an unparseable file to empty", () => {
  const dir = mkdtempSync(join(tmpdir(), "su-"));
  const path = join(dir, "update-state.json");
  writeFileSync(path, "{ not json");
  const s = readState(path);
  assert.deepEqual(s, emptyState());
  rmSync(dir, { recursive: true, force: true });
});

test("writeState is atomic and readState round-trips", () => {
  const dir = mkdtempSync(join(tmpdir(), "su-"));
  const path = join(dir, "update-state.json");
  const s = recordRun(emptyState(), { version: "1.0.1", phase: "done", nowMs: 5 });
  writeState(path, s);
  const back = readState(path);
  assert.equal(back.history_tail.length, 1);
  assert.equal(back.history_tail[0].version, "1.0.1");
  assert.equal(back.history_tail[0].phase, "done");
  rmSync(dir, { recursive: true, force: true });
});

test("recordRun keeps only the most recent HISTORY_KEEP entries", () => {
  let s = emptyState();
  for (let i = 0; i < 30; i++) s = recordRun(s, { version: `1.0.${i}`, phase: "failed", nowMs: i });
  assert.equal(s.history_tail.length, 20);
  assert.equal(s.history_tail[19].version, "1.0.29");
});

test("recordCheck stamps last_check with the latest version + status", () => {
  const s = recordCheck(emptyState(), { check: { status: "available", latestVersion: "1.0.1" }, nowMs: 42 });
  assert.equal(s.last_check.at_ms, 42);
  assert.equal(s.last_check.latest_version, "1.0.1");
  assert.equal(s.last_check.status, "available");
});

// --- kill switch -----------------------------------------------------------

test("killSwitchDisabled true when the sentinel exists", () => {
  const dir = mkdtempSync(join(tmpdir(), "su-"));
  writeFileSync(join(dir, "auto-update.disabled"), "");
  assert.equal(killSwitchDisabled(dir), true);
  rmSync(dir, { recursive: true, force: true });
});

test("killSwitchDisabled false when the sentinel is absent", () => {
  const dir = mkdtempSync(join(tmpdir(), "su-"));
  assert.equal(killSwitchDisabled(dir), false);
  rmSync(dir, { recursive: true, force: true });
});

// --- autoUpdateTick (full cycle, injected fetch + spawn) -------------------

function makeFakeSpawn(onceCode = 0) {
  const calls = [];
  const spawnFn = (cmd, args, opts) => {
    calls.push({ cmd, args });
    const fake = {
      _exited: false,
      kill() {},
      on(ev, cb) {
        if (ev === "exit") {
          this._exitCb = cb;
          // fire on next tick so await sees it
          process.nextTick(() => { this._exited = true; cb(onceCode, null); });
        }
        return this;
      },
    };
    return fake;
  };
  return { spawnFn, calls };
}

function makeStateDir() {
  const dir = mkdtempSync(join(tmpdir(), "su-"));
  mkdirSync(join(dir, "appsupport"), { recursive: true });
  return {
    dir,
    statePath: join(dir, "appsupport", "update-state.json"),
    appSupportDir: join(dir, "appsupport"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test("autoUpdateTick returns Disabled when the kill-switch sentinel exists", async () => {
  const s = makeStateDir();
  writeFileSync(join(s.appSupportDir, "auto-update.disabled"), "");
  let fetched = false;
  const r = await autoUpdateTick({
    pkgName: PKG, ownInstallDir: globalInstallDir(PKG, "/npm-prefix"),
    currentVersion: "0.1.1", statePath: s.statePath, appSupportDir: s.appSupportDir,
    npmPrefix: "/npm-prefix", fetchImpl: async () => { fetched = true; return { ok: true, json: async () => ({ version: "0.2.0" }) }; },
    shouldExit: false,
  });
  assert.equal(r.outcome, AutoUpdateOutcome.Disabled);
  assert.equal(fetched, false, "must not fetch when disabled");
  s.cleanup();
});

test("autoUpdateTick returns DevCheckout when running outside the npm global lib", async () => {
  const s = makeStateDir();
  let fetched = false;
  const r = await autoUpdateTick({
    pkgName: PKG, ownInstallDir: "/Users/x/__devlocal/claude-agent-sdk-to-api",
    currentVersion: "0.1.1", statePath: s.statePath, appSupportDir: s.appSupportDir,
    npmPrefix: "/npm-prefix", fetchImpl: async () => { fetched = true; return { ok: true, json: async () => ({ version: "0.2.0" }) }; },
    shouldExit: false,
  });
  assert.equal(r.outcome, AutoUpdateOutcome.DevCheckout);
  assert.equal(fetched, false, "dev checkout must not fetch");
  s.cleanup();
});

test("autoUpdateTick returns CheckFailed on a registry error and never caches it", async () => {
  const s = makeStateDir();
  const r = await autoUpdateTick({
    pkgName: PKG, ownInstallDir: globalInstallDir(PKG, "/npm-prefix"),
    currentVersion: "0.1.1", statePath: s.statePath, appSupportDir: s.appSupportDir,
    npmPrefix: "/npm-prefix", fetchImpl: async () => { throw new Error("registry down"); },
    shouldExit: false,
  });
  assert.equal(r.outcome, AutoUpdateOutcome.CheckFailed);
  // The failed check is persisted for status display but its status is not "current".
  const state = readState(s.statePath);
  assert.equal(state.last_check.status, "check_failed");
  s.cleanup();
});

test("autoUpdateTick returns Current when the registry version equals running", async () => {
  const s = makeStateDir();
  const r = await autoUpdateTick({
    pkgName: PKG, ownInstallDir: globalInstallDir(PKG, "/npm-prefix"),
    currentVersion: "0.1.1", statePath: s.statePath, appSupportDir: s.appSupportDir,
    npmPrefix: "/npm-prefix", fetchImpl: async () => ({ ok: true, json: async () => ({ version: "0.1.1" }) }),
    shouldExit: false,
  });
  assert.equal(r.outcome, AutoUpdateOutcome.Current);
  s.cleanup();
});

test("autoUpdateTick applies + records done when a newer version is found (spawn exit 0)", async () => {
  const s = makeStateDir();
  const { spawnFn, calls } = makeFakeSpawn(0);
  const r = await autoUpdateTick({
    pkgName: PKG, ownInstallDir: globalInstallDir(PKG, "/npm-prefix"),
    currentVersion: "0.1.1", statePath: s.statePath, appSupportDir: s.appSupportDir,
    npmPrefix: "/npm-prefix", fetchImpl: async () => ({ ok: true, json: async () => ({ version: "0.1.2" }) }),
    spawnFn, shouldExit: false,
  });
  assert.equal(r.outcome, AutoUpdateOutcome.Done);
  assert.equal(r.version, "0.1.2");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, ["install", "-g", `${PKG}@0.1.2`]);
  const state = readState(s.statePath);
  const last = state.history_tail[state.history_tail.length - 1];
  assert.equal(last.phase, "done");
  assert.equal(last.version, "0.1.2");
  s.cleanup();
});

test("autoUpdateTick records failed and does not exit when npm install exits non-zero", async () => {
  const s = makeStateDir();
  const { spawnFn } = makeFakeSpawn(1);
  const r = await autoUpdateTick({
    pkgName: PKG, ownInstallDir: globalInstallDir(PKG, "/npm-prefix"),
    currentVersion: "0.1.1", statePath: s.statePath, appSupportDir: s.appSupportDir,
    npmPrefix: "/npm-prefix", fetchImpl: async () => ({ ok: true, json: async () => ({ version: "0.1.2" }) }),
    spawnFn, shouldExit: false,
  });
  assert.equal(r.outcome, AutoUpdateOutcome.Failed);
  const state = readState(s.statePath);
  const last = state.history_tail[state.history_tail.length - 1];
  assert.equal(last.phase, "failed");
  s.cleanup();
});

test("autoUpdateTick holds (Gated) when the offered version is in backoff", async () => {
  const s = makeStateDir();
  // Seed a fresh failure for 0.1.2 inside the backoff window.
  let state = recordRun(emptyState(), { version: "0.1.2", phase: "failed", nowMs: 1_000 });
  writeState(s.statePath, state);
  const { spawnFn, calls } = makeFakeSpawn(0);
  const r = await autoUpdateTick({
    pkgName: PKG, ownInstallDir: globalInstallDir(PKG, "/npm-prefix"),
    currentVersion: "0.1.1", statePath: s.statePath, appSupportDir: s.appSupportDir,
    npmPrefix: "/npm-prefix", fetchImpl: async () => ({ ok: true, json: async () => ({ version: "0.1.2" }) }),
    spawnFn, shouldExit: false, nowMs: 1_000 + 1000,
  });
  assert.equal(r.outcome, AutoUpdateOutcome.Gated);
  assert.equal(calls.length, 0, "must not spawn npm install while in backoff");
  s.cleanup();
});

// ---------------------------------------------------------------------------
// scheduleExitWhenIdle — drain-aware relaunch
// ---------------------------------------------------------------------------

test("scheduleExitWhenIdle exits immediately when idle", () => {
  _resetDrainGuardForTests();
  const exits = [];
  const timers = [];
  scheduleExitWhenIdle({
    isBusy: () => false,
    exitFn: (c) => exits.push(c),
    setTimeoutFn: (fn) => { timers.push(fn); return { unref() {} }; },
  });
  assert.equal(exits.length, 0, "exit rides a flush timeout, not synchronous");
  assert.equal(timers.length, 1);
  timers[0]();
  assert.deepEqual(exits, [0]);
});

test("scheduleExitWhenIdle drains: waits while busy, exits once idle", () => {
  _resetDrainGuardForTests();
  const exits = [];
  const timers = [];
  let busy = true;
  scheduleExitWhenIdle({
    isBusy: () => busy,
    recheckMs: 10,
    exitFn: (c) => exits.push(c),
    setTimeoutFn: (fn) => { timers.push(fn); return { unref() {} }; },
  });
  // Busy: one recheck timer scheduled, no exit.
  assert.equal(exits.length, 0);
  assert.equal(timers.length, 1);
  timers[0](); // still busy -> another recheck
  assert.equal(exits.length, 0);
  assert.equal(timers.length, 2);
  busy = false;
  timers[1](); // idle now -> schedules the flush-exit timeout
  assert.equal(timers.length, 3);
  timers[2]();
  assert.deepEqual(exits, [0]);
});

test("scheduleExitWhenIdle forces exit at the hard deadline even if busy", () => {
  _resetDrainGuardForTests();
  const exits = [];
  const timers = [];
  let now = 0;
  scheduleExitWhenIdle({
    isBusy: () => true,
    recheckMs: 10,
    hardDeadlineMs: 100,
    nowFn: () => now,
    exitFn: (c) => exits.push(c),
    setTimeoutFn: (fn) => { timers.push(fn); return { unref() {} }; },
  });
  assert.equal(exits.length, 0);
  now = 101; // past deadline
  timers[0](); // recheck fires -> deadline reached -> flush-exit timeout
  timers[1]();
  assert.deepEqual(exits, [0]);
});

test("scheduleExitWhenIdle is single-flight", () => {
  _resetDrainGuardForTests();
  const first = scheduleExitWhenIdle({
    isBusy: () => true,
    setTimeoutFn: () => ({ unref() {} }),
  });
  const second = scheduleExitWhenIdle({
    isBusy: () => true,
    setTimeoutFn: () => ({ unref() {} }),
  });
  assert.equal(first, true);
  assert.equal(second, false);
  _resetDrainGuardForTests();
});
