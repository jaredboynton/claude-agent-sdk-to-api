// Persistent resume index: maps bridge conversation fingerprints to SDK session ids.
//
// Survives daemon restart so cold starts can use query({ options: { resume } })
// instead of flattening the full transcript into a narrative blob.

import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { dirname } from "node:path";

export const MAX_INDEX_ENTRIES = 64;
export const MAX_CATCHUP_TAIL = 6;
export const INDEX_ENTRY_TTL_MS = 30 * 60 * 1000; // 30 min

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
 * @param {(messages: object[], n: number) => string} opts.hashMessages
 * @param {(system: string, messages: object[]) => string} opts.bucketKey
 */
export function findResumeCandidate({
  entries,
  model,
  profileKey,
  bucket,
  messages,
  lastIsToolResult,
  hashMessages,
}) {
  const now = Date.now();
  const candidates = pruneEntries(entries || [], now)
    .filter((e) => e.profileKey === profileKey && e.bucket === bucket)
    .filter((e) => !e.model || e.model === model)
    .filter((e) => messages.length >= e.seenCount)
    .filter((e) => hashMessages(messages, e.seenCount) === e.seenHash)
    .sort((a, b) => b.seenCount - a.seenCount);

  const best = candidates[0];
  if (!best?.sdkSessionId) return null;

  const tail = messages.slice(best.seenCount);
  if (tail.length === 0) return null;

  // Evicted mid tool-loop: only resume if tail is small; caller handles frames.
  if (lastIsToolResult) {
    if (tail.length > MAX_CATCHUP_TAIL) return null;
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
export function buildResumeCatchupFrames(tail, { renderTranscript, toUserFrame, lastIsToolResult }) {
  const frames = [];
  if (lastIsToolResult) {
    frames.push(toUserFrame({
      role: "user",
      content: [{ type: "text", text: `Continue from where we left off. Recent context since your last saved state:\n\n${renderTranscript(tail)}` }],
    }));
    return frames;
  }
  const last = tail[tail.length - 1];
  const prior = tail.slice(0, -1);
  if (prior.length) {
    frames.push(toUserFrame({
      role: "user",
      content: [{ type: "text", text: `Continue this conversation. Context since your last saved state:\n\n${renderTranscript(prior)}` }],
    }));
  }
  frames.push(toUserFrame(last));
  return frames;
}
