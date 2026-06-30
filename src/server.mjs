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
//   - Sessions idle past SESSION_TTL_MS (5 min, matches Claude's prompt cache)
//     are closed by a sweeper, unless a client tool round is still active.
//
// Authentication is handled by src/auth.mjs BEFORE this module's query() runs:
// the SDK's bundled `claude` authenticates natively off the profile named by
// CLAUDE_CONFIG_DIR.
//
// Streaming: SDKPartialAssistantMessage.event is a BetaRawMessageStreamEvent —
// the exact Anthropic SSE event, forwarded verbatim (only tool_use.name is
// de-namespaced from the SDK's mcp__<id>__ prefix).

import http from "node:http";
import { homedir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
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
  CODE_MODE_APPEND,
  CodeValidationError,
  validateCodeInput,
  runCodeScriptDynamic,
  buildCodeToolDescription,
  formatCodeResult,
  codeToolInputShape,
  normalizeClientToolMeta,
} from "./code-mode.mjs";
import { initCacheLog, appendCacheLog, cacheLogEnabled, cacheLogPath, cacheCreationSplit } from "./cache-log.mjs";

const HOME = homedir();
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS || process.env.ACP_SESSION_TTL_MS || 300000); // 5 min
const HEARTBEAT_MS = Number(process.env.HEARTBEAT_MS || process.env.ACP_HEARTBEAT_MS || 15000);
const TOOL_TIMEOUT_MS = Number(process.env.TOOL_TIMEOUT_MS || process.env.ACP_TOOL_TIMEOUT_MS || 1800000); // 30 min; active tool rounds are retained past SESSION_TTL_MS
// Turn-level watchdog: backstop for any path where message_stop never fires
// (e.g. the SDK stream goes quiet mid-thinking, or a parked handler blocks the
// SDK from emitting message_stop and the per-handler TOOL_TIMEOUT_MS somehow
// doesn't fire).
const TURN_TIMEOUT_MS = Number(process.env.TURN_TIMEOUT_MS || process.env.ACP_TURN_TIMEOUT_MS || 300000);
const CODE_SCRIPT_TIMEOUT_MS = Number(process.env.CODE_SCRIPT_TIMEOUT_MS || 0); // 0 = no cap
const CODE_MAX_WAVES = Number(process.env.CODE_MAX_WAVES || 0); // 0 = unlimited
const CODE_MAX_CALLS = Number(process.env.CODE_MAX_CALLS || 0); // 0 = unlimited
const LOG_PREFIX = "[claude-agent-api]";

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

