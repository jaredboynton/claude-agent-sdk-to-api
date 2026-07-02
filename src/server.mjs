

import { randomUUID } from "node:crypto";
import http from "node:http";
import { cacheLogPath, initCacheLog } from "./cache-log.mjs";
import { CAVEMAN_RULES_VERSION, cavemanLevels, cavemanTag, configureCaveman } from "./caveman.mjs";
import { initDebugRing, recentDebug } from "./debug-ring.mjs";
import { CACHE_WARM_WINDOW_MS, buildResumeCatchupFrames, defaultIndexPath, findResumeCandidate, loadResumeIndex, loadToolsetBlob, profileKey, toolsetDirFor } from "./resume-index.mjs";
import { getUpdateStatus, triggerUpdateCheck } from "./self-update.mjs";
import { LOG_PREFIX, metrics } from "./metrics.mjs";
import { jsonResp, latestRateLimitHeaders, sseEvent, toUserFrame, writeSseChunk } from "./wire.mjs";
import { actionableTail, bucketKey, decideWarmAction, extractSystemText, hashMessages, primingFrameText, pushColdStartFrames, renderPrimingTranscript, summarizeMessages } from "./session-identity.mjs";
import { mergeLateTool, stripBridgeToolName } from "./client-tools.mjs";
import { abandonToolRound, failTurn, hasActiveToolRound, notifyTurnAttached } from "./code-run.mjs";
import { resolveCodeModeToolResults } from "./code-recovery.mjs";
import { HEARTBEAT_MS, SESSION_TTL_MS, TURN_STALL_SWEEP_MS, TURN_STALL_TIMEOUT_MS, configureSessionPersistence, createSession, findSession, markSeen, persistResumeIndex, resolveCwd, resumeIndexFile, serverProfileDir, sessions } from "./session.mjs";

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

  const { model: rawModel, messages, system, stream, tools, thinking } = reqBody;
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
  const cwd = resolveCwd(req.headers["x-claude-cwd"], callerSystem);

  // The client's extended-thinking budget maps to the SDK's maxThinkingTokens.
  // queryOptions is fixed at session creation, so the first request of a
  // conversation decides the budget for the whole session; previously the
  // field was dropped entirely and the client's reasoning toggle had no effect.
  const maxThinkingTokens =
    thinking?.type === "enabled" && Number(thinking.budget_tokens) > 0
      ? Number(thinking.budget_tokens)
      : undefined;

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
  let coldReason = null;
  if (session) {
    // Warm session: decide from the classified tail (resolve | push | noop).
    // Never fabricate a user turn from a trailing system/meta message, and never
    // abandon a parked tool round just because a system message trails the
    // tool_result. See decideWarmAction()/actionableTail().
    action = decideWarmAction(tail).action;
    // Tool-set drift: the `code` description froze at session creation (its
    // bytes are part of the cached prefix), but the script runtime is not
    // frozen — merge late tools into session.clientTools/inputParsers so the
    // next code run can call them, and announce them on the next code
    // tool_result (append-only transcript; the prefix is never re-written).
    if (tools?.length && session.clientTools?.size) {
      for (const t of tools) {
        if (!t?.name || t.name === "code" || session.clientTools.has(t.name)) continue;
        mergeLateTool(session, t);
      }
    }
  } else if (messages.length > 1) {
    const b = bucketKey(system, messages, convId, cwd);
    // Cold start: try to recover via SDK session resume (persisted in
    // resume-index.json). For code-mode sessions a tool_result tail is a hard
    // exclusion (synthetic toolu_code_* ids from a prior code run cannot be
    // routed by a freshly-resumed SDK session); small non-tool_result tails go
    // through resume-catchup with the mimicry-safe renderer, same as normal
    // mode. Anything else falls through to mimicry-safe cold priming.
    const index = loadResumeIndex(resumeIndexFile);
    const resumeTrace = {};
    const candidate = findResumeCandidate({
      entries: index.entries,
      model,
      profileKey: profileKey(serverProfileDir),
      bucket: b,
      messages,
      lastIsToolResult,
      codeMode: true,
      hashMessages,
      trace: resumeTrace,
    });
    if (candidate?.mode === "resume" || candidate?.mode === "resume-catchup") {
      // Warm-window resume MUST reuse the conversation's frozen toolset bytes;
      // past the cache TTL the prefix re-writes anyway, so rendering fresh
      // (current tools, current prose) is free — the only moment description
      // bytes are allowed to change.
      let frozenToolset = null;
      const warm = candidate.updatedAt && Date.now() - candidate.updatedAt < CACHE_WARM_WINDOW_MS;
      if (warm) {
        frozenToolset = candidate.toolsetHash
          ? loadToolsetBlob(candidate.toolsetHash, toolsetDirFor(resumeIndexFile))
          : null;
        if (!frozenToolset) {
          process.stderr.write(`${LOG_PREFIX} warm resume without frozen toolset (${candidate.toolsetHash ? "blob missing" : "legacy entry"}); code description may re-write the cached prefix\n`);
        }
        // Caveman settings changed since this entry was persisted: the frozen
        // description bytes are immune (replayed verbatim), but the system
        // append re-derives at the new level — one 2x prefix re-write.
        if ((candidate.caveman || "") !== cavemanTag()) {
          process.stderr.write(`${LOG_PREFIX} caveman settings changed mid-warm-window (entry=${candidate.caveman || "off"} now=${cavemanTag() || "off"}); system append bytes will differ this turn\n`);
        }
      }
      session = createSession(randomUUID(), model, tools, callerSystem, b, { resume: candidate.sdkSessionId, cwd, frozenToolset, maxThinkingTokens });
      action = candidate.mode;
      if (candidate.mode === "resume-catchup") resumeCatchupTail = candidate.tail;
    }
    if (!session) {
      coldReason = `resume-rejected(${resumeTrace.reason || "unknown"})`;
      // Unstable x-claude-cwd diagnosis: a live session for this conversation
      // exists under a different cwd bucket — the client's header moved.
      if (convId) {
        for (const s of sessions.values()) {
          if (!s.closed && s.convId && s.convId === convId && s.cwd !== cwd) {
            coldReason = `cwd-mismatch(live session at ${s.cwd})`;
            process.stderr.write(`${LOG_PREFIX} WARNING conversation ${convId.slice(0, 8)} has a live session under cwd=${s.cwd} but this request says cwd=${cwd}; unstable x-claude-cwd header forces a cache-cold session\n`);
            break;
          }
        }
      }
      session = createSession(randomUUID(), model, tools, callerSystem, b, { cwd, maxThinkingTokens });
      action = "cold";
    }
  } else {
    session = createSession(randomUUID(), model, tools, callerSystem, bucketKey(system, messages, convId, cwd), { cwd, maxThinkingTokens });
    action = "new";
  }
  if (convId && !session.convId) session.convId = convId;

  process.stderr.write(`${LOG_PREFIX} request model=${model} stream=${isStream} key=${session.key.slice(0, 8)} action=${action} cwd=${session.cwd} tools=${tools?.length || 0} msgs=${messages.length} [${summarizeMessages(messages)}]\n`);
  session.lastActivity = Date.now();

  // Attach this HTTP response as the session's current turn.
  let onClose;
  let heartbeat;
  let stallTimer;
  session.turnMetrics = {
    action, startedAt: Date.now(), firstEventAt: null, textDeltas: 0,
    usage: { input: 0, read: 0, create5m: 0, create1h: 0, output: 0 },
    messages: 0, _curMsgOutput: 0, codeSubCalls: 0, codeWaves: 0, scriptOutBytes: 0,
    scriptInBytes: 0, spills: 0, stateBytes: 0, codeErrors: 0, codeRecoveries: 0,
    singleCallRuns: 0, coldReason,
  };
  const turnPromise = new Promise((resolve, reject) => {
    session.currentTurn = { resolve, reject };
  });

  // Stall watchdog: fail (never hang) a turn whose session has gone completely
  // silent — zero SDK events and zero tool traffic — for TURN_STALL_TIMEOUT_MS.
  if (TURN_STALL_TIMEOUT_MS > 0) {
    const attachedAt = Date.now();
    stallTimer = setInterval(() => {
      if (!session.currentTurn) return; // settled; cleanup happens at turn end
      const idleMs = Date.now() - Math.max(attachedAt, session.lastActivity);
      if (idleMs < TURN_STALL_TIMEOUT_MS) return;
      const run = session.codeRun;
      process.stderr.write(
        `${LOG_PREFIX} turn STALLED key=${session.key.slice(0, 8)} action=${action} idle_ms=${idleMs}` +
          ` codeRun=${run ? `codeId=${run.codeId} wave=${run.waveSeq} dispatched=${!!run.currentWave?.dispatched} pending=${run.currentWave?.pending?.size ?? 0}` : "none"}` +
          ` pendingTools=${session.pendingTools.size} streamedToolUses=${session.streamedToolUses.length}; failing turn\n`
      );
      failTurn(session, new Error(`turn stalled: no session activity for ${idleMs}ms (TURN_STALL_TIMEOUT_MS=${TURN_STALL_TIMEOUT_MS})`));
    }, TURN_STALL_SWEEP_MS);
    stallTimer.unref?.();
  }

  if (isStream) {
    session.res = res;
    session.sseHeadersWritten = false;
    session.nonStream = null;
    heartbeat = setInterval(() => { if (!res.writableEnded) writeSseChunk(session, `: keep-alive\n\n`); }, HEARTBEAT_MS);
    heartbeat.unref?.();
    // A response close before writableEnded means the client did not receive
    // the full streamed turn (escape / network drop). Nothing this turn was
    // producing can be delivered or answered: tear down the WHOLE in-flight
    // round unconditionally — active code run dispatched-wave or not — settle
    // the turn with a logged failure, and interrupt the live SDK query so it
    // stops burning tokens on output nobody will receive. The session itself
    // stays warm so the client can rejoin with its next POST. (The old guard
    // on codeRun.currentWave.dispatched leaked runs that were between waves at
    // disconnect time: the run kept executing, its next wave dropped into a
    // null response, and the turn parked forever with no log line.)
    onClose = () => {
      const aborted = !res.writableEnded;
      if (session.res === res) session.res = null;
      // Stop keep-alive ticks once the response closes; otherwise a disconnect
      // arms a post-close tick that races session.res=null and crashes.
      if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
      if (!aborted) return;
      const run = session.codeRun;
      process.stderr.write(
        `${LOG_PREFIX} client disconnected mid-turn key=${session.key.slice(0, 8)}` +
          ` codeRun=${run ? `wave=${run.waveSeq} dispatched=${!!run.currentWave?.dispatched}` : "none"}` +
          `; aborting in-flight work\n`
      );
      // interrupt() is async fire-and-forget: the SDK aborts its current
      // assistant turn; the query stream stays alive for the next push.
      try { session.query?.interrupt?.().catch(() => {}); } catch {}
      if (session.currentTurn) failTurn(session, new Error("client disconnected mid-turn"));
      else abandonToolRound(session);
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
    if (stallTimer) clearInterval(stallTimer);
    if (onClose) res.off("close", onClose);
    return;
  }

  if (heartbeat) clearInterval(heartbeat);
  if (stallTimer) clearInterval(stallTimer);
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
export function startServer({ port = 32809, host = "127.0.0.1", account = null, profileDir = process.env.CLAUDE_CONFIG_DIR, version = null, cacheLog = process.env.CACHE_LOG, caveman = process.env.CAVEMAN, cavemanSystem = process.env.CAVEMAN_SYSTEM } = {}) {
  initDebugRing(profileDir || null);
  configureSessionPersistence({ profileDir, indexPath: defaultIndexPath() });
  initCacheLog(cacheLog, profileDir);
  const cavemanCfg = configureCaveman({ caveman, cavemanSystem });
  process.stderr.write(`${LOG_PREFIX} caveman: tools=${cavemanCfg.tools} system=${cavemanCfg.system} rules=v${CAVEMAN_RULES_VERSION}\n`);
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
        fifoFallbacks: metrics.totalFifoFallbacks,
        codeCalls: metrics.totalCodeCalls,
        codeSubCalls: metrics.totalCodeSubCalls,
        codeErrors: metrics.totalCodeErrors,
        codeWaves: metrics.totalCodeWaves,
        cacheReadTokens: metrics.totalCacheReadTokens,
        cacheCreationTokens: metrics.totalCacheCreationTokens,
        cacheLog: cacheLogPath() || null,
        caveman: { ...cavemanLevels(), rulesVersion: CAVEMAN_RULES_VERSION, descSavedBytes: metrics.totalCavemanDescSaved, systemSavedBytes: metrics.totalCavemanSystemSaved },
        update: getUpdateStatus(),
      });
    }
    // Update status + manual trigger. Background polling may be off during
    // development; POST still runs one registry check / gated apply tick.
    if (req.method === "GET" && (url === "/update" || url === "/update/")) {
      return jsonResp(res, 200, { ok: true, update: getUpdateStatus() });
    }
    if (req.method === "POST" && (url === "/update" || url === "/update/" || url === "/update/check" || url === "/update/check/")) {
      const r = await triggerUpdateCheck();
      return jsonResp(res, 200, { ok: true, outcome: r?.outcome ?? null, detail: r?.detail ?? r?.reason ?? null, update: getUpdateStatus() });
    }
    // Post-mortem trail: newest debug-ring entries (code runs, tool_use
    // dispatches, tool_results). Disk mirror lives at <profileDir>/debug-ring.jsonl.
    if (req.method === "GET" && (url === "/debug/recent" || url === "/debug/recent/")) {
      const n = Number(new URLSearchParams(rawUrl.split("?")[1] || "").get("n")) || 100;
      return jsonResp(res, 200, { entries: recentDebug(n) });
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

  // Every intentional exit logs its reason so a dead daemon is diagnosable
  // from the log alone (no more anonymous deaths between log lines).
  const shutdown = (signal) => () => {
    process.stderr.write(`${LOG_PREFIX} ${signal} received; shutting down\n`);
    try { server.close(); } catch {}
    process.exit(0);
  };
  process.on("SIGTERM", shutdown("SIGTERM"));
  process.on("SIGINT", shutdown("SIGINT"));

  return server;
}

