// server.mjs — Anthropic-compatible HTTP bridge to the Claude Agent SDK.
//
// Exposes POST /v1/messages. The Claude Agent SDK owns tool execution and the
// assistant transcript (its stream-json input accepts ONLY user frames — it
// cannot ingest a caller's pre-baked assistant / tool_use history), so a
// stateless one-shot query() per request cannot drive a multi-turn tool loop.
// A client like Factory Droid, however, speaks the stateless Anthropic Messages
// API: it POSTs the full history each turn, executes tool_use blocks itself, and
// POSTs back tool_result.
//
// This bridge reconciles the two by holding ONE live query() per conversation:
//   - Session identity = bucket(system + first user message) + a prefix match of
//     the already-processed history, so two conversations that diverge at any
//     turn get separate sessions and cannot bleed into each other.
//   - The client's tools are registered as REAL MCP handlers. When the model
//     calls a tool, the handler PARKS on a promise and the tool_use streams to
//     the client as SSE; the HTTP turn ends so the client can execute it. The
//     client POSTs the tool_result on the next request, the bridge resolves the
//     parked promise, the SDK loop continues, and the next assistant message
//     streams back.
//   - Cold start (model swap / TTL eviction / restart): a fresh session is
//     primed with the full prior transcript so context is recovered; the live
//     loop still drives every NEW tool call.
//   - Sessions idle past SESSION_TTL_MS (default 3 h) are closed by a sweeper,
//     unless a client tool round is still active. The TTL is a UX choice (keep
//     sessions warm across normal idle gaps), not a prompt-cache-alignment
//     choice — 3 h exceeds the 5 m / 1 h cache windows.
//
// Authentication is handled by src/auth.mjs BEFORE this module's query() runs:
// the SDK's bundled `claude` authenticates natively off the profile named by
// CLAUDE_CONFIG_DIR.
//
// Streaming: SDKPartialAssistantMessage.event is a BetaRawMessageStreamEvent —
// the exact Anthropic SSE event, forwarded verbatim (only tool_use.name is
// de-namespaced from the SDK's mcp__<id>__ prefix).

import http from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { query, createSdkMcpServer, z } from "./sdk.mjs";
import {
  profileKey,
  defaultIndexPath,
  loadResumeIndex,
  saveResumeIndex,
  findResumeCandidate,
  upsertResumeEntry,
  buildResumeCatchupFrames,
} from "./resume-index.mjs";
import {
  CodeValidationError,
  validateCodeInput,
  runCodeScriptDynamic,
  buildCodeToolDescription,
  formatCodeResult,
  codeToolInputShape,
  normalizeClientToolMeta,
} from "./code-mode.mjs";
import { initCacheLog, appendCacheLog, cacheLogEnabled, cacheLogPath, cacheCreationSplit } from "./cache-log.mjs";
import {
  createAnchorState,
  annotateReadResult,
  translateEditInput,
  reconcileEdit,
  mergeAnchorEditSchema,
  patchCodeEditDescription,
  hasAnchorFields,
  ANCHORED_READ_TOOLS,
  ANCHORED_EDIT_TOOLS,
} from "./anchor-edit.mjs";

const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS || process.env.ACP_SESSION_TTL_MS || 10800000); // 3 h
const HEARTBEAT_MS = Number(process.env.HEARTBEAT_MS || process.env.ACP_HEARTBEAT_MS || 15000);
const TOOL_TIMEOUT_MS = Number(process.env.TOOL_TIMEOUT_MS || process.env.ACP_TOOL_TIMEOUT_MS || 1800000); // 30 min; a tool_result that never arrives returns isError so the SDK loop survives
// NOTE: there is intentionally NO turn-level timeout/watchdog. A clock-based
// backstop only masks the real failure (a wedged turn) and silently drops
// context. Turn teardown is purely EVENT-DRIVEN off the SDK query() lifecycle:
// when the live query()'s async iterator ends, errors, or is aborted,
// consumeSession() immediately settles the attached turn (failTurn) and abandons
// any parked tool round. A turn that never settles means the SDK genuinely never
// emitted message_stop and never closed — that is a real bug to root-cause from
// the event stream, not something to paper over with a timer.
const CODE_SCRIPT_TIMEOUT_MS = Number(process.env.CODE_SCRIPT_TIMEOUT_MS || 0); // 0 = no cap
const CODE_MAX_WAVES = Number(process.env.CODE_MAX_WAVES || 0); // 0 = unlimited
const CODE_MAX_CALLS = Number(process.env.CODE_MAX_CALLS || 0); // 0 = unlimited
const LOG_PREFIX = "[claude-agent-api]";

// Per-request working directory.
//
// In real Claude Code, cwd is a per-process mutable value seeded from the launch
// directory and read fresh into the `<env>Working directory: ...` block. This
// proxy is a single long-lived daemon serving many clients in many projects, so
// it has no inherent knowledge of any client's directory — `process.cwd()` is a
// single global that can't represent N concurrent conversations. The client must
// therefore tell us, per request, via the `x-claude-cwd` header (launch Claude
// Code with ANTHROPIC_CUSTOM_HEADERS="x-claude-cwd: $PWD"). We validate it is an
// existing absolute directory and fall back to CLAUDE_PROXY_CWD, then the
// daemon's own process.cwd(). Mid-session `cd` drift self-corrects: the SDK
// query() is itself a real Claude Code engine whose Bash tool tracks cwd within
// the session — we only need the initial dir right.
const PROXY_CWD_FALLBACK = (() => {
  const env = process.env.CLAUDE_PROXY_CWD;
  if (env && isValidCwd(env)) return env;
  return process.cwd();
})();

function isValidCwd(p) {
  if (typeof p !== "string" || !p.trim() || !isAbsolute(p)) return false;
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// Resolve the working directory for a request: a valid x-claude-cwd header wins,
// otherwise the daemon-wide fallback (CLAUDE_PROXY_CWD or process.cwd()).
function resolveCwd(headerVal) {
  const h = Array.isArray(headerVal) ? headerVal[0] : headerVal;
  if (isValidCwd(h)) return h;
  if (h != null && h !== "") {
    process.stderr.write(`${LOG_PREFIX} ignoring invalid x-claude-cwd header (${String(h).slice(0, 120)}); using ${PROXY_CWD_FALLBACK}\n`);
  }
  return PROXY_CWD_FALLBACK;
}

// Models surfaced via the /v1/models catalog so Claude Code's startup model
// validation succeeds. The SDK is the real source of truth at query time; this
// is just a "yes, that model is available" catalog.
const KNOWN_MODELS = [
  "claude-opus-4-8",
  "claude-sonnet-4-6",
  "claude-haiku-4-5",
  "claude-opus-4-1-20250805",
  "claude-sonnet-4-5-20250929",
];

// Claude Code decorates model ids with context-window suffixes like
// "claude-opus-4-8[1m]" (1M context). The Anthropic API / SDK do not accept
// the bracketed suffix, so strip it before handing the id to query().
function normalizeModel(model) {
  if (typeof model !== "string") return model;
  return model.replace(/\[[^\]]*\]\s*$/, "").trim();
}

function modelObject(id) {
  const base = normalizeModel(id) || id;
  return {
    type: "model",
    id,
    display_name: base,
    created_at: "2025-01-01T00:00:00Z",
  };
}

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

// Build the Zod raw shape for one tool's top-level input_schema, preserving the
// caller's full JSON Schema via the bundled Zod v4 z.fromJSONSchema (which
// resolves oneOf/anyOf/allOf/$ref/$defs/const/nullable/format/pattern/bounds).
// Falls back to a permissive per-property converter on the rare unrepresentable
// schema so one exotic tool can never break the whole request.
function toolInputShape(schema) {
  if (!schema || typeof schema !== "object") return {};
  try {
    const zt = z.fromJSONSchema(schema, { unrepresentable: "any" });
    if (zt && zt.shape && typeof zt.shape === "object") return zt.shape;
  } catch (e) {
    process.stderr.write(`${LOG_PREFIX} fromJSONSchema failed (${String(e?.message || e).slice(0, 100)}); using permissive fallback\n`);
  }
  return fallbackShape(schema);
}

function fallbackShape(schema) {
  const shape = {};
  const required = new Set(schema.required || []);
  for (const [k, v] of Object.entries(schema.properties || {})) {
    const converted = jsonSchemaToZod(v);
    shape[k] = required.has(k) ? converted : converted.optional();
  }
  return shape;
}

function jsonSchemaToZod(schema) {
  if (!schema || typeof schema !== "object") return z.unknown();
  const desc = schema.description || "";
  if (schema.enum) return z.enum(schema.enum).describe(desc);
  switch (schema.type) {
    case "string": return z.string().describe(desc);
    case "number":
    case "integer": return z.number().describe(desc);
    case "boolean": return z.boolean().describe(desc);
    case "array": return z.array(jsonSchemaToZod(schema.items)).describe(desc);
    case "object": {
      const shape = {};
      const required = new Set(schema.required || []);
      for (const [k, v] of Object.entries(schema.properties || {})) {
        const converted = jsonSchemaToZod(v);
        shape[k] = required.has(k) ? converted : converted.optional();
      }
      return z.object(shape).describe(desc);
    }
    default: return z.unknown();
  }
}

// The SDK namespaces in-process MCP tools as mcp__<serverId>__<originalName>.
// The serverId is a numeric index (observed mcp__0__), never containing an
// underscore, so /^mcp__[^_]+__/ strips exactly one namespace segment.
const BRIDGE_NS_RE = /^mcp__[^_]+__/;

// Restore the caller's original tool name from the SDK-namespaced tool_use name.
function stripBridgeToolName(name, originalNames) {
  if (typeof name !== "string") return name;
  if (originalNames && originalNames.has(name)) return name;
  const stripped = name.replace(BRIDGE_NS_RE, "");
  if (!originalNames || originalNames.has(stripped)) return stripped;
  return stripped;
}

// Normalize a tool input value through the SAME Zod object schema the MCP layer
// used to validate the handler's args. The SDK's validateToolInput runs
// normalizeObjectSchema(inputSchema).parse(raw), which injects every JSON-Schema
// `default` and applies coercions — so the args the handler receives are NOT the
// raw JSON the model streamed. Running BOTH the streamed entry.input and the
// handler args through our parser (built from the same shape) canonicalizes them
// to the same form, making isDeepStrictEqual succeed. Idempotent: parsing an
// already-normalized value yields the same object. Identity when no parser is
// registered (keeps pure-logic tests and bare sessions working).
function normalizeToolInput(session, name, value) {
  const parser = session.inputParsers?.get(name);
  if (!parser) return value;
  try {
    const r = parser.safeParse(value);
    return r.success ? r.data : value;
  } catch {
    return value;
  }
}

// Opportunistic, future-proof id hint: if the SDK ever forwards the Anthropic
// tool_use.id into the handler's extra._meta, claim that id directly and skip
// content matching entirely. Today the mcp_message path forwards a plain
// JSON-RPC tools/call with no Anthropic id, so this scans _meta for any value
// that already equals a currently-streamed id — zero-risk: a value only matches
// if it genuinely is one of our streamed ids.
function extractIdHint(session, extra) {
  const meta = extra && typeof extra === "object" ? extra._meta : null;
  if (!meta || typeof meta !== "object") return null;
  const ids = new Set();
  for (const e of session.streamedToolUses) if (e && e.id) ids.add(e.id);
  if (!ids.size) return null;
  for (const v of Object.values(meta)) {
    if (typeof v === "string" && ids.has(v)) return v;
  }
  return null;
}

