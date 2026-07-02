// session.mjs - session store and SDK query() lifecycle: one live session per
// conversation, cwd resolution, cold-start creation, the consume loop, resume
// index persistence, and the idle/stall sweepers.

import { statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { createAnchorState } from "./anchor-edit.mjs";
import { preflightProfileDir } from "./auth.mjs";
import { collectGitSnapshot } from "./local-checks.mjs";
import { defaultIndexPath, loadResumeIndex, profileKey, pruneToolsetBlobs, saveResumeIndex, saveToolsetBlob, toolsetDirFor, upsertResumeEntry } from "./resume-index.mjs";
import { createSdkMcpServer, query } from "./sdk.mjs";
import { LOG_PREFIX } from "./metrics.mjs";
import { cloneUsageForClient, normalizeUsage, refreshRateLimitsFromControl, rememberRateLimitHeaders } from "./wire.mjs";
import { bucketKey, hashMessages } from "./session-identity.mjs";
import { buildParkingMcpServer, mergeLateTool, stripBridgeToolName } from "./client-tools.mjs";
import { cavemanLevels, cavemanTag, compressProse } from "./caveman.mjs";
import { accumulateTurnUsage, endTurn, makeInputQueue, noteStreamTiming } from "./turn-io.mjs";
import { abandonToolRound, failTurn, hasActiveToolRound, initMessageProjection, projectEvent, startCodeRun } from "./code-run.mjs";

const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS || process.env.ACP_SESSION_TTL_MS || 10800000); // 3 h

const HEARTBEAT_MS = Number(process.env.HEARTBEAT_MS || process.env.ACP_HEARTBEAT_MS || 15000);

// Turn teardown is primarily EVENT-DRIVEN off the SDK query() lifecycle:
// message_stop / result / idle settle the turn, and the iterator
// ending/erroring/aborting fails it (consumeSession). The stall watchdog below
// is a last-resort BACKSTOP for a turn that is attached but has seen zero
// activity (no SDK events, no tool traffic — session.lastActivity frozen) for
// the whole window: instead of hanging the client forever on keep-alives, it
// dumps the session state to the log and fails the turn with a real SSE error
// so the wedge is diagnosable and the client can retry. Long thinking and long
// code scripts both bump lastActivity via their stream/tool events, so a
// healthy slow turn never trips it. 0 disables.
const TURN_STALL_TIMEOUT_MS = Number(process.env.TURN_STALL_TIMEOUT_MS ?? 300000); // 5 min

const TURN_STALL_SWEEP_MS = 30000;

const CODE_GIT_SNAPSHOT = process.env.CODE_GIT_SNAPSHOT !== "0";

// Per-request working directory.
//
// In real Claude Code, cwd is a per-process mutable value seeded from the launch
// directory and read fresh into the `<env>Working directory: ...` block. This
// proxy is a single long-lived daemon serving many clients in many projects, so
// it has no inherent knowledge of any client's directory — `process.cwd()` is a
// single global that can't represent N concurrent conversations. The client must
// therefore tell us, per request, via the `x-claude-cwd` header (launch Claude
// Code with ANTHROPIC_CUSTOM_HEADERS="x-claude-cwd: $PWD"). Clients that don't
// set the header still work: Claude Code embeds "Working directory: /abs/path"
// in its system prompt <env> block, which we parse as a fallback. Last resort
// is CLAUDE_PROXY_CWD, then the daemon's own process.cwd(). Mid-session `cd`
// drift self-corrects: the SDK
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

