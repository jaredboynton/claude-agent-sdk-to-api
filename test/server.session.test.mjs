// Session-isolation identity + pure-logic tests for the bridge core.
// Run: node --test test/server.session.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  bucketKey,
  hashMessages,
  renderMsgText,
  renderTranscript,
  renderMsgPriming,
  renderPrimingTranscript,
  primingFrameText,
  findSession,
  markSeen,
  actionableTail,
  decideWarmAction,
  sessions,
  toCallToolResult,
  toUserFrame,
  stripCacheControl,
  makeInputQueue,
  claimStreamedToolUse,
  normalizeToolInput,
  extractIdHint,
  abandonToolRound,
  buildParkingMcpServer,
  resolveTool,
  noteStreamTiming,
  toolInputShape,
  resolveCwd,
  isValidCwd,
} from "../src/server.mjs";
import { z } from "../src/sdk.mjs";

function fakeSession(bucket, { seenCount = 0, seenHash = hashMessages([], 0), closed = false, currentTurn = null } = {}) {
  return { key: `s-${Math.random().toString(16).slice(2)}`, bucket, seenCount, seenHash, closed, currentTurn };
}
function register(s) { sessions.set(s.key, s); return s; }
function clearSessions() { sessions.clear(); }

test("bucketKey is stable across turns of the same conversation", () => {
  const sys = "you are a helpful assistant";
  const turn1 = [{ role: "user", content: [{ type: "text", text: "Fix the bug in foo.js" }] }];
  const turn2 = [
    { role: "user", content: [{ type: "text", text: "Fix the bug in foo.js" }] },
    { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "..." }] }] },
  ];
  assert.equal(bucketKey(sys, turn1), bucketKey(sys, turn2));
});

test("bucketKey differs for different first user messages", () => {
  const a = [{ role: "user", content: [{ type: "text", text: "task A" }] }];
  const b = [{ role: "user", content: [{ type: "text", text: "task B" }] }];
  assert.notEqual(bucketKey("sys", a), bucketKey("sys", b));
});

test("bucketKey differs when only the system prompt differs", () => {
  const msgs = [{ role: "user", content: [{ type: "text", text: "same task" }] }];
  assert.notEqual(bucketKey("system A", msgs), bucketKey("system B", msgs));
});

test("bucketKey handles string content and is 32 hex chars", () => {
  const a = [{ role: "user", content: "hello" }];
  assert.equal(typeof bucketKey("", a), "string");
  assert.equal(bucketKey("", a).length, 32);
});

test("bucketKey uses convId when provided, ignoring content", () => {
  const a = [{ role: "user", content: "hello" }];
  const b = [{ role: "user", content: "totally different" }];
  // Same convId => same bucket regardless of content.
  assert.equal(bucketKey("sysA", a, "conv-1"), bucketKey("sysB", b, "conv-1"));
  assert.equal(bucketKey("", a, "conv-1"), "cc:conv-1");
  // Different convId => different bucket even with identical content.
  assert.notEqual(bucketKey("sys", a, "conv-1"), bucketKey("sys", a, "conv-2"));
});

test("bucketKey isolates the same conversation across different cwds", () => {
  const a = [{ role: "user", content: "same task" }];
  // Content path: identical system+message in two dirs must not share a session.
  assert.notEqual(bucketKey("sys", a, null, "/a"), bucketKey("sys", a, null, "/b"));
  // convId path: same convId in two dirs must not share a session either.
  assert.notEqual(bucketKey("sys", a, "conv-1", "/a"), bucketKey("sys", a, "conv-1", "/b"));
  // Same cwd => same bucket (deterministic).
  assert.equal(bucketKey("sys", a, null, "/a"), bucketKey("sys", a, null, "/a"));
  assert.equal(bucketKey("sys", a, "conv-1", "/a"), bucketKey("sys", a, "conv-1", "/a"));
});

test("bucketKey convId format is unchanged when cwd is empty (back-compat)", () => {
  const a = [{ role: "user", content: "hi" }];
  assert.equal(bucketKey("", a, "conv-1"), "cc:conv-1");
  assert.equal(bucketKey("", a, "conv-1", ""), "cc:conv-1");
});

test("isValidCwd accepts an existing absolute directory, rejects others", () => {
  assert.equal(isValidCwd(process.cwd()), true);
  assert.equal(isValidCwd("relative/path"), false);
  assert.equal(isValidCwd("/definitely/not/a/real/dir/xyz123"), false);
  assert.equal(isValidCwd(""), false);
  assert.equal(isValidCwd(null), false);
  assert.equal(isValidCwd(undefined), false);
});

