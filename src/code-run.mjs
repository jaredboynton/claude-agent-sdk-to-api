// code-run.mjs - dynamic code-mode run orchestration: script lifecycle
// (startCodeRun), tool-call wave dispatch/fabrication, SDK->client stream
// projection while a run drives the turn, and code-run teardown.

import { randomUUID } from "node:crypto";
import { ANCHORED_EDIT_TOOLS, hasAnchorFields, translateEditInput } from "./anchor-edit.mjs";
import { CodeValidationError, buildCodeToolCatalog, formatCodeError, formatCodeResult, runCodeScriptDynamic, validateCodeInput } from "./code-mode.mjs";
import { recordDebug } from "./debug-ring.mjs";
import { runSyntaxCheck } from "./local-checks.mjs";
import { planChunkedRead } from "./read-recovery.mjs";
import { LOG_PREFIX, metrics } from "./metrics.mjs";
import { clientVisibleUsage } from "./wire.mjs";
import { appendCodeResultNote, appendPendingToolNotice, stateByteSize } from "./client-tools.mjs";
import { endTurn, flushPendingClientEvents, hasTurnSink, resolveTool, writeEvent } from "./turn-io.mjs";

const CODE_SCRIPT_TIMEOUT_MS = Number(process.env.CODE_SCRIPT_TIMEOUT_MS || 0); // 0 = no cap

const CODE_MAX_WAVES = Number(process.env.CODE_MAX_WAVES || 0); // 0 = unlimited

const CODE_MAX_CALLS = Number(process.env.CODE_MAX_CALLS || 0); // 0 = unlimited

// Session-lifetime stores backing code mode's `state` global and truncation
// spill artifacts (codemode.recall). Conversation memory, not tool-round state:
// they survive clearAllCodeState/abandonToolRound and die with the session.
const CODE_STATE_MAX_BYTES = Number(process.env.CODE_STATE_MAX_BYTES || 2 * 1024 * 1024);

const CODE_ARTIFACT_BUDGET_BYTES = Number(process.env.CODE_ARTIFACT_BUDGET_BYTES || 4 * 1024 * 1024);

// Daemon-side local checks: codemode.verify() timeout, the failures-only
// post-edit auto-check backstop, and the session-start git snapshot seeded
// into the script's `state.git`.
const CODE_VERIFY_TIMEOUT_MS = Number(process.env.CODE_VERIFY_TIMEOUT_MS || 5000);

const CODE_POST_EDIT_CHECKS = process.env.CODE_POST_EDIT_CHECKS !== "0";

const CODE_POST_EDIT_CHECK_BUDGET_MS = 3000;

const CODE_CHECKED_EDIT_TOOLS = new Set(["Edit", "MultiEdit", "Write"]);

// Consolidation nudge: a successful run that fabricated exactly ONE client tool
// call spent a whole model round-trip on it — say so in-band (append-only
// transcript, frozen prefix untouched), capped per session so a legitimate
// run-one-command turn doesn't accumulate nagging. 0 disables.
const CODE_NUDGE_MAX_PER_SESSION = Number(process.env.CODE_NUDGE_MAX_PER_SESSION ?? 2);

