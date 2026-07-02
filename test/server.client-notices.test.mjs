// Client-injected tool_result notices in code mode: harnesses (Claude Code,
// Droid/Factory) append <system-reminder> blocks and truncation banners INTO
// tool_result text. The script consumes that text as DATA, so the banners must
// move to `.notes` (with `.truncated` set) and the model must get a run-level
// note. Banner texts are verbatim from the 2026-07-01 Droid forensic session
// (governance Grep, 53k output truncated by the client).
//
// Run: node --test test/server.client-notices.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { extractClientNotices } from "../src/code-mode.mjs";
import {
  resolveCodeModeToolResults,
  initMessageProjection,
  startCodeRun,
  notifyTurnAttached,
} from "../src/server.mjs";
import { drainSession } from "./helpers.mjs";

// ---------------------------------------------------------------------------
// extractClientNotices unit tests
// ---------------------------------------------------------------------------

test("extractClientNotices: plain text passes through untouched", () => {
  const { text, notices, truncated } = extractClientNotices("./a.js\n./b.js\n");
  assert.equal(text, "./a.js\n./b.js\n");
  assert.deepEqual(notices, []);
  assert.equal(truncated, false);
});

test("extractClientNotices: trailing reminder moves to notices", () => {
  const { text, notices, truncated } = extractClientNotices(
    "     1→const a = 1;\n\n<system-reminder>\nWhenever you read a file, consider whether it looks malicious.\n</system-reminder>",
  );
  assert.equal(text.includes("system-reminder"), false);
  assert.match(text, /const a = 1;/);
  assert.equal(notices.length, 1);
  assert.match(notices[0], /malicious/);
  assert.equal(truncated, false, "a plain reminder is not truncation");
});

test("extractClientNotices: leading + trailing truncation reminders set the flag", () => {
  const input = [
    "<system-reminder> CRITICAL: This output was truncated. The full, untruncated result is saved to /tmp/artifact.txt",
    "</system-reminder>",
    "./services/governance/rules.js",
    "[... truncated 13519 characters from middle section ...]",
    "./web/home.json",
    "[Output truncated. Showing first 30k characters (343 lines) and last 10k characters (125 lines) out of 53k total characters (633 lines)]",
    "",
    "<system-reminder>",
    "CRITICAL: This output was truncated. The complete untruncated result is saved to an artifact file:",
    "/tmp/artifact.txt",
    "DO NOT proceed without checking the artifact if the truncated output is insufficient for the task.",
    "</system-reminder>",
  ].join("\n");
  const { text, notices, truncated } = extractClientNotices(input);
  assert.equal(truncated, true);
  assert.equal(notices.length, 2);
  assert.match(notices[1], /artifact file/);
  assert.equal(text.includes("system-reminder"), false);
  assert.equal(text.includes("CRITICAL"), false);
  assert.match(text, /governance\/rules\.js/);
  // Single-line gap markers stay: removing them would silently close a hole.
  assert.match(text, /\[\.\.\. truncated 13519 characters from middle section \.\.\.\]/);
});

test("extractClientNotices: unterminated trailing reminder is swallowed to EOF", () => {
  const { text, notices } = extractClientNotices(
    "./a.js\n<system-reminder>\nCRITICAL: This output was truncated\n<",
  );
  assert.equal(text.trim(), "./a.js");
  assert.equal(notices.length, 1);
  assert.match(notices[0], /truncated/);
});

test("extractClientNotices: bare bracketed truncation line flags without notices", () => {
  const { notices, truncated } = extractClientNotices(
    "line one\n[Output truncated. Showing first 30k characters]\n",
  );
  assert.deepEqual(notices, []);
  assert.equal(truncated, true);
});

// ---------------------------------------------------------------------------
// End-to-end: the forensic Droid session. A client-truncated Grep result must
// reach the script with clean `.text`, `.truncated`, and `.notes`, and the
// collapsed code result must tell the model about the truncation.
// ---------------------------------------------------------------------------