// Resolve the working directory for a request: a valid x-claude-cwd header
// wins, then a "Working directory: ..." line in the caller's system prompt
// (Claude Code's <env> block), then the daemon-wide fallback (CLAUDE_PROXY_CWD
// or process.cwd()).
function resolveCwd(headerVal, callerSystem) {
  const h = Array.isArray(headerVal) ? headerVal[0] : headerVal;
  if (isValidCwd(h)) return h;
  if (h != null && h !== "") {
    process.stderr.write(`${LOG_PREFIX} ignoring invalid x-claude-cwd header (${String(h).slice(0, 120)})\n`);
  }
  const m = typeof callerSystem === "string" ? callerSystem.match(/^Working directory:[ \t]*(.+?)[ \t]*$/m) : null;
  if (m && isValidCwd(m[1])) return m[1];
  return PROXY_CWD_FALLBACK;
}

// ----------------------------------------------------------------------------
// Session store: one live SDK query() per conversation (per process).
// ----------------------------------------------------------------------------

const sessions = new Map(); // key (UUID) -> Session

// Set by startServer(); used for disk-backed SDK session resume after cold start.
let serverProfileDir = null;

let resumeIndexFile = defaultIndexPath();

function configureSessionPersistence({ profileDir = null, indexPath = defaultIndexPath() } = {}) {
  serverProfileDir = profileDir || null;
  resumeIndexFile = indexPath;
}

