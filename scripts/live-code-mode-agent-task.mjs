// Thorough live validation for code mode — drives a real mini-agent workflow
// (web research -> multi-file generation -> command validation -> iterate)
// through the bridge with code mode ON, asserting the transparent expand/collapse
// pipeline holds under a realistic multi-tool, multi-turn workload.
//
// Requires a running bridge (code mode default on) + network for WebSearch.
// NOT part of npm test (lives in scripts/, outside the test/*.test.mjs glob).
//
//   node bin/cli.mjs run --no-self-update --profile <dir> --port 32809 &
//   node scripts/live-code-mode-agent-task.mjs 32809
//
// Env: PORT, MODEL, BASE_URL, MAX_TURNS, KEEP_CODE_MODE_FIXTURE=1
// Exit 0 = pass, 1 = fail.

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from "node:fs";
import { join, dirname, resolve, relative, sep } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const PORT = Number(process.argv[2] || process.env.PORT || 32809);
const HOST = "127.0.0.1";
const BASE = process.env.BASE_URL || `http://${HOST}:${PORT}`;
const MODEL = process.env.MODEL || "claude-opus-4-8";
const MAX_TURNS = Number(process.env.MAX_TURNS || 12);
const REQUEST_TIMEOUT_MS = 180000;
const SHELL_TIMEOUT_MS = 30000;
const WEB_TIMEOUT_MS = 8000;
const MAX_FILE_SIZE = 256 * 1024;
const MAX_READ_SIZE = 32 * 1024;
const KEEP = process.env.KEEP_CODE_MODE_FIXTURE === "1";

// --- Client tool schemas (sent on every POST; used at session creation) ----

const TOOLS = [
  {
    name: "WebSearch",
    description: "Search public web sources (npm registry + DuckDuckGo). Returns compact text digest of titles, URLs, and one-line descriptions. Never throws — returns 'no results (...)' on failure.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        limit: { type: "number", description: "Max results per source", default: 5 },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "WriteFile",
    description: "Write a file inside the project root. Path is relative to the project root. Creates parent dirs. Rejects paths that escape the root.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative path inside the project root" },
        content: { type: "string", description: "File content" },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
  },
  {
    name: "ReadFile",
    description: "Read a file inside the project root. Returns the file content as text.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative path inside the project root" },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "ListFiles",
    description: "Recursively list files under a path in the project root (skips node_modules, .git). Returns newline-separated relative paths.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative path to list (default: root)", default: "." },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: "RunValidation",
    description: "Run an allowlisted validation command in the project root. argv[0] must be 'node' or 'npm'; npm subcommand must be 'test' or 'run'. Returns JSON {exitCode, stdout, stderr} as text. No shell parsing — argv is an array.",
    input_schema: {
      type: "object",
      properties: {
        argv: { type: "array", items: { type: "string" }, description: "Command as argv array, e.g. [\"node\",\"--test\"]" },
      },
      required: ["argv"],
      additionalProperties: false,
    },
  },
];

// --- SSE parsing (read to body close, coalescing internal continuations) ----

function sseLines(res) {
  return (async function* () {
    let buf = "";
    for await (const chunk of res.body) {
      buf += new TextDecoder().decode(chunk);
      let idx;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        let event = null, data = null;
        for (const line of frame.split("\n")) {
          if (line.startsWith("event: ")) event = line.slice(7).trim();
          else if (line.startsWith("data: ")) data = line.slice(6);
        }
        if (event && data) yield { event, data: JSON.parse(data) };
      }
    }
  })();
}