test("resolveCwd uses a valid header value and falls back when invalid/absent", () => {
  // Valid header wins.
  assert.equal(resolveCwd(process.cwd()), process.cwd());
  // Array header (Node may pass arrays): first element is used.
  assert.equal(resolveCwd([process.cwd()]), process.cwd());
  // Invalid/absent -> fallback (process.cwd() unless CLAUDE_PROXY_CWD is set).
  const fallback = resolveCwd(undefined);
  assert.equal(typeof fallback, "string");
  assert.equal(resolveCwd("/nope/not/real/xyz"), fallback);
  assert.equal(resolveCwd(""), fallback);
});

test("findSession separates parallel conversations with identical prefix by convId", () => {
  sessions.clear();
  const sys = "sys";
  const first = { role: "user", content: [{ type: "text", text: "same task" }] };
  // Two sessions, identical system+first-user content, but distinct convIds —
  // exactly the fan-out-subagent case content hashing alone cannot separate.
  const sA = { key: "A", bucket: bucketKey(sys, [first], "conv-A"), seenCount: 0, seenHash: hashMessages([], 0), closed: false, currentTurn: null };
  const sB = { key: "B", bucket: bucketKey(sys, [first], "conv-B"), seenCount: 0, seenHash: hashMessages([], 0), closed: false, currentTurn: null };
  sessions.set("A", sA); markSeen(sA, [first]);
  sessions.set("B", sB); markSeen(sB, [first]);
  assert.equal(findSession([first], sys, "conv-A")?.key, "A");
  assert.equal(findSession([first], sys, "conv-B")?.key, "B");
  // Without the convId, both share a content bucket and neither cc: bucket matches.
  assert.equal(findSession([first], sys), null);
  sessions.clear();
});

test("findSession falls back to content bucket when no convId (Droid path)", () => {
  sessions.clear();
  const sys = "sys";
  const first = { role: "user", content: [{ type: "text", text: "task" }] };
  const s = { key: "k", bucket: bucketKey(sys, [first]), seenCount: 0, seenHash: hashMessages([], 0), closed: false, currentTurn: null };
  sessions.set("k", s); markSeen(s, [first]);
  assert.equal(findSession([first], sys)?.key, "k");
  sessions.clear();
});

test("findSession isolates identical conversations running in different cwds", () => {
  sessions.clear();
  const sys = "sys";
  const first = { role: "user", content: [{ type: "text", text: "same task" }] };
  const sA = { key: "A", bucket: bucketKey(sys, [first], null, "/proj/a"), seenCount: 0, seenHash: hashMessages([], 0), closed: false, currentTurn: null };
  const sB = { key: "B", bucket: bucketKey(sys, [first], null, "/proj/b"), seenCount: 0, seenHash: hashMessages([], 0), closed: false, currentTurn: null };
  sessions.set("A", sA); markSeen(sA, [first]);
  sessions.set("B", sB); markSeen(sB, [first]);
  // Same content + same convId-less path, but each cwd resolves to its own session.
  assert.equal(findSession([first], sys, null, "/proj/a")?.key, "A");
  assert.equal(findSession([first], sys, null, "/proj/b")?.key, "B");
  // A request from a third, unseen cwd matches neither.
  assert.equal(findSession([first], sys, null, "/proj/c"), null);
  sessions.clear();
});

test("hashMessages is stable across cache_control drift", () => {
  const a = [{ role: "user", content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }] }];
  const b = [{ role: "user", content: [{ type: "text", text: "hi" }] }];
  assert.equal(hashMessages(a, 1), hashMessages(b, 1));
});

test("hashMessages over a prefix ignores later messages", () => {
  const base = [{ role: "user", content: [{ type: "text", text: "first" }] }];
  const extended = [
    { role: "user", content: [{ type: "text", text: "first" }] },
    { role: "assistant", content: [{ type: "text", text: "later" }] },
  ];
  assert.equal(hashMessages(base, 1), hashMessages(extended, 1));
});

test("findSession isolates two conversations with identical first message that diverge", () => {
  clearSessions();
  const sys = "sys";
  const first = { role: "user", content: [{ type: "text", text: "do the thing" }] };
  const aTurn2 = [first, { role: "assistant", content: [{ type: "text", text: "AAA" }] }];
  const bTurn2 = [first, { role: "assistant", content: [{ type: "text", text: "BBB" }] }];
  const b = bucketKey(sys, [first]);

  const sa = register(fakeSession(b, { seenCount: 2, seenHash: hashMessages(aTurn2, 2) }));
  const sb = register(fakeSession(b, { seenCount: 2, seenHash: hashMessages(bTurn2, 2) }));

  const aTurn3 = [...aTurn2, { role: "user", content: [{ type: "text", text: "next A" }] }];
  const bTurn3 = [...bTurn2, { role: "user", content: [{ type: "text", text: "next B" }] }];
  assert.equal(findSession(aTurn3, sys)?.key, sa.key);
  assert.equal(findSession(bTurn3, sys)?.key, sb.key);
  clearSessions();
});