// Claim the streamed tool_use entry that corresponds to a handler invocation.
// The SDK does not pass the tool_use id to the handler, but it passes the tool
// name (via the handler closure) and the validated input args. We correlate in
// layered priority so a correlation miss can never silently wedge a session:
//   1. Direct id (idHint) — if a real tool_use.id was forwarded via extra._meta.
//   2. Exact normalized (name + normalized input) — the primary path; defaults
//      and coercions are canceled by parsing both sides through the same schema.
//   3. Per-name single candidate — safety net for a uniquely-named tool whose
//      normalization drifted; avoids FIFO when only one entry shares the name.
//   4. Global FIFO (last resort) — preserves prior behavior, but structured log
//      + counter make the drift observable instead of a silent 4.5-min hang.
function claimStreamedToolUse(session, name, args, idHint = null) {
  // 1. Direct id.
  if (idHint) {
    const idx = session.streamedToolUses.findIndex((e) => e && e.id === idHint);
    if (idx !== -1) return session.streamedToolUses.splice(idx, 1)[0] || null;
  }

  // 2. Exact normalized (name + normalized input).
  const normArgs = normalizeToolInput(session, name, args);
  for (let i = 0; i < session.streamedToolUses.length; i++) {
    const entry = session.streamedToolUses[i];
    if (!entry || entry.name !== name) continue;
    if (isDeepStrictEqual(normalizeToolInput(session, name, entry.input), normArgs)) {
      return session.streamedToolUses.splice(i, 1)[0] || null;
    }
  }

  // 3. Per-name single candidate.
  let sameNameIdx = -1;
  let sameNameCount = 0;
  for (let i = 0; i < session.streamedToolUses.length; i++) {
    const entry = session.streamedToolUses[i];
    if (entry && entry.name === name) { sameNameIdx = i; sameNameCount++; }
  }
  if (sameNameCount === 1) {
    return session.streamedToolUses.splice(sameNameIdx, 1)[0] || null;
  }

  // 4. Global FIFO (last resort) — observable.
  if (session.streamedToolUses.length) {
    const fallback = session.streamedToolUses[0];
    session.fifoFallbacks = (session.fifoFallbacks || 0) + 1;
    totalFifoFallbacks++;
    const remaining = session.streamedToolUses.map((e) => e?.id).filter(Boolean).join(",");
    process.stderr.write(
      `${LOG_PREFIX} tool correlation FIFO fallback for ${name}: no exact match `
      + `(args=${JSON.stringify(args).slice(0, 200)}); claiming ${fallback?.id}`
      + ` (remaining: ${remaining})\n`
    );
    return session.streamedToolUses.shift();
  }
  return null;
}

// Build an SDK MCP server whose handlers PARK: when the model calls a tool, the
// handler claims the matching streamed tool_use id, then either returns a result
// that already arrived, or returns a promise that the bridge resolves when the
// client POSTs the matching tool_result. A watchdog timeout returns {isError:true}
// so the SDK agent loop survives a never-delivered tool result.
//
// Code mode is the only mode: the model is offered exactly ONE tool, `code`.
// The model writes an async JS script that calls the client's tools via
// `await tools.<Name>(args)`; the bridge fabricates synthetic client tool_use
// blocks for each await wave (see dispatchCodeWave). The native client tools are
// never registered with the SDK — they are only known to the script runtime, so
// the model has no way to call them directly.
function buildParkingMcpServer(tools, session, createServer = createSdkMcpServer) {
  if (!tools || !tools.length) return null;

  const makeHandler = (originalName) => async (args, extra) => {
    session.lastActivity = Date.now();
    const idHint = extractIdHint(session, extra);
    const entry = claimStreamedToolUse(session, originalName, args, idHint);
    const id = entry?.id;

    if (id && session.resolvedResults.has(id)) {
      const r = session.resolvedResults.get(id);
      session.resolvedResults.delete(id);
      session.lastActivity = Date.now();
      return r;
    }

    return new Promise((resolve) => {
      let settled = false;
      // The `code` handler parks for an ENTIRE multi-wave run, not a single
      // tool_result. Capping it with TOOL_TIMEOUT_MS would kill a legitimately
      // long-running script mid-run (punishing intelligent code-mode logic), so
      // it parks with no per-run clock: a genuine client disconnect is caught
      // event-driven by onClose, and a dead session (client received a wave and
      // never returned) is reclaimed by the idle sweeper (SESSION_TTL_MS,
      // refreshed on every wave POST). Every teardown path resolves this handler
      // via abandonToolRound, so dropping the timer never orphans it. Individual
      // client tools keep the bounded park so the SDK loop survives one missing
      // tool_result.
      const timer = originalName === "code" ? null : setTimeout(() => {
        if (!settled) {
          settled = true;
          if (id) session.pendingTools.delete(id);
          else {
            const idx = session.orphanResolvers.indexOf(wrappedResolve);
            if (idx !== -1) session.orphanResolvers.splice(idx, 1);
          }
          session.lastActivity = Date.now();
          process.stderr.write(`${LOG_PREFIX} tool ${id ?? originalName} park timeout after ${TOOL_TIMEOUT_MS}ms; returning isError\n`);
          resolve({ content: [{ type: "text", text: `Tool result was not provided within ${TOOL_TIMEOUT_MS}ms` }], isError: true });
        }
      }, TOOL_TIMEOUT_MS);

      const wrappedResolve = (result) => {
        if (!settled) {
          settled = true;
          if (timer) clearTimeout(timer);
          session.lastActivity = Date.now();
          resolve(result);
        }
      };

      if (id) session.pendingTools.set(id, wrappedResolve);
      else session.orphanResolvers.push(wrappedResolve);
    });
  };

  // Populate session.clientTools (the script runtime's tool catalog, used to
  // render the `code` tool description and validate wave args in dispatchCodeWave)
  // and session.inputParsers (canonical z.object parser per tool, mirroring the
  // MCP layer's validateToolInput so claimStreamedToolUse can normalize both the
  // streamed raw input and the handler's parsed args to the same form). Anchor
  // editing is additive in code mode: the native old_string path still works
  // (scripts derive bytes from the Read result), and anchor fields are merged in
  // as OPTIONAL so the rendered `code` signature documents both. Translation back
  // to native happens in dispatchCodeWave.
  session.clientTools = session.clientTools || new Map();
  for (const t of tools) {
    const anchorOn = ANCHORED_EDIT_TOOLS.has(t.name);
    session.clientTools.set(t.name, normalizeClientToolMeta(t.name, {
      description: anchorOn ? patchCodeEditDescription(t.name, t.description || "") : (t.description || ""),
      input_schema: anchorOn
        ? mergeAnchorEditSchema(t.name, t.input_schema || { type: "object", properties: {} })
        : (t.input_schema || { type: "object", properties: {} }),
    }));
    const shape = toolInputShape(t.input_schema || { type: "object", properties: {} });
    try {
      const parser = z.object(shape);
      if (session.inputParsers) session.inputParsers.set(t.name, parser);
    } catch (e) {
      process.stderr.write(`${LOG_PREFIX} z.object(shape) failed for ${t.name} (${String(e?.message || e).slice(0, 100)}); correlation will use raw input\n`);
    }
  }

  const codeShape = codeToolInputShape(z);
  const codeTool = {
    name: "code",
    description: buildCodeToolDescription(session.clientTools),
    inputSchema: codeShape,
    handler: makeHandler("code"),
  };
  return createServer({ name: "bridge", tools: [codeTool], alwaysLoad: true });
}

// Deep-remove cache_control from a content block (client TTLs conflict with the
// API's ordering rules when forwarded through the SDK). Recurses into nested
// content arrays (e.g. tool_result.content[]).
function stripCacheControl(block) {
  if (Array.isArray(block)) return block.map(stripCacheControl);
  if (!block || typeof block !== "object") return block;
  const { cache_control, ...rest } = block;
  if (Array.isArray(rest.content)) rest.content = rest.content.map(stripCacheControl);
  return rest;
}

// Convert a client tool_result block into an MCP CallToolResult.
function toCallToolResult(block) {
  let text;
  if (Array.isArray(block.content)) {
    text = block.content.map((c) => (c.type === "text" ? c.text : JSON.stringify(c))).join("\n");
  } else {
    text = String(block.content ?? "");
  }
  const result = { content: [{ type: "text", text }] };
  if (block.is_error) result.isError = true;
  return result;
}

// Build an SDKUserMessage frame for a user turn (cache_control stripped).
function toUserFrame(message) {
  const content = Array.isArray(message.content) ? message.content.map(stripCacheControl) : message.content;
  return { type: "user", message: { role: "user", content }, parent_tool_use_id: null };
}

function jsonResp(res, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
    ...extraHeaders,
  });
  res.end(payload);
}

