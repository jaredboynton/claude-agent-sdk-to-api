// Persistent resume index: maps bridge conversation fingerprints to SDK session ids.
//
// Survives daemon restart so cold starts can use query({ options: { resume } })
// instead of flattening the full transcript into a narrative blob.

import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { dirname } from "node:path";

export const MAX_INDEX_ENTRIES = 256;
export const MAX_CATCHUP_TAIL = 6;
// Resume validity is transcript-based, not cache-based: even past the 1h
// prompt-cache TTL, SDK resume beats narrative priming (native transcript, no
// mimicry risk, no re-render write). 24h covers overnight gaps.
export const INDEX_ENTRY_TTL_MS = 24 * 60 * 60 * 1000;

export function profileKey(profileDir) {
  if (!profileDir) return "default";
  return createHash("sha256").update(profileDir).digest("hex").slice(0, 16);
}

export function defaultIndexPath(home = homedir()) {
  return join(home, ".config", "claude-agent-api", "resume-index.json");
}

export function loadResumeIndex(path = defaultIndexPath()) {
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.entries)) {
      return { entries: [] };
    }
    return parsed;
  } catch {
    return { entries: [] };
  }
}

export function saveResumeIndex(index, path = defaultIndexPath()) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(index, null, 0));
  renameSync(tmp, path);
}

function pruneEntries(entries, now = Date.now()) {
  return entries
    .filter((e) => e && e.sdkSessionId && e.bucket && e.seenHash != null && e.seenCount != null)
    .filter((e) => !e.updatedAt || now - e.updatedAt < INDEX_ENTRY_TTL_MS)
    .slice(-MAX_INDEX_ENTRIES);
}

/** @typedef {{ mode: 'resume' | 'resume-catchup', sdkSessionId: string, seenCount: number, tail: object[] } | null} ResumeCandidate */

/**
 * Find the best resume candidate for an incoming cold-start request.
 *
 * @param {object} opts
 * @param {object[]} opts.entries - index entries
 * @param {string} opts.model
 * @param {string} opts.profileKey
 * @param {string} opts.bucket
 * @param {object[]} opts.messages
 * @param {string} opts.system
 * @param {boolean} opts.lastIsToolResult
 * @param {boolean} [opts.codeMode]
 * @param {(messages: object[], n: number) => string} opts.hashMessages
 * @param {(system: string, messages: object[]) => string} opts.bucketKey
 * @param {object} [opts.trace] - optional; receives `reason` when no candidate is returned (cache-cold telemetry)
 */
export function findResumeCandidate({
  entries,
  model,
  profileKey,
  bucket,
  messages,
  lastIsToolResult,
  codeMode = false,
  hashMessages,
  trace,
}) {
  const now = Date.now();
  const pruned = pruneEntries(entries || [], now);
  const inBucket = pruned
    .filter((e) => e.profileKey === profileKey && e.bucket === bucket)
    .filter((e) => !e.model || e.model === model)
    .filter((e) => !!e.codeMode === !!codeMode);
  const candidates = inBucket
    .filter((e) => messages.length >= e.seenCount)
    .filter((e) => hashMessages(messages, e.seenCount) === e.seenHash)
    .sort((a, b) => b.seenCount - a.seenCount);

  const best = candidates[0];
  if (!best?.sdkSessionId) {
    if (trace) {
      trace.reason = !pruned.length ? "empty-index"
        : !inBucket.length ? "no-bucket-entry"
        : "prefix-mismatch";
    }
    return null;
  }

  // Drop synthesized `role: "system"` metadata (attachments / reminders /
  // recaps that Claude Code appends after the real payload) before classifying
  // the tail shape. They are non-actionable and must not turn a clean
  // `assistant + user` continuation into a multi-message catchup (or block a
  // `tool_result + system` tail from being recognized as a tool-loop tail).
  const tail = messages.slice(best.seenCount).filter((m) => m && m.role !== "system");
  if (tail.length === 0) {
    if (trace) trace.reason = "empty-tail";
    return null;
  }

  // Code mode: a tool_result tail is a HARD exclusion — it carries synthetic
  // toolu_code_* ids that a freshly-resumed SDK session cannot route, and
  // resume-catchup would re-render them as narrative (the very mimicry we
  // avoid). Non-tool_result tails are safe under the same rules as normal
  // mode: clean single/pair tails resume directly, small multi-message tails
  // go through the mimicry-safe catchup renderer (detector watches output).
  if (codeMode && lastIsToolResult) {
    if (trace) trace.reason = "code-tool-result-tail";
    return null;
  }

  // Evicted mid tool-loop: only resume if tail is small; caller handles frames.
  if (lastIsToolResult) {
    if (tail.length > MAX_CATCHUP_TAIL) {
      if (trace) trace.reason = "tail-too-long";
      return null;
    }
    return { mode: "resume-catchup", sdkSessionId: best.sdkSessionId, seenCount: best.seenCount, tail };
  }

  // Normal continuation: one new user turn, or assistant+user pair from client history.
  if (tail.length === 1 && tail[0]?.role === "user") {
    return { mode: "resume", sdkSessionId: best.sdkSessionId, seenCount: best.seenCount, tail };
  }
  if (tail.length === 2 && tail[0]?.role === "assistant" && tail[1]?.role === "user") {
    return { mode: "resume", sdkSessionId: best.sdkSessionId, seenCount: best.seenCount, tail };
  }

  if (tail.length <= MAX_CATCHUP_TAIL) {
    return { mode: "resume-catchup", sdkSessionId: best.sdkSessionId, seenCount: best.seenCount, tail };
  }

  if (trace) trace.reason = "tail-too-long";
  return null;
}

/**
 * Upsert an index entry after a successful turn.
 */
export function upsertResumeEntry(index, entry, now = Date.now()) {
  const entries = pruneEntries(index.entries || [], now);
  const next = {
    profileKey: entry.profileKey,
    bucket: entry.bucket,
    seenCount: entry.seenCount,
    seenHash: entry.seenHash,
    sdkSessionId: entry.sdkSessionId,
    model: entry.model,
    codeMode: !!entry.codeMode,
    updatedAt: now,
  };
  const idx = entries.findIndex(
    (e) => e.profileKey === next.profileKey && e.bucket === next.bucket && e.sdkSessionId === next.sdkSessionId
  );
  if (idx !== -1) entries[idx] = next;
  else entries.push(next);
  return { entries: entries.slice(-MAX_INDEX_ENTRIES) };
}

/**
 * Build SDK input frames for resume-catchup (small unseen tail only).
 */
// `renderTranscript` must be the mimicry-safe priming renderer and `wrap` must
// wrap a summary in the read-only boundary + anti-mimicry instruction (both
// supplied by the server) so catch-up frames cannot teach the model the literal
// tool-call grammar.
export function buildResumeCatchupFrames(tail, { renderTranscript, wrap, toUserFrame, lastIsToolResult }) {
  const frames = [];
  if (lastIsToolResult) {
    frames.push(toUserFrame({
      role: "user",
      content: [{ type: "text", text: wrap(renderTranscript(tail)) }],
    }));
    return frames;
  }
  const last = tail[tail.length - 1];
  const prior = tail.slice(0, -1);
  if (prior.length) {
    frames.push(toUserFrame({
      role: "user",
      content: [{ type: "text", text: wrap(renderTranscript(prior)) }],
    }));
  }
  frames.push(toUserFrame(last));
  return frames;
}