test("findSession picks the longest matching prefix", () => {
  clearSessions();
  const sys = "sys";
  const first = { role: "user", content: [{ type: "text", text: "task" }] };
  const t2 = [first, { role: "assistant", content: [{ type: "text", text: "a" }] }];
  const t4 = [...t2,
    { role: "user", content: [{ type: "text", text: "b" }] },
    { role: "assistant", content: [{ type: "text", text: "c" }] },
  ];
  const b = bucketKey(sys, [first]);
  const shallow = register(fakeSession(b, { seenCount: 2, seenHash: hashMessages(t4, 2) }));
  const deep = register(fakeSession(b, { seenCount: 4, seenHash: hashMessages(t4, 4) }));
  const incoming = [...t4, { role: "user", content: [{ type: "text", text: "next" }] }];
  assert.equal(findSession(incoming, sys)?.key, deep.key, "most-advanced matching session wins");
  assert.ok(shallow);
  clearSessions();
});

test("findSession skips a mid-turn session (forces fork on concurrency)", () => {
  clearSessions();
  const sys = "sys";
  const first = { role: "user", content: [{ type: "text", text: "task" }] };
  const b = bucketKey(sys, [first]);
  register(fakeSession(b, { seenCount: 1, seenHash: hashMessages([first], 1), currentTurn: { resolve() {} } }));
  assert.equal(findSession([first], sys), null);
  clearSessions();
});

test("findSession skips closed sessions", () => {
  clearSessions();
  const sys = "sys";
  const first = { role: "user", content: [{ type: "text", text: "task" }] };
  const b = bucketKey(sys, [first]);
  register(fakeSession(b, { seenCount: 1, seenHash: hashMessages([first], 1), closed: true }));
  assert.equal(findSession([first], sys), null);
  clearSessions();
});

test("findSession returns null on cold start (history with no matching session)", () => {
  clearSessions();
  const sys = "sys";
  const history = [
    { role: "user", content: [{ type: "text", text: "approved plan ..." }] },
    { role: "assistant", content: [{ type: "text", text: "ok" }] },
    { role: "user", content: [{ type: "text", text: "now implement it" }] },
  ];
  assert.equal(findSession(history, sys), null);
  clearSessions();
});

test("markSeen records the processed prefix so the next turn matches", () => {
  clearSessions();
  const sys = "sys";
  const first = { role: "user", content: [{ type: "text", text: "task" }] };
  const b = bucketKey(sys, [first]);
  const s = register(fakeSession(b));
  markSeen(s, [first]);
  const turn2 = [first, { role: "assistant", content: [{ type: "text", text: "a" }] }, { role: "user", content: [{ type: "text", text: "more" }] }];
  assert.equal(findSession(turn2, sys)?.key, s.key);
  clearSessions();
});

test("renderMsgText flattens text, tool_use, and tool_result blocks", () => {
  const m = {
    role: "assistant",
    content: [
      { type: "text", text: "thinking about it" },
      { type: "tool_use", name: "Read", input: { path: "a.txt" } },
    ],
  };
  const out = renderMsgText(m);
  assert.match(out, /thinking about it/);
  assert.match(out, /\[tool_use Read\]/);
  assert.match(out, /a\.txt/);
});

test("renderTranscript labels roles and includes tool_result content", () => {
  const msgs = [
    { role: "user", content: [{ type: "text", text: "read foo" }] },
    { role: "assistant", content: [{ type: "tool_use", name: "Read", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "FILE BODY" }] }] },
  ];
  const t = renderTranscript(msgs);
  assert.match(t, /User: /);
  assert.match(t, /Assistant: /);
  assert.match(t, /FILE BODY/);
});

test("renderMsgText (identity) keeps the literal tool grammar stable", () => {
  // bucketKey/hashMessages depend on this exact format; it must NOT change.
  const m = {
    role: "assistant",
    content: [
      { type: "tool_use", name: "Read", input: { path: "a.txt" } },
      { type: "thinking", thinking: "secret reasoning" },
    ],
  };
  assert.equal(renderMsgText(m), '[tool_use Read] {"path":"a.txt"}\nsecret reasoning');
});

test("renderPrimingTranscript drops the mimicry grammar and thinking", () => {
  const msgs = [
    { role: "user", content: [{ type: "text", text: "edit the PRs" }] },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "internal plan that must not leak" },
        { type: "text", text: "on it" },
        { type: "tool_use", name: "Bash", input: { command: "gh pr edit 4" } },
        { type: "tool_use", name: "Bash", input: { command: "gh pr edit 5" } },
      ],
    },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "https://example/pr/4" }] },
  ];
  const out = renderPrimingTranscript(msgs);
  // No copyable tool-call grammar, no dialogue script, no leaked CoT.
  assert.doesNotMatch(out, /\[tool_use /);
  assert.doesNotMatch(out, /\[tool_result\]/);
  assert.doesNotMatch(out, /^Assistant:/m);
  assert.doesNotMatch(out, /^User:/m);
  assert.doesNotMatch(out, /internal plan that must not leak/);
  // Context is still conveyed.
  assert.match(out, /gh pr edit 4/);
  assert.match(out, /gh pr edit 5/);
  assert.match(out, /example\/pr\/4/);
  // Parallel calls collapse into a single clause (one "called the tools" phrase).
  assert.equal(out.match(/called the tools/g).length, 1);
});