function sseEvent(eventType, data) {
  return `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
}

function normalizeRateLimitUtilization(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const normalized = n > 1 ? n / 100 : n;
  return Math.min(1, Math.max(0, normalized));
}

function rateLimitUtilization(info) {
  if (!info || typeof info !== "object") return null;
  return normalizeRateLimitUtilization(info.utilization ?? info.used_percentage ?? info.used_percent);
}

// Coerce a reset timestamp to unix SECONDS (Claude Code parses `Number(header)`
// and treats it as epoch seconds). Accepts unix seconds, unix millis, or an
// ISO-8601 string (the shape the SDK get_usage control method returns).
function rateLimitResetSeconds(value) {
  if (value == null) return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 1e11 ? Math.round(value / 1000) : Math.round(value);
  }
  const parsed = Date.parse(String(value));
  if (Number.isFinite(parsed)) return Math.round(parsed / 1000);
  return null;
}

// Build the exact unified rate-limit headers Claude Code parses (binary fn
// `zda`): for each window it requires BOTH `-<abbrev>-utilization` (0..1) AND
// `-<abbrev>-reset` (unix seconds) or it drops the window entirely. Abbrevs are
// `5h` (five_hour) and `7d` (seven_day). The statusline turns utilization*100
// into the `used_percentage` it renders.
function rateLimitHeadersFromInfo(rateLimitInfo) {
  if (!rateLimitInfo || typeof rateLimitInfo !== "object") return {};
  if (rateLimitInfo.rate_limits) return rateLimitHeadersFromInfo(rateLimitInfo.rate_limits);
  const headers = {};
  for (const [key, abbrev] of [["five_hour", "5h"], ["seven_day", "7d"]]) {
    const window = rateLimitInfo[key];
    if (!window || typeof window !== "object") continue;
    const util = rateLimitUtilization(window);
    const reset = rateLimitResetSeconds(window.resets_at ?? window.resetsAt);
    if (util == null || reset == null) continue;
    headers[`anthropic-ratelimit-unified-${abbrev}-utilization`] = String(util);
    headers[`anthropic-ratelimit-unified-${abbrev}-reset`] = String(reset);
  }
  return headers;
}

let lastRateLimitHeaders = {};

function rememberRateLimitHeaders(session, rateLimitInfo) {
  const headers = rateLimitHeadersFromInfo(rateLimitInfo);
  if (!Object.keys(headers).length) return headers;
  if (session) session.rateLimitHeaders = { ...(session.rateLimitHeaders || {}), ...headers };
  lastRateLimitHeaders = { ...lastRateLimitHeaders, ...headers };
  return headers;
}

function latestRateLimitHeaders(session) {
  const own = session?.rateLimitHeaders;
  if (own && Object.keys(own).length) return { ...own };
  return { ...(lastRateLimitHeaders || {}) };
}

// The SDK stream's `rate_limit_event` carries only a flat status/resetsAt and
// (on Max plans) NO utilization percentage. The real 5h/7d utilization the
// statusline needs lives behind the SDK control method get_usage, which returns
// the nested { five_hour:{utilization}, seven_day:{utilization} } shape (0-100).
// Pull it on demand and cache the synthesized headers on the session + globally.
// Guarded so only one refresh is in flight per session.
async function refreshRateLimitsFromControl(session) {
  if (!session || session.rateLimitRefreshing) return;
  const fn = session.query?.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET;
  if (typeof fn !== "function") return;
  session.rateLimitRefreshing = true;
  try {
    const usage = await fn.call(session.query);
    if (usage?.rate_limits_available && usage.rate_limits) {
      rememberRateLimitHeaders(session, usage.rate_limits);
    }
  } catch (e) {
    process.stderr.write(`${LOG_PREFIX} rate-limit usage refresh failed: ${String(e?.message || e).slice(0, 120)}\n`);
  } finally {
    session.rateLimitRefreshing = false;
  }
}

function ensureSseHeaders(session) {
  const res = session?.res;
  if (!res || res.headersSent || session.sseHeadersWritten) return;
  const headers = {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
    ...latestRateLimitHeaders(session),
  };
  if (typeof res.writeHead === "function") {
    res.writeHead(200, headers);
  } else if (typeof res.setHeader === "function") {
    for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
    res.statusCode = 200;
  }
  session.sseHeadersWritten = true;
  res.flushHeaders?.();
}

function writeSseChunk(session, chunk) {
  ensureSseHeaders(session);
  session.res.write(chunk);
}

// Reconstruct content blocks from Anthropic stream events (non-streaming mode).
function accumulateStreamEvent(blocks, event) {
  switch (event.type) {
    case "content_block_start": {
      const cb = event.content_block;
      if (!cb) break;
      blocks[event.index] = JSON.parse(JSON.stringify(cb));
      break;
    }
    case "content_block_delta": {
      const d = event.delta;
      if (!d) break;
      const block = blocks[event.index];
      if (!block) break;
      switch (d.type) {
        case "text_delta": block.text = (block.text || "") + (d.text || ""); break;
        case "thinking_delta": block.thinking = (block.thinking || "") + (d.thinking || ""); break;
        case "signature_delta": block.signature = (block.signature || "") + (d.signature || ""); break;
        case "input_json_delta": block._inputJsonPartial = (block._inputJsonPartial || "") + (d.partial_json || ""); break;
        default: break;
      }
      break;
    }
    case "content_block_stop": {
      const block = blocks[event.index];
      if (block && block.type === "tool_use" && block._inputJsonPartial !== undefined) {
        try { block.input = JSON.parse(block._inputJsonPartial || "{}"); } catch { block.input = {}; }
        delete block._inputJsonPartial;
      }
      break;
    }
    default: break;
  }
}

function normalizeUsage(u) {
  if (!u) return null;
  return {
    input_tokens: u.input_tokens || 0,
    output_tokens: u.output_tokens || 0,
    cache_creation_input_tokens: u.cache_creation_input_tokens || 0,
    cache_read_input_tokens: u.cache_read_input_tokens || 0,
  };
}

// A client-facing usage object that preserves the full upstream shape (cache
// breakdown, server_tool_use, service_tier, iterations, speed, etc.) so
// downstream consumers like Claude Code's statusbar see the same fields the
// real Anthropic API would return. Shallow-clone so we can mutate output_tokens
// on message_delta without touching the cached original.
function cloneUsageForClient(u) {
  if (!u || typeof u !== "object") return null;
  const out = { ...u };
  // Guarantee the canonical four fields the SDK and clients rely on.
  out.input_tokens = u.input_tokens || 0;
  out.output_tokens = u.output_tokens || 0;
  out.cache_creation_input_tokens = u.cache_creation_input_tokens || 0;
  out.cache_read_input_tokens = u.cache_read_input_tokens || 0;
  return out;
}

// Fabricated code-mode tool-wave turns are NOT real upstream messages, so they
// must not reset visible usage to zero (Claude Code's statusbar would bounce).
// Replay the last real upstream usage if we have one; otherwise emit a complete
// zeroed usage object so clients that read usage.input_tokens never crash.
function clientVisibleUsage(session) {
  const last = session.lastRawUsage;
  if (last) return cloneUsageForClient(last);
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };
}

// ----------------------------------------------------------------------------
// Session store: one live SDK query() per conversation (per process).
// ----------------------------------------------------------------------------

const sessions = new Map(); // key (UUID) -> Session

// Process-wide count of tool-use correlations that fell through to the global
// FIFO fallback. Surfaced in /healthz so a correlation regression is a visible
// metric instead of a silent 4.5-minute park timeout.
let totalFifoFallbacks = 0;
let totalCodeCalls = 0;
let totalCodeSubCalls = 0;
let totalCodeErrors = 0;
let totalCodeWaves = 0;
let totalCacheReadTokens = 0;
let totalCacheCreationTokens = 0;
let totalMimicryDetections = 0;

// Set by startServer(); used for disk-backed SDK session resume after cold start.
let serverProfileDir = null;
let resumeIndexFile = defaultIndexPath();

function persistResumeIndex(session, model, system, messages, indexPath = resumeIndexFile) {
  if (!session.sdkSessionId || !serverProfileDir) return;
  try {
    const index = loadResumeIndex(indexPath);
    const updated = upsertResumeEntry(index, {
      profileKey: profileKey(serverProfileDir),
      bucket: session.bucket,
      seenCount: session.seenCount,
      seenHash: session.seenHash,
      sdkSessionId: session.sdkSessionId,
      model,
      codeMode: true,
    });
    saveResumeIndex(updated, indexPath);
  } catch (e) {
    process.stderr.write(`${LOG_PREFIX} resume index write failed: ${e?.message || e}\n`);
  }
}

function noteStreamTiming(session, ev) {
  const m = session.turnMetrics;
  if (!m) return;
  if (!m.firstEventAt && (ev.type === "message_start" || ev.type === "content_block_delta")) {
    m.firstEventAt = Date.now();
  }
  if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta") {
    m.textDeltas++;
    detectToolCallMimicry(session, m, ev.delta.text);
  }
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
    totalMimicryDetections++;
    process.stderr.write(
      `${LOG_PREFIX} WARNING tool-call mimicry in output key=${session.key.slice(0, 8)}` +
        ` action=${m.action} (model emitted literal tool-call text instead of a native tool_use)\n`
    );
    return;
  }
  m._mimicTail = tail.slice(-24);
}

// Fold one upstream message's usage (from message_start) into the global
// counters and the active turn row. Output is tracked per-message and flushed
// on the next message_start / at turn end (see logTurnDone), since each message
// reports a cumulative output total of its own.
function accumulateTurnUsage(session, rawUsage) {
  const read = rawUsage?.cache_read_input_tokens || 0;
  const { create5m, create1h } = cacheCreationSplit(rawUsage);
  const input = rawUsage?.input_tokens || 0;
  totalCacheReadTokens += read;
  totalCacheCreationTokens += create5m + create1h;
  const m = session.turnMetrics;
  if (!m) return;
  m.usage.input += input;
  m.usage.read += read;
  m.usage.create5m += create5m;
  m.usage.create1h += create1h;
  m.usage.output += m._curMsgOutput || 0; // flush prior message's final output
  m._curMsgOutput = rawUsage?.output_tokens || 0;
  m.messages += 1;
}

function logTurnDone(session) {
  const m = session.turnMetrics;
  if (!m) return;
  m.usage.output += m._curMsgOutput || 0; // flush the last message's output
  const total = Date.now() - m.startedAt;
  const ttft = m.firstEventAt != null ? m.firstEventAt - m.startedAt : null;
  process.stderr.write(
    `${LOG_PREFIX} turn done key=${session.key.slice(0, 8)} action=${m.action}` +
      ` ttft_ms=${ttft ?? "?"} total_ms=${total} textDeltas=${m.textDeltas}\n`
  );
  if (cacheLogEnabled()) {
    const u = m.usage;
    const create = u.create5m + u.create1h;
    appendCacheLog({
      ts: new Date().toISOString(),
      conv: session.key,
      bucket: session.bucket,
      model: session.model,
      action: m.action,
      input: u.input,
      read: u.read,
      create,
      create5m: u.create5m,
      create1h: u.create1h,
      output: u.output,
      messages: m.messages,
      hit: read_hit_ratio(u.read, create),
      codeSubCalls: m.codeSubCalls,
      codeWaves: m.codeWaves,
      scriptOutBytes: m.scriptOutBytes,
      ttftMs: ttft,
      durationMs: total,
    });
  }
  session.turnMetrics = null;
}

function read_hit_ratio(read, create) {
  const denom = read + create;
  return denom > 0 ? Number((read / denom).toFixed(4)) : null;
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

// Find the live session this request belongs to: same bucket, not closed, not
// mid-turn (a mid-turn match means a genuinely concurrent request -> fork a new
// session so we never clobber currentTurn/res), and whose already-processed
// prefix the incoming history extends. Longest matching prefix wins (most
// specific). Returns null on cold start (model swap / eviction / restart).
function findSession(messages, system, convId = null, cwd = "") {
  const b = bucketKey(system, messages, convId, cwd);
  let best = null;
  for (const s of sessions.values()) {
    if (s.bucket !== b || s.closed || s.currentTurn) continue;
    if (messages.length < s.seenCount) continue;
    if (hashMessages(messages, s.seenCount) !== s.seenHash) continue;
    if (!best || s.seenCount > best.seenCount) best = s;
  }
  return best;
}

// Record the full history this session has now processed, so the next request's
// prefix check can match it.
function markSeen(session, messages) {
  session.seenCount = messages.length;
  session.seenHash = hashMessages(messages, messages.length);
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

// Pushable, held-open async-iterable input queue for the SDK.
function makeInputQueue() {
  const items = [];
  let wake = null;
  let closed = false;
  const iterable = (async function* () {
    while (true) {
      if (items.length) { yield items.shift(); continue; }
      if (closed) return;
      await new Promise((r) => { wake = r; });
    }
  })();
  return {
    iterable,
    push(m) { items.push(m); if (wake) { const w = wake; wake = null; w(); } },
    close() { closed = true; if (wake) { const w = wake; wake = null; w(); } },
  };
}

function initMessageProjection(session) {
  session._proj = {
    clientIndex: 0,
    sdkToClient: new Map(),
    syntheticCount: 0,
    hadCode: false,
  };
}

function rejectTurnWaitersForRun(session, run, err) {
  const waiters = session.turnWaiters ?? [];
  session.turnWaiters = waiters.filter((w) => {
    if (w.run === run) {
      try { w.reject(err); } catch {}
      return false;
    }
    return true;
  });
}

function waitForCurrentTurn(session, run) {
  if (session.currentTurn && hasTurnSink(session)) return Promise.resolve();
  if (run.aborted) return Promise.reject(new Error("code run aborted"));
  return new Promise((resolve, reject) => {
    (session.turnWaiters ??= []).push({ resolve, reject, run });
  });
}

function hasTurnSink(session) {
  return !!(session.nonStream || (session.res && !session.res.writableEnded));
}

function notifyTurnAttached(session) {
  if (!session.currentTurn || !hasTurnSink(session)) return;
  const waiters = session.turnWaiters ?? [];
  session.turnWaiters = [];
  for (const w of waiters) {
    if (w.run.aborted) {
      try { w.reject(new Error("code run aborted")); } catch {}
    } else {
      try { w.resolve(); } catch {}
    }
  }
  fabricateCurrentWave(session);
}

function clearCodeRun(session, codeId) {
  const run = session.codeRun;
  if (run && run.codeId === codeId) {
    run.aborted = true;
    try { run.abortController?.abort(); } catch {}
    rejectTurnWaitersForRun(session, run, new Error("code round abandoned"));
    session.codeRun = null;
  }
}

function clearAllCodeState(session) {
  if (session.codeRun) {
    const run = session.codeRun;
    run.aborted = true;
    try { run.abortController?.abort(); } catch {}
    rejectTurnWaitersForRun(session, run, new Error("code round abandoned"));
    if (run.currentWave?.reject) {
      try { run.currentWave.reject(new Error("code round abandoned")); } catch {}
    }
    session.codeRun = null;
  }
  session.syntheticToCode?.clear();
  session.codeDriving = false;
  session.suppressEndTurn = false;
}

function hasActiveToolRound(session, { includeCurrentTurn = true } = {}) {
  return !!(
    (includeCurrentTurn && session.currentTurn) ||
    session.pendingTools?.size ||
    session.orphanResolvers?.length ||
    session.streamedToolUses?.length ||
    session.toolUseAccum?.size ||
    (
      session.codeRun ||
      session.syntheticToCode?.size ||
      session.codeDriving
    )
  );
}

function syntheticIdFor(codeToolUseId, waveSeq, idx) {
  const short = String(codeToolUseId || "code").replace(/^toolu_/, "").slice(0, 8);
  return `toolu_code_${short}_w${waveSeq}_${idx}`;
}

function emitClientToolUse(session, { syntheticId, tool, args }) {
  const p = session._proj;
  const idx = p.clientIndex++;
  const start = {
    type: "content_block_start",
    index: idx,
    content_block: { type: "tool_use", id: syntheticId, name: tool, input: {} },
  };
  const delta = {
    type: "content_block_delta",
    index: idx,
    delta: { type: "input_json_delta", partial_json: JSON.stringify(args) },
  };
  const stop = { type: "content_block_stop", index: idx };
  writeEvent(session, start);
  writeEvent(session, delta);
  writeEvent(session, stop);
  p.syntheticCount++;
  return idx;
}

function internalResolveCode(session, codeToolUseId, result) {
  resolveTool(session, codeToolUseId, result);
  session.suppressEndTurn = true;
}

// Start a dynamic code run: spin up the Worker-contained script, which will
// emit waves of tool calls. The SDK is parked on the `code` MCP handler for
// the entire run; each wave becomes a fabricated client tool turn.
function startCodeRun(session, codeToolUseId, input) {
  let normalized;
  try {
    normalized = validateCodeInput(input);
  } catch (e) {
    session.codeErrors = (session.codeErrors || 0) + 1;
    totalCodeErrors++;
    const msg = e instanceof CodeValidationError ? e.message : String(e?.message || e);
    internalResolveCode(session, codeToolUseId, {
      content: [{ type: "text", text: `code validation error: ${msg}` }],
      isError: true,
    });
    process.stderr.write(`${LOG_PREFIX} code call ${codeToolUseId}: validation failed (${msg})\n`);
    return;
  }

  // One active code run per session.
  if (session.codeRun) {
    session.codeErrors = (session.codeErrors || 0) + 1;
    totalCodeErrors++;
    internalResolveCode(session, codeToolUseId, {
      content: [{ type: "text", text: "only one active code run per session" }],
      isError: true,
    });
    process.stderr.write(`${LOG_PREFIX} code call ${codeToolUseId}: rejected — another code run is active\n`);
    return;
  }

  const { script } = normalized;
  session.codeCalls = (session.codeCalls || 0) + 1;
  totalCodeCalls++;

  const run = {
    codeId: codeToolUseId,
    script,
    abortController: new AbortController(),
    currentWave: null,       // single in-flight wave awaiting client tool_results
    waveSeq: 0,
    waveCount: 0,
    callCount: 0,
    aborted: false,
    preamble: null,          // preserved text/thinking blocks from the SDK code message
    settled: false,
  };
  session.codeRun = run;
  session.codeDriving = true;
  session.suppressEndTurn = true; // swallow T0's message_stop while the run is active

  const toolNames = [...session.clientTools.keys()];
  const t0 = Date.now();

  run.promise = runCodeScriptDynamic(script, {
    toolNames,
    maxWaves: CODE_MAX_WAVES,
    maxCalls: CODE_MAX_CALLS,
    timeoutMs: CODE_SCRIPT_TIMEOUT_MS,
    signal: run.abortController.signal,
    dispatchWave: (waveNum, calls) => dispatchCodeWave(session, codeToolUseId, waveNum, calls),
  });

  run.promise.then((result) => {
    if (run.aborted) return;
    run.settled = true;
    const waves = result.waves || 0;
    const calls = result.calls || 0;
    session.codeWaves = (session.codeWaves || 0) + waves;
    totalCodeWaves = (totalCodeWaves || 0) + waves;
    if (session.turnMetrics) session.turnMetrics.codeWaves += waves;

    let collapsed;
    if (result.error) {
      session.codeErrors = (session.codeErrors || 0) + 1;
      totalCodeErrors++;
      collapsed = {
        content: [{ type: "text", text: `code script error: ${result.error}` }],
        isError: true,
      };
      process.stderr.write(`${LOG_PREFIX} code call ${codeToolUseId}: failed (${result.error}) waves=${waves} calls=${calls}\n`);
    } else {
      collapsed = formatCodeResult(result.value, result.logs || []);
      const scriptOut = collapsed.content?.[0]?.text?.length ?? 0;
      if (session.turnMetrics) session.turnMetrics.scriptOutBytes += scriptOut;
      process.stderr.write(
        `${LOG_PREFIX} code call ${codeToolUseId}: done waves=${waves} calls=${calls} scriptOut=${scriptOut} bytes execute=${Date.now() - t0}ms\n`,
      );
    }

    session.codeDriving = false;
    clearCodeRun(session, codeToolUseId);
    // Resolve the parked `code` MCP handler so the SDK emits the final answer.
    resolveTool(session, codeToolUseId, collapsed);
  }).catch((err) => {
    if (run.aborted) return;
    run.settled = true;
    session.codeErrors = (session.codeErrors || 0) + 1;
    totalCodeErrors++;
    session.codeDriving = false;
    clearCodeRun(session, codeToolUseId);
    internalResolveCode(session, codeToolUseId, {
      content: [{ type: "text", text: `code script error: ${err?.message || err}` }],
      isError: true,
    });
    process.stderr.write(`${LOG_PREFIX} code call ${codeToolUseId}: worker error (${err?.message || err})\n`);
  });

  process.stderr.write(`${LOG_PREFIX} code call ${codeToolUseId}: starting dynamic run (tools: ${toolNames.length})\n`);
}

// Dispatch one wave of tool calls from the script. Fabricates a client-visible
// assistant message containing synthetic tool_use blocks, closes the current
// HTTP response, and returns a Promise that resolves with the wave's results
// once the client POSTs them back.
async function dispatchCodeWave(session, codeToolUseId, waveNum, calls) {
  const run = session.codeRun;
  if (!run || run.aborted) {
    return calls.map(() => ({ text: "code run aborted", raw: null, isError: true }));
  }

  // Validate args against client schemas; unknown/invalid tools return isError
  // to the script rather than fabricating an invalid client call.
  const validated = [];
  for (let i = 0; i < calls.length; i++) {
    const { name } = calls[i];
    let { args } = calls[i];
    const meta = session.clientTools.get(name);
    if (!meta) {
      validated.push({
        syntheticId: null,
        tool: name,
        args,
        inlineError: `unknown tool: ${name}`,
      });
      continue;
    }
    // Anchor editing in code mode: if the script passed anchor fields, translate
    // them to byte-exact native old_string/new_string from the cached snapshot
    // BEFORE schema validation (the native parser would otherwise reject the
    // anchor shape). Native old_string args pass through untranslated.
    let anchorPlan = null;
    if (session.anchorState && ANCHORED_EDIT_TOOLS.has(name) && hasAnchorFields(name, args)) {
      const t = translateEditInput(session.anchorState, name, args);
      if (!t.ok) {
        validated.push({
          syntheticId: null,
          tool: name,
          args,
          inlineError: `anchor edit translation failed for ${name}: ${t.reason}`,
        });
        continue;
      }
      args = t.input;
      anchorPlan = t.plan;
    }
    const parser = session.inputParsers?.get(name);
    let syntheticArgs = args;
    if (parser) {
      const r = parser.safeParse(args && typeof args === "object" ? args : {});
      if (!r.success) {
        validated.push({
          syntheticId: null,
          tool: name,
          args,
          inlineError: `invalid args for ${name}: ${r.error.message}`,
        });
        continue;
      }
      syntheticArgs = r.data;
    }
    run.callCount++;
    const syntheticId = syntheticIdFor(codeToolUseId, waveNum, i);
    validated.push({ syntheticId, tool: name, args: syntheticArgs, inlineError: null, anchorPlan });
  }

  // If all calls in this wave are inline errors, return them directly without
  // fabricating a client turn.
  const fabricatable = validated.filter((v) => v.syntheticId !== null);
  if (fabricatable.length === 0) {
    return validated.map((v) => ({ text: v.inlineError, raw: null, isError: true }));
  }

  if (run.currentWave) {
    return calls.map(() => ({ text: "previous code wave still in flight", raw: null, isError: true }));
  }

  const waveEntry = {
    waveNum,
    calls: validated,
    fabricatable,
    results: new Array(validated.length).fill(null),
    pending: new Set(fabricatable.map((v) => v.syntheticId)),
    dispatched: false,
    promise: null,
    resolve: null,
    reject: null,
  };
  waveEntry.promise = new Promise((res, rej) => { waveEntry.resolve = res; waveEntry.reject = rej; });

  run.currentWave = waveEntry;
  run.waveSeq = waveNum;
  run.waveCount++;

  try {
    if (!session.currentTurn) {
      await waitForCurrentTurn(session, run);
    }
    if (run.aborted) {
      if (run.currentWave === waveEntry) run.currentWave = null;
      return calls.map(() => ({ text: "code run aborted", raw: null, isError: true }));
    }
    fabricateCurrentWave(session);
    return await waveEntry.promise;
  } catch (e) {
    if (run.currentWave === waveEntry) run.currentWave = null;
    return calls.map(() => ({ text: e?.message || String(e), raw: null, isError: true }));
  }
}

// Fabricate the single in-flight wave onto the attached HTTP turn.
function fabricateCurrentWave(session) {
  const run = session.codeRun;
  if (!run || run.aborted) return;
  if (!session.currentTurn) return;
  if (!hasTurnSink(session)) return;
  const wave = run.currentWave;
  if (!wave || wave.dispatched) return;

  wave.dispatched = true;

  const p = session._proj;
  // Start a fresh fabricated assistant message. The client (and its subagent
  // accounting) reads message.usage.input_tokens, so a bare { role } here
  // throws "undefined is not an object (evaluating 'o.input_tokens')". Emit a
  // complete message envelope with a usage object — but replay the last real
  // upstream usage instead of zeros, so statusbar context does not bounce to
  // zero between real upstream messages during a code-mode tool wave.
  writeEvent(session, {
    type: "message_start",
    message: {
      id: `msg_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
      type: "message",
      role: "assistant",
      model: session.model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: clientVisibleUsage(session),
    },
  });

  // Emit any preserved preamble (text/thinking from the SDK code message) on
  // the first wave only.
  if (wave.waveNum === 1 && run.preamble && run.preamble.length) {
    for (const block of run.preamble) {
      const idx = p.clientIndex++;
      if (block.type === "text") {
        writeEvent(session, {
          type: "content_block_start",
          index: idx,
          content_block: { type: "text", text: block.text || "" },
        });
        writeEvent(session, {
          type: "content_block_delta",
          index: idx,
          delta: { type: "text_delta", text: block.text || "" },
        });
        writeEvent(session, { type: "content_block_stop", index: idx });
      }
    }
  }

  // Emit synthetic tool_use blocks for fabricatable calls.
  for (let i = 0; i < wave.calls.length; i++) {
    const v = wave.calls[i];
    if (v.syntheticId === null) continue; // inline error — no client block
    session.syntheticToCode.set(v.syntheticId, run.codeId);
    emitClientToolUse(session, { syntheticId: v.syntheticId, tool: v.tool, args: v.args });
  }

  // Close the fabricated message + HTTP turn. message_delta carries a usage
  // object in the real API; include one (replaying last known output tokens)
  // so clients that read delta.usage.output_tokens don't trip over undefined
  // and the statusbar doesn't bounce to zero during a code-mode tool wave.
  writeEvent(session, {
    type: "message_delta",
    delta: { stop_reason: "tool_use", stop_sequence: null },
    usage: { output_tokens: session.lastRawUsage?.output_tokens ?? 0 },
  });
  writeEvent(session, {
    type: "message_stop",
    message: { stop_reason: "tool_use" },
  });

  // endTurn closes the HTTP response; the SDK's code handler stays parked.
  // We must NOT let endTurn resolve the current turn in a way that prevents
  // the next client request from attaching. endTurn resolves currentTurn; the
  // next client POST will attach a new one.
  endTurn(session);
}

