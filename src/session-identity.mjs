// session-identity.mjs - content-derived session identity (bucket + processed-
// prefix hashing), transcript rendering, mimicry-safe cold-start priming, and
// warm-turn classification (actionableTail/decideWarmAction).

import { createHash } from "node:crypto";
import { LOG_PREFIX, metrics } from "./metrics.mjs";
import { stripCacheControl, toUserFrame } from "./wire.mjs";

// Extract system prompt text from Anthropic `system` field (string or array).
function extractSystemText(system) {
  if (!system) return "";
  if (typeof system === "string") return system;
  if (Array.isArray(system)) {
    return system.map((b) => (b.type === "text" ? b.text : "")).join("\n");
  }
  return "";
}

// Session identity: the client speaks the stateless Anthropic API and sends NO
// conversation id for BYOK/custom models, so identity is derived from content:
//   - bucketKey = hash(system + first user message) groups candidate sessions.
//   - within a bucket, the incoming history must match a live session's already
//     -processed message prefix (hashMessages) — two conversations that diverge
//     at any turn get different sessions, so they cannot bleed.

// Flatten one message's content blocks to text (used for bucketing + transcript).
function renderMsgText(message) {
  if (!message) return "";
  const c = message.content;
  if (!Array.isArray(c)) return String(c || "");
  return c
    .map((b) => {
      if (!b || typeof b !== "object") return "";
      if (b.type === "text") return b.text || "";
      if (b.type === "tool_use") return `[tool_use ${b.name}] ${JSON.stringify(b.input || {})}`;
      if (b.type === "tool_result") {
        const inner = Array.isArray(b.content)
          ? b.content.map((x) => (x?.type === "text" ? x.text : JSON.stringify(x))).join("\n")
          : String(b.content ?? "");
        return `[tool_result] ${inner}`;
      }
      if (b.type === "thinking") return b.thinking || "";
      return "";
    })
    .join("\n");
}

// Bucket key: groups sessions that could belong to the same conversation; the
// final match is by history prefix. When the client supplies a stable
// conversation id (Claude Code sends `x-claude-code-session-id`), use it
// directly — this deterministically separates parallel conversations that
// share an identical system+first-user prefix (e.g. fan-out subagents), which
// content hashing alone cannot. Falls back to hash(system + first user msg).
//
// cwd is part of identity on BOTH paths: the same conversation id or content in
// two different working directories must NOT share a session, because cwd is
// baked into the SDK query()'s env block at creation and cannot change after.
function bucketKey(system, messages, convId = null, cwd = "") {
  if (convId) return cwd ? `cc:${cwd}\u0000${convId}` : `cc:${convId}`;
  const firstUser = (messages || []).find((m) => m.role === "user");
  const text = cwd + "\u0000" + extractSystemText(system) + "\u0000" + renderMsgText(firstUser);
  return createHash("sha256").update(text).digest("hex").slice(0, 32);
}

// Hash of messages[0..n) with cache_control stripped (clients mutate cache_control
// across turns, so it must not affect identity). Used to prove that an incoming
// history extends a live session's already-processed prefix.
function hashMessages(messages, n) {
  const slice = (messages || []).slice(0, n).map(stripCacheControl);
  return createHash("sha256").update(JSON.stringify(slice)).digest("hex").slice(0, 32);
}

// Render a full transcript to role-labeled text for cold-start priming (model
// swap / TTL eviction / restart). Prior tool calls become narrative context;
// the live loop still drives every NEW tool call.
function renderTranscript(messages) {
  return (messages || [])
    .map((m) => `${m.role === "assistant" ? "Assistant" : "User"}: ${renderMsgText(m)}`)
    .join("\n\n");
}

// renderMsgText (above) is the IDENTITY renderer: it feeds bucketKey/hashMessages
// and must stay byte-stable, so it keeps the literal `[tool_use X] {json}` /
// `[tool_result] ...` grammar. That exact grammar, when fed back to the model as
// cold-start priming, is a near-perfect few-shot template the model copies — it
// emits literal `[tool_use ...]` text and fabricates `User: [tool_result]` turns
// instead of native tool_use blocks. The renderers below are a SEPARATE priming
// surface that deliberately destroys that grammar: prose only, no bracket tags,
// no standalone JSON, no Assistant:/User: dialogue script, thinking dropped.

