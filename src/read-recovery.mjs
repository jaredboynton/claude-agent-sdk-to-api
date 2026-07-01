// Read/Edit failure recovery planning: pure helpers the server uses to absorb
// client-side tool failures without waking the model.
//
// Forensic background (2026-07-01 session): Claude Code's Edit tool refuses to
// write when its per-file read state is stale ("File has been modified since
// read... Read it again"), and its Read tool refuses whole-file reads over
// 25,000 tokens. For a large file those two guards form a closed loop the model
// escapes only by discovering windowed (offset/limit) Reads by trial and error
// — ~9 wasted model round-trips. The daemon runs on the same machine as the
// files, so it can classify these failures, verify the intended edit against
// the real disk bytes, and plan the windowed Reads that recover — all at zero
// model cost.
//
// This module is PURE planning/classification (fs reads only, no session or
// dispatch coupling), mirroring anchor-edit.mjs: the server owns the seams.

import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

// Claude Code's Read caps: 2000 lines per call by default, 25k tokens per
// result, lines truncated at 2000 chars. Chunks stay comfortably inside both
// caps so a planned chunk can never itself trip the token guard.
export const CHUNK_MAX_LINES = 1800;
export const CHUNK_BYTE_TARGET = 60_000; // ~15k tokens at ~4 bytes/token
export const LINE_BYTE_CAP = 2000;       // client truncates longer lines
export const MAX_READ_CHUNKS = 24;       // ~1.4MB ceiling; beyond that, advise Grep/windows

export const EDIT_RECOVERY_MAX_ROUNDS = 2;
export const NOTE_RECOVERED = "[note: proxy auto-refreshed stale read state and retried this edit]";
export const NOTE_DRIFT = "[note: the file also changed elsewhere since your Read; re-Read if you need current content]";
export const NOTE_FRESHNESS_HINT = "[proxy note: a short windowed Read (offset/limit) of this file refreshes the client's read state; whole-file Reads of large files exceed its token cap]";

export function editRecoveryDisabled(env = process.env) {
  return env.CODE_EDIT_RECOVERY === "0";
}

// The exact client error texts, pinned by tests so a future Claude Code
// wording change is a conscious fixture bump. No match -> null -> the failure
// passes through exactly as today (fails safe).
const RE_STALE_READ = /File has been modified since read/;
const RE_NOT_READ = /File has not been read yet/;
const RE_READ_TOO_LARGE = /File content \((\d+) tokens\) exceeds maximum allowed tokens \((\d+)\)/;

const EDITING_TOOLS = new Set(["Edit", "MultiEdit", "Write"]);

/**
 * Classify a client tool failure the daemon knows how to recover from.
 * @returns {{kind:"stale-read"|"not-read"}|{kind:"read-too-large",actualTokens:number,capTokens:number}|null}
 */
export function classifyToolFailure(toolName, text) {
  if (typeof text !== "string" || !text) return null;
  if (EDITING_TOOLS.has(toolName)) {
    if (RE_STALE_READ.test(text)) return { kind: "stale-read" };
    if (RE_NOT_READ.test(text)) return { kind: "not-read" };
    return null;
  }
  if (toolName === "Read") {
    const m = text.match(RE_READ_TOO_LARGE);
    if (m) return { kind: "read-too-large", actualTokens: Number(m[1]), capTokens: Number(m[2]) };
  }
  return null;
}

function resolvePath(filePath, cwd) {
  const p = typeof filePath === "string" ? filePath.trim() : "";
  if (!p) return null;
  return isAbsolute(p) ? p : resolve(cwd || process.cwd(), p);
}

/**
 * Verify an Edit/MultiEdit chain still applies cleanly to the CURRENT disk
 * bytes, simulating the client's semantics exactly: edits apply sequentially,
 * each old_string must occur exactly once in the current simulated content
 * (>=1 with replace_all). Success means the client's freshness guard was the
 * only obstacle — a retry after a windowed Read will land byte-identically.
 *
 * @param {{filePath:string, cwd?:string, edits:Array<{old_string?:string,new_string?:string,replace_all?:boolean}>}} opts
 * @returns {{ok:true, line:number, content:string}|{ok:false, reason:string}}
 */
export function verifyEditsOnDisk({ filePath, cwd, edits }) {
  const path = resolvePath(filePath, cwd);
  if (!path) return { ok: false, reason: "no file_path" };
  if (!Array.isArray(edits) || !edits.length) return { ok: false, reason: "no edits" };
  let content;
  try {
    content = readFileSync(path, "utf8");
  } catch (e) {
    return { ok: false, reason: `file unreadable: ${e?.code || e?.message || e}` };
  }
  const original = content;
  let firstIdx = -1;
  for (const e of edits) {
    const oldStr = typeof e?.old_string === "string" ? e.old_string : "";
    const newStr = typeof e?.new_string === "string" ? e.new_string : "";
    if (!oldStr) return { ok: false, reason: "empty old_string" };
    const count = content.split(oldStr).length - 1;
    if (count === 0) return { ok: false, reason: "old_string not found in current file content" };
    if (count > 1 && !e.replace_all) return { ok: false, reason: `old_string appears ${count} times (not unique)` };
    if (firstIdx < 0) firstIdx = content.indexOf(oldStr);
    content = e.replace_all ? content.split(oldStr).join(newStr) : content.replace(oldStr, newStr);
  }
  const line = original.slice(0, Math.max(firstIdx, 0)).split("\n").length;
  return { ok: true, line, content: original };
}