function remapIndex(session, sdkIndex) {
  const mapped = session._proj?.sdkToClient.get(sdkIndex);
  return mapped ?? sdkIndex;
}

function projectEvent(session, ev) {
  const p = session._proj;
  if (!p) return;

  // While a dynamic code run is driving, suppress SDK messages entirely.
  // The bridge fabricates client turns from script waves; the SDK's code
  // message and its trailing framing are not client-visible.
  if (session.codeDriving && session.codeRun) {
    // Collect preamble (text/thinking) from the SDK code message so we can
    // re-emit it on the first fabricated wave.
    if (ev.type === "content_block_start") {
      const cb = ev.content_block;
      if (cb?.type === "text" || cb?.type === "thinking") {
        session.codeRun.preamble = session.codeRun.preamble || [];
        session.codeRun.preamble.push({ type: cb.type, text: cb.text || cb.thinking || "" });
      }
    }
    // Update toolUseAccum so consumeSession's code-detection hook fires.
    if (ev.type === "content_block_start" && ev.content_block?.type === "tool_use") {
      // already handled by consumeSession
    }
    return;
  }

  switch (ev.type) {
    case "message_start":
      writeEvent(session, ev);
      break;
    case "content_block_start": {
      const cb = ev.content_block;
      if (cb?.type === "tool_use" && cb.name === "code") {
        p.hadCode = true;
        return; // suppress code block from client stream
      }
      const idx = p.clientIndex++;
      p.sdkToClient.set(ev.index, idx);
      writeEvent(session, { ...ev, index: idx });
      break;
    }
    case "content_block_delta": {
      if (session.toolUseAccum.has(ev.index)) {
        const acc = session.toolUseAccum.get(ev.index);
        if (acc?.name === "code") return;
      }
      writeEvent(session, { ...ev, index: remapIndex(session, ev.index) });
      break;
    }
    case "content_block_stop": {
      const mapped = p.sdkToClient.get(ev.index);
      if (mapped === undefined) {
        // code block or unmapped — handled in consumeSession start hook
        return;
      }
      writeEvent(session, { ...ev, index: mapped });
      break;
    }
    case "message_delta": {
      const out = { ...ev };
      if (p.syntheticCount > 0 && out.delta) {
        out.delta = { ...out.delta, stop_reason: "tool_use" };
      }
      writeEvent(session, out);
      break;
    }
    case "message_stop": {
      const out = { ...ev };
      if (p.syntheticCount > 0 && out.message?.stop_reason) {
        out.message = { ...out.message, stop_reason: "tool_use" };
      }
      writeEvent(session, out);
      break;
    }
    default:
      writeEvent(session, ev);
  }
}