function previewJson(value, max = 200) {
  let s;
  try { s = JSON.stringify(value ?? {}); } catch { s = String(value); }
  if (s.length > max) s = `${s.slice(0, max)}\u2026`;
  return s;
}

function summarizePrimingResult(b, max = 400) {
  const inner = Array.isArray(b.content)
    ? b.content.map((x) => (x?.type === "text" ? x.text : JSON.stringify(x))).join(" ")
    : String(b.content ?? "");
  const t = inner.length > max ? `${inner.slice(0, max)}\u2026` : inner;
  return b.is_error ? `error: ${t}` : t;
}

// Prose summary of one message for priming. Collapses ALL of a turn's tool calls
// into a single clause (the repeated [tool_use]\n[tool_use] pattern is what fuels
// the mimicry), omits thinking, and never uses the bracket grammar.
function renderMsgPriming(m) {
  if (!m) return null;
  const c = Array.isArray(m.content) ? m.content : [{ type: "text", text: String(m.content ?? "") }];
  const texts = [];
  const calls = [];
  const results = [];
  for (const b of c) {
    if (!b || typeof b !== "object") continue;
    if (b.type === "text") { if (b.text) texts.push(b.text.trim()); }
    else if (b.type === "tool_use") calls.push(`${b.name} ${previewJson(b.input)}`);
    else if (b.type === "tool_result") results.push(summarizePrimingResult(b));
    // thinking intentionally dropped — raw chain-of-thought must not leak.
  }
  const isAsst = m.role === "assistant";
  const parts = [];
  if (texts.length) parts.push(`${isAsst ? "You wrote" : "The user wrote"}: ${texts.join(" ")}`);
  if (calls.length) parts.push(`${isAsst ? "you" : "the user"} called the tools ${calls.join(", ")}`);
  if (results.length) parts.push(`those calls returned: ${results.join(" || ")}`);
  if (!parts.length) return null;
  return `${parts.join("; ")}.`;
}

// Full prior-context summary for cold-start priming. Mimicry-safe by construction.
function renderPrimingTranscript(messages) {
  return (messages || []).map(renderMsgPriming).filter(Boolean).join("\n");
}

// Wrap a priming summary in an explicit read-only boundary with the actionable
// instruction placed AFTER the (long) summary so recency keeps it salient.
function primingFrameText(summary) {
  return (
    `<prior_conversation_summary readonly="true">\n${summary}\n</prior_conversation_summary>\n\n` +
    "The block above is a READ-ONLY summary of earlier conversation context, provided only so you can continue. " +
    'Do NOT reproduce its wording or format, do NOT emit text like "[tool_use ...]" or "[tool_result]", and do NOT fabricate user messages or tool results. ' +
    "Continue the conversation now; if you need to act, issue real tool calls using your normal tool-calling mechanism."
  );
}

// One-line message summary for debug logs (never sent to the model).
function summarizeMessages(messages) {
  return (messages || [])
    .map((m) => {
      const t = Array.isArray(m.content) ? m.content.map((b) => b?.type).join("+") : "text";
      return `${m.role}:${t}`;
    })
    .join(" ");
}

