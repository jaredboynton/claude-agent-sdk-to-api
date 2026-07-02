// turn-io.mjs - per-turn I/O shared by the session loop and code-run
// orchestration: client event emission/buffering, turn settle/fail, parked
// tool resolution, and per-turn usage/timing accounting.

import { reconcileEdit } from "./anchor-edit.mjs";
import { appendCacheLog, cacheCreationSplit, cacheLogEnabled } from "./cache-log.mjs";
import { LOG_PREFIX, metrics } from "./metrics.mjs";
import { accumulateStreamEvent, sseEvent, writeSseChunk } from "./wire.mjs";
import { detectToolCallMimicry } from "./session-identity.mjs";

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

// Fold one upstream message's usage (from message_start) into the global
// counters and the active turn row. Output is tracked per-message and flushed
// on the next message_start / at turn end (see logTurnDone), since each message
// reports a cumulative output total of its own.
function accumulateTurnUsage(session, rawUsage) {
  const read = rawUsage?.cache_read_input_tokens || 0;
  const { create5m, create1h } = cacheCreationSplit(rawUsage);
  const input = rawUsage?.input_tokens || 0;
  metrics.totalCacheReadTokens += read;
  metrics.totalCacheCreationTokens += create5m + create1h;
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
      scriptInBytes: m.scriptInBytes,
      spills: m.spills,
      stateBytes: m.stateBytes,
      codeErrors: m.codeErrors,
      ...(m.codeRecoveries ? { codeRecoveries: m.codeRecoveries } : {}),
      ...(m.singleCallRuns ? { singleCallRuns: m.singleCallRuns } : {}),
      ...(session.descHash ? { descHash: session.descHash } : {}),
      ...(session.cavemanDescSaved ? { cavemanSaved: session.cavemanDescSaved } : {}),
      ...(session.cavemanSystemSaved ? { cavemanSystemSaved: session.cavemanSystemSaved } : {}),
      ...(m.coldReason ? { coldReason: m.coldReason } : {}),
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

function hasTurnSink(session) {
  return !!(session.nonStream || (session.res && !session.res.writableEnded));
}

const PENDING_EVENT_BUFFER_MAX = 2000;

function writeEvent(session, ev) {
  if (session.nonStream) {
    accumulateStreamEvent(session.nonStream.blocks, ev);
    if (ev.type === "message_delta" && ev.delta?.stop_reason) session.nonStream.stopReason = ev.delta.stop_reason;
    return;
  }
  if (session.res && !session.res.writableEnded) {
    writeSseChunk(session, sseEvent(ev.type, ev));
    return;
  }
  // No sink (client is between HTTP turns, e.g. executing a fabricated wave
  // locally). Events used to be dropped here, permanently losing anything the
  // model streamed in the gap — buffer them instead and flush them at the
  // head of the next attached turn (notifyTurnAttached), in original order.
  const buf = (session.pendingClientEvents ??= []);
  if (buf.length < PENDING_EVENT_BUFFER_MAX) buf.push(ev);
}

// Flush events buffered while no HTTP turn was attached. Runs before wave
// fabrication so buffered content lands ahead of the tool_uses that follow it.
function flushPendingClientEvents(session) {
  const buf = session.pendingClientEvents;
  if (!buf?.length || !hasTurnSink(session)) return;
  session.pendingClientEvents = [];
  for (const ev of buf) writeEvent(session, ev);
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

export {
  noteStreamTiming,
  accumulateTurnUsage,
  makeInputQueue,
  hasTurnSink,
  writeEvent,
  flushPendingClientEvents,
  endTurn,
  resolveTool,
};