// ---------------------------------------------------------------------------
// Barrel re-exports: bin/cli.mjs, the package export, and the test suite all
// import from src/server.mjs; keep every historical seam available here.
// ---------------------------------------------------------------------------
export {
  stripCacheControl,
  toCallToolResult,
  toUserFrame,
  writeSseChunk,
  accumulateStreamEvent,
  normalizeRateLimitUtilization,
  rateLimitHeadersFromInfo,
  rememberRateLimitHeaders,
  latestRateLimitHeaders,
  ensureSseHeaders,
} from "./wire.mjs";
export {
  bucketKey,
  hashMessages,
  renderMsgText,
  renderTranscript,
  renderMsgPriming,
  renderPrimingTranscript,
  primingFrameText,
  actionableTail,
  decideWarmAction,
  pushColdStartFrames,
} from "./session-identity.mjs";
export {
  toolInputShape,
  fallbackShape,
  jsonSchemaToZod,
  stripBridgeToolName,
  claimStreamedToolUse,
  normalizeToolInput,
  extractIdHint,
  buildParkingMcpServer,
  registerClientTool,
  mergeLateTool,
  appendPendingToolNotice,
  appendCodeResultNote,
  stateByteSize,
} from "./client-tools.mjs";
export {
  makeInputQueue,
  noteStreamTiming,
  endTurn,
  resolveTool,
  writeEvent,
} from "./turn-io.mjs";
export {
  abandonToolRound,
  hasActiveToolRound,
  startCodeRun,
  dispatchCodeWave,
  fabricateCurrentWave,
  notifyTurnAttached,
  projectEvent,
  initMessageProjection,
  clearAllCodeState,
  clearCodeRun,
  syntheticIdFor,
  internalResolveCode,
  emitClientToolUse,
} from "./code-run.mjs";
export {
  resolveCodeModeToolResults,
} from "./code-recovery.mjs";
export {
  CAVEMAN_RULES_VERSION,
  cavemanLevels,
  cavemanTag,
  compressProse,
  configureCaveman,
  normalizeCavemanLevel,
} from "./caveman.mjs";
export {
  findSession,
  markSeen,
  sessions,
  persistResumeIndex,
  createSession,
  resolveCwd,
  isValidCwd,
  activeWork,
} from "./session.mjs";
export {
  normalizeModel,
  modelObject,
  needsStructuredOutputPassthrough,
  anthropicPassthroughHeaders,
  forwardAnthropicMessages,
};
