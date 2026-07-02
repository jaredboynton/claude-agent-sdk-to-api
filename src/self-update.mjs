// Daemon auto-update poller.
//
// Keeps the npm-installed bridge current with no operator click: every poll
// cycle it asks the npm registry for `latest`, semver-compares against the
// running version, and when a newer version is found it spawns a detached
// `npm install -g <pkg>@<latest>` and exits 0 so launchd `KeepAlive` relaunches
// the daemon on the freshly-swapped files (an npm -g install replaces the lib
// dir atomically; the plist's pinned cli.mjs path is stable across versions).
//
// Modeled on the cse-tools `cse-toold` auto-update poller
// (crates/cse-toold/src/self_update/auto_update.rs), simplified for an npm
// Node package: the signed-binary staging + LaunchAgent swap + rollback
// collapse to `npm install -g` + process.exit(0).
//
// Safety rails (ported):
//   - Dev-checkout gate: only runs when the daemon's own install dir is the
//     npm global lib path. A checkout run from ~/__devlocal/... is skipped
//     (analog of cse-tools' 0.0.0-dev baseline gate).
//   - Kill switch: a sentinel file parks the poller with no registry fetch.
//   - Per-version failure backoff (10 min, max 5 attempts).
//   - Done-suppress window (10 min) so the poller does not re-fire for a
//     version a worker just landed before the new code's version stamp shows.
//   - Single-instance guard so re-entrant starts cannot stack intervals.
//   - check_failed is never cached: a registry error retries next tick.

import { spawn } from "node:child_process";
import { execSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve as resolvePath } from "node:path";
import semver from "semver";

// --- tunables (mirror cse-tools constants) ---------------------------------

export const POLL_INTERVAL_MS = 60_000; // base cadence; +0..20s jitter per tick
export const JITTER_MS = 20_000;
export const RETRY_BACKOFF_MS = 10 * 60 * 1000; // min wait after a failed attempt
export const MAX_ATTEMPTS = 5; // hard cap before a version is parked
export const DONE_SUPPRESS_MS = 10 * 60 * 1000; // no re-offer right after a success
export const INSTALL_TIMEOUT_MS = 120_000; // npm install -g watchdog
export const DRAIN_RECHECK_MS = 15_000; // post-install idle poll while sessions are busy
export const DRAIN_HARD_DEADLINE_MS = 30 * 60 * 1000; // force relaunch after this even if busy
export const REGISTRY = "https://registry.npmjs.org";
export const DISABLE_SENTINEL = "auto-update.disabled";
export const STATE_SCHEMA_VERSION = 1;
export const HISTORY_KEEP = 20;

const LOG_PREFIX = "[claude-agent-api]";

// --- paths -----------------------------------------------------------------

export function defaultAppSupportDir(home = homedir()) {
  return join(home, "Library", "Application Support", "claude-agent-api");
}
export function defaultStatePath(home = homedir()) {
  return join(defaultAppSupportDir(home), "update-state.json");
}
export function defaultKillSwitchPath(home = homedir()) {
  return join(defaultAppSupportDir(home), DISABLE_SENTINEL);
}

// The npm global lib path this package is installed under when `npm install -g`
// placed it: <prefix>/lib/node_modules/<pkgName>. `prefix` is `npm prefix -g`.
export function globalInstallDir(pkgName, npmPrefix) {
  return resolvePath(join(npmPrefix, "lib", "node_modules", pkgName));
}

// True when the running process lives under the npm global install (so
// self-update is safe). A dev checkout (~/__devlocal/...) returns false.
export function isGlobalInstall(ownInstallDir, pkgName, npmPrefix) {
  if (!ownInstallDir || !npmPrefix) return false;
  return resolvePath(ownInstallDir) === globalInstallDir(pkgName, npmPrefix);
}

// Resolve the npm CLI shim that ships next to the running node binary
// (fnm places `npm` in the same bin dir as `node`). No PATH reliance.
export function npmBinFromExecPath(execPath = process.execPath) {
  return join(dirname(execPath), "npm");
}