/**
 * Plan the small windowed Read that refreshes the client's read state for a
 * file. Any successful Read refreshes freshness; the window just has to exist,
 * so keep it small (cheap client tool_result) but anchored on the edit site so
 * the bytes it returns are also the ones under change.
 */
export function planFreshnessWindow({ content, line, oldString }) {
  const totalLines = typeof content === "string" ? content.split("\n").length : 1;
  const oldLines = typeof oldString === "string" && oldString ? oldString.split("\n").length : 1;
  const offset = Math.max(1, Math.min(Number(line) || 1, totalLines) - 5);
  const limit = Math.min(oldLines + 20, Math.max(totalLines - offset + 1, 1));
  return { offset, limit };
}

/**
 * Plan a chunked Read for a file the client cannot return in one call.
 * Byte-aware: each chunk stays under CHUNK_MAX_LINES and ~CHUNK_BYTE_TARGET
 * (long lines counted at the client's LINE_BYTE_CAP truncation).
 *
 * @returns {null                                    // fits one default Read
 *   | {chunks:Array<{offset:number,limit:number}>, totalLines:number, coversWholeFile:boolean}
 *   | {tooLarge:true, totalLines:number, estTokens:number}}
 */
export function planChunkedRead({ filePath, cwd, offset, limit } = {}) {
  const path = resolvePath(filePath, cwd);
  if (!path) return null;
  let content;
  try {
    content = readFileSync(path, "utf8");
  } catch {
    return null; // daemon can't read it either; let the client produce the real error
  }
  const allLines = content.split("\n");
  const start = Math.max(1, Number(offset) || 1);
  if (start > allLines.length) return null;
  const requested = Number(limit) > 0 ? Number(limit) : Infinity;
  const end = Math.min(allLines.length, start + requested - 1);

  const lineBytes = [];
  let totalBytes = 0;
  for (let n = start; n <= end; n++) {
    const b = Math.min(Buffer.byteLength(allLines[n - 1], "utf8"), LINE_BYTE_CAP) + 8; // + gutter overhead
    lineBytes.push(b);
    totalBytes += b;
  }
  const totalLines = end - start + 1;
  if (totalLines <= CHUNK_MAX_LINES && totalBytes <= CHUNK_BYTE_TARGET) return null;

  const chunks = [];
  let chunkStart = start;
  let chunkLines = 0;
  let chunkBytes = 0;
  for (let n = start; n <= end; n++) {
    const b = lineBytes[n - start];
    if (chunkLines > 0 && (chunkLines >= CHUNK_MAX_LINES || chunkBytes + b > CHUNK_BYTE_TARGET)) {
      chunks.push({ offset: chunkStart, limit: chunkLines });
      chunkStart = n;
      chunkLines = 0;
      chunkBytes = 0;
    }
    chunkLines++;
    chunkBytes += b;
  }
  if (chunkLines > 0) chunks.push({ offset: chunkStart, limit: chunkLines });

  if (chunks.length > MAX_READ_CHUNKS) {
    return { tooLarge: true, totalLines, estTokens: Math.round(totalBytes / 4) };
  }
  // Whole-file coverage lets the caller mark the stitched snapshot complete
  // (anchor minimization is only sound against a full-file snapshot).
  return { chunks, totalLines, coversWholeFile: start === 1 && end === allLines.length };
}

// Same gutter shape anchor-edit.mjs recognizes: `<spaces><lineno><tab|arrow><content>`.
const GUTTER_LINE_RE = /^(\s*)(\d+)(\t|→)/;

/**
 * Stitch N windowed Read results (in offset order) into one text the script
 * sees as a single Read. Every chunk except the last keeps only its guttered
 * lines (dropping per-chunk trailers like <system-reminder>); the last chunk
 * passes through verbatim so end-of-result framing survives once.
 *
 * @returns {{text:string, lastLine:number|null}}
 */
export function stitchReadResults(chunkTexts) {
  const parts = [];
  let lastLine = null;
  const texts = Array.isArray(chunkTexts) ? chunkTexts : [];
  for (let c = 0; c < texts.length; c++) {
    const raw = typeof texts[c] === "string" ? texts[c] : "";
    const lines = raw.split("\n");
    if (c === texts.length - 1) {
      parts.push(...lines);
      for (const l of lines) {
        const m = l.match(GUTTER_LINE_RE);
        if (m) lastLine = Number(m[2]);
      }
    } else {
      for (const l of lines) {
        if (!GUTTER_LINE_RE.test(l)) break; // first non-gutter line ends this chunk's content
        parts.push(l);
        lastLine = Number(l.match(GUTTER_LINE_RE)[2]);
      }
    }
  }
  return { text: parts.join("\n"), lastLine };
}