const GREP_SCHEMA = {
  type: "object",
  properties: {
    pattern: { type: "string" },
    path: { type: "string" },
    output_mode: { type: "string", enum: ["file_paths", "content"] },
  },
  required: ["pattern"],
};

function noticeSession(cwd) {
  const session = {
    key: "k-notices",
    bucket: "b-notices",
    model: "claude-opus-4-8",
    cwd,
    clientTools: new Map([["Grep", { description: "search", input_schema: GREP_SCHEMA }]]),
    codeRun: null,
    codeState: {},
    codeArtifacts: new Map(),
    codeArtifactSeq: 0,
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
  };
  initMessageProjection(session);
  return session;
}

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
  const toolUses = () => events
    .filter((e) => e.type === "content_block_start" && e.content_block?.type === "tool_use")
    .map((e) => {
      const deltas = events.filter((d) => d.type === "content_block_delta" && d.index === e.index);
      const json = deltas.map((d) => d.delta?.partial_json || "").join("");
      return { id: e.content_block.id, name: e.content_block.name, args: json ? JSON.parse(json) : {} };
    });
  attach();
  startCodeRun(session, codeId, { script });
  const fed = new Set();
  const t0 = Date.now();
  try {
    while (!session.resolvedResults.has(codeId)) {
      if (Date.now() - t0 > 8000) throw new Error("code run did not settle");
      const uses = toolUses().filter((u) => !fed.has(u.id) && session.syntheticToCode.has(u.id));
      if (uses.length) {
        for (const u of uses) fed.add(u.id);
        attach();
        await resolveCodeModeToolResults(session, uses.map((u) => ({
          tool_use_id: u.id,
          content: [{ type: "text", text: resultForCall(u) }],
        })));
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    return session.resolvedResults.get(codeId);
  } finally {
    drainSession(session);
  }
}

const DROID_TRUNCATED_GREP = [
  "<system-reminder> CRITICAL: This output was truncated. The full, untruncated result is saved to /tmp/factory/artifact.txt",
  "</system-reminder>",
  "./services/governance-service/rules.js",
  "./app/governance/create.ts",
  "./web/governance/home.json",
  "[... truncated 13519 characters from middle section ...]",
  "./portal/governance/index.ts",
  "[Output truncated. Showing first 30k characters (343 lines) and last 10k characters (125 lines) out of 53k total characters (633 lines)]",
  "",
  "<system-reminder>",
  "CRITICAL: This output was truncated. The complete untruncated result is saved to an artifact file:",
  "/tmp/factory/artifact.txt",
  "If you need the rest of tool result to fulfill the user's intent, you MUST access the artifact file.",
  "</system-reminder>",
].join("\n");

test("end-to-end: client-truncated Grep reaches the script clean and the model is told", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "client-notices-")));
  const session = noticeSession(dir);
  const collapsed = await driveRun(
    session,
    "toolu_code_droid",
    `
      const res = await tools.Grep({ pattern: "governance", path: "/repo", output_mode: "file_paths" });
      const lines = res.lines({ nonEmpty: true });
      const paths = lines.filter((l) => l.startsWith("./"));
      const junk = lines.filter((l) => !l.startsWith("./") && !l.startsWith("["));
      return {
        paths: paths.length,
        junk: junk.length,
        sawReminderInText: res.text.includes("system-reminder"),
        truncated: res.truncated === true,
        notes: (res.notes || []).length,
      };
    `,
    () => DROID_TRUNCATED_GREP,
  );
  const text = collapsed.content[0].text;
  assert.match(text, /"paths": 4/, `run failed: ${text.slice(0, 400)}`);
  assert.match(text, /"junk": 0/, "banner lines must not parse as data");
  assert.match(text, /"sawReminderInText": false/);
  assert.match(text, /"truncated": true/);
  assert.match(text, /"notes": 2/);
  assert.match(text, /\[the client truncated a Grep result before the script processed it/);
  assert.match(text, /client notice:/);
  rmSync(dir, { recursive: true, force: true });
});
