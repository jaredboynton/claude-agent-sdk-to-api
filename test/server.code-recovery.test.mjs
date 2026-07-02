// Code-mode self-healing: large-Read auto-split (proactive + reactive) and
// Edit freshness auto-recovery. All failures use the exact client error texts
// from the 2026-07-01 forensic session.
//
// Run: node --test test/server.code-recovery.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  dispatchCodeWave,
  resolveCodeModeToolResults,
  syntheticIdFor,
  initMessageProjection,
  startCodeRun,
  notifyTurnAttached,
  stateByteSize,
} from "../src/server.mjs";
import { createAnchorState } from "../src/anchor-edit.mjs";
import { NOTE_RECOVERED, NOTE_FRESHNESS_HINT } from "../src/read-recovery.mjs";
import { drainSession } from "./helpers.mjs";

const STALE_READ_ERR = "<tool_use_error>File has been modified since read, either by the user or by a linter. Read it again before attempting to write it.</tool_use_error>";
const TOO_LARGE_ERR = "File content (29916 tokens) exceeds maximum allowed tokens (25000). Use offset and limit parameters to read specific portions of the file, or search for specific content instead of reading the whole file.";

const READ_SCHEMA = { type: "object", properties: { file_path: { type: "string" }, offset: { type: "number" }, limit: { type: "number" } }, required: ["file_path"] };
const EDIT_SCHEMA = { type: "object", properties: { file_path: { type: "string" }, old_string: { type: "string" }, new_string: { type: "string" }, replace_all: { type: "boolean" } }, required: ["file_path", "old_string", "new_string"] };

function clientTools() {
  return new Map([
    ["Read", { description: "read", input_schema: READ_SCHEMA }],
    ["Edit", { description: "edit", input_schema: EDIT_SCHEMA }],
    ["Write", { description: "write", input_schema: { type: "object", properties: { file_path: { type: "string" }, content: { type: "string" } }, required: ["file_path", "content"] } }],
  ]);
}

function recoverySession(cwd, overrides = {}) {
  const session = {
    key: "k-recovery",
    bucket: "b-recovery",
    model: "claude-opus-4-8",
    cwd,
    clientTools: clientTools(),
    codeRun: null,
    syntheticToCode: new Map(),
    codeDriving: false,
    suppressEndTurn: false,
    pendingTools: new Map(),
    resolvedResults: new Map(),
    orphanResolvers: [],
    streamedToolUses: [],
    toolUseAccum: new Map(),
    inputParsers: new Map(),
    originalNames: new Set(["code"]),
    res: null,
    nonStream: null,
    currentTurn: null,
    turnMetrics: null,
    ...overrides,
  };
  initMessageProjection(session);
  return session;
}

// Attach a fresh HTTP turn capturing SSE events; returns the live event array.
function attachTurn(session) {
  const events = [];
  session.currentTurn = { resolve: () => {}, reject: () => {} };
  session.res = {
    writableEnded: false,
    write: (s) => {
      for (const m of String(s).matchAll(/^data: (.+)$/gm)) {
        try { events.push(JSON.parse(m[1])); } catch {}
      }
    },
  };
  return events;
}

function toolUses(events) {
  // Content-block indices restart at 0 in each fabricated message frame, so a
  // delta must attach to the block most recently OPENED at its index — a
  // global index match would concatenate JSON across waves.
  const out = [];
  const open = new Map(); // index -> accumulating record
  for (const e of events) {
    if (e.type === "content_block_start" && e.content_block?.type === "tool_use") {
      const rec = { id: e.content_block.id, name: e.content_block.name, json: "" };
      open.set(e.index, rec);
      out.push(rec);
    } else if (e.type === "content_block_delta" && open.has(e.index)) {
      open.get(e.index).json += e.delta?.partial_json || "";
    } else if (e.type === "content_block_stop") {
      open.delete(e.index);
    } else if (e.type === "message_start") {
      open.clear();
    }
  }
  return out.map((r) => ({ id: r.id, name: r.name, args: r.json ? JSON.parse(r.json) : {} }));
}