function initMessageProjection(session) {
  session._proj = {
    clientIndex: 0,
    sdkToClient: new Map(),
    syntheticCount: 0,
    hadCode: false,
    // Whether a client-visible message frame is currently open. A frame can
    // outlive one SDK message: during a code run T0's message_start passes
    // through but its message_stop is suppressed, and the first fabricated
    // wave appends its tool_uses to — then closes — that same frame. So this
    // survives the per-SDK-message reset above.
    frameOpen: session._proj?.frameOpen ?? false,
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

function notifyTurnAttached(session) {
  if (!session.currentTurn || !hasTurnSink(session)) return;
  flushPendingClientEvents(session);
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
  // Recovery parts queued while the turn sink was gone (client disconnected
  // mid-POST) flush on the next attached turn.
  fabricateRecoveryTurn(session);
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

// Store the full text of a truncated code result; oldest-first eviction keeps
// the per-session store under CODE_ARTIFACT_BUDGET_BYTES (never evicts the
// artifact just stored).
function storeCodeArtifact(session, text) {
  session.codeArtifacts = session.codeArtifacts || new Map();
  const id = `a${++session.codeArtifactSeq}`;
  session.codeArtifacts.set(id, { text: String(text ?? ""), ts: Date.now() });
  let total = 0;
  for (const v of session.codeArtifacts.values()) total += v.text.length;
  for (const [k, v] of session.codeArtifacts) {
    if (total <= CODE_ARTIFACT_BUDGET_BYTES || k === id) break;
    total -= v.text.length;
    session.codeArtifacts.delete(k);
  }
  if (session.turnMetrics) session.turnMetrics.spills += 1;
  return id;
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
    metrics.totalCodeErrors++;
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
    metrics.totalCodeErrors++;
    internalResolveCode(session, codeToolUseId, {
      content: [{ type: "text", text: "only one active code run per session" }],
      isError: true,
    });
    process.stderr.write(`${LOG_PREFIX} code call ${codeToolUseId}: rejected — another code run is active\n`);
    return;
  }

  const { script } = normalized;
  session.codeCalls = (session.codeCalls || 0) + 1;
  metrics.totalCodeCalls++;

  const run = {
    codeId: codeToolUseId,
    script,
    abortController: new AbortController(),
    currentWave: null,       // single in-flight wave awaiting client tool_results
    waveSeq: 0,
    waveCount: 0,
    callCount: 0,
    aborted: false,
    settled: false,
    ledger: [],              // completed-call evidence for the structured error result
  };
  session.codeRun = run;
  session.codeDriving = true;
  session.suppressEndTurn = true; // swallow T0's message_stop while the run is active
  recordDebug({ kind: "code_run", bucket: session.bucket, id: codeToolUseId, head: script });

  // Seed the session-start git snapshot into `state.git` exactly once. The
  // one-time flag respects a script that deliberately deletes state.git.
  if (session.gitSnapshot && !session.gitSeeded) {
    if (session.codeState.git === undefined) session.codeState.git = session.gitSnapshot;
    session.gitSeeded = true;
  }

  const toolNames = [...session.clientTools.keys()];
  const toolDocs = buildCodeToolCatalog(session.clientTools);
  const t0 = Date.now();
  if (session.turnMetrics) session.turnMetrics.scriptInBytes += Buffer.byteLength(script, "utf8");

  run.promise = runCodeScriptDynamic(script, {
    toolNames,
    toolDocs,
    maxWaves: CODE_MAX_WAVES,
    maxCalls: CODE_MAX_CALLS,
    timeoutMs: CODE_SCRIPT_TIMEOUT_MS,
    signal: run.abortController.signal,
    state: session.codeState,
    dispatchWave: (waveNum, calls) => dispatchCodeWave(session, codeToolUseId, waveNum, calls),
  });

  run.promise.then(async (result) => {
    if (run.aborted) return;
    run.settled = true;
    const waves = result.waves || 0;
    const calls = result.calls || 0;
    session.codeWaves = (session.codeWaves || 0) + waves;
    metrics.totalCodeWaves = (metrics.totalCodeWaves || 0) + waves;
    if (session.turnMetrics) session.turnMetrics.codeWaves += waves;

    // Persist the script's `state` (success AND error: progress stashed before
    // a throw must survive). Over-cap keeps the previous state — losing new
    // progress beats silently dropping everything — and the model is TOLD via
    // an in-band note: a silent drop means its next script assumes the stash
    // succeeded and finds `state` mysteriously reverted.
    let stateNote = null;
    if (result.state && typeof result.state === "object") {
      try {
        const bytes = stateByteSize(result.state);
        if (bytes <= CODE_STATE_MAX_BYTES) {
          session.codeState = result.state;
          if (session.turnMetrics) session.turnMetrics.stateBytes = bytes;
        } else {
          stateNote = `[state NOT saved this call: ${bytes} bytes > ${CODE_STATE_MAX_BYTES} cap; the previous state was kept. Delete large entries (raw file text, full tool outputs) from state before returning.]`;
          process.stderr.write(`${LOG_PREFIX} code call ${codeToolUseId}: state over cap (${bytes} > ${CODE_STATE_MAX_BYTES} bytes); keeping previous state\n`);
        }
      } catch (e) {
        stateNote = `[state NOT saved this call: serialization failed (${String(e?.message || e).slice(0, 120)}); the previous state was kept]`;
      }
    }

    let collapsed;
    if (result.error) {
      session.codeErrors = (session.codeErrors || 0) + 1;
      metrics.totalCodeErrors++;
      if (session.turnMetrics) session.turnMetrics.codeErrors += 1;
      collapsed = formatCodeError(result.error, {
        ledger: run.ledger,
        logs: result.logs || [],
        waves,
        calls,
      });
      const scriptOut = collapsed.content?.[0]?.text?.length ?? 0;
      if (session.turnMetrics) session.turnMetrics.scriptOutBytes += scriptOut;
      process.stderr.write(`${LOG_PREFIX} code call ${codeToolUseId}: failed (${result.error}) waves=${waves} calls=${calls}\n`);
    } else {
      collapsed = formatCodeResult(result.value, result.logs || [], {
        onSpill: (full) => storeCodeArtifact(session, full),
      });
      const scriptOut = collapsed.content?.[0]?.text?.length ?? 0;
      if (session.turnMetrics) session.turnMetrics.scriptOutBytes += scriptOut;
      process.stderr.write(
        `${LOG_PREFIX} code call ${codeToolUseId}: done waves=${waves} calls=${calls} scriptOut=${scriptOut} bytes execute=${Date.now() - t0}ms\n`,
      );
    }

    recordDebug({
      kind: result.error ? "code_error" : "code_result",
      bucket: session.bucket,
      id: codeToolUseId,
      head: result.error ? String(result.error) : (collapsed.content?.[0]?.text ?? ""),
      ...(result.error ? { isError: true } : {}),
    });

    if (stateNote) appendCodeResultNote(collapsed, stateNote);

    // The client cut a tool's output before the script saw it. The script may
    // have checked `.truncated`/`.notes`, but the model must hear it either
    // way: counts and lists derived from a truncated result look complete and
    // silently are not.
    if (run.clientTruncations?.length) {
      const shown = run.clientTruncations.slice(0, 3);
      for (const t of shown) {
        const notice = t.notice ? `; client notice: ${t.notice.slice(0, 400)}` : "";
        appendCodeResultNote(collapsed, `[the client truncated a ${t.tool} result before the script processed it — data derived from it may be incomplete${notice}]`);
      }
      if (run.clientTruncations.length > shown.length) {
        appendCodeResultNote(collapsed, `[+${run.clientTruncations.length - shown.length} more client-truncated tool results this run]`);
      }
    }

    // Same contract as truncation notices: empty grep results caused by GNU-BRE
    // alternation look like true no-matches to the script and the model alike.
    if (run.grepHazards) {
      appendCodeResultNote(collapsed, `[${run.grepHazards} grep/rg call(s) used \\| — GNU-BRE-only alternation; rg/ugrep/BSD grep treat it as a literal pipe, so those empty results are unreliable. Re-run with grep -E 'a|b' / rg 'a|b', or repeated -F -e 'literal' flags]`);
    }

    // Post-edit auto-check backstop (failures only): the daemon syntax-checks
    // files this run successfully edited, at zero client/model cost. A clean
    // check appends NOTHING; paths the script already codemode.verify()-ed are
    // skipped. Bounded by a hard budget so the final answer is never held
    // hostage; any failure here must never break result delivery.
    if (CODE_POST_EDIT_CHECKS && run.editedPaths?.size) {
      try {
        const paths = [...run.editedPaths].filter((p) => !run.verifiedPaths?.has(p));
        const checks = paths.map((p) => runSyntaxCheck(p, { cwd: session.cwd, timeoutMs: CODE_VERIFY_TIMEOUT_MS }));
        let timer;
        const deadline = new Promise((res) => {
          timer = setTimeout(() => res(null), CODE_POST_EDIT_CHECK_BUDGET_MS);
          timer.unref?.();
        });
        const settled = await Promise.race([Promise.all(checks), deadline]);
        clearTimeout(timer);
        if (Array.isArray(settled)) {
          for (const res of settled) {
            if (res.ok || res.reason || run.verifiedPaths?.has(res.resolvedPath)) continue;
            const tail = res.output.split("\n").slice(0, 3).join("\n");
            appendCodeResultNote(collapsed, `[post-edit check] ${res.checker} failed for ${res.path}:\n${tail}`);
          }
        }
      } catch (e) {
        process.stderr.write(`${LOG_PREFIX} post-edit check failed: ${String(e?.message || e).slice(0, 120)}\n`);
      }
    }

    // Single-call runs are the dribble pattern the one-call doctrine targets:
    // count every one (telemetry), nudge the first few (in-band, append-only).
    // run.callCount counts FABRICATED client calls, so pure-compute runs and
    // inline __verify/__recall traffic never trip this.
    if (!result.error && run.callCount === 1) {
      if (session.turnMetrics) session.turnMetrics.singleCallRuns += 1;
      if ((session.consolidationNudges || 0) < CODE_NUDGE_MAX_PER_SESSION) {
        session.consolidationNudges = (session.consolidationNudges || 0) + 1;
        appendCodeResultNote(collapsed, "[note: this run made a single tool call — each code call costs a full model round-trip. Fold the surrounding steps into one script: batch independent calls with Promise.all, branch on results in-script, and verify edits in the same run.]");
      }
    }

    appendPendingToolNotice(session, collapsed);
    session.codeDriving = false;
    clearCodeRun(session, codeToolUseId);
    // Resolve the parked `code` MCP handler so the SDK emits the final answer.
    resolveTool(session, codeToolUseId, collapsed);
  }).catch((err) => {
    if (run.aborted) return;
    run.settled = true;
    session.codeErrors = (session.codeErrors || 0) + 1;
    metrics.totalCodeErrors++;
    if (session.turnMetrics) session.turnMetrics.codeErrors += 1;
    session.codeDriving = false;
    clearCodeRun(session, codeToolUseId);
    internalResolveCode(session, codeToolUseId, formatCodeError(err?.message || String(err), { ledger: run.ledger }));
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
    // codemode.recall: reserved server-side call resolved inline from the
    // session artifact store — no client turn is fabricated, no transcript
    // bytes are spent. A real client tool named __recall (theoretical) wins.
    if (name === "__recall" && !session.clientTools.has("__recall")) {
      const id = String(args?.id ?? "");
      const art = session.codeArtifacts?.get(id);
      validated.push({
        syntheticId: null,
        tool: name,
        args,
        inlineError: null,
        inlineResult: art
          ? { text: art.text, raw: null, isError: false }
          : { text: `no artifact ${JSON.stringify(id)} in this session (artifacts live for the session only)`, raw: null, isError: true },
      });
      continue;
    }
    // codemode.verify: daemon-side syntax check of the real file, resolved
    // inline (same machinery as __recall) — zero client round-trips, zero
    // model round-trips. Paths verified here are skipped by the post-edit
    // auto-check backstop.
    if (name === "__verify" && !session.clientTools.has("__verify")) {
      const res = await runSyntaxCheck(String(args?.path ?? ""), { cwd: session.cwd, timeoutMs: CODE_VERIFY_TIMEOUT_MS });
      // Record both spellings so the post-edit backstop can dedupe whether the
      // edit args used the raw or the resolved path.
      (run.verifiedPaths ||= new Set()).add(String(args?.path ?? ""));
      if (res.resolvedPath) run.verifiedPaths.add(res.resolvedPath);
      validated.push({
        syntheticId: null,
        tool: name,
        args,
        inlineError: null,
        inlineResult: res.ok
          ? { text: `OK ${res.checker}: ${res.path}`, raw: null, isError: false }
          : { text: res.output || res.reason || "check failed", raw: null, isError: true },
      });
      continue;
    }
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
    // Large-Read auto-split: the client hard-caps Read at 25k tokens (with an
    // error) and 2000 lines (SILENTLY — the model gets a truncated result with
    // no marker). Both break the read->edit loop on big files, so a Read that
    // cannot come back whole is dispatched as N windowed Reads and stitched
    // into ONE script-visible result. The daemon stats the file locally to
    // plan the windows; if it can't, the single call proceeds and the client
    // produces the real error.
    if (name === "Read" && typeof syntheticArgs?.file_path === "string") {
      const plan = planChunkedRead({
        filePath: syntheticArgs.file_path,
        cwd: session.cwd,
        offset: syntheticArgs.offset,
        limit: syntheticArgs.limit,
      });
      if (plan?.tooLarge) {
        validated.push({
          syntheticId: null,
          tool: name,
          args,
          inlineError: `file too large to read whole (${plan.totalLines} lines, ~${plan.estTokens} tokens); read a window with offset/limit or use Grep`,
        });
        continue;
      }
      if (plan?.chunks?.length > 1) {
        run.callCount++;
        const parts = plan.chunks.map((c, k) => ({
          syntheticId: syntheticIdFor(codeToolUseId, waveNum, `${i}c${k}`),
          args: { ...syntheticArgs, offset: c.offset, limit: c.limit },
        }));
        validated.push({
          syntheticId: parts[0].syntheticId,
          tool: name,
          args: syntheticArgs,
          inlineError: null,
          anchorPlan: null,
          parts,
          partResults: new Array(parts.length).fill(null),
          stitch: { coversWholeFile: !!plan.coversWholeFile },
        });
        continue;
      }
    }
    run.callCount++;
    const syntheticId = syntheticIdFor(codeToolUseId, waveNum, i);
    validated.push({ syntheticId, tool: name, args: syntheticArgs, inlineError: null, anchorPlan });
  }

  for (const v of validated) {
    let argsHead = "";
    try { argsHead = JSON.stringify(v.args) ?? ""; } catch { argsHead = String(v.args); }
    recordDebug({
      kind: "tool_use",
      bucket: session.bucket,
      id: v.syntheticId,
      tool: v.tool,
      head: argsHead,
      ...(v.inlineError ? { isError: true } : {}),
    });
  }

  // If all calls in this wave are inline (errors or recalls), return them
  // directly without fabricating a client turn.
  const fabricatable = validated.filter((v) => v.syntheticId !== null);
  if (fabricatable.length === 0) {
    return validated.map((v) => v.inlineResult || { text: v.inlineError, raw: null, isError: true });
  }

  if (run.currentWave) {
    return calls.map(() => ({ text: "previous code wave still in flight", raw: null, isError: true }));
  }

  const waveEntry = {
    waveNum,
    calls: validated,
    fabricatable,
    results: new Array(validated.length).fill(null),
    // Multi-part calls (chunked Reads) contribute one pending id per part;
    // the wave resolves only when every part of every call has come back.
    pending: new Set(fabricatable.flatMap((v) => (v.parts ?? [v]).map((p) => p.syntheticId))),
    partIndex: null,          // lazy Map<syntheticId, {callIdx, partIdx}> (see waveSlotFor)
    recoveryParts: null,      // queued recovery tool_uses awaiting fabrication (freshness retries)
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

  beginFabricatedMessage(session);

  // Emit synthetic tool_use blocks for fabricatable calls. A multi-part call
  // (chunked Read) emits one block per part; the results stitch back into a
  // single script-visible entry in resolveCodeModeToolResults.
  for (let i = 0; i < wave.calls.length; i++) {
    const v = wave.calls[i];
    if (v.syntheticId === null) continue; // inline error — no client block
    for (const part of v.parts ?? [v]) {
      session.syntheticToCode.set(part.syntheticId, run.codeId);
      emitClientToolUse(session, { syntheticId: part.syntheticId, tool: v.tool, args: part.args });
    }
  }

  finishFabricatedMessage(session);
}

// Fabricated assistant-message envelope shared by fabricateCurrentWave and
// fabricateRecoveryTurn. The client (and its subagent accounting) reads
// message.usage.input_tokens, so a bare { role } would throw "undefined is not
// an object (evaluating 'o.input_tokens')" — emit a complete envelope with a
// usage object, replaying the last real upstream usage instead of zeros so
// statusbar context does not bounce to zero during a code-mode tool wave.
function beginFabricatedMessage(session) {
  const p = session._proj;
  // A frame is already open (T0: the model's own message_start passed through
  // but its message_stop was suppressed when the run took over). Append to it
  // instead of opening a second message_start the client would misparse as a
  // fresh message — discarding the preamble thinking/text it just rendered.
  if (p?.frameOpen) return;
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
  if (p) {
    p.frameOpen = true;
    // Fresh frame: content block indices restart at 0 per the Messages API
    // per-message contract (fabricated wave turns used to continue T0's
    // running index, starting at >0).
    p.clientIndex = 0;
  }
}

// Close the fabricated message + HTTP turn. message_delta carries a usage
// object in the real API; include one (replaying last known output tokens) so
// clients that read delta.usage.output_tokens don't trip over undefined.
// endTurn closes the HTTP response; the SDK's code handler stays parked, and
// the next client POST attaches a fresh turn.
function finishFabricatedMessage(session) {
  writeEvent(session, {
    type: "message_delta",
    delta: { stop_reason: "tool_use", stop_sequence: null },
    usage: { output_tokens: session.lastRawUsage?.output_tokens ?? 0 },
  });
  writeEvent(session, {
    type: "message_stop",
    message: { stop_reason: "tool_use" },
  });
  if (session._proj) session._proj.frameOpen = false;
  endTurn(session);
}

// Fabricate a recovery turn: the queued recovery tool_uses (freshness
// re-Read + Edit retry pairs, or re-planned chunked Reads) go to the client as
// ONE synthetic assistant message on the currently attached turn. The client
// executes a message's tool_uses in order (Edit is not concurrency-safe, so
// its recovery Read completes — refreshing the client's read state — before
// the Edit retry runs). Costs one local client round-trip, zero model
// round-trips; the parked `code` script never observes it.
function fabricateRecoveryTurn(session) {
  const run = session.codeRun;
  if (!run || run.aborted) return;
  const wave = run.currentWave;
  if (!wave || !wave.recoveryParts?.length) return;
  if (!session.currentTurn || !hasTurnSink(session)) return; // notifyTurnAttached retries
  const parts = wave.recoveryParts;
  wave.recoveryParts = null;
  beginFabricatedMessage(session);
  for (const part of parts) {
    emitClientToolUse(session, { syntheticId: part.syntheticId, tool: part.tool, args: part.args });
  }
  finishFabricatedMessage(session);
}

function remapIndex(session, sdkIndex) {
  const mapped = session._proj?.sdkToClient.get(sdkIndex);
  return mapped ?? sdkIndex;
}

function projectEvent(session, ev) {
  const p = session._proj;
  if (!p) return;

  // While a dynamic code run is driving, the bridge owns the message framing
  // (fabricated wave messages carry the tool_use blocks and close each HTTP
  // turn), so message_start/message_delta/message_stop from the SDK are
  // suppressed. Content, however, streams LIVE: text and thinking blocks pass
  // through with remapped indices so the client never sits behind a silent
  // gap while the model produces a follow-up message during an active run.
  // Buffering these as a "preamble" to replay on the next fabricated wave
  // (the old design) meant seconds-to-minutes of dead air — the UI looked
  // frozen even though the model was working.
  if (session.codeDriving && session.codeRun) {
    switch (ev.type) {
      case "content_block_start": {
        const cb = ev.content_block;
        if (cb?.type === "text" || cb?.type === "thinking" || cb?.type === "redacted_thinking") {
          // Live content needs a client frame: T0's own message_start already
          // opened one, but a follow-up message during an active run arrives
          // with its framing suppressed — open a fabricated frame so the
          // client never receives orphan content_block events.
          beginFabricatedMessage(session);
          const idx = p.clientIndex++;
          p.sdkToClient.set(ev.index, idx);
          writeEvent(session, { ...ev, index: idx });
        }
        // tool_use blocks (the code call itself) stay suppressed; the
        // fabricated wave emits the client-visible synthetic tool_uses.
        return;
      }
      case "content_block_delta":
      case "content_block_stop": {
        const mapped = p.sdkToClient.get(ev.index);
        if (mapped !== undefined) writeEvent(session, { ...ev, index: mapped });
        return;
      }
      default:
        return; // message framing suppressed while the run drives the client turn
    }
  }

  switch (ev.type) {
    case "message_start":
      // A frame opened during a code run (T0 whose message_stop was
      // suppressed and no wave closed it, or a lazily-opened mid-run frame)
      // may still be open. Close it before starting the new message so the
      // client never sees two message_starts inside one frame.
      if (p.frameOpen) {
        writeEvent(session, {
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { output_tokens: session.lastRawUsage?.output_tokens ?? 0 },
        });
        writeEvent(session, { type: "message_stop", message: { stop_reason: "end_turn" } });
      }
      p.frameOpen = true;
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
      p.frameOpen = false;
      writeEvent(session, out);
      break;
    }
    default:
      writeEvent(session, ev);
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
  session.pendingClientEvents = null;
  clearAllCodeState(session);
}

// The live query() died or the turn hard-failed: no tool result will ever
// arrive, so abandon the round (resolve every parked handler with isError)
// before the session is torn down.
function failTurn(session, err) {
  const turn = session.currentTurn;
  if (turn) { session.currentTurn = null; turn.reject(err); }
  abandonToolRound(session);
}

export {
  CODE_CHECKED_EDIT_TOOLS,
  initMessageProjection,
  notifyTurnAttached,
  clearCodeRun,
  clearAllCodeState,
  hasActiveToolRound,
  syntheticIdFor,
  emitClientToolUse,
  internalResolveCode,
  startCodeRun,
  dispatchCodeWave,
  fabricateCurrentWave,
  fabricateRecoveryTurn,
  projectEvent,
  abandonToolRound,
  failTurn,
};