// `npm prefix -g`, cached. Returns null if it cannot be resolved (tests inject).
let _npmPrefixCache = null;
export function resolveNpmPrefix({ execPath = process.execPath } = {}) {
  if (_npmPrefixCache != null) return _npmPrefixCache;
  try {
    const npm = npmBinFromExecPath(execPath);
    const out = execSync(`"${npm}" prefix -g`, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    _npmPrefixCache = out;
    return out;
  } catch {
    return null;
  }
}

// --- registry check --------------------------------------------------------

export function npmLatestUrl(pkgName, registry = REGISTRY) {
  return `${registry}/${pkgName}/latest`;
}

// Fetch the latest version from the registry. `fetchImpl` is injectable so
// tests never hit the network.
export async function checkForUpdate({ pkgName, currentVersion, fetchImpl, registry = REGISTRY }) {
  const fetchFn = fetchImpl || (typeof fetch === "function" ? fetch.bind(globalThis) : null);
  if (!fetchFn) return { status: "check_failed", detail: "no fetch implementation" };
  let res;
  try {
    res = await fetchFn(npmLatestUrl(pkgName, registry), {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(8000),
    });
  } catch (e) {
    return { status: "check_failed", detail: String(e?.message || e) };
  }
  if (!res.ok) return { status: "check_failed", detail: `registry ${res.status}` };
  let j;
  try {
    j = await res.json();
  } catch (e) {
    return { status: "check_failed", detail: `bad json: ${e?.message || e}` };
  }
  const latest = j?.version;
  if (!latest || !semver.valid(latest)) {
    return { status: "check_failed", detail: "no version in registry response" };
  }
  if (semver.gt(latest, currentVersion)) {
    return { status: "available", latestVersion: latest };
  }
  return { status: "current", latestVersion: latest };
}

// --- failure / suppress accounting (pure) ----------------------------------

// { count, newestFinishedMs } for terminal `failed` runs targeting `version`.
export function failedAttemptsForVersion(history, version) {
  let count = 0;
  let newestFinished = null;
  for (const run of history) {
    if (run.phase === "failed" && run.version === version) {
      count++;
      const finished = run.finishedAtMs ?? run.startedAtMs ?? 0;
      newestFinished = newestFinished == null ? finished : Math.max(newestFinished, finished);
    }
  }
  return { count, newestFinishedMs: newestFinished };
}

export function backoffAllows(history, version, nowMs) {
  const { count, newestFinishedMs } = failedAttemptsForVersion(history, version);
  if (count >= MAX_ATTEMPTS) return false;
  if (newestFinishedMs == null) return true;
  return nowMs - newestFinishedMs >= RETRY_BACKOFF_MS;
}

export function recentlyDoneForVersion(history, version, nowMs) {
  return history.some(
    (r) =>
      r.phase === "done" &&
      r.version === version &&
      nowMs - (r.finishedAtMs ?? r.startedAtMs ?? 0) < DONE_SUPPRESS_MS
  );
}

// Whether the poller should auto-apply now: an available update that is not the
// running version, not freshly done, and backoff-clear.
export function shouldApply({ check, currentVersion, history, nowMs }) {
  if (check.status !== "available") return false;
  const latest = check.latestVersion;
  if (!latest || latest === currentVersion) return false;
  if (recentlyDoneForVersion(history, latest, nowMs)) return false;
  return backoffAllows(history, latest, nowMs);
}

// Pure planner: returns the version to apply, or null with a reason.
export function planApply({ check, currentVersion, history, nowMs }) {
  if (check.status === "check_failed") return { apply: false, reason: "check_failed", detail: check.detail };
  if (check.status === "current") return { apply: false, reason: "current", latestVersion: check.latestVersion };
  if (!shouldApply({ check, currentVersion, history, nowMs })) {
    return { apply: false, reason: "gated", latestVersion: check.latestVersion };
  }
  return { apply: true, version: check.latestVersion };
}

// --- state file ------------------------------------------------------------

export function emptyState() {
  return { schema_version: STATE_SCHEMA_VERSION, last_check: null, history_tail: [] };
}

// Self-healing: a torn write / unparseable file is treated as empty.
export function readState(statePath) {
  try {
    const j = JSON.parse(readFileSync(statePath, "utf8"));
    if (j && typeof j === "object") {
      return {
        schema_version: STATE_SCHEMA_VERSION,
        last_check: j.last_check ?? null,
        history_tail: Array.isArray(j.history_tail) ? j.history_tail.slice(-HISTORY_KEEP) : [],
      };
    }
  } catch {
    /* fall through to empty */
  }
  return emptyState();
}

// Atomic write: temp file (pid+counter-suffixed so concurrent writers never
// share a temp) + rename, 0600.
let _writeCounter = 0;
export function writeState(statePath, state) {
  const dir = dirname(statePath);
  mkdirSync(dir, { recursive: true });
  _writeCounter++;
  const tmp = join(dir, `.update-state.${process.pid}.${_writeCounter}.${randomUUID()}.tmp`);
  writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  try {
    renameSync(tmp, statePath);
  } catch (e) {
    try { unlinkSync(tmp); } catch {}
    throw e;
  }
}

// Record a terminal run in a state copy and return the new state.
export function recordRun(state, { version, phase, nowMs, message = null }) {
  const run = { version, phase, startedAtMs: nowMs, finishedAtMs: nowMs };
  if (message) run.message = message;
  const history_tail = [...(state.history_tail ?? []), run].slice(-HISTORY_KEEP);
  return { ...state, history_tail };
}

export function recordCheck(state, { check, nowMs }) {
  return {
    ...state,
    last_check: {
      at_ms: nowMs,
      latest_version: check.latestVersion ?? null,
      status: check.status,
    },
  };
}

// --- kill switch -----------------------------------------------------------

export function killSwitchDisabled(appSupportDir = defaultAppSupportDir()) {
  return existsSync(join(appSupportDir, DISABLE_SENTINEL));
}

// --- apply: detached npm install -g ---------------------------------------

// Spawn `npm install -g <pkg>@<version>`, await exit. Returns "done" | "failed".
// `npmBin` defaults to the shim next to the running node. The child is detached
// with ignored stdio so it survives a parent exit, but we await its exit event
// to know success/failure before deciding to exit the daemon.
export function applyUpdate({ pkgName, version, npmBin = npmBinFromExecPath(), cwd = homedir(), timeoutMs = INSTALL_TIMEOUT_MS, spawnFn = spawn }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnNpm(spawnFn, npmBin, ["install", "-g", `${pkgName}@${version}`], cwd);
    } catch (e) {
      resolve({ outcome: "failed", detail: String(e?.message || e) });
      return;
    }
    let settled = false;
    const finish = (outcome, detail = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ outcome, detail });
    };
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
      finish("failed", `npm install timed out after ${timeoutMs}ms`);
    }, timeoutMs);
    child.on("error", (e) => finish("failed", String(e?.message || e)));
    child.on("exit", (code, signal) => {
      if (code === 0) finish("done");
      else finish("failed", `npm install exited code=${code} signal=${signal ?? "none"}`);
    });
  });
}