function newRun(codeId = "toolu_code_main") {
  return { codeId, aborted: false, currentWave: null, preamble: null, waveSeq: 0, waveCount: 0, callCount: 0, ledger: [] };
}

// Render a client-style guttered Read result for a window of a file's content.
function fakeReadResult(content, offset = 1, limit = Infinity, trailer = "") {
  const all = content.split("\n");
  const end = Math.min(all.length, offset + (Number(limit) || all.length) - 1);
  const lines = [];
  for (let n = offset; n <= end; n++) lines.push(`${String(n).padStart(6)}→${all[n - 1]}`);
  return lines.join("\n") + (trailer ? `\n\n${trailer}` : "");
}

function tmp() {
  return realpathSync(mkdtempSync(join(tmpdir(), "code-recovery-")));
}

// ---------------------------------------------------------------------------
// Proactive large-Read auto-split
// ---------------------------------------------------------------------------

test("oversized Read splits into chunked tool_uses and stitches to one anchored result", async () => {
  const dir = tmp();
  const file = join(dir, "big.js");
  const content = Array.from({ length: 2761 }, (_, i) => `const v${i + 1} = ${i + 1};`).join("\n");
  writeFileSync(file, content);

  const session = recoverySession(dir, { anchorState: createAnchorState() });
  const events = attachTurn(session);
  session.codeRun = newRun();

  const resultPromise = dispatchCodeWave(session, "toolu_code_main", 1, [
    { name: "Read", args: { file_path: file } },
  ]);

  const uses = toolUses(events);
  assert.ok(uses.length >= 2, `expected chunked Reads, got ${uses.length}`);
  assert.ok(uses.every((u) => u.name === "Read"));
  assert.equal(uses[0].args.offset, 1);
  const last = uses[uses.length - 1];
  assert.equal(last.args.offset + last.args.limit - 1, 2761, "chunks cover the whole file");

  attachTurn(session);
  await resolveCodeModeToolResults(session, uses.map((u, k) => ({
    tool_use_id: u.id,
    content: [{ type: "text", text: fakeReadResult(content, u.args.offset, u.args.limit, k === uses.length - 1 ? "<system-reminder>final</system-reminder>" : "<system-reminder>mid</system-reminder>") }],
  })));

  const results = await resultPromise;
  assert.equal(results.length, 1, "script sees ONE Read result");
  assert.equal(results[0].isError, false);
  assert.match(results[0].text, /const v1 = 1;/);
  assert.match(results[0].text, /const v2761 = 2761;/);
  assert.equal(results[0].text.split("mid").length, 1, "intermediate trailers dropped");
  assert.ok(!/final/.test(results[0].text), "client reminders never pollute .text");
  assert.ok(results[0].notes.includes("final"), "client reminders surface in .notes");
  assert.ok(results[0].anchored, "stitched read is anchor-annotated");
  assert.equal(session.anchorState.files.get(file).partial, false, "stitched whole-file snapshot is complete");
  assert.equal(session.syntheticToCode.size, 0);
  rmSync(dir, { recursive: true, force: true });
});

