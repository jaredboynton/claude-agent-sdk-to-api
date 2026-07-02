// code-recovery.mjs - code-mode tool_result intake: wave slot routing, stale-
// read edit recovery and chunked-Read re-planning (zero model round-trips),
// wave finalization, and anchor snapshot reconciliation.

import { ANCHORED_READ_TOOLS, annotateReadResult, reconcileEdit } from "./anchor-edit.mjs";
import { extractClientNotices, ledgerEntry } from "./code-mode.mjs";
import { recordDebug } from "./debug-ring.mjs";
import { checkerFor } from "./local-checks.mjs";
import { EDIT_RECOVERY_MAX_ROUNDS, NOTE_FRESHNESS_HINT, NOTE_RECOVERED, classifyToolFailure, editRecoveryDisabled, planChunkedRead, planFreshnessWindow, stitchReadResults, verifyEditsOnDisk } from "./read-recovery.mjs";
import { LOG_PREFIX, metrics } from "./metrics.mjs";
import { toCallToolResult } from "./wire.mjs";
import { CODE_CHECKED_EDIT_TOOLS, fabricateRecoveryTurn, syntheticIdFor } from "./code-run.mjs";

// ----------------------------------------------------------------------------
// Request handling.
// ----------------------------------------------------------------------------

// Map a synthetic tool_use id to its wave slot. Built lazily over the wave's
// calls (a multi-part chunked Read contributes one entry per part) and extended
// in place when recovery ids are queued mid-wave.
function waveSlotFor(wave, id) {
  if (!wave.partIndex) {
    wave.partIndex = new Map();
    for (let i = 0; i < wave.calls.length; i++) {
      const v = wave.calls[i];
      if (v.syntheticId === null) continue;
      const parts = v.parts ?? [v];
      for (let k = 0; k < parts.length; k++) {
        wave.partIndex.set(parts[k].syntheticId, { callIdx: i, partIdx: k, kind: "call" });
      }
    }
  }
  return wave.partIndex.get(id) || null;
}

// The edit chain an Edit/MultiEdit call would apply (native shape — anchor
// translation already ran at dispatch).
function editsOf(call) {
  if (call.tool === "MultiEdit") return Array.isArray(call.args?.edits) ? call.args.edits : [];
  return [call.args];
}

// Queue a freshness-recovery round for a failed Edit/MultiEdit: a small
// windowed Read of the edit site (any successful Read refreshes the client's
// per-file read state) followed by the identical edit. Both ride ONE
// fabricated message; the client executes them in order.
function queueEditRecovery(session, run, wave, callIdx, verified) {
  const call = wave.calls[callIdx];
  const round = (call.recoveryRounds = (call.recoveryRounds || 0) + 1);
  const firstEdit = editsOf(call)[0] || {};
  const window = planFreshnessWindow({
    content: verified.content,
    line: verified.line,
    oldString: firstEdit.old_string,
  });
  const readId = syntheticIdFor(run.codeId, wave.waveNum, `${callIdx}r${round}R`);
  const editId = syntheticIdFor(run.codeId, wave.waveNum, `${callIdx}r${round}E`);
  waveSlotFor(wave, readId); // force partIndex construction
  wave.partIndex.set(readId, { callIdx, partIdx: 0, kind: "recovery-read" });
  wave.partIndex.set(editId, { callIdx, partIdx: 0, kind: "edit-retry" });
  wave.pending.add(readId);
  wave.pending.add(editId);
  session.syntheticToCode.set(readId, run.codeId);
  session.syntheticToCode.set(editId, run.codeId);
  (wave.recoveryParts ||= []).push(
    { syntheticId: readId, tool: "Read", args: { file_path: call.args.file_path, offset: window.offset, limit: window.limit } },
    { syntheticId: editId, tool: call.tool, args: call.args },
  );
  session.codeRecoveries = (session.codeRecoveries || 0) + 1;
  metrics.totalCodeRecoveries++;
  if (session.turnMetrics) session.turnMetrics.codeRecoveries = (session.turnMetrics.codeRecoveries || 0) + 1;
  process.stderr.write(`${LOG_PREFIX} auto-recovering stale-read ${call.tool} on ${call.args.file_path} (round ${round}) key=${session.key.slice(0, 8)}\n`);
}