function spawnNpm(spawnFn, npmBin, args, cwd) {
  return spawnFn(npmBin, args, {
    cwd,
    stdio: "ignore",
    detached: true,
    env: { ...process.env },
  });
}

// --- status surface ----------------------------------------------------------

// Operator-visible snapshot of the updater, surfaced as `update` in /healthz
// and refreshed by every tick — waiting on a release is never blind polling.
const _updateStatus = {
  currentVersion: null,
  lastCheckAt: null,
  lastOutcome: null,
  lastDetail: null,
  latestSeen: null,
  nextCheckAt: null,
  installing: false,
  draining: null, // { version, since, hardDeadlineAt } while a relaunch waits on live work
  pollActive: false,
};

let _manualUpdateOpts = null;
let _manualInFlight = null;

/** Register config for manual POST /update ticks (works with polling off). */
export function registerManualUpdate(opts = {}) {
  _manualUpdateOpts = {
    pkgName: opts.pkgName,
    ownInstallDir: opts.ownInstallDir,
    currentVersion: opts.currentVersion,
    statePath: opts.statePath,
    appSupportDir: opts.appSupportDir ?? (opts.statePath ? dirname(opts.statePath) : defaultAppSupportDir()),
    npmPrefix: opts.npmPrefix,
    fetchImpl: opts.fetchImpl,
    spawnFn: opts.spawnFn,
    isBusy: opts.isBusy,
  };
  _updateStatus.currentVersion = opts.currentVersion ?? null;
}