function persistResumeIndex(session, model, system, messages, indexPath = resumeIndexFile) {
  if (!session.sdkSessionId || !serverProfileDir) return;
  try {
    // Persist the frozen toolset (exact description bytes + raw tools) so a
    // warm-window resume can reuse them verbatim instead of re-rendering —
    // a re-render with a grown tool list or newer prose would re-write the
    // conversation's whole cached prefix. Content-addressed: identical
    // toolsets across conversations share one blob.
    let toolsetHash = null;
    if (session.codeDescription && Array.isArray(session.toolsetRawTools)) {
      try {
        toolsetHash = saveToolsetBlob(
          {
            description: session.codeDescription,
            tools: session.toolsetRawTools,
            // Frozen with the description; omitted for sessions created from a
            // legacy blob so their re-persisted blob keeps its original hash.
            ...(session.scriptDesc ? { scriptDesc: session.scriptDesc } : {}),
          },
          toolsetDirFor(indexPath),
        );
      } catch (e) {
        process.stderr.write(`${LOG_PREFIX} toolset blob write failed: ${e?.message || e}\n`);
      }
    }
    const index = loadResumeIndex(indexPath);
    const updated = upsertResumeEntry(index, {
      profileKey: profileKey(serverProfileDir),
      bucket: session.bucket,
      seenCount: session.seenCount,
      seenHash: session.seenHash,
      sdkSessionId: session.sdkSessionId,
      model,
      codeMode: true,
      ...(toolsetHash ? { toolsetHash } : {}),
      // Caveman settings fingerprint: lets a later warm resume detect that the
      // system-append bytes will differ (level/rules changed) and say so.
      ...(cavemanTag() ? { caveman: cavemanTag() } : {}),
    });
    saveResumeIndex(updated, indexPath);
    pruneToolsetBlobs(updated.entries, toolsetDirFor(indexPath));
  } catch (e) {
    process.stderr.write(`${LOG_PREFIX} resume index write failed: ${e?.message || e}\n`);
  }
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

function createSession(key, model, tools, callerSystem, bucket, { resume, cwd = PROXY_CWD_FALLBACK, frozenToolset = null, maxThinkingTokens = undefined } = {}) {
  // Recheck the profile dir on every new session, not just at startup: the
  // bundled CLI mkdirs $CLAUDE_CONFIG_DIR/session-env/<id> per session, and a
  // profile cleanup can break that (dangling symlink) while the daemon is up.
  // Repair is a handful of lstats when healthy; log-and-continue on failure —
  // the SDK surfaces its own error if the dir is truly unusable.
  if (serverProfileDir) {
    try {
      const pre = preflightProfileDir(serverProfileDir, { repair: true });
      for (const r of pre.repaired) {
        process.stderr.write(`${LOG_PREFIX} profile preflight: repaired ${r.entry} (${r.reason}) -> ${r.target}\n`);
      }
      for (const e of pre.errors) {
        process.stderr.write(`${LOG_PREFIX} profile preflight: UNREPAIRABLE ${e.entry}: ${e.reason}\n`);
      }
    } catch (e) {
      process.stderr.write(`${LOG_PREFIX} profile preflight failed: ${e?.message || e}\n`);
    }
  }
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
    codeRun: null,                // active dynamic code run: { codeId, currentWave, waveSeq, waveCount, callCount, aborted }
    syntheticToCode: new Map(),   // syntheticId -> codeId (for routing tool_results)
    codeDriving: false,           // bridge controls visible client turns while SDK is parked on code
    suppressEndTurn: false,
    codeCalls: 0,
    codeSubCalls: 0,
    codeErrors: 0,
    codeWaves: 0,
    codeState: {},               // persistent `state` global across code calls (conversation memory; survives clearAllCodeState)
    codeArtifacts: new Map(),    // id -> {text, ts}: full text of truncated results, fetched via codemode.recall(id)
    codeArtifactSeq: 0,
    lateTools: null,             // Set of tool names that arrived after session creation (merged into the runtime; telemetry)
    pendingToolNotice: null,      // Set of late-tool names awaiting in-band announcement on the next code tool_result
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

  // Ambient git context, captured once per session (fire-and-forget; ~50ms
  // typical, ready long before the first code run). Seeded into the script's
  // `state.git` — state costs ZERO transcript bytes unless a script touches
  // it, so this is cache-safe by construction, unlike appending to a result.
  if (CODE_GIT_SNAPSHOT) {
    collectGitSnapshot(cwd)
      .then((snap) => { if (snap && !session.closed) session.gitSnapshot = snap; })
      .catch(() => {});
  }

  const mcpServer = buildParkingMcpServer(tools, session, createSdkMcpServer, frozenToolset);
  // Warm-window resume: tools the client added since the frozen toolset was
  // persisted merge into the script runtime (announced in-band on the next
  // code result); the frozen description bytes stay untouched.
  if (frozenToolset && tools?.length && session.clientTools?.size) {
    for (const t of tools) {
      if (!t?.name || t.name === "code" || session.clientTools.has(t.name)) continue;
      mergeLateTool(session, t);
    }
  }
  // The SDK sees the caveman-compressed system append; the RAW callerSystem
  // keeps driving bucketKey identity and resolveCwd scraping, so compression
  // can never perturb session matching. The append is not frozen anywhere: a
  // pure function of (bytes, level) re-derives identical bytes every turn.
  const sdkSystem = callerSystem
    ? compressProse(callerSystem, { level: cavemanLevels().system })
    : { text: callerSystem, savedBytes: 0 };
  session.cavemanSystemSaved = sdkSystem.savedBytes;
  const queryOptions = {
    model,
    systemPrompt: { type: "preset", preset: "claude_code", append: sdkSystem.text },
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
  if (maxThinkingTokens) queryOptions.maxThinkingTokens = maxThinkingTokens;
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

// Live-work probe for drain-aware shutdown (self-update): a session with an
// attached HTTP turn or an executing code run must not be killed by a relaunch.
export function activeWork() {
  let turns = 0;
  let codeRuns = 0;
  for (const s of sessions.values()) {
    if (s.closed) continue;
    if (s.currentTurn) turns++;
    if (s.codeRun) codeRuns++;
  }
  return { turns, codeRuns, busy: turns + codeRuns > 0 };
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

export {
  SESSION_TTL_MS,
  HEARTBEAT_MS,
  TURN_STALL_TIMEOUT_MS,
  TURN_STALL_SWEEP_MS,
  isValidCwd,
  resolveCwd,
  sessions,
  serverProfileDir,
  resumeIndexFile,
  configureSessionPersistence,
  persistResumeIndex,
  findSession,
  markSeen,
  createSession,
};