// Reactive fallback when a single Read comes back with the client's 25k-token
// refusal (explicit big limit, or the file grew past the dispatch-time plan):
// convert the call into a multi-part chunked Read and queue the chunks as a
// recovery round.
function queueChunkedReadRecovery(session, run, wave, callIdx, plan) {
  const call = wave.calls[callIdx];
  const round = (call.recoveryRounds = (call.recoveryRounds || 0) + 1);
  const parts = plan.chunks.map((c, k) => ({
    syntheticId: syntheticIdFor(run.codeId, wave.waveNum, `${callIdx}r${round}c${k}`),
    args: { ...call.args, offset: c.offset, limit: c.limit },
  }));
  call.parts = parts;
  call.partResults = new Array(parts.length).fill(null);
  call.stitch = { coversWholeFile: !!plan.coversWholeFile };
  waveSlotFor(wave, parts[0].syntheticId); // force partIndex construction
  for (let k = 0; k < parts.length; k++) {
    wave.partIndex.set(parts[k].syntheticId, { callIdx, partIdx: k, kind: "call" });
    wave.pending.add(parts[k].syntheticId);
    session.syntheticToCode.set(parts[k].syntheticId, run.codeId);
    (wave.recoveryParts ||= []).push({ syntheticId: parts[k].syntheticId, tool: call.tool, args: parts[k].args });
  }
  session.codeRecoveries = (session.codeRecoveries || 0) + 1;
  metrics.totalCodeRecoveries++;
  if (session.turnMetrics) session.turnMetrics.codeRecoveries = (session.turnMetrics.codeRecoveries || 0) + 1;
  process.stderr.write(`${LOG_PREFIX} re-dispatching oversized Read of ${call.args.file_path} as ${parts.length} chunks key=${session.key.slice(0, 8)}\n`);
}

// Finalize a call slot: anchor-annotate Reads, reconcile confirmed anchored
// edits, store the entry, and (for `complete` stitched reads) mark the anchor
// snapshot full-file so minimization stays sound.
function finalizeWaveEntry(session, wave, callIdx, entry, { complete } = {}) {
  const call = wave.calls[callIdx];
  if (session.anchorState && !entry.isError) {
    if (ANCHORED_READ_TOOLS.has(call.tool) && call.args?.file_path) {
      const { text: annotated, anchored } = annotateReadResult(
        session.anchorState, call.args.file_path, entry.text, { complete },
      );
      if (anchored) entry.anchored = annotated;
    }
    if (call.anchorPlan) {
      try { reconcileEdit(session.anchorState, call.anchorPlan); }
      catch (e) { process.stderr.write(`${LOG_PREFIX} anchor reconcile failed for ${call.anchorPlan?.path}: ${String(e?.message || e).slice(0, 120)}\n`); }
    }
  }
  // Successful edits to checkable files feed the post-edit auto-check backstop.
  if (!entry.isError && CODE_CHECKED_EDIT_TOOLS.has(call.tool)
      && typeof call.args?.file_path === "string" && checkerFor(call.args.file_path)) {
    const run = session.codeRun;
    if (run) (run.editedPaths ||= new Set()).add(call.args.file_path);
  }
  wave.results[callIdx] = entry;
}