function createSession(key, model, tools, callerSystem, bucket, { resume, cwd = PROXY_CWD_FALLBACK } = {}) {
  const input = makeInputQueue();
  const abortController = new AbortController();
  const session = {
    key,                          // bridge-owned UUID (never collides)
    bucket,                       // hash(system + first user msg) for candidate grouping
    seenCount: 0,                 // messages already processed by this session
    seenHash: hashMessages([], 0),// hash of that processed prefix (prefix-match guard)
    sdkSessionId: resume || null, // SDK-persisted session id for resume after cold start
    model,
    cwd,                          // working directory baked into the SDK query() env block
    anchorState: createAnchorState(),
    toolMeta: new Map(),          // tool_use id -> {name,input}; lets the resolve path anchor Read results
    anchorEditPlans: new Map(),   // tool_use id -> reconcile plan; applied to the snapshot on client success
    originalNames: new Set(
      ["code", ...(tools || []).map((t) => t && t.name).filter(Boolean)],
    ),
    input,
    abortController,
    pendingTools: new Map(),      // toolUseId -> resolve(CallToolResult)
    resolvedResults: new Map(),   // toolUseId -> CallToolResult (arrived before handler parked)
    orphanResolvers: [],          // resolvers with no captured id (defensive)
    streamedToolUses: [],         // completed {id,name,input} tool_use blocks awaiting handler claim
    toolUseAccum: new Map(),      // stream index -> {id,name,partial} (input JSON assembled across deltas)
    inputParsers: new Map(),      // toolName -> z.object(shape); canonical parser mirroring MCP validateToolInput
    fifoFallbacks: 0,             // per-session count of correlation FIFO fallbacks (observable)
    clientTools: new Map(),       // code mode: name -> {description, input_schema}
    codeRun: null,                // active dynamic code run: { codeId, currentWave, waveSeq, waveCount, callCount, aborted, preamble }
    syntheticToCode: new Map(),   // syntheticId -> codeId (for routing tool_results)
    codeDriving: false,           // bridge controls visible client turns while SDK is parked on code
    suppressEndTurn: false,
    codeCalls: 0,
    codeSubCalls: 0,
    codeErrors: 0,
    codeWaves: 0,
    currentTurn: null,            // { resolve } deferred for the active HTTP turn
    res: null,                    // current streaming HTTP response
    nonStream: null,              // { blocks, stopReason } when buffering for non-stream
    lastUsage: { input_tokens: 0, output_tokens: 0 },
    lastRawUsage: null,           // full-shape upstream usage for client replay
    rateLimitHeaders: {},
    rateLimitResetsAt: null,
    sseHeadersWritten: false,
    lastActivity: Date.now(),
    closed: false,
    turnMetrics: null,
  };

  const mcpServer = buildParkingMcpServer(tools, session);
  const queryOptions = {
    model,
    systemPrompt: { type: "preset", preset: "claude_code", append: callerSystem },
    settingSources: [],
    tools: [],
    mcpServers: mcpServer ? [mcpServer] : [],
    strictMcpConfig: true,
    permissionMode: "bypassPermissions", // MCP handlers (our parking tools) must run without prompts
    allowDangerouslySkipPermissions: true, // SDK types require this whenever permissionMode is bypassPermissions
    cwd,
    includePartialMessages: true,
    abortController,
    // The proxy parks MCP handlers across HTTP turns, but the SDK's bundled CLI
    // closes its stdin stream after CLAUDE_CODE_STREAM_CLOSE_TIMEOUT ms of
    // inactivity (default ~60s). A code run parks the `code` handler for its
    // whole multi-wave lifetime with the SDK's stdin idle throughout, so the
    // ceiling must outlast the session lifecycle, not just TOOL_TIMEOUT_MS —
    // otherwise the CLI would cut a legitimately long-running script (SDK issue
    // #114 symptom, and the "punish long code logic" failure mode). Dead
    // sessions are still reclaimed event-driven (onClose) or by the idle sweeper
    // (SESSION_TTL_MS). env REPLACES process.env, so spread it.
    env: {
      ...process.env,
      CLAUDE_CODE_STREAM_CLOSE_TIMEOUT: String(
        Number(process.env.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT) || (SESSION_TTL_MS + 60000)
      ),
    },
  };
  if (resume) queryOptions.resume = resume;
  session.query = query({ prompt: input.iterable, options: queryOptions });

  consumeSession(session);
  sessions.set(key, session);
  return session;
}