test("primingFrameText wraps in a read-only boundary with the instruction last", () => {
  const t = primingFrameText("SUMMARY BODY");
  assert.match(t, /^<prior_conversation_summary readonly="true">/);
  assert.match(t, /SUMMARY BODY/);
  assert.match(t, /issue real tool calls[^]*$/);
  assert.ok(t.indexOf("SUMMARY BODY") < t.indexOf("issue real tool calls"));
});

test("renderMsgPriming returns null for empty/thinking-only messages", () => {
  assert.equal(renderMsgPriming({ role: "assistant", content: [{ type: "thinking", thinking: "x" }] }), null);
  assert.equal(renderMsgPriming(null), null);
});

test("noteStreamTiming flags tool-call mimicry in output text", () => {
  const session = { key: "abc12345", turnMetrics: { action: "cold", firstEventAt: 1, textDeltas: 0 } };
  const delta = (text) => ({ type: "content_block_delta", delta: { type: "text_delta", text } });
  noteStreamTiming(session, delta("Sure, let me run "));
  assert.ok(!session.turnMetrics.mimicry);
  noteStreamTiming(session, delta("[tool_use Bash] {\"command\":\"ls\"}"));
  assert.equal(session.turnMetrics.mimicry, true);
});

test("noteStreamTiming detects mimicry split across deltas", () => {
  const session = { key: "abc12345", turnMetrics: { action: "cold", firstEventAt: 1, textDeltas: 0 } };
  const delta = (text) => ({ type: "content_block_delta", delta: { type: "text_delta", text } });
  noteStreamTiming(session, delta("...[tool_"));
  noteStreamTiming(session, delta("use Read]"));
  assert.equal(session.turnMetrics.mimicry, true);
});

test("toCallToolResult converts a tool_result to MCP shape", () => {
  const block = { type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "line1" }, { type: "text", text: "line2" }] };
  assert.deepEqual(toCallToolResult(block), { content: [{ type: "text", text: "line1\nline2" }] });
});

test("toCallToolResult marks errors", () => {
  const r = toCallToolResult({ type: "tool_result", tool_use_id: "t1", content: "boom", is_error: true });
  assert.equal(r.isError, true);
  assert.equal(r.content[0].text, "boom");
});

test("toUserFrame builds a user SDK frame and strips cache_control", () => {
  const msg = { role: "user", content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }] };
  const frame = toUserFrame(msg);
  assert.equal(frame.type, "user");
  assert.equal(frame.message.role, "user");
  assert.equal(frame.parent_tool_use_id, null);
  assert.ok(!("cache_control" in frame.message.content[0]));
});

test("stripCacheControl recurses into nested content arrays", () => {
  const block = {
    type: "tool_result",
    tool_use_id: "x",
    cache_control: { type: "ephemeral" },
    content: [{ type: "text", text: "r", cache_control: { type: "ephemeral" } }],
  };
  const out = stripCacheControl(block);
  assert.ok(!("cache_control" in out));
  assert.ok(!("cache_control" in out.content[0]));
});

test("makeInputQueue yields pushed items in order and ends on close", async () => {
  const q = makeInputQueue();
  q.push({ n: 1 });
  q.push({ n: 2 });
  const got = [];
  const consumer = (async () => {
    for await (const item of q.iterable) {
      got.push(item.n);
      if (got.length === 3) return;
    }
  })();
  setTimeout(() => q.push({ n: 3 }), 10);
  await consumer;
  assert.deepEqual(got, [1, 2, 3]);
});

test("makeInputQueue iterable terminates when closed with no items", async () => {
  const q = makeInputQueue();
  setTimeout(() => q.close(), 10);
  const got = [];
  for await (const item of q.iterable) got.push(item);
  assert.deepEqual(got, []);
});

// ---------------------------------------------------------------------------
// claimStreamedToolUse — name + input correlation (the desync fix)
// ---------------------------------------------------------------------------

function toolSession(streamedToolUses = []) {
  return { streamedToolUses };
}

test("claimStreamedToolUse matches by (name, input) regardless of stream order", () => {
  const s = toolSession([
    { id: "id_alpha", name: "alpha", input: { reason: "a" } },
    { id: "id_beta", name: "beta", input: { reason: "b" } },
  ]);
  const beta = claimStreamedToolUse(s, "beta", { reason: "b" });
  assert.equal(beta.id, "id_beta");
  const alpha = claimStreamedToolUse(s, "alpha", { reason: "a" });
  assert.equal(alpha.id, "id_alpha");
  assert.equal(s.streamedToolUses.length, 0);
});

