// Per-turn cache-usage log: append one JSON line per completed HTTP turn with the
// turn's cache_read / cache_creation (and input/output) token counts, so the
// code-mode savings model can be replaced with measured per-conversation receipts
// (group by `conv`, price with the Opus card; see docs/code-mode-cache-savings.md).
//
// Opt-in. Disabled unless startServer({ cacheLog }) / --cache-log / CACHE_LOG is set.
// One row per turn is low volume, but we keep an append stream open to avoid
// re-opening the fd each turn and to preserve write ordering. Failures never throw
// into the request path — a telemetry sink must not take down the bridge.

import fs from "node:fs";
import { dirname, join, isAbsolute } from "node:path";
import { homedir } from "node:os";

const LOG_PREFIX = "[claude-agent-api]";

let state = { enabled: false, path: null, stream: null };

function expandHome(p) {
  if (!p) return p;
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

/**
 * Resolve the cache-log destination from the `cacheLog` option.
 *   falsy/"0"/"false" -> disabled
 *   true/"1"/"true"   -> <profileDir>/cache-log.jsonl (per-account, no collision)
 *   <string path>     -> that path (~ expanded, relative resolved vs cwd)
 */
export function resolveCacheLogPath(cacheLog, profileDir) {
  if (cacheLog == null || cacheLog === false || cacheLog === "0" || cacheLog === "false") return null;
  if (cacheLog === true || cacheLog === "1" || cacheLog === "true") {
    const base = profileDir || process.cwd();
    return join(base, "cache-log.jsonl");
  }
  const p = expandHome(String(cacheLog));
  return isAbsolute(p) ? p : join(process.cwd(), p);
}

/** Initialize (or reconfigure) the cache log. Safe to call once at startup. */
export function initCacheLog(cacheLog, profileDir) {
  const path = resolveCacheLogPath(cacheLog, profileDir);
  if (state.stream) { try { state.stream.end(); } catch {} }
  state = { enabled: !!path, path, stream: null };
  if (!path) return null;
  try {
    fs.mkdirSync(dirname(path), { recursive: true });
    state.stream = fs.createWriteStream(path, { flags: "a" });
    state.stream.on("error", (e) => {
      process.stderr.write(`${LOG_PREFIX} cache-log write error: ${e?.message || e}\n`);
      state.enabled = false;
    });
    process.stderr.write(`${LOG_PREFIX} cache-log enabled: ${path}\n`);
  } catch (e) {
    process.stderr.write(`${LOG_PREFIX} cache-log init failed (${e?.message || e}); disabled\n`);
    state.enabled = false;
  }
  return path;
}

export function cacheLogEnabled() {
  return state.enabled && !!state.stream;
}

export function cacheLogPath() {
  return state.path;
}

/** Append one turn row. No-op when disabled. Never throws. */
export function appendCacheLog(row) {
  if (!cacheLogEnabled()) return;
  try {
    state.stream.write(JSON.stringify(row) + "\n");
  } catch (e) {
    process.stderr.write(`${LOG_PREFIX} cache-log append failed: ${e?.message || e}\n`);
  }
}

export function flushCacheLogForTest() {
  if (!cacheLogEnabled()) return Promise.resolve();
  return new Promise((resolve) => {
    try {
      state.stream.write("", resolve);
    } catch {
      resolve();
    }
  });
}

/** Extract the 5m / 1h cache-creation split from a raw Anthropic usage object. */
export function cacheCreationSplit(rawUsage) {
  const cc = rawUsage?.cache_creation;
  if (cc && typeof cc === "object") {
    return {
      create5m: cc.ephemeral_5m_input_tokens || 0,
      create1h: cc.ephemeral_1h_input_tokens || 0,
    };
  }
  return { create5m: rawUsage?.cache_creation_input_tokens || 0, create1h: 0 };
}

// Test seam: reset module state between tests.
export function _resetCacheLogForTest() {
  if (state.stream) { try { state.stream.end(); } catch {} }
  state = { enabled: false, path: null, stream: null };
}