// Background consumer: routes the live query()'s events to whatever HTTP turn is
// currently attached, and ends each turn on message_stop.
async function consumeSession(session) {
  try {
    for await (const msg of session.query) {
      session.lastActivity = Date.now();
      if (msg.session_id) session.sdkSessionId = msg.session_id;
      if (msg.type === "rate_limit_event") {
        rememberRateLimitHeaders(session, msg.rate_limit_info ?? msg.rate_limit_event?.rate_limit_info);
        // The event itself often lacks utilization; fetch the nested 5h/7d
        // utilization from the SDK control method and cache it for this and
        // future turns' response headers.
        refreshRateLimitsFromControl(session);
      } else if (msg.type === "stream_event" && msg.event) {
        const ev = msg.event;
        noteStreamTiming(session, ev);
        // A new assistant message begins a fresh tool round. Clear the per-message
        // correlation buffers so a tool_use streamed but never executed in a prior
        // message (e.g. an interleaved-thinking speculative call, or a round the
        // caller abandoned with a fresh user turn) can never offset this message's
        // handler-to-tool_use matching. pendingTools is left alone: a genuinely
        // in-flight park is resolved by the client's tool_result or the watchdog,
        // never by a message boundary.
        if (ev.type === "message_start") {
          session.streamedToolUses.length = 0;
          session.toolUseAccum.clear();
          session.resolvedResults.clear();
          // Per-message anchor state. toolMeta from the prior assistant message
          // was already consumed in the resolve path before this boundary.
          session.toolMeta.clear();
          initMessageProjection(session);
        }
        // Assemble each streamed tool_use into a complete {id,name,input} record.
        // The id+name arrive on content_block_start; input streams as
        // input_json_delta and is only complete at content_block_stop. The SDK
        // dispatches handlers after the full assistant message, so every record is
        // finalized before any handler tries to claim it.
        if (ev.type === "content_block_start" && ev.content_block?.type === "tool_use") {
          ev.content_block.name = stripBridgeToolName(ev.content_block.name, session.originalNames);
          session.toolUseAccum.set(ev.index, { id: ev.content_block.id, name: ev.content_block.name, partial: "" });
        }
        if (ev.type === "content_block_delta" && ev.delta?.type === "input_json_delta") {
          const a = session.toolUseAccum.get(ev.index);
          if (a) a.partial += ev.delta.partial_json || "";
        }
        if (ev.type === "content_block_stop") {
          const a = session.toolUseAccum.get(ev.index);
          if (a) {
            let input = {};
            try { input = JSON.parse(a.partial || "{}"); } catch { input = {}; }
            session.streamedToolUses.push({ id: a.id, name: a.name, input });
            // Record name+input so the resolve path can anchor Read results.
            session.toolMeta.set(a.id, { name: a.name, input });
            if (a.name === "code") {
              startCodeRun(session, a.id, input);
            }
            session.toolUseAccum.delete(ev.index);
          }
        }
        // Capture usage from the stream (the result message may not arrive
        // before the turn parks mid-loop). message_start carries input tokens;
        // message_delta carries the running output tokens.
        if (ev.type === "message_start" && ev.message?.usage) {
          const u = normalizeUsage(ev.message.usage);
          if (u) session.lastUsage = u;
          // Preserve the full upstream shape for client-facing replay
          // (fabricated code-mode waves reuse this so statusbar usage does
          // not bounce to zero between real upstream messages).
          const full = cloneUsageForClient(ev.message.usage);
          if (full) session.lastRawUsage = full;
          // message_start usage is authoritative for the prefill cache/input
          // tokens of this upstream call; accumulate global counters and the
          // per-turn row from it. (An HTTP turn may contain several upstream
          // messages when code mode resolves internally and the SDK continues.)
          accumulateTurnUsage(session, ev.message.usage);
        }
        if (ev.type === "message_delta" && ev.usage) {
          // delta usage carries the running output total for the current message.
          if (ev.usage.output_tokens != null) {
            session.lastUsage.output_tokens = ev.usage.output_tokens;
            if (session.lastRawUsage) session.lastRawUsage.output_tokens = ev.usage.output_tokens;
            if (session.turnMetrics) session.turnMetrics._curMsgOutput = ev.usage.output_tokens;
          }
        }
        projectEvent(session, ev);
        if (ev.type === "message_stop") endTurn(session);
      } else if (msg.type === "result") {
        if (msg.usage) {
          const u = normalizeUsage(msg.usage);
          if (u) session.lastUsage = u;
          const full = cloneUsageForClient(msg.usage);
          if (full) session.lastRawUsage = full;
        }
        if (session.nonStream && msg.stop_reason) session.nonStream.stopReason = msg.stop_reason;
        if (msg.subtype && msg.subtype !== "success") {
          failTurn(session, new Error(`SDK result ${msg.subtype}`));
        } else if (msg.subtype === "success" && session.currentTurn) {
          // Fallback turn settlement: the SDK emitted a successful result
          // WITHOUT a preceding message_stop (SDK bugs #333 / #339 — iterator
          // silent after tool_result, or ends without result). Without this
          // fallback the HTTP turn would hang indefinitely waiting on an
          // event that never arrives. Only resolve if a turn is still
          // attached; otherwise endTurn is a no-op and we just clear state.
          process.stderr.write(`${LOG_PREFIX} result=success without message_stop key=${session.key.slice(0, 8)}; settling turn via result fallback\n`);
          endTurn(session);
        }
      } else if (msg.type === "system" && msg.subtype === "session_state_changed" && msg.state === "idle") {
        // The SDK's authoritative turn-over signal. If a turn is still
        // attached (message_stop was missed), settle it now.
        if (session.currentTurn) {
          process.stderr.write(`${LOG_PREFIX} session_state=idle without message_stop key=${session.key.slice(0, 8)}; settling turn via idle fallback\n`);
          endTurn(session);
        }
      }
    }
  } catch (e) {
    if (!session.abortController.signal.aborted) {
      process.stderr.write(`${LOG_PREFIX} session ${session.key} error: ${e?.stack || e}\n`);
      failTurn(session, e);
    }
  } finally {
    session.closed = true;
    sessions.delete(session.key);
    // Safety net: the query() ended (normal close, error, or eviction abort).
    // If a turn is still attached (e.g. evicted mid-turn, where the catch above
    // is skipped because signal.aborted is true), settle it so the awaiting HTTP
    // handler cannot hang, and abandon any parked tool round.
    if (session.currentTurn) failTurn(session, new Error("session closed"));
    else abandonToolRound(session);
  }
}

function writeEvent(session, ev) {
  if (session.nonStream) {
    accumulateStreamEvent(session.nonStream.blocks, ev);
    if (ev.type === "message_delta" && ev.delta?.stop_reason) session.nonStream.stopReason = ev.delta.stop_reason;
    return;
  }
  if (session.res && !session.res.writableEnded) {
    writeSseChunk(session, sseEvent(ev.type, ev));
  }
}

// Abandon the current tool round: the parked handlers will never receive a
// result (the query died, or the caller dropped the round by sending a fresh
// user turn instead of a tool_result), so resolve each with isError to unblock
// the SDK loop, then wipe all tool-correlation state. Distinct from a normal
// turn boundary, where parked handlers MUST survive.
function abandonToolRound(session) {
  session.lastActivity = Date.now();
  for (const resolve of session.pendingTools.values()) {
    resolve({ content: [{ type: "text", text: "Tool round abandoned before result was provided" }], isError: true });
  }
  for (const resolve of session.orphanResolvers) {
    resolve({ content: [{ type: "text", text: "Tool round abandoned before result was provided" }], isError: true });
  }
  session.pendingTools.clear();
  session.resolvedResults.clear();
  session.streamedToolUses.length = 0;
  session.orphanResolvers.length = 0;
  session.toolUseAccum.clear();
  session.toolMeta?.clear();
  session.anchorEditPlans?.clear();
  clearAllCodeState(session);
}

// Ending a streamed turn flushes the HTTP response to the client, but the tool
// round is NOT over: a parked handler must outlive this boundary so the client
// can execute the tool and POST the result on a later request. So endTurn never
// touches tool state. message_start clears the per-message correlation buffers;
// the watchdog and resolveTool clear pendingTools.
function endTurn(session) {
  if (session.suppressEndTurn) {
    session.suppressEndTurn = false;
    return;
  }
  logTurnDone(session);
  const turn = session.currentTurn;
  if (turn) { session.currentTurn = null; turn.resolve(); }
}

// The live query() died or the turn hard-failed: no tool result will ever
// arrive, so abandon the round (resolve every parked handler with isError)
// before the session is torn down.
function failTurn(session, err) {
  const turn = session.currentTurn;
  if (turn) { session.currentTurn = null; turn.reject(err); }
  abandonToolRound(session);
}

// Resolve a parked tool handler (or stash the result if the handler hasn't
// parked yet).
function resolveTool(session, toolUseId, result) {
  session.lastActivity = Date.now();
  // Dirac-style reconcile: an edit the client confirmed (non-error) updates the
  // cached snapshot so its anchors stay live for the next edit without a re-Read.
  // A failed edit drops the plan untouched, leaving the prior snapshot intact.
  if (session.anchorState && session.anchorEditPlans?.has(toolUseId)) {
    const plan = session.anchorEditPlans.get(toolUseId);
    session.anchorEditPlans.delete(toolUseId);
    if (!result?.isError) {
      try { reconcileEdit(session.anchorState, plan); }
      catch (e) { process.stderr.write(`${LOG_PREFIX} anchor reconcile failed for ${plan?.path}: ${String(e?.message || e).slice(0, 120)}\n`); }
    }
  }
  if (session.pendingTools.has(toolUseId)) {
    const resolve = session.pendingTools.get(toolUseId);
    session.pendingTools.delete(toolUseId);
    resolve(result);
  } else if (session.orphanResolvers.length) {
    session.orphanResolvers.shift()(result);
  } else {
    session.resolvedResults.set(toolUseId, result);
  }
}

// Idle sweeper: close sessions past SESSION_TTL_MS.
const sweeper = setInterval(() => {
  const now = Date.now();
  for (const [key, s] of sessions) {
    if (now - s.lastActivity > SESSION_TTL_MS) {
      if (s.codeRun && !s.currentTurn) {
        process.stderr.write(`${LOG_PREFIX} evicting stale code session ${key}\n`);
        try { abandonToolRound(s); s.input.close(); s.abortController.abort(); } catch {}
        sessions.delete(key);
        continue;
      }
      if (hasActiveToolRound(s)) continue;
      process.stderr.write(`${LOG_PREFIX} evicting idle session ${key}\n`);
      try { s.input.close(); s.abortController.abort(); } catch {}
      sessions.delete(key);
    }
  }
}, 30000);
sweeper.unref?.();

// ----------------------------------------------------------------------------
// Request handling.
// ----------------------------------------------------------------------------

async function resolveCodeModeToolResults(session, toolResults) {
  session.lastActivity = Date.now();
  const run = session.codeRun;
  for (const tr of toolResults) {
    const codeId = session.syntheticToCode.get(tr.tool_use_id);
    if (codeId && run && run.codeId === codeId && run.currentWave) {
      // Route into the current wave.
      const wave = run.currentWave;
      const result = toCallToolResult(tr);
      for (let i = 0; i < wave.calls.length; i++) {
        if (wave.calls[i].syntheticId === tr.tool_use_id) {
          const text = result.content?.[0]?.text || "";
          const entry = {
            text,
            raw: result,
            isError: !!result.isError,
          };
          // Anchor editing: if this was a Read, cache the snapshot and expose an
          // `.anchored` view (text with per-line anchor tokens) so the script can
          // pass start_anchor/end_anchor to a later Edit. `.text` stays clean so
          // scripts deriving old_string from raw bytes keep working unchanged.
          // If this was a confirmed (non-error) anchored Edit, reconcile the
          // snapshot so its anchors stay live for the next edit (Dirac-style),
          // even within the same wave/script, without a re-Read.
          if (session.anchorState && !result.isError) {
            const call = wave.calls[i];
            if (call && ANCHORED_READ_TOOLS.has(call.tool) && call.args?.file_path) {
              const { text: annotated, anchored } = annotateReadResult(session.anchorState, call.args.file_path, text);
              if (anchored) entry.anchored = annotated;
            }
            if (call && call.anchorPlan) {
              try { reconcileEdit(session.anchorState, call.anchorPlan); }
              catch (e) { process.stderr.write(`${LOG_PREFIX} anchor reconcile failed for ${call.anchorPlan?.path}: ${String(e?.message || e).slice(0, 120)}\n`); }
            }
          }
          wave.results[i] = entry;
          wave.pending.delete(tr.tool_use_id);
          session.syntheticToCode.delete(tr.tool_use_id);
          break;
        }
      }
    } else {
      process.stderr.write(`${LOG_PREFIX} ignoring unmatched code-mode tool_result id=${tr.tool_use_id}\n`);
    }
  }

  // If the current wave is complete, resolve it and try to dispatch the next.
  if (run && run.currentWave && run.currentWave.pending.size === 0) {
    const wave = run.currentWave;
    run.currentWave = null;

    // Fill in inline errors for calls that had no syntheticId.
    const results = wave.results.map((r, i) => {
      if (r) return r;
      return { text: wave.calls[i].inlineError || "(no result)", raw: null, isError: true };
    });

    // Update sub-call metrics.
    const subCalls = wave.calls.filter((v) => v.syntheticId !== null).length;
    session.codeSubCalls = (session.codeSubCalls || 0) + subCalls;
    totalCodeSubCalls += subCalls;
    if (session.turnMetrics) session.turnMetrics.codeSubCalls += subCalls;

    wave.resolve(results);
  }
}

// Claude Code prompt/agent hooks (Stop, SubagentStop, PreToolUse, etc.) call the
// Messages API with output_config.format (structured JSON). The SDK bridge cannot
// honor that — it injects the claude_code preset and MCP tools, so hook eval gets
// narrative text instead of {"ok": true/false} and Claude Code reports "JSON validation failed".
// Similarly, statusline and hook requests send effort/model/context_window/rate_limits/cost
// metadata that the bridge's intervention would corrupt. Passthrough those requests to api.anthropic.com.
function needsStructuredOutputPassthrough(reqBody) {
  if (!reqBody || typeof reqBody !== "object") return false;
  if (reqBody.output_config?.format) return true;
  // Legacy field Claude Code still accepts during the structured-outputs transition.
  if (reqBody.output_format) return true;
  // Claude Code hooks and statusline send effort level and other metadata.
  if (reqBody.effort) return true;
  // Usage and rate limit fields from statusline hooks.
  if (reqBody.rate_limits) return true;
  if (reqBody.cost) return true;
  if (reqBody.context_window) return true;
  return false;
}