test("claimStreamedToolUse disambiguates same-name calls by input", () => {
  const s = toolSession([
    { id: "id_1", name: "Read", input: { file: "x.js" } },
    { id: "id_2", name: "Read", input: { file: "y.js" } },
  ]);
  const second = claimStreamedToolUse(s, "Read", { file: "y.js" });
  assert.equal(second.id, "id_2");
  const first = claimStreamedToolUse(s, "Read", { file: "x.js" });
  assert.equal(first.id, "id_1");
});

test("claimStreamedToolUse FIFO-falls back for identical same-name inputs", () => {
  const s = toolSession([
    { id: "id_1", name: "Read", input: { file: "x.js" } },
    { id: "id_2", name: "Read", input: { file: "x.js" } },
  ]);
  const a = claimStreamedToolUse(s, "Read", { file: "x.js" });
  const b = claimStreamedToolUse(s, "Read", { file: "x.js" });
  assert.deepEqual([a.id, b.id], ["id_1", "id_2"]);
});

test("claimStreamedToolUse returns null when nothing is queued", () => {
  assert.equal(claimStreamedToolUse(toolSession([]), "alpha", {}), null);
});

// ---------------------------------------------------------------------------
// claimStreamedToolUse — schema-symmetric normalization (the desync fix for
// tools whose JSON Schema has `default` values, e.g. Cursor Grep/Glob/Read).
// The MCP layer parses handler args through normalizeObjectSchema(inputSchema),
// injecting every default; the streamed entry.input is the raw model JSON. We
// canonicalize both sides through the same z.object(shape) so they match.
// ---------------------------------------------------------------------------

// A Cursor-Grep-like schema with defaults on several optional fields.
const GREP_SCHEMA = {
  type: "object",
  properties: {
    pattern: { type: "string" },
    path: { type: "string" },
    output_mode: { type: "string", enum: ["content", "files_with_matches", "count"], default: "content" },
    case_insensitive: { type: "boolean", default: false },
    line_numbers: { type: "boolean", default: true },
    head_limit: { type: "number" },
    multiline: { type: "boolean", default: false },
  },
  required: ["pattern"],
  additionalProperties: false,
};

const GLOB_SCHEMA = {
  type: "object",
  properties: {
    pattern: { type: "string" },
    folder: { type: "string" },
    case_sensitive: { type: "boolean", default: true },
    include_hidden: { type: "boolean", default: false },
  },
  required: ["pattern"],
  additionalProperties: false,
};

function parserSession(parsers) {
  return { streamedToolUses: [], inputParsers: new Map(parsers), fifoFallbacks: 0 };
}

function buildParser(schema) {
  return z.object(toolInputShape(schema));
}

test("normalizeToolInput is identity when no parser is registered for the tool", () => {
  const s = parserSession([]);
  assert.deepEqual(normalizeToolInput(s, "X", { a: 1 }), { a: 1 });
});

test("normalizeToolInput injects schema defaults into raw model input", () => {
  const s = parserSession([["Grep", buildParser(GREP_SCHEMA)]]);
  const raw = { pattern: "rtinferd", path: "/x" };
  const out = normalizeToolInput(s, "Grep", raw);
  assert.equal(out.output_mode, "content");
  assert.equal(out.line_numbers, true);
  assert.equal(out.multiline, false);
  assert.equal(out.case_insensitive, false);
  assert.equal(out.pattern, "rtinferd");
});

test("claimStreamedToolUse matches a defaulted tool when args carry injected defaults but the streamed entry does not", () => {
  const parser = buildParser(GREP_SCHEMA);
  const s = parserSession([["Grep", parser]]);
  // The model streamed a raw subset (no defaulted keys); the SDK will parse this
  // and hand the handler an args object WITH defaults. Pre-fix this fell to FIFO.
  s.streamedToolUses = [{ id: "g1", name: "Grep", input: { pattern: "rtinferd", path: "/x", head_limit: 60 } }];
  const sdkArgs = parser.parse({ pattern: "rtinferd", path: "/x", head_limit: 60 });
  const got = claimStreamedToolUse(s, "Grep", sdkArgs);
  assert.equal(got?.id, "g1");
  assert.equal(s.streamedToolUses.length, 0);
  assert.equal(s.fifoFallbacks, 0, "must not fall to FIFO when normalized match succeeds");
});

