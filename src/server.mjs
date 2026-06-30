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
//     are closed by a sweeper.
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

const HOME = homedir();
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS || process.env.ACP_SESSION_TTL_MS || 300000); // 5 min
const HEARTBEAT_MS = Number(process.env.HEARTBEAT_MS || process.env.ACP_HEARTBEAT_MS || 15000);
const TOOL_TIMEOUT_MS = Number(process.env.TOOL_TIMEOUT_MS || process.env.ACP_TOOL_TIMEOUT_MS || 270000); // 4.5 min; must stay under SESSION_TTL_MS
// Turn-level watchdog: backstop for any path where message_stop never fires
// (e.g. the SDK stream goes quiet mid-thinking, or a parked handler blocks the
// SDK from emitting message_stop and the per-handler TOOL_TIMEOUT_MS somehow
// doesn't fire). Must be > TOOL_TIMEOUT_MS so the handler park timeout gets the
// first chance to unblock the loop; default matches SESSION_TTL_MS.
const TURN_TIMEOUT_MS = Number(process.env.TURN_TIMEOUT_MS || process.env.ACP_TURN_TIMEOUT_MS || 300000);
const LOG_PREFIX = "[claude-agent-api]";

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

// Bucket key: hash of system prompt + first user message. Groups sessions that
// could belong to the same conversation; final match is by history prefix.
function bucketKey(system, messages) {
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

// Claim the streamed tool_use entry that corresponds to a handler invocation.
// The SDK does not pass the tool_use id to the handler, but it passes the tool
// name (via the handler closure) and the validated input args. We therefore
// correlate by (name, input), consuming the matched entry so parallel or
// duplicate calls cannot collide. If exact matching fails, fall back to FIFO.
function claimStreamedToolUse(session, name, args) {
  const idx = session.streamedToolUses.findIndex(
    (entry) => entry.name === name && isDeepStrictEqual(entry.input, args)
  );
  if (idx !== -1) return session.streamedToolUses.splice(idx, 1)[0] || null;
  if (session.streamedToolUses.length) {
    const fallback = session.streamedToolUses[0];
    process.stderr.write(`${LOG_PREFIX} no exact match for ${name}(${JSON.stringify(args)}); falling back to FIFO ${fallback.id}\n`);
    return session.streamedToolUses.shift();
  }
  return null;
}

// Build an SDK MCP server whose handlers PARK: when the model calls a tool, the
// handler claims the matching streamed tool_use id, then either returns a result
// that already arrived, or returns a promise that the bridge resolves when the
// client POSTs the matching tool_result. A watchdog timeout returns {isError:true}
// so the SDK agent loop survives a never-delivered tool result.
function buildParkingMcpServer(tools, session, createServer = createSdkMcpServer) {
  if (!tools || !tools.length) return null;
  const mcpTools = tools.map((t) => ({
    name: t.name,
    description: t.description || "",
    inputSchema: toolInputShape(t.input_schema || { type: "object", properties: {} }),
    handler: async (args) => {
      const originalName = t.name;
      const entry = claimStreamedToolUse(session, originalName, args);
      const id = entry?.id;

      if (id && session.resolvedResults.has(id)) {
        const r = session.resolvedResults.get(id);
        session.resolvedResults.delete(id);
        return r;
      }

      return new Promise((resolve) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (!settled) {
            settled = true;
            if (id) session.pendingTools.delete(id);
            process.stderr.write(`${LOG_PREFIX} tool ${id ?? originalName} park timeout after ${TOOL_TIMEOUT_MS}ms; returning isError\n`);
            resolve({ content: [{ type: "text", text: `Tool result was not provided within ${TOOL_TIMEOUT_MS}ms` }], isError: true });
          }
        }, TOOL_TIMEOUT_MS);

        const wrappedResolve = (result) => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            resolve(result);
          }
        };

        if (id) session.pendingTools.set(id, wrappedResolve);
        else session.orphanResolvers.push(wrappedResolve);
      });
    },
  }));
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