async function resolveCodeModeToolResults(session, toolResults) {
  session.lastActivity = Date.now();
  const run = session.codeRun;
  for (const tr of toolResults) {
    const codeId = session.syntheticToCode.get(tr.tool_use_id);
    if (!(codeId && run && run.codeId === codeId && run.currentWave)) {
      process.stderr.write(`${LOG_PREFIX} ignoring unmatched code-mode tool_result id=${tr.tool_use_id}\n`);
      continue;
    }
    const wave = run.currentWave;
    const slot = waveSlotFor(wave, tr.tool_use_id);
    if (!slot) {
      process.stderr.write(`${LOG_PREFIX} ignoring unindexed code-mode tool_result id=${tr.tool_use_id}\n`);
      continue;
    }
    wave.pending.delete(tr.tool_use_id);
    session.syntheticToCode.delete(tr.tool_use_id);
    const call = wave.calls[slot.callIdx];
    const result = toCallToolResult(tr);
    // Client harnesses inject <system-reminder> blocks and truncation banners
    // into tool_result text; the script consumes text as DATA, so those move
    // to `.notes` (with `.truncated` set) instead of polluting it. `raw` keeps
    // the original. Root cause: a client-truncated Grep whose banner lines
    // parsed as file paths sent a whole session chasing phantom results.
    const flat = result.content?.[0]?.text || "";
    const { text, notices, truncated } = extractClientNotices(flat);
    const isError = !!result.isError;
    recordDebug({
      kind: "tool_result",
      bucket: session.bucket,
      id: tr.tool_use_id,
      tool: call.tool,
      head: text,
      ...(isError ? { isError: true } : {}),
      ...(truncated ? { truncated: true } : {}),
    });

    // Recovery-read result: consumed and discarded. NEVER fed to the anchor
    // cache — a small freshness window must not overwrite a full snapshot —
    // and even an error is ignored: the paired edit-retry (already emitted in
    // the same fabricated message) is authoritative.
    if (slot.kind === "recovery-read") continue;

    const noticeFields = {
      ...(notices.length ? { notes: notices } : {}),
      ...(truncated ? { truncated: true } : {}),
    };
    if (truncated) {
      (run.clientTruncations ||= []).push({
        tool: call.tool,
        notice: notices.find((n) => /truncat/i.test(n)) || "",
      });
    }

    // Edit-retry result: on success the original slot resolves as a success
    // with an in-band recovery note; on a repeat freshness failure we
    // re-verify (the content may have changed BETWEEN rounds) and either loop
    // within the budget or surface the truth.
    if (slot.kind === "edit-retry") {
      if (!isError) {
        call.recovered = true;
        finalizeWaveEntry(session, wave, slot.callIdx, {
          text: `${text}\n\n${NOTE_RECOVERED}`,
          raw: result,
          isError: false,
          ...noticeFields,
        });
        continue;
      }
      const cls = classifyToolFailure(call.tool, text);
      if (cls && (cls.kind === "stale-read" || cls.kind === "not-read")
          && call.recoveryRounds < EDIT_RECOVERY_MAX_ROUNDS && !editRecoveryDisabled()) {
        const verified = verifyEditsOnDisk({ filePath: call.args.file_path, cwd: session.cwd, edits: editsOf(call) });
        if (verified.ok) {
          queueEditRecovery(session, run, wave, slot.callIdx, verified);
          continue;
        }
        finalizeWaveEntry(session, wave, slot.callIdx, {
          text: `${text}\n\n[proxy verified on disk: ${verified.reason} — the file content actually changed; Read the region again (a windowed Read with offset/limit is enough for large files) before re-editing]`,
          raw: result,
          isError: true,
          ...noticeFields,
        });
        continue;
      }
      finalizeWaveEntry(session, wave, slot.callIdx, {
        text: cls ? `${text}\n\n${NOTE_FRESHNESS_HINT}` : text,
        raw: result,
        isError: true,
        ...noticeFields,
      });
      continue;
    }

    // Multi-part chunked Read: park the part, assemble when the set completes.
    if (call.parts) {
      call.partResults[slot.partIdx] = { text, isError, notices, truncated };
      if (!call.partResults.every((r) => r !== null)) continue;
      const mergedNotes = [...new Set(call.partResults.flatMap((r) => r.notices || []))];
      const anyTruncated = call.partResults.some((r) => r.truncated);
      const mergedFields = {
        ...(mergedNotes.length ? { notes: mergedNotes } : {}),
        ...(anyTruncated ? { truncated: true } : {}),
      };
      const failed = call.partResults.findIndex((r) => r.isError);
      if (failed >= 0) {
        finalizeWaveEntry(session, wave, slot.callIdx, {
          text: `chunked read failed at offset ${call.parts[failed].args.offset}: ${call.partResults[failed].text}`,
          raw: null,
          isError: true,
          ...mergedFields,
        });
      } else {
        const { text: stitched } = stitchReadResults(call.partResults.map((r) => r.text));
        finalizeWaveEntry(session, wave, slot.callIdx, {
          text: stitched,
          raw: null,
          isError: false,
          ...mergedFields,
        }, { complete: call.stitch?.coversWholeFile === true ? true : undefined });
      }
      continue;
    }

    // Single-part failures the daemon can absorb.
    if (isError) {
      const cls = classifyToolFailure(call.tool, text);
      if (cls?.kind === "read-too-large") {
        const plan = planChunkedRead({
          filePath: call.args.file_path,
          cwd: session.cwd,
          offset: call.args.offset,
          limit: call.args.limit,
        });
        if (plan?.chunks?.length && (call.recoveryRounds || 0) < EDIT_RECOVERY_MAX_ROUNDS) {
          queueChunkedReadRecovery(session, run, wave, slot.callIdx, plan);
          continue;
        }
        finalizeWaveEntry(session, wave, slot.callIdx, {
          text: `${text}\n\n${NOTE_FRESHNESS_HINT}`,
          raw: result,
          isError: true,
          ...noticeFields,
        });
        continue;
      }
      if (cls && (cls.kind === "stale-read" || cls.kind === "not-read")) {
        // Write has nothing to verify against (no old_string): retrying would
        // silently clobber whatever changed, so it only gets the hint.
        const recoverable = (call.tool === "Edit" || call.tool === "MultiEdit")
          && !editRecoveryDisabled()
          && (call.recoveryRounds || 0) < EDIT_RECOVERY_MAX_ROUNDS;
        if (recoverable) {
          const verified = verifyEditsOnDisk({ filePath: call.args.file_path, cwd: session.cwd, edits: editsOf(call) });
          if (verified.ok) {
            queueEditRecovery(session, run, wave, slot.callIdx, verified);
            continue;
          }
          finalizeWaveEntry(session, wave, slot.callIdx, {
            text: `${text}\n\n[proxy verified on disk: ${verified.reason} — the file content actually changed; Read the region again (a windowed Read with offset/limit is enough for large files) before re-editing]`,
            raw: result,
            isError: true,
            ...noticeFields,
          });
          continue;
        }
        finalizeWaveEntry(session, wave, slot.callIdx, {
          text: `${text}\n\n${NOTE_FRESHNESS_HINT}`,
          raw: result,
          isError: true,
          ...noticeFields,
        });
        continue;
      }
    }

    // Normal single-part result (the pre-existing path).
    finalizeWaveEntry(session, wave, slot.callIdx, { text, raw: result, isError, ...noticeFields });
  }

  // Queued recovery tool_uses ride out on the freshly attached turn as one
  // fabricated message — before the completion check, which cannot fire while
  // their pending ids are outstanding.
  if (run?.currentWave?.recoveryParts?.length) {
    fabricateRecoveryTurn(session);
  }

  // If the current wave is complete, resolve it and try to dispatch the next.
  if (run && run.currentWave && run.currentWave.pending.size === 0) {
    const wave = run.currentWave;
    run.currentWave = null;

    // Fill in inline results/errors for calls that had no syntheticId.
    const results = wave.results.map((r, i) => {
      if (r) return r;
      const v = wave.calls[i];
      return v.inlineResult || { text: v.inlineError || "(no result)", raw: null, isError: true };
    });

    // Ledger: completed-call evidence for the structured error result, so a
    // later script failure doesn't force the model to redo this wave's work.
    for (let i = 0; i < wave.calls.length; i++) {
      const v = wave.calls[i];
      if (v.syntheticId === null) continue; // inline errors/recalls are not completed client work
      (run.ledger ||= []).push(ledgerEntry(v.tool, v.args, !!results[i]?.isError, v.recovered ? "auto-recovered stale read" : undefined));
    }

    // Update sub-call metrics.
    const subCalls = wave.calls.filter((v) => v.syntheticId !== null).length;
    session.codeSubCalls = (session.codeSubCalls || 0) + subCalls;
    metrics.totalCodeSubCalls += subCalls;
    if (session.turnMetrics) session.turnMetrics.codeSubCalls += subCalls;

    wave.resolve(results);
  }
}

export {
  resolveCodeModeToolResults,
};