export function getUpdateStatus() {
  return {
    ..._updateStatus,
    draining: _updateStatus.draining ? { ..._updateStatus.draining } : null,
    manualCheckAvailable: _runTickNow != null || _manualUpdateOpts != null,
  };
}

// Set by startAutoUpdateLoop; lets POST /update/check run a tick immediately.
let _runTickNow = null;

/**
 * Run one update tick now instead of waiting for the poll. Single-flight: a
 * trigger while a tick is in flight joins it. Uses the background loop when
 * active; otherwise runs a one-off tick from registerManualUpdate() config.
 */
export function triggerUpdateCheck() {
  // Manual ticks bypass the auto-update kill switch (it parks polling only).
  if (_runTickNow) return _runTickNow({ ignoreKillSwitch: true });
  if (!_manualUpdateOpts) return Promise.resolve({ outcome: "not_configured" });
  if (_manualInFlight) return _manualInFlight;
  _manualInFlight = (async () => {
    try {
      const r = await autoUpdateTick({ ..._manualUpdateOpts, shouldExit: true, ignoreKillSwitch: true });
      _updateStatus.lastOutcome = r?.outcome ?? null;
      _updateStatus.lastDetail = r?.detail ?? r?.reason ?? null;
      if (r?.latestVersion) _updateStatus.latestSeen = r.latestVersion;
      return r;
    } finally {
      _manualInFlight = null;
    }
  })();
  return _manualInFlight;
}

// --- drain-aware relaunch ---------------------------------------------------

// After a successful install, do NOT kill live turns: the daemon relaunches
// only once `isBusy()` reports idle (no attached HTTP turn, no executing code
// run), rechecked on a short poll, with a hard deadline so a wedged/marathon
// session cannot pin the daemon on stale code forever. Injectable exit/now for
// tests. Single-flight: a second successful install while a drain is already
// scheduled does not stack exits.
let _drainScheduled = false;
export function scheduleExitWhenIdle({
  isBusy = null,
  recheckMs = DRAIN_RECHECK_MS,
  hardDeadlineMs = DRAIN_HARD_DEADLINE_MS,
  exitFn = (code) => process.exit(code),
  nowFn = Date.now,
  setTimeoutFn = setTimeout,
  version = null,
} = {}) {
  if (_drainScheduled) return false;
  _drainScheduled = true;
  const startedMs = nowFn();
  _updateStatus.draining = { version, since: startedMs, hardDeadlineAt: startedMs + hardDeadlineMs };
  let loggedBusy = false;
  const attempt = () => {
    let busy = false;
    try { busy = !!isBusy?.(); } catch { busy = false; }
    if (busy && nowFn() - startedMs < hardDeadlineMs) {
      if (!loggedBusy) {
        log(`auto-update: installed but sessions have work in flight; draining before relaunch (recheck ${recheckMs}ms, deadline ${hardDeadlineMs}ms)`);
        loggedBusy = true;
      }
      const t = setTimeoutFn(attempt, recheckMs);
      t?.unref?.();
      return;
    }
    if (busy) log(`auto-update: drain deadline reached with work still in flight; exiting for launchd relaunch anyway`);
    else log(`auto-update: exiting for launchd relaunch`);
    _updateStatus.draining = null;
    // Give the log line a beat to flush, then let launchd KeepAlive restart us.
    const t = setTimeoutFn(() => exitFn(0), 250);
    t?.unref?.();
  };
  attempt();
  return true;
}

