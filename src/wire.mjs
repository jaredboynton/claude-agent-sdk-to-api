// wire.mjs - Anthropic wire-format plumbing: SSE emission, stream-event
// accumulation (non-streaming mode), usage shaping for client visibility, and
// unified rate-limit header synthesis/caching.

import { LOG_PREFIX } from "./metrics.mjs";

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
  // session.res can be nulled by onClose between heartbeat ticks; the heartbeat
  // guards on the captured res.writableEnded, but a client disconnect sets
  // session.res=null while writableEnded is still false. Without this guard the
  // next keep-alive tick throws null.write and kills the whole daemon.
  if (!session.res || session.res.destroyed || session.res.writableEnded) return;
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

export {
  stripCacheControl,
  toCallToolResult,
  toUserFrame,
  jsonResp,
  sseEvent,
  normalizeRateLimitUtilization,
  rateLimitHeadersFromInfo,
  rememberRateLimitHeaders,
  latestRateLimitHeaders,
  refreshRateLimitsFromControl,
  ensureSseHeaders,
  writeSseChunk,
  accumulateStreamEvent,
  normalizeUsage,
  cloneUsageForClient,
  clientVisibleUsage,
};