// Find the live session this request belongs to: same bucket, not closed, not
// mid-turn (a mid-turn match means a genuinely concurrent request -> fork a new
// session so we never clobber currentTurn/res), and whose already-processed
// prefix the incoming history extends. Longest matching prefix wins (most
// specific). Returns null on cold start (model swap / eviction / restart).
function findSession(messages, system) {
  const b = bucketKey(system, messages);
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

function createSession(key, model, tools, callerSystem, bucket) {
  const input = makeInputQueue();
  const abortController = new AbortController();
  const session = {
    key,                          // bridge-owned UUID (never collides)
    bucket,                       // hash(system + first user msg) for candidate grouping
    seenCount: 0,                 // messages already processed by this session
    seenHash: hashMessages([], 0),// hash of that processed prefix (prefix-match guard)
    model,
    originalNames: new Set((tools || []).map((t) => t && t.name).filter(Boolean)),
    input,
    abortController,
    pendingTools: new Map(),      // toolUseId -> resolve(CallToolResult)
    resolvedResults: new Map(),   // toolUseId -> CallToolResult (arrived before handler parked)
    orphanResolvers: [],          // resolvers with no captured id (defensive)
    streamedToolUses: [],         // completed {id,name,input} tool_use blocks awaiting handler claim
    toolUseAccum: new Map(),      // stream index -> {id,name,partial} (input JSON assembled across deltas)
    currentTurn: null,            // { resolve } deferred for the active HTTP turn
    res: null,                    // current streaming HTTP response
    nonStream: null,              // { blocks, stopReason } when buffering for non-stream
    lastUsage: { input_tokens: 0, output_tokens: 0 },
    lastActivity: Date.now(),
    closed: false,
  };

  const mcpServer = buildParkingMcpServer(tools, session);
  session.query = query({
    prompt: input.iterable,
    options: {
      model,
      systemPrompt: { type: "preset", preset: "claude_code", append: callerSystem },
      settingSources: [],
      tools: [],
      mcpServers: mcpServer ? [mcpServer] : [],
      strictMcpConfig: true,
      permissionMode: "bypassPermissions", // MCP handlers (our parking tools) must run without prompts
      cwd: HOME,
      includePartialMessages: true,
      abortController,
    },
  });

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
      if (msg.type === "stream_event" && msg.event) {
        const ev = msg.event;
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
            session.toolUseAccum.delete(ev.index);
          }
        }
        // Capture usage from the stream (the result message may not arrive
        // before the turn parks mid-loop). message_start carries input tokens;
        // message_delta carries the running output tokens.
        if (ev.type === "message_start" && ev.message?.usage) {
          const u = normalizeUsage(ev.message.usage);
          if (u) session.lastUsage = u;
        }
        if (ev.type === "message_delta" && ev.usage) {
          // delta usage carries output (and cache) tokens; keep input from message_start.
          if (ev.usage.output_tokens != null) session.lastUsage.output_tokens = ev.usage.output_tokens;
          if (ev.usage.cache_read_input_tokens != null) session.lastUsage.cache_read_input_tokens = ev.usage.cache_read_input_tokens;
          if (ev.usage.cache_creation_input_tokens != null) session.lastUsage.cache_creation_input_tokens = ev.usage.cache_creation_input_tokens;
        }
        writeEvent(session, ev);
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
}