// Matches the literal text grammar the model emits when it parrots a primed
// transcript instead of issuing native tool calls: `[tool_use Name]`,
// `[tool_result]`, or a fabricated `User: [tool_result]` turn.
const MIMICRY_RE = /\[tool_use\s|\[tool_result\]|User:\s*\[tool_result/;

// Detector ONLY (no auto-conversion): there is no parked MCP handler to receive
// a tool_result for a text-emitted call, so converting would wedge the turn.
// Counting + a one-shot structured log makes regressions of the cold-priming
// fix observable instead of silent.
function detectToolCallMimicry(session, m, text) {
  if (m.mimicry || typeof text !== "string" || !text) return;
  const tail = (m._mimicTail || "") + text;
  if (MIMICRY_RE.test(tail)) {
    m.mimicry = true;
    metrics.totalMimicryDetections++;
    process.stderr.write(
      `${LOG_PREFIX} WARNING tool-call mimicry in output key=${session.key.slice(0, 8)}` +
        ` action=${m.action} (model emitted literal tool-call text instead of a native tool_use)\n`
    );
    return;
  }
  m._mimicTail = tail.slice(-24);
}

function pushColdStartFrames(session, messages, last, lastIsToolResult) {
  if (lastIsToolResult) {
    session.input.push(toUserFrame({
      role: "user",
      content: [{ type: "text", text: primingFrameText(renderPrimingTranscript(messages)) }],
    }));
    return;
  }
  session.input.push(toUserFrame({
    role: "user",
    content: [{ type: "text", text: primingFrameText(renderPrimingTranscript(messages.slice(0, -1))) }],
  }));
  session.input.push(toUserFrame(last));
}

// Classify the unseen tail of a request into actionable pieces.
//
// Clients (Claude Code in particular) do NOT append exactly one new message per
// POST. They synthesize trailing `role: "system"` messages (attachments /
// reminders / recaps such as `task_reminder`, `output_style`, `away_summary`)
// AFTER the real payload. The Anthropic Messages API rejects `role: "system"`
// inside `messages`; this bridge must not let that synthesized metadata win the
// "what is the new turn?" decision, or it (a) drops the real user text and (b)
// misclassifies a `tool_result` turn as a fresh push, abandoning the parked
// tool round and wedging the SDK (the turn then never settles until the live
// query() closes). This selector is the root-cause fix for both failures.
//
// Given the unseen tail (`messages.slice(prevSeen)`), return:
//   {
//     toolResultMsgs: [...],          // the actionable msg if it carries tool_results
//     toolResults:     [...],          // its flattened tool_result blocks (for resolve)
//     userMsg:         <msg | null>,   // the actionable real user turn to push
//     isToolResult:    <bool>,         // the actionable msg is a tool_result turn
//     hasSystemOnly:   <bool>,         // no actionable user msg, only system/meta
//   }
//
// The "actionable" message is found by scanning from the END of the tail and
// taking the first `role: "user"` message, skipping `assistant` echoes (the SDK
// authored them) and `role: "system"` metadata (synthesized attachments /
// reminders / recaps that must never be coerced into a user turn). This mirrors
// the original "last message" intent but is immune to trailing system messages,
// and it stays correct when the tail is the full history (prevSeen=0 on the
// cold/resume path): only the LATEST turn's nature drives the decision, not any
// tool_result buried earlier in the conversation.
//
// A user message can carry BOTH tool_result and text (Claude Code sometimes
// appends a text note alongside results); such a message is a tool_result turn
// (resolved), not a fresh user turn.
function actionableTail(tail) {
  const list = Array.isArray(tail) ? tail : [];
  let actionable = null;
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i];
    if (!m || typeof m !== "object") continue;
    if (m.role === "user") { actionable = m; break; }
    // assistant echoes and system metadata are skipped; keep scanning back.
  }

  if (!actionable) {
    const hasSystemOnly = list.some((m) => m && m.role === "system");
    return { toolResultMsgs: [], toolResults: [], userMsg: null, isToolResult: false, hasSystemOnly };
  }

  const content = Array.isArray(actionable.content) ? actionable.content : null;
  const trs = content ? content.filter((b) => b && b.type === "tool_result") : [];
  if (trs.length) {
    return { toolResultMsgs: [actionable], toolResults: trs, userMsg: null, isToolResult: true, hasSystemOnly: false };
  }
  return { toolResultMsgs: [], toolResults: [], userMsg: actionable, isToolResult: false, hasSystemOnly: false };
}

// Decide the warm-session action from a classified unseen tail. Pure + exported
// so the request-handler decision tree is unit-testable without an HTTP harness.
//
// Returns { action: "resolve"|"push"|"noop", toolResults, userMsg }.
//   - "resolve": the tail carries tool_result(s) for the parked handler.
//   - "push":    the tail has a real user turn to feed the SDK.
//   - "noop":    only system/meta (or nothing) — do not fabricate a user turn.
function decideWarmAction(tail) {
  const cls = actionableTail(tail);
  if (cls.isToolResult) return { action: "resolve", toolResults: cls.toolResults, userMsg: null };
  if (cls.userMsg) return { action: "push", toolResults: [], userMsg: cls.userMsg };
  return { action: "noop", toolResults: [], userMsg: null };
}

export {
  extractSystemText,
  renderMsgText,
  bucketKey,
  hashMessages,
  renderTranscript,
  renderMsgPriming,
  renderPrimingTranscript,
  primingFrameText,
  summarizeMessages,
  detectToolCallMimicry,
  pushColdStartFrames,
  actionableTail,
  decideWarmAction,
};
