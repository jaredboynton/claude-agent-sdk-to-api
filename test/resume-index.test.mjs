// Resume index: candidate selection, prefix validation, catchup frames.
// Run: node --test test/resume-index.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  profileKey,
  loadResumeIndex,
  saveResumeIndex,
  findResumeCandidate,
  upsertResumeEntry,
  buildResumeCatchupFrames,
  MAX_CATCHUP_TAIL,
} from "../src/resume-index.mjs";
import { bucketKey, hashMessages, renderTranscript, toUserFrame, pushColdStartFrames } from "../src/server.mjs";

const SYS = "you are helpful";
const PK = profileKey("/Users/me/.claude");
const BUCKET = bucketKey(SYS, [{ role: "user", content: [{ type: "text", text: "start" }] }]);

function entry(seenCount, messages, sdkSessionId = "sdk-uuid-1") {
  return {
    profileKey: PK,
    bucket: BUCKET,
    seenCount,
    seenHash: hashMessages(messages, seenCount),
    sdkSessionId,
    model: "claude-opus-4-8",
    updatedAt: Date.now(),
  };
}

test("profileKey is stable and 16 hex chars", () => {
  const a = profileKey("/Users/me/.claude");
  const b = profileKey("/Users/me/.claude");
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{16}$/);
});

test("findResumeCandidate returns resume for single new user tail", () => {
  const base = [
    { role: "user", content: [{ type: "text", text: "start" }] },
    { role: "assistant", content: [{ type: "text", text: "ok" }] },
  ];
  const incoming = [...base, { role: "user", content: [{ type: "text", text: "next" }] }];
  const cand = findResumeCandidate({
    entries: [entry(2, incoming)],
    model: "claude-opus-4-8",
    profileKey: PK,
    bucket: BUCKET,
    messages: incoming,
    lastIsToolResult: false,
    hashMessages,
  });
  assert.equal(cand?.mode, "resume");
  assert.equal(cand?.sdkSessionId, "sdk-uuid-1");
  assert.equal(cand?.tail.length, 1);
});

test("findResumeCandidate returns resume for assistant+user tail", () => {
  const incoming = [
    { role: "user", content: [{ type: "text", text: "start" }] },
    { role: "assistant", content: [{ type: "text", text: "a" }] },
    { role: "user", content: [{ type: "text", text: "b" }] },
    { role: "assistant", content: [{ type: "text", text: "c" }] },
    { role: "user", content: [{ type: "text", text: "d" }] },
  ];
  const cand = findResumeCandidate({
    entries: [entry(3, incoming)],
    model: "claude-opus-4-8",
    profileKey: PK,
    bucket: BUCKET,
    messages: incoming,
    lastIsToolResult: false,
    hashMessages,
  });
  assert.equal(cand?.mode, "resume");
  assert.equal(cand?.tail.length, 2);
});

test("findResumeCandidate returns resume-catchup for multi-message tail", () => {
  const incoming = [
    { role: "user", content: [{ type: "text", text: "start" }] },
    { role: "assistant", content: [{ type: "text", text: "a" }] },
    { role: "user", content: [{ type: "text", text: "b" }] },
    { role: "user", content: [{ type: "text", text: "c" }] },
    { role: "user", content: [{ type: "text", text: "d" }] },
  ];
  const cand = findResumeCandidate({
    entries: [entry(2, incoming)],
    model: "claude-opus-4-8",
    profileKey: PK,
    bucket: BUCKET,
    messages: incoming,
    lastIsToolResult: false,
    hashMessages,
  });
  assert.equal(cand?.mode, "resume-catchup");
  assert.equal(cand?.tail.length, 3);
});

test("findResumeCandidate returns null when prefix diverges", () => {
  const indexed = [
    { role: "user", content: [{ type: "text", text: "start" }] },
    { role: "assistant", content: [{ type: "text", text: "a" }] },
  ];
  const incoming = [
    { role: "user", content: [{ type: "text", text: "start" }] },
    { role: "assistant", content: [{ type: "text", text: "DIFFERENT" }] },
    { role: "user", content: [{ type: "text", text: "next" }] },
  ];
  const cand = findResumeCandidate({
    entries: [entry(2, indexed)],
    model: "claude-opus-4-8",
    profileKey: PK,
    bucket: BUCKET,
    messages: incoming,
    lastIsToolResult: false,
    hashMessages,
  });
  assert.equal(cand, null);
});