// Ending a streamed turn flushes the HTTP response to the client, but the tool
// round is NOT over: a parked handler must outlive this boundary so the client
// can execute the tool and POST the result on a later request. So endTurn never
// touches tool state. message_start clears the per-message correlation buffers;
// the watchdog and resolveTool clear pendingTools.
function endTurn(session) {
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

async function handleMessages(req, res) {
  let body = "";
  for await (const chunk of req) body += chunk;
  let reqBody;
  try {
    reqBody = JSON.parse(body);
  } catch (e) {
    return jsonResp(res, 400, { type: "error", error: { type: "invalid_request_error", message: "invalid JSON body" } });
  }

  const { model, messages, system, stream, tools } = reqBody;
  if (!model || !Array.isArray(messages) || !messages.length) {
    return jsonResp(res, 400, { type: "error", error: { type: "invalid_request_error", message: "model and messages are required" } });
  }

  const callerSystem = extractSystemText(system);
  const isStream = stream !== false;
  const last = messages[messages.length - 1];
  const toolResults = Array.isArray(last?.content) ? last.content.filter((b) => b.type === "tool_result") : [];
  const lastIsToolResult = toolResults.length > 0;

  let session = findSession(messages, system);
  // "resolve" => feed tool_result(s) to the parked handler of a matched session.
  // "push"    => push the latest user turn into a matched session.
  // "cold"    => no matching live session but history exists (model swap / TTL
  //              eviction / restart): new session primed with the full transcript.
  // "new"     => brand-new conversation (single message): new session.
  let action;
  if (session && lastIsToolResult) {
    action = "resolve";
  } else if (session) {
    action = "push";
  } else if (messages.length > 1) {
    session = createSession(randomUUID(), model, tools, callerSystem, bucketKey(system, messages));
    action = "cold";
  } else {
    session = createSession(randomUUID(), model, tools, callerSystem, bucketKey(system, messages));
    action = "new";
  }

  process.stderr.write(`${LOG_PREFIX} request model=${model} stream=${isStream} key=${session.key.slice(0, 8)} action=${action} tools=${tools?.length || 0} msgs=${messages.length} [${summarizeMessages(messages)}]\n`);

  // Attach this HTTP response as the session's current turn.
  let onClose;
  let heartbeat;
  const turnPromise = new Promise((resolve, reject) => {
    session.currentTurn = { resolve, reject };
  });

  if (isStream) {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    res.flushHeaders?.();
    session.res = res;
    session.nonStream = null;
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
    for (const tr of toolResults) resolveTool(session, tr.tool_use_id, toCallToolResult(tr));
  } else if (action === "cold") {
    // Recover full context: prime the fresh session with the prior transcript,
    // then push the actionable last turn. The live loop still drives all NEW
    // tool calls, so prior tool calls are narrative context only.
    if (lastIsToolResult) {
      // Evicted mid tool-loop: a raw tool_result has no matching tool_use in the
      // fresh session, so fold the whole transcript into narrative and ask the
      // model to continue from it.
      session.input.push(toUserFrame({
        role: "user",
        content: [{ type: "text", text: `Continue this conversation from where it left off. Full prior context:\n\n${renderTranscript(messages)}` }],
      }));
    } else {
      session.input.push(toUserFrame({
        role: "user",
        content: [{ type: "text", text: `Continue this conversation. Full prior context:\n\n${renderTranscript(messages.slice(0, -1))}` }],
      }));
      session.input.push(toUserFrame(last));
    }
  } else {
    // action === "push": a fresh user turn on a live session. If the prior turn
    // left a tool round parked (the caller interjected text instead of returning
    // a tool_result), abandon it so the new turn is not stuck behind a handler
    // that will never be resolved.
    if (session.pendingTools.size || session.streamedToolUses.length || session.orphanResolvers.length) {
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
export function startServer({ port = 32809, host = "127.0.0.1", account = null, profileDir = process.env.CLAUDE_CONFIG_DIR, version = null } = {}) {
  const server = http.createServer(async (req, res) => {
    const url = req.url || "";
    if (req.method === "GET" && (url === "/healthz" || url === "/")) {
      return jsonResp(res, 200, {
        ok: true,
        service: "claude-agent-api",
        version,
        port,
        profileDir: profileDir || null,
        account: account?.email || null,
        sessions: sessions.size,
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
  findSession,
  markSeen,
  sessions,
  stripCacheControl,
  toCallToolResult,
  toUserFrame,
  makeInputQueue,
  claimStreamedToolUse,
  abandonToolRound,
  buildParkingMcpServer,
  raceTurn,
};