test("absurdly large Read gets an inline tooLarge error with zero client turns", async () => {
  const dir = tmp();
  const file = join(dir, "huge.txt");
  writeFileSync(file, Array.from({ length: 24 * 1800 + 10 }, (_, i) => `${i}`).join("\n"));

  const session = recoverySession(dir);
  const events = attachTurn(session);
  session.codeRun = newRun();

  const results = await dispatchCodeWave(session, "toolu_code_main", 1, [
    { name: "Read", args: { file_path: file } },
  ]);
  assert.equal(results[0].isError, true);
  assert.match(results[0].text, /file too large to read whole/);
  assert.equal(toolUses(events).length, 0, "no client tool_use fabricated");
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Reactive chunk recovery (file grew between dispatch-time plan and execution)
// ---------------------------------------------------------------------------

test("read-too-large error re-dispatches as chunks and stitches transparently", async () => {
  const dir = tmp();
  const file = join(dir, "growing.js");
  writeFileSync(file, Array.from({ length: 100 }, (_, i) => `small ${i + 1}`).join("\n"));

  const session = recoverySession(dir);
  const events = attachTurn(session);
  session.codeRun = newRun();

  const resultPromise = dispatchCodeWave(session, "toolu_code_main", 1, [
    { name: "Read", args: { file_path: file } },
  ]);
  const [firstUse] = toolUses(events);
  assert.equal(firstUse.name, "Read");

  // The file grows past the client cap after dispatch; the client refuses.
  const content = Array.from({ length: 2761 }, (_, i) => `grown line ${i + 1}`).join("\n");
  writeFileSync(file, content);
  const recoveryEvents = attachTurn(session);
  await resolveCodeModeToolResults(session, [
    { tool_use_id: firstUse.id, content: [{ type: "text", text: TOO_LARGE_ERR }], is_error: true },
  ]);

  const chunkUses = toolUses(recoveryEvents);
  assert.ok(chunkUses.length >= 2, "chunked recovery Reads fabricated");
  attachTurn(session);
  await resolveCodeModeToolResults(session, chunkUses.map((u) => ({
    tool_use_id: u.id,
    content: [{ type: "text", text: fakeReadResult(content, u.args.offset, u.args.limit) }],
  })));

  const results = await resultPromise;
  assert.equal(results[0].isError, false);
  assert.match(results[0].text, /grown line 2761/);
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Edit freshness auto-recovery
// ---------------------------------------------------------------------------

function editWaveSetup(fileContent) {
  const dir = tmp();
  const file = join(dir, "target.js");
  writeFileSync(file, fileContent);
  const session = recoverySession(dir);
  session.codeRun = newRun();
  return { dir, file, session };
}

test("stale-read Edit auto-recovers: windowed Read + retry in one fabricated message", async () => {
  const content = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join("\n");
  const { dir, file, session } = editWaveSetup(content);
  const events = attachTurn(session);

  const editArgs = { file_path: file, old_string: "line 30", new_string: "LINE THIRTY" };
  const resultPromise = dispatchCodeWave(session, "toolu_code_main", 1, [
    { name: "Edit", args: editArgs },
  ]);
  const [editUse] = toolUses(events);
  assert.equal(editUse.name, "Edit");

  const recoveryEvents = attachTurn(session);
  await resolveCodeModeToolResults(session, [
    { tool_use_id: editUse.id, content: [{ type: "text", text: STALE_READ_ERR }], is_error: true },
  ]);

  const recovery = toolUses(recoveryEvents);
  assert.equal(recovery.length, 2, "one Read + one Edit retry");
  assert.equal(recovery[0].name, "Read");
  assert.equal(recovery[0].args.file_path, file);
  assert.ok(recovery[0].args.offset >= 1 && recovery[0].args.offset <= 30, "window anchored near the edit site");
  assert.equal(recovery[1].name, "Edit");
  assert.deepEqual(recovery[1].args, editArgs, "identical edit retried");
  // The message_start/stop envelope framed the recovery turn.
  assert.ok(recoveryEvents.some((e) => e.type === "message_start"));
  assert.ok(recoveryEvents.some((e) => e.type === "message_stop"));

  attachTurn(session);
  await resolveCodeModeToolResults(session, [
    { tool_use_id: recovery[0].id, content: [{ type: "text", text: fakeReadResult(content, recovery[0].args.offset, recovery[0].args.limit) }] },
    { tool_use_id: recovery[1].id, content: [{ type: "text", text: "The file has been updated." }] },
  ]);

  const results = await resultPromise;
  assert.equal(results[0].isError, false);
  assert.match(results[0].text, /The file has been updated\./);
  assert.ok(results[0].text.includes(NOTE_RECOVERED));
  assert.equal(session.syntheticToCode.size, 0);
  const ledger = session.codeRun === null ? null : session.codeRun.ledger; // run may persist
  // Ledger note rides on the wave's ledger entries.
  const entries = ledger ?? [];
  assert.ok(entries.some((e) => e.note === "auto-recovered stale read"), "ledger marks the recovery");
  rmSync(dir, { recursive: true, force: true });
});

test("edit whose old_string is gone gets the truth immediately, no retry", async () => {
  const { dir, file, session } = editWaveSetup("alpha\nbeta\n");
  const events = attachTurn(session);
  const resultPromise = dispatchCodeWave(session, "toolu_code_main", 1, [
    { name: "Edit", args: { file_path: file, old_string: "NOT PRESENT ANYWHERE", new_string: "x" } },
  ]);
  const [editUse] = toolUses(events);

  const recoveryEvents = attachTurn(session);
  await resolveCodeModeToolResults(session, [
    { tool_use_id: editUse.id, content: [{ type: "text", text: STALE_READ_ERR }], is_error: true },
  ]);
  assert.equal(toolUses(recoveryEvents).length, 0, "no recovery fabricated");

  const results = await resultPromise;
  assert.equal(results[0].isError, true);
  assert.match(results[0].text, /proxy verified on disk: old_string not found/);
  rmSync(dir, { recursive: true, force: true });
});

test("recovery budget: two rounds then the real error surfaces", async () => {
  const content = "solo target line\nother\n";
  const { dir, file, session } = editWaveSetup(content);
  const events = attachTurn(session);
  const resultPromise = dispatchCodeWave(session, "toolu_code_main", 1, [
    { name: "Edit", args: { file_path: file, old_string: "solo target line", new_string: "replaced" } },
  ]);
  let [use] = toolUses(events);

  let recoveryMessages = 0;
  for (;;) {
    const evs = attachTurn(session);
    await resolveCodeModeToolResults(session, [
      { tool_use_id: use.id, content: [{ type: "text", text: STALE_READ_ERR }], is_error: true },
    ]);
    const uses = toolUses(evs);
    if (!uses.length) break;
    recoveryMessages++;
    // Feed the recovery Read; fail the Edit retry again on the next loop pass.
    const read = uses.find((u) => u.name === "Read");
    const edit = uses.find((u) => u.name === "Edit");
    await resolveCodeModeToolResults(session, [
      { tool_use_id: read.id, content: [{ type: "text", text: fakeReadResult(content, read.args.offset, read.args.limit) }] },
    ]);
    use = edit;
  }
  assert.equal(recoveryMessages, 2, "exactly EDIT_RECOVERY_MAX_ROUNDS recovery messages");

  const results = await resultPromise;
  assert.equal(results[0].isError, true);
  assert.ok(results[0].text.includes(NOTE_FRESHNESS_HINT));
  rmSync(dir, { recursive: true, force: true });
});

test("Write freshness failure passes through with the hint, no retry", async () => {
  const { dir, file, session } = editWaveSetup("old content\n");
  const events = attachTurn(session);
  const resultPromise = dispatchCodeWave(session, "toolu_code_main", 1, [
    { name: "Write", args: { file_path: file, content: "new content\n" } },
  ]);
  const [writeUse] = toolUses(events);

  const recoveryEvents = attachTurn(session);
  await resolveCodeModeToolResults(session, [
    { tool_use_id: writeUse.id, content: [{ type: "text", text: STALE_READ_ERR }], is_error: true },
  ]);
  assert.equal(toolUses(recoveryEvents).length, 0);

  const results = await resultPromise;
  assert.equal(results[0].isError, true);
  assert.ok(results[0].text.includes(NOTE_FRESHNESS_HINT));
  rmSync(dir, { recursive: true, force: true });
});

test("CODE_EDIT_RECOVERY=0 disables recovery entirely", async () => {
  process.env.CODE_EDIT_RECOVERY = "0";
  try {
    const { dir, file, session } = editWaveSetup("kill switch line\n");
    const events = attachTurn(session);
    const resultPromise = dispatchCodeWave(session, "toolu_code_main", 1, [
      { name: "Edit", args: { file_path: file, old_string: "kill switch line", new_string: "x" } },
    ]);
    const [editUse] = toolUses(events);
    const recoveryEvents = attachTurn(session);
    await resolveCodeModeToolResults(session, [
      { tool_use_id: editUse.id, content: [{ type: "text", text: STALE_READ_ERR }], is_error: true },
    ]);
    assert.equal(toolUses(recoveryEvents).length, 0);
    const results = await resultPromise;
    assert.equal(results[0].isError, true);
    rmSync(dir, { recursive: true, force: true });
  } finally {
    delete process.env.CODE_EDIT_RECOVERY;
  }
});

test("recovery-read failure is ignored when the edit retry succeeds", async () => {
  const content = "the only line\n";
  const { dir, file, session } = editWaveSetup(content);
  const events = attachTurn(session);
  const resultPromise = dispatchCodeWave(session, "toolu_code_main", 1, [
    { name: "Edit", args: { file_path: file, old_string: "the only line", new_string: "changed" } },
  ]);
  const [editUse] = toolUses(events);

  const recoveryEvents = attachTurn(session);
  await resolveCodeModeToolResults(session, [
    { tool_use_id: editUse.id, content: [{ type: "text", text: STALE_READ_ERR }], is_error: true },
  ]);
  const recovery = toolUses(recoveryEvents);

  attachTurn(session);
  await resolveCodeModeToolResults(session, [
    { tool_use_id: recovery[0].id, content: [{ type: "text", text: "Read failed for unrelated reasons" }], is_error: true },
    { tool_use_id: recovery[1].id, content: [{ type: "text", text: "The file has been updated." }] },
  ]);

  const results = await resultPromise;
  assert.equal(results[0].isError, false);
  assert.ok(results[0].text.includes(NOTE_RECOVERED));
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// __verify inline dispatch (daemon-side syntax check, zero client turns)
// ---------------------------------------------------------------------------

test("__verify resolves inline with no fabricated client turn", async () => {
  const dir = tmp();
  writeFileSync(join(dir, "ok.mjs"), "export const x = 1;\n");
  writeFileSync(join(dir, "bad.mjs"), "const x = ;\n");
  const session = recoverySession(dir);
  const events = attachTurn(session);
  session.codeRun = newRun();

  const results = await dispatchCodeWave(session, "toolu_code_main", 1, [
    { name: "__verify", args: { path: "ok.mjs" } },
    { name: "__verify", args: { path: "bad.mjs" } },
  ]);
  assert.equal(results[0].isError, false);
  assert.match(results[0].text, /OK node: ok\.mjs/);
  assert.equal(results[1].isError, true);
  assert.match(results[1].text, /SyntaxError/);
  assert.equal(toolUses(events).length, 0, "no client tool_use fabricated");
  assert.ok(session.codeRun.verifiedPaths?.size >= 2, "verified paths recorded for the auto-check dedupe");
  rmSync(dir, { recursive: true, force: true });
});

test("__verify refuses paths outside the session cwd", async () => {
  const dir = tmp();
  const session = recoverySession(dir);
  attachTurn(session);
  session.codeRun = newRun();
  const results = await dispatchCodeWave(session, "toolu_code_main", 1, [
    { name: "__verify", args: { path: "../escape.js" } },
  ]);
  assert.equal(results[0].isError, true);
  assert.match(results[0].text, /outside session cwd|unresolvable/);
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Post-edit auto-check backstop, state-overflow notice, git seeding
// ---------------------------------------------------------------------------

function runSession(dir, overrides = {}) {
  return recoverySession(dir, {
    codeState: {},
    codeArtifacts: new Map(),
    codeArtifactSeq: 0,
    ...overrides,
  });
}

// Drive a full startCodeRun to completion: attach turns, execute every
// fabricated tool_use with resultForCall, and return the collapsed result the
// parked `code` handler would receive (stashed in session.resolvedResults).
async function driveRun(session, codeId, script, resultForCall) {
  const events = [];
  const attach = () => {
    session.currentTurn = { resolve: () => {}, reject: () => {} };
    session.res = {
      writableEnded: false,
      write: (s) => {
        for (const m of String(s).matchAll(/^data: (.+)$/gm)) {
          try { events.push(JSON.parse(m[1])); } catch {}
        }
      },
    };
    notifyTurnAttached(session);
  };
  attach();
  startCodeRun(session, codeId, { script });
  const fed = new Set();
  const t0 = Date.now();
  try {
    while (!session.resolvedResults.has(codeId)) {
      if (Date.now() - t0 > 8000) throw new Error("code run did not settle");
      const uses = toolUses(events).filter((u) => !fed.has(u.id) && session.syntheticToCode.has(u.id));
      if (uses.length) {
        for (const u of uses) fed.add(u.id);
        attach();
        await resolveCodeModeToolResults(session, uses.map((u) => {
          const r = resultForCall(u);
          const text = typeof r === "string" ? r : r.text;
          const isErr = typeof r === "object" && !!r.is_error;
          return { tool_use_id: u.id, content: [{ type: "text", text }], ...(isErr ? { is_error: true } : {}) };
        }));
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    const collapsed = session.resolvedResults.get(codeId);
    Object.defineProperty(collapsed, "resolvedResultCountBeforeDrain", {
      value: session.resolvedResults.size,
      enumerable: false,
    });
    return collapsed;
  } finally {
    drainSession(session);
  }
}

test("post-edit auto-check appends a failures-only note", async () => {
  const dir = tmp();
  writeFileSync(join(dir, "broken.mjs"), "const x = ;\n");
  writeFileSync(join(dir, "clean.mjs"), "export const ok = 1;\n");
  const session = runSession(dir);
  const collapsed = await driveRun(
    session,
    "toolu_code_pec",
    'await tools.Edit({ file_path: "broken.mjs", old_string: "a", new_string: "b" });'
      + 'await tools.Edit({ file_path: "clean.mjs", old_string: "a", new_string: "b" });'
      + 'return "edits done";',
    () => "The file has been updated.",
  );
  const text = collapsed.content[0].text;
  assert.match(text, /\[post-edit check\] node failed for broken\.mjs/);
  assert.ok(!text.includes("failed for clean.mjs"), "clean file appends nothing");
  rmSync(dir, { recursive: true, force: true });
});

test("post-edit auto-check skips paths the script already verified", async () => {
  const dir = tmp();
  writeFileSync(join(dir, "broken.mjs"), "const x = ;\n");
  const session = runSession(dir);
  const collapsed = await driveRun(
    session,
    "toolu_code_skip",
    'await tools.Edit({ file_path: "broken.mjs", old_string: "a", new_string: "b" });'
      + 'const v = await codemode.verify("broken.mjs");'
      + 'return "saw failure inline: " + v.isError;',
    () => "The file has been updated.",
  );
  const text = collapsed.content[0].text;
  assert.match(text, /saw failure inline: true/);
  assert.ok(!text.includes("[post-edit check]"), "already-verified path not re-reported");
  rmSync(dir, { recursive: true, force: true });
});

test("state overflow appends an in-band notice and keeps previous state", async () => {
  const dir = tmp();
  const session = runSession(dir, { codeState: { keep: "me" } });
  const collapsed = await driveRun(
    session,
    "toolu_code_state",
    'state.big = "x".repeat(2 * 1024 * 1024 + 4096); return "stashed";',
    () => "unused",
  );
  const text = collapsed.content[0].text;
  assert.match(text, /\[state NOT saved this call:/);
  assert.deepEqual(session.codeState, { keep: "me" }, "previous state kept");
  rmSync(dir, { recursive: true, force: true });
});

test("session git snapshot is seeded into state.git exactly once", async () => {
  const dir = tmp();
  const session = runSession(dir, {
    gitSnapshot: { branch: "main", dirty: true, changes: [" M a.js"], recentCommits: ["abc fix"], capturedAt: "t" },
  });
  const collapsed = await driveRun(
    session,
    "toolu_code_git",
    "return `branch=${state.git.branch} dirty=${state.git.dirty}`;",
    () => "unused",
  );
  assert.match(collapsed.content[0].text, /branch=main dirty=true/);
  assert.equal(session.gitSeeded, true);
  rmSync(dir, { recursive: true, force: true });
});

test("stateByteSize counts Map and Set contents", () => {
  const big = new Map([["k", "v".repeat(1000)]]);
  assert.ok(stateByteSize({ m: big }) > 1000, "Map contents counted");
  assert.ok(stateByteSize({ s: new Set(["x".repeat(500)]) }) > 500, "Set contents counted");
  assert.ok(stateByteSize({ plain: 1 }) < 50);
});

// ---------------------------------------------------------------------------
// Integration: a fake Claude Code executor enforcing the REAL client rules
// (per-file read-state freshness + 25k-token whole-file Read cap) over a real
// temp dir. This is the forensic failure end-to-end: oversized file, external
// mutation between Read and Edit, and the run still completes in ONE code
// round-trip with the edit landed on disk.
// ---------------------------------------------------------------------------

test("end-to-end: oversized file + stale read heal invisibly within one code call", async () => {
  const { statSync, readFileSync, appendFileSync } = await import("node:fs");
  const dir = tmp();
  const file = join(dir, "huge.js");
  writeFileSync(file, Array.from({ length: 2761 }, (_, i) => `const line${i + 1} = ${i + 1};`).join("\n"));

  const readState = new Map(); // path -> mtimeMs at last Read
  let editAttempts = 0;
  const executor = (u) => {
    if (u.name === "Read") {
      const content = readFileSync(u.args.file_path, "utf8");
      if (!u.args.limit && Math.round(Buffer.byteLength(content) / 4) > 25000) {
        return { text: TOO_LARGE_ERR, is_error: true };
      }
      readState.set(u.args.file_path, statSync(u.args.file_path).mtimeMs);
      return { text: fakeReadResult(content, u.args.offset || 1, u.args.limit || Infinity) };
    }
    if (u.name === "Edit") {
      editAttempts++;
      if (editAttempts === 1) {
        // A "linter" touches the file between the Read and the Edit.
        appendFileSync(u.args.file_path, "\n// linter was here\n");
      }
      const mtime = statSync(u.args.file_path).mtimeMs;
      if (!readState.has(u.args.file_path)) {
        return { text: "<tool_use_error>File has not been read yet. Read it first before writing to it.</tool_use_error>", is_error: true };
      }
      if (mtime > readState.get(u.args.file_path)) {
        return { text: STALE_READ_ERR, is_error: true };
      }
      const content = readFileSync(u.args.file_path, "utf8");
      if (content.split(u.args.old_string).length - 1 !== 1) {
        return { text: "old_string mismatch", is_error: true };
      }
      writeFileSync(u.args.file_path, content.replace(u.args.old_string, u.args.new_string));
      readState.set(u.args.file_path, statSync(u.args.file_path).mtimeMs);
      return { text: "The file has been updated." };
    }
    return { text: `unexpected tool ${u.name}`, is_error: true };
  };

  const session = runSession(dir);
  const collapsed = await driveRun(
    session,
    "toolu_code_e2e",
    `
      const r = await tools.Read({ file_path: ${JSON.stringify(file)} });
      if (!r.includes("const line2761")) return "read incomplete";
      const e = await tools.Edit({ file_path: ${JSON.stringify(file)}, old_string: "const line1500 = 1500;", new_string: "const line1500 = 9999; // edited" });
      return { edit: e.text, editOk: !e.isError };
    `,
    executor,
  );
  const text = collapsed.content[0].text;
  assert.match(text, /"editOk": true/, `run failed: ${text.slice(0, 400)}`);
  assert.match(text, /auto-refreshed stale read state/);
  assert.ok(readFileSync(file, "utf8").includes("const line1500 = 9999;"), "edit landed on disk");
  assert.ok(editAttempts >= 2, "first edit was refused by the freshness guard");
  assert.equal(collapsed.resolvedResultCountBeforeDrain, 1, "exactly one code tool_result reached the SDK");
  rmSync(dir, { recursive: true, force: true });
});