function anthropicPassthroughHeaders(req) {
  const headers = { accept: req.headers["accept"] || "application/json" };
  const ct = req.headers["content-type"];
  if (ct) headers["content-type"] = Array.isArray(ct) ? ct.join(",") : String(ct);
  const auth = req.headers["authorization"];
  if (auth) headers["authorization"] = Array.isArray(auth) ? auth.join(",") : String(auth);
  const beta = req.headers["anthropic-beta"];
  if (beta) headers["anthropic-beta"] = Array.isArray(beta) ? beta.join(",") : String(beta);
  const version = req.headers["anthropic-version"];
  if (version) headers["anthropic-version"] = Array.isArray(version) ? version.join(",") : String(version);
  return headers;
}

async function forwardAnthropicMessages(req, res, rawBody, rawUrl) {
  try {
    const upstream = new URL(anthropicApiOrigin() + rawUrl);
    const up = await fetch(upstream, {
      method: "POST",
      headers: anthropicPassthroughHeaders(req),
      body: rawBody,
      signal: AbortSignal.timeout(600000),
    });
    const outHeaders = {};
    up.headers.forEach((v, h) => {
      if (h.startsWith("anthropic-ratelimit-")) outHeaders[h] = v;
    });
    for (const h of ["content-type", "cache-control", "request-id"]) {
      const v = up.headers.get(h);
      if (v) outHeaders[h] = v;
    }
    if (typeof res.writeHead === "function") {
      res.writeHead(up.status, outHeaders);
    } else if (typeof res.setHeader === "function") {
      for (const [k, v] of Object.entries(outHeaders)) res.setHeader(k, v);
      res.statusCode = up.status;
    }
    if (up.body) {
      for await (const chunk of up.body) {
        if (!res.writableEnded) res.write(chunk);
      }
    }
    if (!res.writableEnded) res.end();
  } catch (e) {
    process.stderr.write(`${LOG_PREFIX} structured-output pass-through failed: ${e?.message || e}\n`);
    if (!res.headersSent) {
      jsonResp(res, 502, { type: "error", error: { type: "api_error", message: `upstream messages fetch failed: ${e?.message || e}` } });
    } else if (!res.writableEnded) res.end();
  }
}