export function _resetDrainGuardForTests() {
  _drainScheduled = false;
  _updateStatus.draining = null;
}

// --- one tick --------------------------------------------------------------

export const AutoUpdateOutcome = Object.freeze({
  Disabled: "disabled",
  DevCheckout: "dev_checkout",
  CheckFailed: "check_failed",
  Current: "current",
  Gated: "gated",
  Started: "started",
  Done: "done",
  Failed: "failed",
});

// One poll cycle. Pure-ish: takes injectable fetchImpl, spawnFn, and a
// `shouldExit` callback (so tests can assert the decision without process.exit).
// Returns the outcome. Mutates the state file (read/record/write).
export async function autoUpdateTick({
  pkgName,
  ownInstallDir,
  currentVersion,
  statePath,
  appSupportDir = dirname(statePath),
  npmPrefix = resolveNpmPrefix(),
  fetchImpl,
  spawnFn = spawn,
  nowMs = Date.now(),
  shouldExit = true,
  isBusy = null,
  drainRecheckMs = DRAIN_RECHECK_MS,
  drainHardDeadlineMs = DRAIN_HARD_DEADLINE_MS,
  exitFn = (code) => process.exit(code),
  ignoreKillSwitch = false,
}) {
  // The kill switch parks BACKGROUND polling only. A manual POST /update is an
  // explicit operator action and must keep working while polling is disabled —
  // that is the whole point of the manual endpoint during development.
  if (!ignoreKillSwitch && killSwitchDisabled(appSupportDir)) return { outcome: AutoUpdateOutcome.Disabled };

  if (!isGlobalInstall(ownInstallDir, pkgName, npmPrefix)) {
    return { outcome: AutoUpdateOutcome.DevCheckout };
  }

  const check = await checkForUpdate({ pkgName, currentVersion, fetchImpl });
  _updateStatus.lastCheckAt = nowMs;
  if (check.latestVersion) _updateStatus.latestSeen = check.latestVersion;
  let state = readState(statePath);
  state = recordCheck(state, { check, nowMs });
  writeState(statePath, state);

  if (check.status === "check_failed") {
    return { outcome: AutoUpdateOutcome.CheckFailed, detail: check.detail };
  }

  const plan = planApply({ check, currentVersion, history: state.history_tail, nowMs });
  if (!plan.apply) {
    if (plan.reason === "current") return { outcome: AutoUpdateOutcome.Current, latestVersion: plan.latestVersion };
    return { outcome: AutoUpdateOutcome.Gated, latestVersion: plan.latestVersion, reason: plan.reason };
  }

  log(`auto-update: installing ${pkgName}@${plan.version} (from ${currentVersion})`);
  _updateStatus.installing = true;
  let result;
  try {
    result = await applyUpdate({ pkgName, version: plan.version, spawnFn });
  } finally {
    _updateStatus.installing = false;
  }
  state = readState(statePath);
  state = recordRun(state, {
    version: plan.version,
    phase: result.outcome === "done" ? "done" : "failed",
    nowMs: Date.now(),
    message: result.detail,
  });
  writeState(statePath, state);

  if (result.outcome === "done") {
    log(`auto-update: installed ${plan.version}`);
    if (shouldExit) {
      // Drain-aware relaunch: never exit under a live turn / code run.
      scheduleExitWhenIdle({ isBusy, recheckMs: drainRecheckMs, hardDeadlineMs: drainHardDeadlineMs, exitFn, version: plan.version });
    }
    return { outcome: AutoUpdateOutcome.Done, version: plan.version };
  }
  log(`auto-update: install failed: ${result.detail}`);
  return { outcome: AutoUpdateOutcome.Failed, version: plan.version, detail: result.detail };
}

// --- the loop --------------------------------------------------------------

let _loopRunning = false;
let _devCheckoutLogged = false;