test("claimStreamedToolUse does not cross-wire parallel non-identical defaulted calls claimed out of order", () => {
  const grep = buildParser(GREP_SCHEMA);
  const glob = buildParser(GLOB_SCHEMA);
  const s = parserSession([["Grep", grep], ["Glob", glob]]);
  // Both tools emitted in one assistant message; handlers may dispatch in any order.
  s.streamedToolUses = [
    { id: "grep_1", name: "Grep", input: { pattern: "rtinferd", path: "/x" } },
    { id: "glob_1", name: "Glob", input: { pattern: "**/rtinfer*", folder: "/x" } },
  ];
  // Glob handler fires first (out of stream order) with SDK-parsed args.
  const globArgs = glob.parse({ pattern: "**/rtinfer*", folder: "/x" });
  const g = claimStreamedToolUse(s, "Glob", globArgs);
  assert.equal(g?.id, "glob_1", "Glob claim must not steal Grep's id");
  const grepArgs = grep.parse({ pattern: "rtinferd", path: "/x" });
  const r = claimStreamedToolUse(s, "Grep", grepArgs);
  assert.equal(r?.id, "grep_1", "Grep claim must get its own id");
  assert.equal(s.streamedToolUses.length, 0);
  assert.equal(s.fifoFallbacks, 0, "no FIFO fallback should occur");
});

test("claimStreamedToolUse still disambiguates same-name defaulted calls by normalized input", () => {
  const parser = buildParser(GREP_SCHEMA);
  const s = parserSession([["Grep", parser]]);
  s.streamedToolUses = [
    { id: "g_a", name: "Grep", input: { pattern: "alpha" } },
    { id: "g_b", name: "Grep", input: { pattern: "beta" } },
  ];
  const b = claimStreamedToolUse(s, "Grep", parser.parse({ pattern: "beta" }));
  assert.equal(b?.id, "g_b");
  const a = claimStreamedToolUse(s, "Grep", parser.parse({ pattern: "alpha" }));
  assert.equal(a?.id, "g_a");
  assert.equal(s.streamedToolUses.length, 0);
  assert.equal(s.fifoFallbacks, 0);
});

test("claimStreamedToolUse prefers an idHint over content matching (future-proof direct-id path)", () => {
  const parser = buildParser(GREP_SCHEMA);
  const s = parserSession([["Grep", parser]]);
  // Two identical-content calls — content alone could not disambiguate, but an
  // idHint forwarded via extra._meta picks the right one.
  s.streamedToolUses = [
    { id: "g_1", name: "Grep", input: { pattern: "x" } },
    { id: "g_2", name: "Grep", input: { pattern: "x" } },
  ];
  const args = parser.parse({ pattern: "x" });
  const second = claimStreamedToolUse(s, "Grep", args, "g_2");
  assert.equal(second?.id, "g_2");
  const first = claimStreamedToolUse(s, "Grep", args, "g_1");
  assert.equal(first?.id, "g_1");
  assert.equal(s.streamedToolUses.length, 0);
});

test("claimStreamedToolUse uses per-name single candidate when normalized match drifts", () => {
  // A uniquely-named tool whose input drifted (e.g. parser divergence) should
  // still claim the only same-name entry rather than FIFO.
  const s = parserSession([]);
  s.streamedToolUses = [
    { id: "only", name: "Unique", input: { x: 1 } },
  ];
  const got = claimStreamedToolUse(s, "Unique", { x: 999 });
  assert.equal(got?.id, "only");
  assert.equal(s.fifoFallbacks, 0, "single same-name candidate is not a FIFO fallback");
});

test("claimStreamedToolUse FIFO-falls back (with counter + log) when two same-name entries cannot be disambiguated", () => {
  const s = parserSession([]);
  s.streamedToolUses = [
    { id: "u_1", name: "Unique", input: { x: 1 } },
    { id: "u_2", name: "Unique", input: { x: 1 } },
    { id: "u_3", name: "Unique", input: { x: 1 } },
  ];
  // First claim: 3 same-name candidates, no content match -> FIFO (count 1).
  const a = claimStreamedToolUse(s, "Unique", { x: 999 });
  assert.equal(a?.id, "u_1");
  assert.equal(s.fifoFallbacks, 1);
  // Second claim: 2 same-name candidates still -> FIFO again (count 2).
  const b = claimStreamedToolUse(s, "Unique", { x: 999 });
  assert.equal(b?.id, "u_2");
  assert.equal(s.fifoFallbacks, 2);
  // Third claim: 1 same-name candidate left -> single-candidate path (NOT FIFO).
  const c = claimStreamedToolUse(s, "Unique", { x: 999 });
  assert.equal(c?.id, "u_3");
  assert.equal(s.fifoFallbacks, 2, "single same-name candidate is not a FIFO fallback");
  assert.equal(s.streamedToolUses.length, 0);
});

// ---------------------------------------------------------------------------
// buildParkingMcpServer — parallel defaulted tools park and unblock end-to-end
// ---------------------------------------------------------------------------