// Race an HTTP turn promise against a wall-clock timeout. Resolves with the
// turn's value if it settles in time; otherwise rejects with a typed timeout
// error so the caller can failTurn + abandon the tool round + surface an error
// to the client instead of hanging forever.
function raceTurn(turnPromise, timeoutMs = TURN_TIMEOUT_MS) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`turn did not complete within ${timeoutMs}ms`);
      err.code = "turn_timeout";
      reject(err);
    }, timeoutMs);
  });
  return Promise.race([turnPromise, timeout]).finally(() => clearTimeout(timer));
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
function bucketKey(system, messages, convId = null) {
  if (convId) return `cc:${convId}`;
  const firstUser = (messages || []).find((m) => m.role === "user");
  const text = extractSystemText(system) + "\u0000" + renderMsgText(firstUser);
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
// In code mode, `code` is registered alongside the original tools. The model can
// batch non-interactive work through `code`, while native client tools remain
// available for interactive/approval/handoff flows with their real schemas.
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
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          if (id) session.pendingTools.delete(id);
          else {
            const idx = session.orphanResolvers.indexOf(wrappedResolve);
            if (idx !== -1) session.orphanResolvers.splice(idx, 1);
          }
          if (session.codeMode && originalName === "code" && id) clearCodeRun(session, id);
          session.lastActivity = Date.now();
          process.stderr.write(`${LOG_PREFIX} tool ${id ?? originalName} park timeout after ${TOOL_TIMEOUT_MS}ms; returning isError\n`);
          resolve({ content: [{ type: "text", text: `Tool result was not provided within ${TOOL_TIMEOUT_MS}ms` }], isError: true });
        }
      }, TOOL_TIMEOUT_MS);

      const wrappedResolve = (result) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          session.lastActivity = Date.now();
          resolve(result);
        }
      };

      if (id) session.pendingTools.set(id, wrappedResolve);
      else session.orphanResolvers.push(wrappedResolve);
    });
  };

  if (session.codeMode) {
    session.clientTools = session.clientTools || new Map();
    for (const t of tools) {
      session.clientTools.set(t.name, normalizeClientToolMeta(t.name, {
        description: t.description || "",
        input_schema: t.input_schema || { type: "object", properties: {} },
      }));
    }
    const codeShape = codeToolInputShape(z);
    const codeTool = {
      name: "code",
      description: buildCodeToolDescription(session.clientTools),
      inputSchema: codeShape,
      handler: makeHandler("code"),
    };
    const passthroughTools = tools.map((t) => {
      const shape = toolInputShape(t.input_schema || { type: "object", properties: {} });
      try {
        const parser = z.object(shape);
        if (session.inputParsers) session.inputParsers.set(t.name, parser);
      } catch (e) {
        process.stderr.write(`${LOG_PREFIX} z.object(shape) failed for ${t.name} (${String(e?.message || e).slice(0, 100)}); correlation will use raw input\n`);
      }
      return {
        name: t.name,
        description: t.description || "",
        inputSchema: shape,
        handler: makeHandler(t.name),
      };
    });
    return createServer({ name: "bridge", tools: [codeTool, ...passthroughTools], alwaysLoad: true });
  }

  const mcpTools = tools.map((t) => {
    const shape = toolInputShape(t.input_schema || { type: "object", properties: {} });
    // Capture a canonical parser mirroring the MCP layer's validateToolInput so
    // claimStreamedToolUse can normalize both the streamed raw input and the
    // handler's already-parsed args to the same form (defaults, coercions).
    try {
      const parser = z.object(shape);
      if (session.inputParsers) session.inputParsers.set(t.name, parser);
    } catch (e) {
      process.stderr.write(`${LOG_PREFIX} z.object(shape) failed for ${t.name} (${String(e?.message || e).slice(0, 100)}); correlation will use raw input\n`);
    }
    return {
      name: t.name,
      description: t.description || "",
      inputSchema: shape,
      handler: makeHandler(t.name),
    };
  });
  return createServer({ name: "bridge", tools: mcpTools, alwaysLoad: true });
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