async function handleMessages(req, res) {
  let body = "";
  for await (const chunk of req) body += chunk;
  let reqBody;
  try {
    reqBody = JSON.parse(body);
  } catch (e) {
    return jsonResp(res, 400, { type: "error", error: { type: "invalid_request_error", message: "invalid JSON body" } });
  }

  if (needsStructuredOutputPassthrough(reqBody)) {
    process.stderr.write(`${LOG_PREFIX} structured-output pass-through stream=${reqBody.stream !== false}\n`);
    return forwardAnthropicMessages(req, res, body, req.url || "/v1/messages");
  }

  const { model: rawModel, messages, system, stream, tools } = reqBody;
  if (!rawModel || !Array.isArray(messages) || !messages.length) {
    return jsonResp(res, 400, { type: "error", error: { type: "invalid_request_error", message: "model and messages are required" } });
  }
  const model = normalizeModel(rawModel);

  const callerSystem = extractSystemText(system);
  const isStream = stream !== false;
  // Classify what's actionable in this request. Clients (Claude Code) append
  // synthesized `role: "system"` messages (attachments/reminders/recaps) AFTER
  // the real payload; the physical last array element is therefore NOT a
  // reliable "new turn" selector. We pick the latest actionable user/tool-result
  // message and treat system messages as non-actionable metadata. See
  // actionableTail() above.
  //
  // `tail` is computed against the matched session's seenCount once we have a
  // session; for cold/new/resume (no matched warm session) we classify the full
  // messages array to find the actionable user message for priming/resume.
  const last = messages[messages.length - 1];
  // Stable conversation id when the client provides one. Claude Code sends
  // `x-claude-code-session-id` (distinct per conversation AND per subagent), so
  // parallel fan-out sessions that share an identical system+first-user prefix
  // get separate bridge sessions instead of colliding in one content bucket.
  // Droid sends no such header and falls back to content-derived bucketing.
  const convId = (() => {
    const h = req.headers["x-claude-code-session-id"] || req.headers["x-session-id"] || req.headers["x-conversation-id"];
    return typeof h === "string" && h.trim() ? h.trim() : null;
  })();

  // Per-request working directory (see resolveCwd). Part of session identity so
  // two projects never share a session; passed to the SDK query()'s env block.
  const cwd = resolveCwd(req.headers["x-claude-cwd"]);

  let session = findSession(messages, system, convId, cwd);
  let resumeCatchupTail = null;

  // Classify the unseen tail against the matched warm session's seenCount. For
  // cold/new/resume there is no matched session, so classify the full array to
  // find the actionable user message (used for priming/resume).
  const prevSeen = session ? session.seenCount : 0;
  const tail = messages.slice(prevSeen);
  const cls = actionableTail(tail);
  const { toolResults, userMsg, isToolResult } = cls;
  // For cold/resume paths that still take a single "last" user turn, prefer the
  // actionable user message; fall back to the physical last message only when
  // the tail has no actionable user message (e.g. a genuinely single-message
  // new conversation, or a pathological system-only request).
  const actionableLast = userMsg || last;
  const lastIsToolResult = isToolResult;

  // "resolve" => feed tool_result(s) to the parked handler of a matched session.
  // "push"    => push the latest real user turn into a matched session.
  // "noop"    => matched warm session but tail is system-only metadata: nothing
  //              to feed the SDK; just mark seen and end the turn cleanly.
  // "resume"  => cold start recovered via SDK resume; push only the last user turn.
  // "resume-catchup" => SDK resume + small unseen tail as narrative context.
  // "cold"    => no matching live session and no resume index hit: narrative priming.
  // "new"     => brand-new conversation (single message): new session.
  let action;
  if (session) {
    // Warm session: decide from the classified tail (resolve | push | noop).
    // Never fabricate a user turn from a trailing system/meta message, and never
    // abandon a parked tool round just because a system message trails the
    // tool_result. See decideWarmAction()/actionableTail().
    action = decideWarmAction(tail).action;
  } else if (messages.length > 1) {
    const b = bucketKey(system, messages, convId, cwd);
    // Cold start: try to recover via SDK session resume (persisted in
    // resume-index.json). findResumeCandidate only returns a clean user-turn
    // resume for code-mode sessions (no tool_result tail, no catchup), which is
    // the safe subset — synthetic toolu_code_* ids from a prior code run cannot
    // be routed by a freshly-resumed SDK session. Anything else falls through to
    // mimicry-safe cold priming.
    const index = loadResumeIndex(resumeIndexFile);
    const candidate = findResumeCandidate({
      entries: index.entries,
      model,
      profileKey: profileKey(serverProfileDir),
      bucket: b,
      messages,
      lastIsToolResult,
      codeMode: true,
      hashMessages,
    });
    if (candidate?.mode === "resume") {
      session = createSession(randomUUID(), model, tools, callerSystem, b, { resume: candidate.sdkSessionId, cwd });
      action = "resume";
    } else if (candidate?.mode === "resume-catchup") {
      session = createSession(randomUUID(), model, tools, callerSystem, b, { resume: candidate.sdkSessionId, cwd });
      action = "resume-catchup";
      resumeCatchupTail = candidate.tail;
    }
    if (!session) {
      session = createSession(randomUUID(), model, tools, callerSystem, b, { cwd });
      action = "cold";
    }
  } else {
    session = createSession(randomUUID(), model, tools, callerSystem, bucketKey(system, messages, convId, cwd), { cwd });
    action = "new";
  }

  process.stderr.write(`${LOG_PREFIX} request model=${model} stream=${isStream} key=${session.key.slice(0, 8)} action=${action} cwd=${session.cwd} tools=${tools?.length || 0} msgs=${messages.length} [${summarizeMessages(messages)}]\n`);
  session.lastActivity = Date.now();

  // Attach this HTTP response as the session's current turn.
  let onClose;
  let heartbeat;
  session.turnMetrics = {
    action, startedAt: Date.now(), firstEventAt: null, textDeltas: 0,
    usage: { input: 0, read: 0, create5m: 0, create1h: 0, output: 0 },
    messages: 0, _curMsgOutput: 0, codeSubCalls: 0, codeWaves: 0, scriptOutBytes: 0,
  };
  const turnPromise = new Promise((resolve, reject) => {
    session.currentTurn = { resolve, reject };
  });

  if (isStream) {
    session.res = res;
    session.sseHeadersWritten = false;
    session.nonStream = null;
    heartbeat = setInterval(() => { if (!res.writableEnded) writeSseChunk(session, `: keep-alive\n\n`); }, HEARTBEAT_MS);
    // A response close before writableEnded means the client did not receive
    // the full streamed turn. If that turn was a fabricated code wave, no
    // reliable tool_result can arrive for it, so abort the parked code run.
    onClose = () => {
      const aborted = !res.writableEnded;
      if (session.res === res) session.res = null;
      if (aborted && session.codeRun?.currentWave?.dispatched) {
        process.stderr.write(`${LOG_PREFIX} client disconnected during code wave key=${session.key.slice(0, 8)}; aborting code run\n`);
        if (session.currentTurn) failTurn(session, new Error("client disconnected during code wave"));
        else abandonToolRound(session);
      }
    };
    res.on("close", onClose);
  } else {
    session.res = null;
    session.nonStream = { blocks: [], stopReason: "end_turn" };
  }
  notifyTurnAttached(session);

  // Drive the turn.
  if (action === "resolve") {
    await resolveCodeModeToolResults(session, toolResults);
  } else if (action === "resume") {
    session.input.push(toUserFrame(actionableLast));
  } else if (action === "resume-catchup") {
    for (const frame of buildResumeCatchupFrames(resumeCatchupTail || [], {
      renderTranscript: renderPrimingTranscript,
      wrap: primingFrameText,
      toUserFrame,
      lastIsToolResult,
    })) {
      session.input.push(frame);
    }
  } else if (action === "cold") {
    pushColdStartFrames(session, messages, actionableLast, lastIsToolResult);
  } else if (action === "noop") {
    // Matched warm session but the unseen tail is only system/meta (or empty).
    // Do NOT fabricate a user turn from a synthesized system message — that would
    // drop a real user turn or abandon a parked tool round. Emit a minimal,
    // well-formed empty assistant turn and resolve immediately so the client gets
    // a clean end_turn without waiting on the SDK (which has nothing new to do).
    // If notifyTurnAttached already fabricated a pending code wave, endTurn cleared
    // currentTurn — skip the empty noop response.
    if (session.currentTurn) {
      if (isStream) {
        if (!res.writableEnded) {
          writeSseChunk(session, sseEvent("message_start", { type: "message_start", message: { id: `msg_${Date.now()}`, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } }));
          writeSseChunk(session, sseEvent("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 0 } }));
          writeSseChunk(session, sseEvent("message_stop", { type: "message_stop" }));
        }
      } else {
        session.nonStream = { blocks: [], stopReason: "end_turn" };
      }
      const t = session.currentTurn;
      session.currentTurn = null;
      t.resolve();
    }
  } else {
    // action === "push" or "new": a fresh user turn on a live session. If the
    // prior turn left a tool round parked (the caller interjected text instead
    // of returning a tool_result), abandon it so the new turn is not stuck
    // behind a handler that will never be resolved. Push the REAL user message,
    // never a trailing system/meta message.
    if (hasActiveToolRound(session, { includeCurrentTurn: false })) {
      abandonToolRound(session);
    }
    session.input.push(toUserFrame(userMsg || last));
  }
  markSeen(session, messages);

  try {
    // Await the turn directly — NO timeout race. The turn settles only on a real
    // SDK event: message_stop (endTurn -> resolve) or the query() iterator
    // ending/erroring/aborting (consumeSession -> failTurn -> reject). A clock
    // would only mask a genuine wedge and drop context.
    await turnPromise;
  } catch (e) {
    process.stderr.write(`${LOG_PREFIX} turn failed (${session.key}): ${e?.message || e}\n`);
    // The rejection came from consumeSession's catch/finally (iterator
    // error/abort/close), which already called failTurn. The guard avoids a
    // double settle if a turn is somehow still attached.
    if (session.currentTurn) failTurn(session, e);
    if (isStream) {
      if (!res.writableEnded) {
        writeSseChunk(session, sseEvent("error", { type: "error", error: { type: "api_error", message: String(e?.message || e) } }));
        res.end();
      }
    } else {
      if (!res.headersSent) jsonResp(res, 500, { type: "error", error: { type: "api_error", message: String(e?.message || e) } });
    }
    if (heartbeat) clearInterval(heartbeat);
    if (onClose) res.off("close", onClose);
    return;
  }

  if (heartbeat) clearInterval(heartbeat);
  if (onClose) res.off("close", onClose);

  persistResumeIndex(session, model, system, messages);

  if (isStream) {
    if (session.res === res) session.res = null;
    if (!res.writableEnded) res.end();
  } else {
    const blocks = session.nonStream.blocks.filter(Boolean);
    for (const b of blocks) if (b.type === "tool_use") b.name = stripBridgeToolName(b.name, session.originalNames);
    let stopReason = session.nonStream.stopReason;
    if (blocks.some((b) => b.type === "tool_use") && stopReason === "end_turn") stopReason = "tool_use";
    session.nonStream = null;
    jsonResp(res, 200, {
      id: `msg_${Date.now()}`,
      type: "message",
      role: "assistant",
      model,
      content: blocks,
      stop_reason: stopReason,
      stop_sequence: null,
      usage: session.lastUsage,
    }, latestRateLimitHeaders(session));
  }
}

// Anthropic OAuth usage endpoint (the same one ~/.claude-/statusline.py calls
// out-of-band for extra_usage). Limited to a known-safe upstream host so the
// pass-through can never be redirected by the client.
function anthropicApiOrigin() {
  return process.env.ANTHROPIC_API_ORIGIN || "https://api.anthropic.com";
}
const OAUTH_PASS_THROUGH_PATHS = new Set([
  "/api/oauth/usage",
]);

// Forward an OAuth usage request to the real Anthropic endpoint, preserving
// the client's Authorization header. The proxy does not see or store the
// token. Claude Code only issues this GET once it treats the base URL as
// first-party — the launcher sets _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL=1
// for that; without it the TUI suppresses the fetch entirely.
async function forwardOauthUsage(req, res, rawUrl) {
  const headers = { "accept": "application/json" };
  const auth = req.headers["authorization"];
  if (auth) headers["authorization"] = Array.isArray(auth) ? auth.join(",") : String(auth);
  const beta = req.headers["anthropic-beta"];
  if (beta) headers["anthropic-beta"] = Array.isArray(beta) ? beta.join(",") : String(beta);
  try {
    const upstream = new URL(anthropicApiOrigin() + rawUrl);
    const up = await fetch(upstream, { method: "GET", headers, signal: AbortSignal.timeout(8000) });
    const contentType = up.headers.get("content-type") || "application/json";
    const body = Buffer.from(await up.arrayBuffer());
    // Observable: log status + path (never the token) so a working pass-through
    // is distinct from "never called". A 401 here means the TUI sent no/stale
    // bearer, not a proxy fault.
    process.stderr.write(`${LOG_PREFIX} oauth usage pass-through ${up.status} ${rawUrl}\n`);
    res.writeHead(up.status, { "content-type": contentType, "content-length": body.length });
    res.end(body);
  } catch (e) {
    process.stderr.write(`${LOG_PREFIX} oauth usage pass-through failed: ${e?.message || e}\n`);
    jsonResp(res, 502, { type: "error", error: { type: "api_error", message: `upstream usage fetch failed: ${e?.message || e}` } });
  }
}

// Start the HTTP server. Auth (CLAUDE_CONFIG_DIR / token) must already be applied
// to process.env by the caller (src/auth.mjs). Returns the http.Server.
export function startServer({ port = 32809, host = "127.0.0.1", account = null, profileDir = process.env.CLAUDE_CONFIG_DIR, version = null, cacheLog = process.env.CACHE_LOG } = {}) {
  serverProfileDir = profileDir || null;
  resumeIndexFile = defaultIndexPath();
  initCacheLog(cacheLog, profileDir);
  const server = http.createServer(async (req, res) => {
    const rawUrl = req.url || "";
    // Match on pathname only; clients append query strings like
    // `/v1/messages?beta=true` (Claude Code) that must not break routing.
    const url = rawUrl.split("?")[0];
    if (req.method === "GET" && (url === "/healthz" || url === "/")) {
      return jsonResp(res, 200, {
        ok: true,
        service: "claude-agent-api",
        version,
        port,
        profileDir: profileDir || null,
        account: account?.email || null,
        sessions: sessions.size,
        fifoFallbacks: totalFifoFallbacks,
        codeCalls: totalCodeCalls,
        codeSubCalls: totalCodeSubCalls,
        codeErrors: totalCodeErrors,
        codeWaves: totalCodeWaves,
        cacheReadTokens: totalCacheReadTokens,
        cacheCreationTokens: totalCacheCreationTokens,
        cacheLog: cacheLogPath() || null,
      });
    }
    if (req.method === "POST" && (url === "/v1/messages" || url === "/v1/messages/")) {
      try {
        return await handleMessages(req, res);
      } catch (e) {
        process.stderr.write(`${LOG_PREFIX} handler crash: ${e?.stack || e}\n`);
        if (!res.headersSent) jsonResp(res, 500, { type: "error", error: { type: "api_error", message: String(e?.message || e) } });
        else if (!res.writableEnded) res.end();
        return;
      }
    }
    // Claude Code validates the selected model at startup by hitting the models
    // API; without these it shows "model may not exist or you may not have
    // access". We answer affirmatively for any requested model (the SDK is the
    // real source of truth at query time) and synthesize a minimal catalog.
    if (req.method === "GET" && url === "/v1/models") {
      return jsonResp(res, 200, { data: KNOWN_MODELS.map(modelObject), has_more: false, first_id: KNOWN_MODELS[0], last_id: KNOWN_MODELS[KNOWN_MODELS.length - 1] });
    }
    if (req.method === "GET" && url.startsWith("/v1/models/")) {
      const id = decodeURIComponent(url.slice("/v1/models/".length).split("?")[0]);
      return jsonResp(res, 200, modelObject(id));
    }
    // count_tokens: Claude Code (and the Anthropic SDK) may probe this. The SDK
    // doesn't expose a token counter here, so return a cheap char-based estimate
    // (~4 chars/token) so the client proceeds rather than erroring.
    if (req.method === "POST" && (url === "/v1/messages/count_tokens" || url === "/v1/messages/count_tokens/")) {
      try {
        let body = "";
        for await (const chunk of req) body += chunk;
        const parsed = JSON.parse(body || "{}");
        const text = JSON.stringify(parsed.messages || []) + JSON.stringify(parsed.system || "") + JSON.stringify(parsed.tools || []);
        return jsonResp(res, 200, { input_tokens: Math.max(1, Math.ceil(text.length / 4)) });
      } catch {
        return jsonResp(res, 200, { input_tokens: 1 });
      }
    }
    // OAuth usage pass-through. Claude Code may probe private usage endpoints
    // through ANTHROPIC_BASE_URL for auxiliary statusbar data. The proxy talks
    // upstream through the Claude Agent SDK (which does not expose these
    // endpoints), so forward the request to the real Anthropic OAuth endpoint
    // with the client's Authorization header.
    // The proxy never sees or stores the token. Limited to a known-safe
    // upstream host and an allowlist of paths.
    if (req.method === "GET" && OAUTH_PASS_THROUGH_PATHS.has(url)) {
      return forwardOauthUsage(req, res, rawUrl);
    }
    // Secret-safe unknown-route diagnostics: Claude Code sometimes probes
    // private usage/rate-limit/status endpoints through ANTHROPIC_BASE_URL.
    // Surface the route + a non-sensitive header allowlist so a missing
    // compatibility surface is observable instead of a silent 404. Never log
    // authorization, cookies, or the request body.
    const SAFE_HEADERS = [
      "anthropic-beta",
      "anthropic-version",
      "user-agent",
      "content-type",
      "accept",
    ];
    const safeHeaders = {};
    for (const h of SAFE_HEADERS) {
      const v = req.headers[h];
      if (v != null) safeHeaders[h] = Array.isArray(v) ? v.join(",") : String(v);
    }
    process.stderr.write(
      `${LOG_PREFIX} 404 ${req.method} ${url} headers=${JSON.stringify(safeHeaders)}\n`
    );
    jsonResp(res, 404, { type: "error", error: { type: "not_found_error", message: `unknown route: ${req.method} ${url}` } });
  });

  server.listen(port, host, () => {
    process.stderr.write(`${LOG_PREFIX} listening on http://${host}:${port}\n`);
    process.stderr.write(`${LOG_PREFIX} CLAUDE_CONFIG_DIR: ${profileDir || "(default)"}\n`);
    process.stderr.write(`${LOG_PREFIX} account: ${account?.email || "(unconfirmed — SDK is source of truth)"}\n`);
    process.stderr.write(`${LOG_PREFIX} stateful session bridge (TTL ${SESSION_TTL_MS}ms ≈ ${Math.round(SESSION_TTL_MS / 60000)}min) — one live query() per conversation\n`);
  });

  const shutdown = () => { try { server.close(); } catch {} process.exit(0); };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  return server;
}

// Exported for tests; the server only starts when startServer() is called.
export {
  toolInputShape,
  fallbackShape,
  jsonSchemaToZod,
  stripBridgeToolName,
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
  stripCacheControl,
  toCallToolResult,
  toUserFrame,
  makeInputQueue,
  claimStreamedToolUse,
  normalizeToolInput,
  extractIdHint,
  abandonToolRound,
  buildParkingMcpServer,
  hasActiveToolRound,
  pushColdStartFrames,
  noteStreamTiming,
  persistResumeIndex,
  profileKey,
  findResumeCandidate,
  upsertResumeEntry,
  buildResumeCatchupFrames,
  loadResumeIndex,
  createSession,
  startCodeRun,
  dispatchCodeWave,
  fabricateCurrentWave,
  notifyTurnAttached,
  resolveCodeModeToolResults,
  projectEvent,
  initMessageProjection,
  clearAllCodeState,
  clearCodeRun,
  syntheticIdFor,
  internalResolveCode,
  endTurn,
  resolveTool,
  writeEvent,
  accumulateStreamEvent,
  emitClientToolUse,
  normalizeModel,
  modelObject,
  resolveCwd,
  isValidCwd,
  normalizeRateLimitUtilization,
  rateLimitHeadersFromInfo,
  rememberRateLimitHeaders,
  latestRateLimitHeaders,
  ensureSseHeaders,
  needsStructuredOutputPassthrough,
  anthropicPassthroughHeaders,
  forwardAnthropicMessages,
  totalCodeCalls,
  totalCodeSubCalls,
  totalCodeErrors,
  totalCodeWaves,
};