function parkingSession(overrides = {}) {
  return {
    codeMode: false,
    anchorEdit: false,
    streamedToolUses: [],
    inputParsers: new Map(),
    fifoFallbacks: 0,
    pendingTools: new Map(),
    resolvedResults: new Map(),
    orphanResolvers: [],
    lastActivity: Date.now(),
    ...overrides,
  };
}

test("buildParkingMcpServer: parallel defaulted tools park on correct ids and unblock after both results", async () => {
  const grep = buildParser(GREP_SCHEMA);
  const glob = buildParser(GLOB_SCHEMA);
  const session = parkingSession({
    streamedToolUses: [
      { id: "grep_1", name: "Grep", input: { pattern: "rtinferd", path: "/x" } },
      { id: "glob_1", name: "Glob", input: { pattern: "**/rtinfer*", folder: "/x" } },
    ],
  });
  let captured = null;
  buildParkingMcpServer(
    [
      { name: "Grep", description: "grep", input_schema: GREP_SCHEMA },
      { name: "Glob", description: "glob", input_schema: GLOB_SCHEMA },
    ],
    session,
    (config) => { captured = config; return { ok: true }; },
  );
  const handlers = Object.fromEntries(captured.tools.map((t) => [t.name, t.handler]));
  const globArgs = glob.parse({ pattern: "**/rtinfer*", folder: "/x" });
  const grepArgs = grep.parse({ pattern: "rtinferd", path: "/x" });

  // Glob handler fires first (out of stream order), mirroring the live regression.
  const globP = handlers.Glob(globArgs, {});
  const grepP = handlers.Grep(grepArgs, {});

  assert.equal(session.pendingTools.size, 2);
  assert.ok(session.pendingTools.has("glob_1"));
  assert.ok(session.pendingTools.has("grep_1"));
  assert.equal(session.orphanResolvers.length, 0);
  assert.equal(session.fifoFallbacks, 0);
  assert.equal(session.streamedToolUses.length, 0);

  resolveTool(session, "grep_1", { content: [{ type: "text", text: "grep ok" }] });
  resolveTool(session, "glob_1", { content: [{ type: "text", text: "glob ok" }] });

  const [globResult, grepResult] = await Promise.all([globP, grepP]);
  assert.equal(globResult.content[0].text, "glob ok");
  assert.equal(grepResult.content[0].text, "grep ok");
  assert.equal(session.pendingTools.size, 0);
  assert.equal(session.orphanResolvers.length, 0);
});

// ---------------------------------------------------------------------------
// extractIdHint — opportunistic direct-id from extra._meta
// ---------------------------------------------------------------------------

test("extractIdHint returns a streamed id when one is present in extra._meta", () => {
  const s = parserSession([]);
  s.streamedToolUses = [{ id: "abc", name: "X", input: {} }];
  assert.equal(extractIdHint(s, { _meta: { anything: "abc" } }), "abc");
});

test("extractIdHint returns null when no _meta value matches a streamed id", () => {
  const s = parserSession([]);
  s.streamedToolUses = [{ id: "abc", name: "X", input: {} }];
  assert.equal(extractIdHint(s, { _meta: { foo: "nope" } }), null);
  assert.equal(extractIdHint(s, { _meta: null }), null);
  assert.equal(extractIdHint(s, {}), null);
  assert.equal(extractIdHint(s, null), null);
});

test("extractIdHint returns null when nothing is streamed", () => {
  const s = parserSession([]);
  assert.equal(extractIdHint(s, { _meta: { x: "abc" } }), null);
});

// ---------------------------------------------------------------------------
// abandonToolRound — unblocks the SDK loop and wipes correlation state
// ---------------------------------------------------------------------------

test("abandonToolRound resolves parked handlers with isError and clears state", () => {
  const resolved = [];
  const s = {
    pendingTools: new Map([["id_1", (r) => resolved.push(r)]]),
    orphanResolvers: [(r) => resolved.push(r)],
    resolvedResults: new Map([["id_x", {}]]),
    streamedToolUses: [{ id: "id_2", name: "alpha", input: {} }],
    toolUseAccum: new Map([[0, { id: "id_2" }]]),
  };
  abandonToolRound(s);
  assert.equal(resolved.length, 2);
  assert.ok(resolved.every((r) => r.isError === true));
  assert.equal(s.pendingTools.size, 0);
  assert.equal(s.orphanResolvers.length, 0);
  assert.equal(s.resolvedResults.size, 0);
  assert.equal(s.streamedToolUses.length, 0);
  assert.equal(s.toolUseAccum.size, 0);
});

// ---------------------------------------------------------------------------
// actionableTail — classifies the unseen request tail, ignoring trailing
// role:"system" metadata that Claude Code appends after the real payload.
// ---------------------------------------------------------------------------