function jsonResp(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function sseEvent(eventType, data) {
  return `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
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

// Default code mode (opt-out: true unless profile/header disables).
let serverCodeMode = true;

// Set by startServer(); used for disk-backed SDK session resume after cold start.
let serverProfileDir = null;
let resumeIndexFile = defaultIndexPath();

function persistResumeIndex(session, model, system, messages) {
  if (!session.sdkSessionId || !serverProfileDir) return;
  // Never checkpoint mid tool-round: a code-mode wave parks on synthetic
  // toolu_code_* ids that live only in this process's memory. Recording a
  // seenCount in that state would let a later resume rehydrate an SDK session
  // that cannot route the still-outstanding synthetic tool_results.
  if (hasActiveToolRound(session, { includeCurrentTurn: false })) return;
  try {
    const index = loadResumeIndex(resumeIndexFile);
    const updated = upsertResumeEntry(index, {
      profileKey: profileKey(serverProfileDir),
      bucket: session.bucket,
      seenCount: session.seenCount,
      seenHash: session.seenHash,
      sdkSessionId: session.sdkSessionId,
      model,
      codeMode: !!session.codeMode,
    });
    saveResumeIndex(updated, resumeIndexFile);
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
      codeMode: !!session.codeMode,
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
function findSession(messages, system, convId = null) {
  const b = bucketKey(system, messages, convId);
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

function clearCodeRun(session, codeId) {
  const run = session.codeRun;
  if (run && run.codeId === codeId) {
    session.codeRun = null;
  }
}

function clearAllCodeState(session) {
  if (session.codeRun) {
    session.codeRun.aborted = true;
    if (session.codeRun.reject) {
      try { session.codeRun.reject(new Error("code round abandoned")); } catch {}
    }
  }
  session.codeRun = null;
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
    (session.codeMode && (
      session.codeRun ||
      session.syntheticToCode?.size ||
      session.codeDriving
    ))
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
    waveQueue: [],           // FIFO of waves waiting for an open HTTP request
    currentWave: null,       // { waveNum, calls, results, pending, promise, resolve, reject }
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
    const { name, args } = calls[i];
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
    validated.push({ syntheticId, tool: name, args: syntheticArgs, inlineError: null });
  }

  // If all calls in this wave are inline errors, return them directly without
  // fabricating a client turn.
  const fabricatable = validated.filter((v) => v.syntheticId !== null);
  if (fabricatable.length === 0) {
    return validated.map((v) => ({ text: v.inlineError, raw: null, isError: true }));
  }

  // Build the wave entry. The bridge will fabricate a client turn when an HTTP
  // request is available.
  const waveEntry = {
    waveNum,
    calls: validated,
    fabricatable,
    results: new Array(validated.length).fill(null),
    pending: new Set(fabricatable.map((v) => v.syntheticId)),
    promise: null,
    resolve: null,
    reject: null,
  };
  waveEntry.promise = new Promise((res, rej) => { waveEntry.resolve = res; waveEntry.reject = rej; });

  run.waveQueue.push(waveEntry);
  run.waveSeq = waveNum;
  run.waveCount++;

  // Try to dispatch immediately if an HTTP turn is attached.
  maybeDispatchQueuedWave(session);

  const results = await waveEntry.promise;
  return results;
}

// If an HTTP turn is attached and a wave is queued, fabricate the client turn.
function maybeDispatchQueuedWave(session) {
  const run = session.codeRun;
  if (!run || run.aborted) return;
  if (!session.currentTurn) return; // no open HTTP request to ride on
  if (run.currentWave) return;      // a wave is already being served
  const wave = run.waveQueue.shift();
  if (!wave) return;
  run.currentWave = wave;

  const p = session._proj;
  // Start a fresh fabricated assistant message. The client (and its subagent
  // accounting) reads message.usage.input_tokens, so a bare { role } here
  // throws "undefined is not an object (evaluating 'o.input_tokens')". Emit a
  // complete message envelope with a usage object (zeroed — the real token
  // accounting rides on the SDK's own message_start/message_delta events).
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
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
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
  // object in the real API; include a zeroed one so clients that read
  // delta.usage.output_tokens don't trip over undefined.
  writeEvent(session, {
    type: "message_delta",
    delta: { stop_reason: "tool_use", stop_sequence: null },
    usage: { output_tokens: 0 },
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
  if (!session.codeMode) {
    writeEvent(session, ev);
    return;
  }

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

function createSession(key, model, tools, callerSystem, bucket, { resume, codeMode = serverCodeMode } = {}) {
  const input = makeInputQueue();
  const abortController = new AbortController();
  const session = {
    key,                          // bridge-owned UUID (never collides)
    bucket,                       // hash(system + first user msg) for candidate grouping
    seenCount: 0,                 // messages already processed by this session
    seenHash: hashMessages([], 0),// hash of that processed prefix (prefix-match guard)
    sdkSessionId: resume || null, // SDK-persisted session id for resume after cold start
    model,
    codeMode: !!codeMode,
    originalNames: new Set(
      codeMode
        ? ["code", ...(tools || []).map((t) => t && t.name).filter(Boolean)]
        : (tools || []).map((t) => t && t.name).filter(Boolean),
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
    codeRun: null,                // active dynamic code run: { codeId, resultPromise, waveQueue, currentWave, waveSeq, waveCount, callCount, aborted, resolve, reject, preamble }
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
    lastActivity: Date.now(),
    closed: false,
    turnMetrics: null,
  };

  const systemAppend = codeMode ? callerSystem + CODE_MODE_APPEND : callerSystem;
  const mcpServer = buildParkingMcpServer(tools, session);
  const queryOptions = {
    model,
    systemPrompt: { type: "preset", preset: "claude_code", append: systemAppend },
    settingSources: [],
    tools: [],
    mcpServers: mcpServer ? [mcpServer] : [],
    strictMcpConfig: true,
    permissionMode: "bypassPermissions", // MCP handlers (our parking tools) must run without prompts
    cwd: HOME,
    includePartialMessages: true,
    abortController,
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
      if (msg.type === "stream_event" && msg.event) {
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
          if (session.codeMode) initMessageProjection(session);
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
            if (session.codeMode && a.name === "code") {
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
            if (session.turnMetrics) session.turnMetrics._curMsgOutput = ev.usage.output_tokens;
          }
        }
        if (session.codeMode) projectEvent(session, ev);
        else writeEvent(session, ev);
        if (ev.type === "message_stop") endTurn(session);
      } else if (msg.type === "result") {
        if (msg.usage) {
          const u = normalizeUsage(msg.usage);
          if (u) session.lastUsage = u;
        }
        if (session.nonStream && msg.stop_reason) session.nonStream.stopReason = msg.stop_reason;
        if (msg.subtype && msg.subtype !== "success") {
          failTurn(session, new Error(`SDK result ${msg.subtype}`));
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
    session.res.write(sseEvent(ev.type, ev));
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
  if (session.codeMode) clearAllCodeState(session);
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

// Idle sweeper: close sessions past the TTL (matches Claude prompt-cache window).
const sweeper = setInterval(() => {
  const now = Date.now();
  for (const [key, s] of sessions) {
    if (now - s.lastActivity > SESSION_TTL_MS) {
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
          wave.results[i] = {
            text: result.content?.[0]?.text || "",
            raw: result,
            isError: !!result.isError,
          };
          wave.pending.delete(tr.tool_use_id);
          session.syntheticToCode.delete(tr.tool_use_id);
          break;
        }
      }
    } else {
      // Passthrough / native tool result.
      resolveTool(session, tr.tool_use_id, toCallToolResult(tr));
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

    // Try to dispatch the next queued wave into this same open request.
    maybeDispatchQueuedWave(session);
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

  const { model: rawModel, messages, system, stream, tools } = reqBody;
  if (!rawModel || !Array.isArray(messages) || !messages.length) {
    return jsonResp(res, 400, { type: "error", error: { type: "invalid_request_error", message: "model and messages are required" } });
  }
  const model = normalizeModel(rawModel);

  const callerSystem = extractSystemText(system);
  const isStream = stream !== false;
  const headerCode = req.headers["x-code-mode"];
  let codeMode = serverCodeMode;
  if (headerCode === "0" || headerCode === "false") codeMode = false;
  else if (headerCode === "1" || headerCode === "true") codeMode = true;
  const last = messages[messages.length - 1];
  const toolResults = Array.isArray(last?.content) ? last.content.filter((b) => b.type === "tool_result") : [];
  const lastIsToolResult = toolResults.length > 0;

  // Stable conversation id when the client provides one. Claude Code sends
  // `x-claude-code-session-id` (distinct per conversation AND per subagent), so
  // parallel fan-out sessions that share an identical system+first-user prefix
  // get separate bridge sessions instead of colliding in one content bucket.
  // Droid sends no such header and falls back to content-derived bucketing.
  const convId = (() => {
    const h = req.headers["x-claude-code-session-id"] || req.headers["x-session-id"] || req.headers["x-conversation-id"];
    return typeof h === "string" && h.trim() ? h.trim() : null;
  })();

  let session = findSession(messages, system, convId);
  let resumeCatchupTail = null;
  // "resolve" => feed tool_result(s) to the parked handler of a matched session.
  // "push"    => push the latest user turn into a matched session.
  // "resume"  => cold start recovered via SDK resume; push only the last user turn.
  // "resume-catchup" => SDK resume + small unseen tail as narrative context.
  // "cold"    => no matching live session and no resume index hit: narrative priming.
  // "new"     => brand-new conversation (single message): new session.
  let action;
  if (session && lastIsToolResult) {
    action = "resolve";
  } else if (session) {
    action = "push";
  } else if (messages.length > 1) {
    const b = bucketKey(system, messages, convId);
    {
      const index = loadResumeIndex(resumeIndexFile);
      const candidate = findResumeCandidate({
        entries: index.entries,
        model,
        profileKey: profileKey(serverProfileDir),
        bucket: b,
        messages,
        lastIsToolResult,
        codeMode,
        hashMessages,
      });
      if (candidate?.mode === "resume") {
        session = createSession(randomUUID(), model, tools, callerSystem, b, { resume: candidate.sdkSessionId, codeMode });
        action = "resume";
      } else if (candidate?.mode === "resume-catchup") {
        session = createSession(randomUUID(), model, tools, callerSystem, b, { resume: candidate.sdkSessionId, codeMode });
        action = "resume-catchup";
        resumeCatchupTail = candidate.tail;
      }
    }
    if (!session) {
      session = createSession(randomUUID(), model, tools, callerSystem, b, { codeMode });
      action = "cold";
    }
  } else {
    session = createSession(randomUUID(), model, tools, callerSystem, bucketKey(system, messages, convId), { codeMode });
    action = "new";
  }

  process.stderr.write(`${LOG_PREFIX} request model=${model} stream=${isStream} codeMode=${codeMode} key=${session.key.slice(0, 8)} action=${action} tools=${tools?.length || 0} msgs=${messages.length} [${summarizeMessages(messages)}]\n`);
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
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    res.flushHeaders?.();
    session.res = res;
    session.nonStream = null;
    if (action === "cold" || action === "resume" || action === "resume-catchup") {
      res.write(": warming up\n\n");
    }
    heartbeat = setInterval(() => { if (!res.writableEnded) res.write(`: keep-alive\n\n`); }, HEARTBEAT_MS);
    // Client disconnect detaches the response but must NOT kill the session —
    // the client reconnects with the next POST.
    onClose = () => { if (session.res === res) session.res = null; };
    req.on("close", onClose);
  } else {
    session.res = null;
    session.nonStream = { blocks: [], stopReason: "end_turn" };
  }

  // Drive the turn.
  if (action === "resolve") {
    if (session.codeMode) await resolveCodeModeToolResults(session, toolResults);
    else for (const tr of toolResults) resolveTool(session, tr.tool_use_id, toCallToolResult(tr));
  } else if (action === "resume") {
    session.input.push(toUserFrame(last));
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
    pushColdStartFrames(session, messages, last, lastIsToolResult);
  } else {
    // action === "push" or "new": a fresh user turn on a live session. If the prior turn
    // left a tool round parked (the caller interjected text instead of returning
    // a tool_result), abandon it so the new turn is not stuck behind a handler
    // that will never be resolved.
    if (hasActiveToolRound(session, { includeCurrentTurn: false })) {
      abandonToolRound(session);
    }
    session.input.push(toUserFrame(last));
  }
  markSeen(session, messages);

  try {
    await raceTurn(turnPromise, TURN_TIMEOUT_MS);
  } catch (e) {
    const isTimeout = e?.code === "turn_timeout";
    process.stderr.write(
      `${LOG_PREFIX} turn failed (${session.key}): ${e?.message || e}` +
        (isTimeout
          ? ` wedged: pendingTools=${session.pendingTools.size} streamedToolUses=${session.streamedToolUses.length} orphanResolvers=${session.orphanResolvers.length} resolvedResults=${session.resolvedResults.size}\n`
          : "\n")
    );
    // A timeout means the turn is still attached and the SDK loop may still be
    // parked on a tool handler: settle the turn and abandon the round so the
    // SDK is unblocked (parked handlers resolve with isError) rather than left
    // to hang. consumeSession-initiated failures have already called failTurn
    // (currentTurn is null here), so the guard avoids a double settle.
    if (session.currentTurn) failTurn(session, e);
    if (isStream) {
      if (!res.writableEnded) {
        res.write(sseEvent("error", { type: "error", error: { type: "api_error", message: String(e?.message || e) } }));
        res.end();
      }
    } else {
      if (!res.headersSent) jsonResp(res, 500, { type: "error", error: { type: "api_error", message: String(e?.message || e) } });
    }
    if (heartbeat) clearInterval(heartbeat);
    if (onClose) req.off("close", onClose);
    return;
  }

  if (heartbeat) clearInterval(heartbeat);
  if (onClose) req.off("close", onClose);

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
    });
  }
}

// Start the HTTP server. Auth (CLAUDE_CONFIG_DIR / token) must already be applied
// to process.env by the caller (src/auth.mjs). Returns the http.Server.
export function startServer({ port = 32809, host = "127.0.0.1", account = null, profileDir = process.env.CLAUDE_CONFIG_DIR, version = null, codeMode = true, cacheLog = process.env.CACHE_LOG } = {}) {
  serverProfileDir = profileDir || null;
  serverCodeMode = codeMode !== false;
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
        codeMode: serverCodeMode,
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
    jsonResp(res, 404, { type: "error", error: { type: "not_found_error", message: `unknown route: ${req.method} ${url}` } });
  });

  server.listen(port, host, () => {
    process.stderr.write(`${LOG_PREFIX} listening on http://${host}:${port}\n`);
    process.stderr.write(`${LOG_PREFIX} CLAUDE_CONFIG_DIR: ${profileDir || "(default)"}\n`);
    process.stderr.write(`${LOG_PREFIX} account: ${account?.email || "(unconfirmed — SDK is source of truth)"}\n`);
    process.stderr.write(`${LOG_PREFIX} stateful session bridge (TTL ${SESSION_TTL_MS}ms) — one live query() per conversation\n`);
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
  raceTurn,
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
  maybeDispatchQueuedWave,
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
  serverCodeMode,
  normalizeModel,
  modelObject,
  totalCodeCalls,
  totalCodeSubCalls,
  totalCodeErrors,
  totalCodeWaves,
};