test("findResumeCandidate returns null when tail exceeds MAX_CATCHUP_TAIL", () => {
  const prefix = [{ role: "user", content: [{ type: "text", text: "start" }] }];
  const tail = Array.from({ length: MAX_CATCHUP_TAIL + 2 }, (_, i) => ({
    role: "user",
    content: [{ type: "text", text: `m${i}` }],
  }));
  const incoming = [...prefix, ...tail];
  const cand = findResumeCandidate({
    entries: [entry(1, incoming)],
    model: "claude-opus-4-8",
    profileKey: PK,
    bucket: BUCKET,
    messages: incoming,
    lastIsToolResult: false,
    hashMessages,
  });
  assert.equal(cand, null);
});

test("findResumeCandidate picks longest matching prefix", () => {
  const incoming = [
    { role: "user", content: [{ type: "text", text: "start" }] },
    { role: "assistant", content: [{ type: "text", text: "a" }] },
    { role: "user", content: [{ type: "text", text: "b" }] },
    { role: "user", content: [{ type: "text", text: "c" }] },
  ];
  const shallow = entry(1, incoming, "shallow");
  const deep = entry(2, incoming, "deep");
  const cand = findResumeCandidate({
    entries: [shallow, deep],
    model: "claude-opus-4-8",
    profileKey: PK,
    bucket: BUCKET,
    messages: incoming,
    lastIsToolResult: false,
    hashMessages,
  });
  assert.equal(cand?.sdkSessionId, "deep");
});

test("buildResumeCatchupFrames summarizes prior tail and pushes last user", () => {
  const tail = [
    { role: "user", content: [{ type: "text", text: "u1" }] },
    { role: "user", content: [{ type: "text", text: "u2" }] },
  ];
  const frames = buildResumeCatchupFrames(tail, { renderTranscript, toUserFrame, lastIsToolResult: false });
  assert.equal(frames.length, 2);
  assert.match(frames[0].message.content[0].text, /Context since your last saved state/);
  assert.match(frames[0].message.content[0].text, /u1/);
  assert.equal(frames[1].message.content[0].text, "u2");
});

test("buildResumeCatchupFrames for tool_result uses full tail narrative", () => {
  const tail = [
    { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "data" }] },
  ];
  const frames = buildResumeCatchupFrames(tail, { renderTranscript, toUserFrame, lastIsToolResult: true });
  assert.equal(frames.length, 1);
  assert.match(frames[0].message.content[0].text, /Recent context/);
  assert.match(frames[0].message.content[0].text, /tool_result/);
});

test("upsertResumeEntry round-trips through save and load", () => {
  const dir = mkdtempSync(join(tmpdir(), "resume-index-"));
  const path = join(dir, "resume-index.json");
  const messages = [{ role: "user", content: [{ type: "text", text: "start" }] }];
  const updated = upsertResumeEntry({ entries: [] }, {
    profileKey: PK,
    bucket: BUCKET,
    seenCount: 1,
    seenHash: hashMessages(messages, 1),
    sdkSessionId: "sdk-abc",
    model: "claude-opus-4-8",
  });
  saveResumeIndex(updated, path);
  assert.ok(existsSync(path));
  const loaded = loadResumeIndex(path);
  assert.equal(loaded.entries.length, 1);
  assert.equal(loaded.entries[0].sdkSessionId, "sdk-abc");
});

test("pushColdStartFrames produces full-transcript priming plus last user", () => {
  const pushed = [];
  const messages = [
    { role: "user", content: [{ type: "text", text: "a" }] },
    { role: "assistant", content: [{ type: "text", text: "b" }] },
  ];
  const last = { role: "user", content: [{ type: "text", text: "c" }] };
  pushColdStartFrames({ input: { push: (m) => pushed.push(m) } }, [...messages, last], last, false);
  assert.equal(pushed.length, 2);
  assert.match(pushed[0].message.content[0].text, /Full prior context/);
  assert.equal(pushed[1].message.content[0].text, "c");
});
