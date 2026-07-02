// Always-on post-mortem trail of code-mode activity: script starts, synthetic
// tool_use dispatches, resolved tool_results, and run completions. In-memory
// ring served by GET /debug/recent, mirrored to <profileDir>/debug-ring.jsonl
// (size-rotated, one .1 generation kept) so a crash or relaunch does not erase
// the evidence. Heads are byte-capped: this is a forensic index of what ran,
// not a transcript (cache-log stays the opt-in accounting log).

import { appendFileSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";

const MAX_ENTRIES = Math.max(1, Number(process.env.DEBUG_RING_ENTRIES || 500));
const HEAD_BYTES = Math.max(64, Number(process.env.DEBUG_RING_HEAD_BYTES || 2048));
const FILE_MAX_BYTES = Math.max(64 * 1024, Number(process.env.DEBUG_RING_FILE_MAX_BYTES || 5 * 1024 * 1024));

let ring = [];
let filePath = null;
let fileBytes = 0;
let maxFileBytes = FILE_MAX_BYTES;

export function initDebugRing(profileDir, { maxFileBytes: maxBytes = FILE_MAX_BYTES } = {}) {
  filePath = profileDir ? join(profileDir, "debug-ring.jsonl") : null;
  fileBytes = 0;
  maxFileBytes = maxBytes;
  if (filePath) {
    try { fileBytes = statSync(filePath).size; } catch { fileBytes = 0; }
  }
}

function capHead(value) {
  const str = typeof value === "string" ? value : value == null ? "" : String(value);
  const bytes = Buffer.byteLength(str, "utf8");
  if (bytes <= HEAD_BYTES) return { head: str, bytes };
  return { head: `${str.slice(0, HEAD_BYTES)}…[+${bytes - HEAD_BYTES} bytes]`, bytes };
}

/**
 * Record one entry: { kind, bucket?, tool?, id?, head, isError?, truncated? }.
 * `bytes` is the UNCAPPED head size so truncation is measurable after the fact.
 * Never throws — forensics must not break serving.
 */
export function recordDebug(entry) {
  const { head, bytes } = capHead(entry.head);
  const e = { ts: new Date().toISOString(), ...entry, head, bytes };
  ring.push(e);
  if (ring.length > MAX_ENTRIES) ring.splice(0, ring.length - MAX_ENTRIES);
  if (!filePath) return e;
  try {
    const line = JSON.stringify(e) + "\n";
    if (fileBytes + line.length > maxFileBytes) {
      renameSync(filePath, `${filePath}.1`);
      fileBytes = 0;
    }
    appendFileSync(filePath, line);
    fileBytes += line.length;
  } catch { /* never break serving for forensics */ }
  return e;
}

export function recentDebug(n = 100) {
  const count = Math.max(1, Math.min(Number(n) || 100, MAX_ENTRIES));
  return ring.slice(-count);
}

export function debugRingPath() {
  return filePath;
}

export function _resetDebugRingForTests() {
  ring = [];
  filePath = null;
  fileBytes = 0;
  maxFileBytes = FILE_MAX_BYTES;
}