export function startAutoUpdateLoop({
  pkgName,
  ownInstallDir,
  currentVersion,
  statePath = defaultStatePath(),
  appSupportDir = dirname(statePath),
  npmPrefix = resolveNpmPrefix(),
  fetchImpl,
  spawnFn = spawn,
  pollIntervalMs = POLL_INTERVAL_MS,
  jitterMs = JITTER_MS,
  isBusy = null,
} = {}) {
  if (_loopRunning) return;
  _loopRunning = true;
  _updateStatus.pollActive = true;
  _updateStatus.currentVersion = currentVersion;
  if (!_manualUpdateOpts) registerManualUpdate({ pkgName, ownInstallDir, currentVersion, statePath, appSupportDir, npmPrefix, fetchImpl, spawnFn, isBusy });

  let timer = null;
  let inFlight = null;

  const scheduleNext = () => {
    const jitter = Math.floor(Math.random() * (jitterMs + 1));
    const delay = pollIntervalMs + jitter;
    _updateStatus.nextCheckAt = Date.now() + delay;
    timer = setTimeout(runTick, delay);
    timer.unref?.();
  };

  // Single-flight tick shared by the poll timer and triggerUpdateCheck(): a
  // manual trigger while a tick is in flight joins it instead of stacking.
  // `extra` carries manual-trigger overrides (ignoreKillSwitch); the timer
  // invokes with no args, so scheduled polls never inherit the bypass.
  const runTick = (extra) => {
    if (inFlight) return inFlight;
    if (timer) { clearTimeout(timer); timer = null; }
    inFlight = (async () => {
      let r;
      try {
        r = await autoUpdateTick({
          pkgName,
          ownInstallDir,
          currentVersion,
          statePath,
          appSupportDir,
          npmPrefix,
          fetchImpl,
          spawnFn,
          isBusy,
          ...(extra && typeof extra === "object" ? extra : {}),
        });
        switch (r.outcome) {
          case AutoUpdateOutcome.Disabled:
            break; // quiet
          case AutoUpdateOutcome.DevCheckout:
            if (!_devCheckoutLogged) {
              log(`auto-update: dev checkout (${ownInstallDir}); skipping self-update`);
              _devCheckoutLogged = true;
            }
            break;
          case AutoUpdateOutcome.CheckFailed:
            log(`auto-update: check failed (${r.detail}); retrying next tick`);
            break;
          case AutoUpdateOutcome.Current:
            break; // quiet
          case AutoUpdateOutcome.Gated:
            break; // quiet (backoff / done-suppress)
          case AutoUpdateOutcome.Done:
          case AutoUpdateOutcome.Failed:
          case AutoUpdateOutcome.Started:
            break; // already logged inside the tick
        }
      } catch (e) {
        log(`auto-update: tick error: ${e?.stack || e}`);
        r = { outcome: "tick_error", detail: String(e?.message || e) };
      }
      _updateStatus.lastOutcome = r?.outcome ?? null;
      _updateStatus.lastDetail = r?.detail ?? r?.reason ?? null;
      if (r?.latestVersion) _updateStatus.latestSeen = r.latestVersion;
      inFlight = null;
      scheduleNext();
      return r;
    })();
    return inFlight;
  };
  _runTickNow = runTick;

  // Fire one soon after boot (5s) so a fresh launch picks up a pending release
  // promptly, then settle into the cadence.
  _updateStatus.nextCheckAt = Date.now() + 5000;
  timer = setTimeout(runTick, 5000);
  timer.unref?.();
}

export function _resetLoopGuardForTests() {
  _loopRunning = false;
  _devCheckoutLogged = false;
  _runTickNow = null;
  _manualUpdateOpts = null;
  _manualInFlight = null;
  Object.assign(_updateStatus, {
    currentVersion: null,
    lastCheckAt: null,
    lastOutcome: null,
    lastDetail: null,
    latestSeen: null,
    nextCheckAt: null,
    installing: false,
    draining: null,
    pollActive: false,
  });
}

function log(msg) {
  process.stderr.write(`${LOG_PREFIX} ${msg}\n`);
}