// Read ONE HTTP response to body close. A single response can contain multiple
// assistant messages when the bridge internally continues an invalid/empty code
// call (suppressEndTurn). Collect every content block across all messages in
// completion order; do NOT return at the first message_stop.
async function consumeResponse(res) {
  const completedBlocks = [];
  const toolUses = [];
  let sawCode = false;
  let stopReason = null;
  let currentBlocks = [];
  const start = Date.now();
  for await (const { event, data } of sseLines(res)) {
    if (event === "message_start") {
      currentBlocks = [];
    } else if (event === "content_block_start") {
      const cb = JSON.parse(JSON.stringify(data.content_block || {}));
      if (cb.type === "tool_use" && cb.name === "code") sawCode = true;
      currentBlocks[data.index] = cb;
    } else if (event === "content_block_delta") {
      const b = currentBlocks[data.index];
      if (!b) continue;
      const d = data.delta || {};
      if (d.type === "text_delta") b.text = (b.text || "") + (d.text || "");
      if (d.type === "input_json_delta") b._partial = (b._partial || "") + (d.partial_json || "");
    } else if (event === "content_block_stop") {
      const b = currentBlocks[data.index];
      if (!b) continue;
      if (b.type === "tool_use") {
        try { b.input = JSON.parse(b._partial || "{}"); } catch { b.input = {}; }
        delete b._partial;
        toolUses.push({ id: b.id, name: b.name, input: b.input });
      }
      delete b._partial;
      completedBlocks.push(b);
    } else if (event === "message_delta") {
      if (data.delta?.stop_reason) stopReason = data.delta.stop_reason;
    } else if (event === "message_stop") {
      // keep reading — body close is the real turn boundary
    } else if (event === "error") {
      throw new Error(`stream error: ${JSON.stringify(data)}`);
    }
  }
  return { completedBlocks, toolUses, sawCode, stopReason, elapsed: Date.now() - start };
}