const SYS = (text) => ({ role: "system", content: [{ type: "text", text }] });
const U = (text) => ({ role: "user", content: [{ type: "text", text }] });
const A = (text) => ({ role: "assistant", content: [{ type: "text", text }] });
const ATOOL = (name = "Read", id = "t1") => ({
  role: "assistant",
  content: [{ type: "tool_use", id, name, input: {} }],
});
const URES = (id = "t1", text = "data") => ({
  role: "user",
  content: [{ type: "tool_result", tool_use_id: id, content: [{ type: "text", text }] }],
});

test("actionableTail: user text followed by trailing system -> userMsg is the user text", () => {
  const t = actionableTail([A("ok"), U("hello"), SYS("reminder")]);
  assert.equal(t.isToolResult, false);
  assert.deepEqual(t.toolResults, []);
  assert.equal(t.userMsg?.content?.[0]?.text, "hello");
  assert.equal(t.hasSystemOnly, false);
});

test("actionableTail: tool_result followed by trailing system -> isToolResult, no userMsg, no abandon trigger", () => {
  const t = actionableTail([ATOOL(), URES(), SYS("reminder")]);
  assert.equal(t.isToolResult, true);
  assert.equal(t.toolResults.length, 1);
  assert.equal(t.toolResults[0].tool_use_id, "t1");
  assert.equal(t.userMsg, null);
  assert.equal(t.hasSystemOnly, false);
});

test("actionableTail: normal single user turn -> one userMsg", () => {
  const t = actionableTail([U("next")]);
  assert.equal(t.isToolResult, false);
  assert.equal(t.userMsg?.content?.[0]?.text, "next");
});

test("actionableTail: assistant echoes are ignored", () => {
  const t = actionableTail([A("echo"), A("echo2"), U("real")]);
  assert.equal(t.userMsg?.content?.[0]?.text, "real");
});

test("actionableTail: system-only tail -> hasSystemOnly, no userMsg, no toolResults", () => {
  const t = actionableTail([SYS("a"), SYS("b")]);
  assert.equal(t.hasSystemOnly, true);
  assert.equal(t.userMsg, null);
  assert.equal(t.isToolResult, false);
  assert.deepEqual(t.toolResults, []);
});

test("actionableTail: mixed user text + tool_result blocks in one user message is a tool_result turn", () => {
  const mixed = {
    role: "user",
    content: [
      { type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "data" }] },
      { type: "text", text: "and a note" },
    ],
  };
  const t = actionableTail([ATOOL(), mixed, SYS("r")]);
  assert.equal(t.isToolResult, true);
  assert.equal(t.toolResults.length, 1);
  assert.equal(t.userMsg, null); // tool_result message is resolved, not pushed as a fresh turn
});

test("actionableTail: multiple user turns -> latest user text wins as userMsg", () => {
  const t = actionableTail([U("first"), U("second"), SYS("r")]);
  assert.equal(t.userMsg?.content?.[0]?.text, "second");
  assert.equal(t.isToolResult, false);
});

test("actionableTail: empty tail -> nothing actionable", () => {
  const t = actionableTail([]);
  assert.equal(t.userMsg, null);
  assert.equal(t.isToolResult, false);
  assert.equal(t.hasSystemOnly, false);
});

// ---------------------------------------------------------------------------
// decideWarmAction — the warm-session decision tree (the 4 tail shapes from the
// plan). This is what handleMessages uses for a matched live session.
// ---------------------------------------------------------------------------

test("decideWarmAction: [assistant, user:text, system] -> push the user text (Symptom 1 fix)", () => {
  const d = decideWarmAction([A("ok"), U("well the background subagent also got stuck"), SYS("away_summary")]);
  assert.equal(d.action, "push");
  assert.equal(d.userMsg?.content?.[0]?.text, "well the background subagent also got stuck");
  assert.deepEqual(d.toolResults, []);
});

test("decideWarmAction: [assistant(tool_use), user:tool_result, system] -> resolve, not push (Symptom 2 fix)", () => {
  const d = decideWarmAction([ATOOL("Read", "t1"), URES("t1"), SYS("reminder")]);
  assert.equal(d.action, "resolve");
  assert.equal(d.toolResults.length, 1);
  assert.equal(d.toolResults[0].tool_use_id, "t1");
  assert.equal(d.userMsg, null);
});

test("decideWarmAction: normal single user turn -> push exactly that turn", () => {
  const d = decideWarmAction([U("next")]);
  assert.equal(d.action, "push");
  assert.equal(d.userMsg?.content?.[0]?.text, "next");
});

test("decideWarmAction: system-only tail -> noop (no fabricated user turn)", () => {
  const d = decideWarmAction([SYS("recap"), SYS("reminder")]);
  assert.equal(d.action, "noop");
  assert.equal(d.userMsg, null);
  assert.deepEqual(d.toolResults, []);
});

test("decideWarmAction: empty tail -> noop", () => {
  const d = decideWarmAction([]);
  assert.equal(d.action, "noop");
});