async function postMessages(messages) {
  const res = await fetch(`${BASE}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 8192,
      stream: true,
      system: SYSTEM_PROMPT,
      tools: TOOLS,
      messages,
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  return consumeResponse(res);
}

async function healthz() {
  try { return await (await fetch(`${BASE}/healthz`, { signal: AbortSignal.timeout(5000) })).json(); }
  catch { return {}; }
}

// --- Local tool execution (the "client" side) ------------------------------

function contain(root, p) {
  const resolved = resolve(root, p);
  if (resolved !== root && !resolved.startsWith(root + sep)) return null;
  return resolved;
}

async function webSearch(args) {
  const { query } = args;
  const limit = Math.min(Number(args.limit) || 5, 10);
  const lines = [];
  // Source 1: npm registry search (no auth, generous rate limits).
  try {
    const r = await fetch(
      `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(query)}&size=${limit}`,
      { signal: AbortSignal.timeout(WEB_TIMEOUT_MS) },
    );
    if (r.ok) {
      const j = await r.json();
      for (const pkg of (j.objects || []).slice(0, limit)) {
        const p = pkg.package;
        lines.push(`[npm] ${p.name} — ${(p.description || "").slice(0, 120)} — ${p.links?.npm || ""}`);
      }
    }
  } catch (e) { lines.push(`[npm] no results (${e?.name || "error"})`); }
  // Source 2: DuckDuckGo Instant Answer (no auth).
  try {
    const r = await fetch(
      `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1`,
      { signal: AbortSignal.timeout(WEB_TIMEOUT_MS) },
    );
    if (r.ok) {
      const j = await r.json();
      if (j.AbstractText) lines.push(`[ddg] ${j.AbstractText.slice(0, 200)} — ${j.AbstractURL || ""}`);
      for (const t of (j.RelatedTopics || []).slice(0, 3)) {
        if (t.Text) lines.push(`[ddg] ${t.Text.slice(0, 200)}`);
      }
    }
  } catch (e) { lines.push(`[ddg] no results (${e?.name || "error"})`); }
  return { text: lines.length ? lines.join("\n") : "no results (all sources unavailable)" };
}

function writeFile(root, args) {
  const resolved = contain(root, args.path);
  if (!resolved) return { text: "error: path escapes project root", is_error: true };
  const content = String(args.content ?? "").slice(0, MAX_FILE_SIZE);
  mkdirSync(dirname(resolved), { recursive: true });
  writeFileSync(resolved, content);
  return { text: `wrote ${relative(root, resolved)} (${content.length} bytes)` };
}

function readFile(root, args) {
  const resolved = contain(root, args.path);
  if (!resolved) return { text: "error: path escapes project root", is_error: true };
  try { return { text: readFileSync(resolved, "utf8").slice(0, MAX_READ_SIZE) }; }
  catch (e) { return { text: `error: ${e.message}`, is_error: true }; }
}

function listFiles(root, args) {
  const resolved = contain(root, args.path || ".");
  if (!resolved) return { text: "error: path escapes project root", is_error: true };
  const out = [];
  function walk(d, prefix) {
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name === "node_modules" || e.name === ".git") continue;
      const p = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) walk(join(d, e.name), p);
      else out.push(p);
    }
  }
  walk(resolved, "");
  return { text: out.join("\n") || "(empty)" };
}

const ALLOWED_BIN = new Set(["node", "npm"]);
const ALLOWED_NPM_SUB = new Set(["test", "run"]);

function runValidation(root, args) {
  const argv = args.argv;
  if (!Array.isArray(argv) || argv.length === 0) {
    return { text: JSON.stringify({ exitCode: 1, stdout: "", stderr: "argv must be a non-empty array" }), is_error: true };
  }
  const bin = argv[0];
  if (!ALLOWED_BIN.has(bin)) {
    return { text: JSON.stringify({ exitCode: 1, stdout: "", stderr: `disallowed bin: ${bin}` }), is_error: true };
  }
  if (bin === "npm" && !ALLOWED_NPM_SUB.has(argv[1])) {
    return { text: JSON.stringify({ exitCode: 1, stdout: "", stderr: `disallowed npm subcommand: ${argv[1]}` }), is_error: true };
  }
  const r = spawnSync(bin, argv.slice(1), { cwd: root, shell: false, timeout: SHELL_TIMEOUT_MS, encoding: "utf8" });
  const out = {
    exitCode: r.status ?? (r.signal ? 143 : 1),
    stdout: (r.stdout || "").slice(0, 4000),
    stderr: (r.stderr || "").slice(0, 4000),
  };
  return { text: JSON.stringify(out) };
}

async function executeTool(root, t) {
  switch (t.name) {
    case "WebSearch": return await webSearch(t.input);
    case "WriteFile": return writeFile(root, t.input);
    case "ReadFile": return readFile(root, t.input);
    case "ListFiles": return listFiles(root, t.input);
    case "RunValidation": return runValidation(root, t.input);
    default: return { text: `unknown tool: ${t.name}`, is_error: true };
  }
}

// --- Prompts ---------------------------------------------------------------

const SYSTEM_PROMPT =
  "You are building a small Node.js utility package inside an isolated temp project directory. "
  + "You have these tools: WebSearch, WriteFile, ReadFile, ListFiles, RunValidation. "
  + "Use ONE code({calls, script}) tool call per phase — batch all independent operations into a single code call's calls[] array. "
  + "CRITICAL: ONLY your script's return value is visible to you. Raw tool results are NOT added to your context. "
  + "Your script MUST return any tool output you need to read next turn. "
  + "For RunValidation, parse the result with JSON.parse(results.<id>.text) to read {exitCode, stdout, stderr} and return the parts you need. "
  + "For WebSearch, return the snippets you will cite. "
  + "Write at least: package.json, one src/*.mjs module, one test/*.test.mjs, and README.md. "
  + "Use ONLY Node built-ins (node:test, node:assert/strict, node:fs, node:path). No third-party packages. "
  + "After writing files, run RunValidation with argv [\"node\",\"--test\"] and iterate until exitCode === 0. "
  + "If validation fails, read the stderr from your script's return value, fix the files, and re-run.";

function userPrompt(root) {
  return (
    `Build a small string-utilities package in the project root: ${root}\n\n`
    + "Requirements:\n"
    + "1. src/strings.mjs exporting slugify(str) — lowercase, trim, replace non-alphanumeric runs with hyphens, strip leading/trailing hyphens — and camelCase(str) — convert kebab/snake/spaces to camelCase.\n"
    + "2. test/strings.test.mjs using node:test + node:assert/strict covering edge cases (empty, unicode, multiple separators).\n"
    + "3. package.json with type: module and a test script.\n"
    + "4. README.md documenting the API with examples.\n\n"
    + "Workflow:\n"
    + "- FIRST use WebSearch at least twice (e.g. 'slugify javascript', 'javascript camelCase convention') and cite the URLs in the README.\n"
    + "- THEN write all files in one code call (batch the WriteFile calls).\n"
    + "- THEN run RunValidation with argv [\"node\",\"--test\"] and fix until exitCode === 0.\n"
    + "- Batch independent operations into one code call per phase.\n"
    + "- Remember: only your script's return value is visible to you."
  );
}

// --- Main ------------------------------------------------------------------

async function main() {
  const root = mkdtempSync(join(tmpdir(), "claude-agent-api-code-mode-"));
  console.log(`temp project: ${root}`);

  const h0 = await healthz();
  const startCounts = {
    codeCalls: h0.codeCalls ?? 0,
    codeSubCalls: h0.codeSubCalls ?? 0,
    codeErrors: h0.codeErrors ?? 0,
  };
  console.log(`healthz before: codeMode=${h0.codeMode} codeCalls=${startCounts.codeCalls} codeSubCalls=${startCounts.codeSubCalls} codeErrors=${startCounts.codeErrors}`);

  const toolCounts = { WebSearch: 0, WriteFile: 0, ReadFile: 0, ListFiles: 0, RunValidation: 0 };
  const validationResults = [];
  let sawCode = false;
  let pathEscapes = 0;
  let maxToolUsesInTurn = 0;
  let turns = 0;
  let lastAssistantText = "";

  const messages = [{ role: "user", content: [{ type: "text", text: userPrompt(root) }] }];
  let failed = null;

  try {
    while (turns < MAX_TURNS) {
      turns++;
      const resp = await postMessages(messages);
      if (resp.sawCode) sawCode = true;
      maxToolUsesInTurn = Math.max(maxToolUsesInTurn, resp.toolUses.length);

      const assistantContent = [];
      for (const b of resp.completedBlocks) {
        if (b.type === "text") assistantContent.push({ type: "text", text: b.text || "" });
        else if (b.type === "tool_use") assistantContent.push({ type: "tool_use", id: b.id, name: b.name, input: b.input });
      }
      messages.push({ role: "assistant", content: assistantContent });
      const textParts = resp.completedBlocks.filter((b) => b.type === "text").map((b) => b.text || "");
      lastAssistantText = textParts.join("\n").slice(0, 2000);

      console.log(`turn ${turns}: toolUses=${resp.toolUses.length} stopReason=${resp.stopReason} elapsed=${resp.elapsed}ms`);
      for (const t of resp.toolUses) console.log(`  -> ${t.name} ${JSON.stringify(t.input).slice(0, 120)}`);

      if (resp.toolUses.length === 0) {
        console.log(`turn ${turns}: final answer (no tool_use) — loop complete`);
        break;
      }

      // Execute EVERY synthetic tool_use from this turn and post ALL results in ONE request.
      const toolResultContent = [];
      for (const t of resp.toolUses) {
        toolCounts[t.name] = (toolCounts[t.name] || 0) + 1;
        const result = await executeTool(root, t);
        if (result.is_error && /escapes project root/.test(result.text)) pathEscapes++;
        if (t.name === "RunValidation") {
          try {
            const v = JSON.parse(result.text);
            validationResults.push(v.exitCode);
            console.log(`     validation exitCode=${v.exitCode}`);
          } catch { validationResults.push(null); }
        }
        const tr = { type: "tool_result", tool_use_id: t.id, content: [{ type: "text", text: result.text }] };
        if (result.is_error) tr.is_error = true;
        toolResultContent.push(tr);
      }
      messages.push({ role: "user", content: toolResultContent });
    }
  } catch (e) {
    failed = e;
    console.error(`driver error during loop: ${e?.stack || e}`);
  }

  // --- Independent post-run validation (do not trust the model's self-report) ---
  let independentTestExit = null;
  let independentTestStderr = "";
  if (existsSync(join(root, "package.json"))) {
    const r = spawnSync("node", ["--test"], { cwd: root, shell: false, timeout: SHELL_TIMEOUT_MS, encoding: "utf8" });
    independentTestExit = r.status ?? 1;
    independentTestStderr = (r.stderr || "").slice(0, 1000);
  }

  const expectedFiles = ["package.json", "src/strings.mjs", "test/strings.test.mjs", "README.md"];
  const filesPresent = expectedFiles.map((f) => ({ f, present: existsSync(join(root, f)) }));

  const h1 = await healthz();
  const deltas = {
    codeCalls: (h1.codeCalls ?? 0) - startCounts.codeCalls,
    codeSubCalls: (h1.codeSubCalls ?? 0) - startCounts.codeSubCalls,
    codeErrors: (h1.codeErrors ?? 0) - startCounts.codeErrors,
  };

  // --- Assertions ---
  const checks = [];
  const check = (name, ok, detail) => {
    checks.push({ name, ok, detail });
    console.log(`${ok ? "PASS" : "FAIL"}: ${name}${detail ? ` — ${detail}` : ""}`);
  };

  check("client never sees a code tool_use block", !sawCode, sawCode ? "code block leaked to client stream" : "");
  check("at least one turn expanded to 2+ client tool calls", maxToolUsesInTurn >= 2, `max toolUses in one turn = ${maxToolUsesInTurn}`);
  check(">= 2 WebSearch calls", toolCounts.WebSearch >= 2, `WebSearch=${toolCounts.WebSearch}`);
  check(">= 3 WriteFile calls", toolCounts.WriteFile >= 3, `WriteFile=${toolCounts.WriteFile}`);
  check(">= 1 RunValidation call", toolCounts.RunValidation >= 1, `RunValidation=${toolCounts.RunValidation}`);
  check(">= 1 RunValidation exitCode 0", validationResults.some((c) => c === 0), `exit codes = ${JSON.stringify(validationResults)}`);
  check("no file path escaped temp root", pathEscapes === 0, `escapes = ${pathEscapes}`);
  check("expected files exist", filesPresent.every((x) => x.present), filesPresent.filter((x) => !x.present).map((x) => x.f).join(",") || "all present");
  check("independent node --test exits 0", independentTestExit === 0, `exitCode = ${independentTestExit}${independentTestStderr ? `; stderr: ${independentTestStderr.slice(0, 300)}` : ""}`);
  check("codeCalls delta > 0", deltas.codeCalls > 0, `delta = ${deltas.codeCalls}`);
  check("codeSubCalls delta > 0", deltas.codeSubCalls > 0, `delta = ${deltas.codeSubCalls}`);
  check("codeErrors delta === 0", deltas.codeErrors === 0, `delta = ${deltas.codeErrors}`);

  // --- Summary ---
  console.log("\n--- summary ---");
  console.log(`temp project: ${root}`);
  console.log(`turns: ${turns}`);
  console.log(`tool counts: ${JSON.stringify(toolCounts)}`);
  console.log(`validation exit codes: ${JSON.stringify(validationResults)}`);
  console.log(`independent node --test exit: ${independentTestExit}`);
  console.log(`files: ${filesPresent.map((x) => `${x.f}=${x.present ? "ok" : "MISSING"}`).join(", ")}`);
  console.log(`healthz deltas: ${JSON.stringify(deltas)}`);
  if (lastAssistantText) console.log(`last assistant text: ${lastAssistantText.slice(0, 500)}`);
  if (failed) console.log(`loop error: ${failed.message}`);

  const allPass = checks.every((c) => c.ok) && !failed;
  console.log(`\nresult: ${allPass ? "PASS" : "FAIL"} (${checks.filter((c) => c.ok).length}/${checks.length} checks)`);

  if (allPass && !KEEP) {
    try { rmSync(root, { recursive: true, force: true }); console.log(`cleaned up temp project: ${root}`); }
    catch (e) { console.log(`cleanup failed: ${e.message}`); }
  } else {
    console.log(`preserved temp project: ${root}`);
  }

  process.exit(allPass ? 0 : 1);
}

main().catch((e) => {
  console.error("fatal:", e?.stack || e);
  process.exit(1);
});
