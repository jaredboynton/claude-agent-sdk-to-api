// Extreme live validation for code mode parallelism.
//
// Drives a real multi-turn /v1/messages session through a running bridge using
// Haiku by default. The model must use one code script that:
//   1. lists fixture files,
//   2. branches on the listing,
//   3. issues many independent ReadFile/StatFile calls via Promise.all,
//   4. branches on read contents,
//   5. issues a second dependent CountPattern wave.
//
// Exit 0 = pass, 1 = fail.

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, readdirSync, rmSync } from "node:fs";
import { join, resolve, relative, sep } from "node:path";
import { tmpdir } from "node:os";

const PORT = Number(process.argv[2] || process.env.PORT || 32809);
const HOST = "127.0.0.1";
const BASE = process.env.BASE_URL || `http://${HOST}:${PORT}`;
const MODEL = process.env.MODEL || "claude-haiku-4-5";
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 240000);
const TARGET_PARALLEL_CALLS = Number(process.env.TARGET_PARALLEL_CALLS || 24);
const MIN_PARALLEL_TOOL_USES = Number(process.env.MIN_PARALLEL_TOOL_USES || TARGET_PARALLEL_CALLS * 2);
const MAX_TURNS = Number(process.env.MAX_TURNS || 8);
const KEEP = process.env.KEEP_CODE_MODE_FIXTURE === "1";

const TOOLS = [
  {
    name: "ListFiles",
    description: "List files under a path in the fixture root. Returns newline-separated relative paths.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string", default: "." } },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: "ReadFile",
    description: "Read one file in the fixture root.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "StatFile",
    description: "Return JSON stats for one file in the fixture root.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "CountPattern",
    description: "Count literal pattern occurrences in one file in the fixture root.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        pattern: { type: "string" },
        case_sensitive: { type: "boolean", default: true },
      },
      required: ["path", "pattern"],
      additionalProperties: false,
    },
  },
];

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), "claude-agent-api-extreme-"));
  mkdirSync(join(root, "notes"), { recursive: true });
  for (let i = 0; i < TARGET_PARALLEL_CALLS; i++) {
    const marker = i % 3 === 0 ? "needle needle" : i % 3 === 1 ? "needle" : "plain";
    writeFileSync(
      join(root, "notes", `file-${String(i).padStart(2, "0")}.txt`),
      `name=file-${i}\nkind=${i % 2 === 0 ? "even" : "odd"}\nmarker=${marker}\n`,
    );
  }
  writeFileSync(join(root, "README.md"), "fixture for extreme code-mode parallelism\n");
  return root;
}

function contain(root, p) {
  const resolved = resolve(root, p || ".");
  if (resolved !== root && !resolved.startsWith(root + sep)) return null;
  return resolved;
}

function listFiles(root, args) {
  const base = contain(root, args.path || ".");
  if (!base) return { text: "error: path escapes fixture root", is_error: true };
  const out = [];
  function walk(dir, prefix) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) walk(join(dir, e.name), rel);
      else out.push(rel);
    }
  }
  walk(base, relative(root, base));
  return { text: out.sort().join("\n") };
}

function readFile(root, args) {
  const file = contain(root, args.path);
  if (!file) return { text: "error: path escapes fixture root", is_error: true };
  try { return { text: readFileSync(file, "utf8") }; }
  catch (e) { return { text: `error: ${e.message}`, is_error: true }; }
}

function statFile(root, args) {
  const file = contain(root, args.path);
  if (!file) return { text: "error: path escapes fixture root", is_error: true };
  try {
    const st = statSync(file);
    return { text: JSON.stringify({ path: args.path, bytes: st.size, file: st.isFile() }) };
  } catch (e) {
    return { text: `error: ${e.message}`, is_error: true };
  }
}

function countPattern(root, args) {
  const file = contain(root, args.path);
  if (!file) return { text: "error: path escapes fixture root", is_error: true };
  try {
    const text = readFileSync(file, "utf8");
    const haystack = args.case_sensitive === false ? text.toLowerCase() : text;
    const needle = args.case_sensitive === false ? String(args.pattern).toLowerCase() : String(args.pattern);
    let count = 0;
    let pos = 0;
    while (needle && (pos = haystack.indexOf(needle, pos)) !== -1) {
      count++;
      pos += needle.length;
    }
    return { text: JSON.stringify({ path: args.path, count }) };
  } catch (e) {
    return { text: `error: ${e.message}`, is_error: true };
  }
}

async function executeTool(root, t) {
  switch (t.name) {
    case "ListFiles": return listFiles(root, t.input || {});
    case "ReadFile": return readFile(root, t.input || {});
    case "StatFile": return statFile(root, t.input || {});
    case "CountPattern": return countPattern(root, t.input || {});
    default: return { text: `unknown tool: ${t.name}`, is_error: true };
  }
}

function sseLines(res) {
  return (async function* () {
    let buf = "";
    for await (const chunk of res.body) {
      buf += new TextDecoder().decode(chunk);
      let idx;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        let event = null;
        let data = null;
        for (const line of frame.split("\n")) {
          if (line.startsWith("event: ")) event = line.slice(7).trim();
          else if (line.startsWith("data: ")) data = line.slice(6);
        }
        if (event && data) yield { event, data: JSON.parse(data) };
      }
    }
  })();
}

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
    } else if (event === "error") {
      throw new Error(`stream error: ${JSON.stringify(data)}`);
    }
  }
  return { completedBlocks, toolUses, sawCode, stopReason, elapsed: Date.now() - start };
}

async function postMessages(messages, system) {
  const res = await fetch(`${BASE}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 8192,
      stream: true,
      system,
      tools: TOOLS,
      messages,
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 500)}`);
  }
  return consumeResponse(res);
}

async function healthz() {
  try {
    const res = await fetch(`${BASE}/healthz`, { signal: AbortSignal.timeout(5000) });
    return await res.json();
  } catch {
    return {};
  }
}

function assistantContentFrom(blocks) {
  const out = [];
  for (const b of blocks) {
    if (b.type === "text") out.push({ type: "text", text: b.text || "" });
    else if (b.type === "tool_use") out.push({ type: "tool_use", id: b.id, name: b.name, input: b.input });
  }
  return out;
}

function prompt(root) {
  return (
    `Fixture root: ${root}\n`
    + `Use one code tool call. Copy this script shape, adapting only syntax if needed:\n`
    + "const listed = await tools.ListFiles({ path: '.' });\n"
    + "const files = listed.text.split('\\n').filter((f) => f.endsWith('.txt')).slice(0, 24);\n"
    + "if (files.length < 24) return { ok: false, reason: 'too few txt files', files };\n"
    + "const wave1 = await Promise.all(files.flatMap((path) => [tools.ReadFile({ path }), tools.StatFile({ path })]));\n"
    + "const reads = wave1.filter((_, i) => i % 2 === 0);\n"
    + "const needleFiles = files.filter((_, i) => reads[i].text.includes('needle'));\n"
    + "let counts = [];\n"
    + "if (needleFiles.length > 0) {\n"
    + "  counts = await Promise.all(needleFiles.map((path) => tools.CountPattern({ path, pattern: 'needle' })));\n"
    + "}\n"
    + "const totalNeedles = counts.reduce((sum, r) => sum + JSON.parse(r.text).count, 0);\n"
    + "return { ok: true, files: files.length, wave1Calls: wave1.length, needleFiles: needleFiles.length, countCalls: counts.length, totalNeedles };\n\n"
    + "Important: use Promise.all for wave1 so the bridge emits at least 48 parallel client-visible tool_use blocks in one turn. "
    + "Use the if (needleFiles.length > 0) branch for the dependent count wave. Final answer must include the returned JSON."
  );
}

async function main() {
  const root = makeFixture();
  console.log(`fixture root: ${root}`);
  console.log(`model: ${MODEL}`);

  const h0 = await healthz();
  const start = {
    codeCalls: h0.codeCalls ?? 0,
    codeSubCalls: h0.codeSubCalls ?? 0,
    codeWaves: h0.codeWaves ?? 0,
    codeErrors: h0.codeErrors ?? 0,
  };
  console.log(`healthz before: ${JSON.stringify(start)}`);

  const system =
    "You are validating code-mode parallel tool execution. You must use exactly one code tool call, not native tools directly. "
    + "Your code script must do the list -> if -> Promise.all(read/stat) -> if -> Promise.all(count) flow requested by the user. "
    + "Only the script return value is visible to you, so return the JSON summary.";

  const messages = [{ role: "user", content: [{ type: "text", text: prompt(root) }] }];
  const toolCounts = {};
  const turnToolCounts = [];
  const validation = { sawCode: false, finalText: "", failed: null };
  let turns = 0;

  try {
    while (turns < MAX_TURNS) {
      turns++;
      const resp = await postMessages(messages, system);
      validation.sawCode ||= resp.sawCode;
      turnToolCounts.push(resp.toolUses.length);
      console.log(`turn ${turns}: toolUses=${resp.toolUses.length} stopReason=${resp.stopReason} elapsed=${resp.elapsed}ms`);

      messages.push({ role: "assistant", content: assistantContentFrom(resp.completedBlocks) });
      const text = resp.completedBlocks.filter((b) => b.type === "text").map((b) => b.text || "").join("\n");
      if (text) validation.finalText = text.slice(0, 2000);

      if (resp.toolUses.length === 0) break;

      const results = await Promise.all(resp.toolUses.map(async (t) => {
        toolCounts[t.name] = (toolCounts[t.name] || 0) + 1;
        const result = await executeTool(root, t);
        const tr = {
          type: "tool_result",
          tool_use_id: t.id,
          content: [{ type: "text", text: result.text }],
        };
        if (result.is_error) tr.is_error = true;
        return tr;
      }));
      messages.push({ role: "user", content: results });
    }
  } catch (e) {
    validation.failed = e;
    console.error(`driver error: ${e?.stack || e}`);
  }

  const h1 = await healthz();
  const deltas = {
    codeCalls: (h1.codeCalls ?? 0) - start.codeCalls,
    codeSubCalls: (h1.codeSubCalls ?? 0) - start.codeSubCalls,
    codeWaves: (h1.codeWaves ?? 0) - start.codeWaves,
    codeErrors: (h1.codeErrors ?? 0) - start.codeErrors,
  };

  const maxToolUses = Math.max(0, ...turnToolCounts);
  const expectedNeedleFiles = TARGET_PARALLEL_CALLS - Math.floor(TARGET_PARALLEL_CALLS / 3);
  const expectedNeedles = Math.ceil(TARGET_PARALLEL_CALLS / 3) * 2 + Math.floor((TARGET_PARALLEL_CALLS + 1) / 3);
  const totalNeedlesRe = new RegExp(
    `("totalNeedles"\\s*:\\s*${expectedNeedles})|(${expectedNeedles}[\\s\\S]{0,80}(occurrences|instances|matches))|((occurrences|instances|matches)[\\s\\S]{0,80}${expectedNeedles})`,
    "i",
  );
  const checks = [];
  const check = (name, ok, detail) => {
    checks.push({ name, ok, detail });
    console.log(`${ok ? "PASS" : "FAIL"}: ${name}${detail ? ` - ${detail}` : ""}`);
  };

  check("client stream never exposed code tool_use", !validation.sawCode, validation.sawCode ? "code leaked" : "");
  check("one turn carried extreme parallel tool_use count", maxToolUses >= MIN_PARALLEL_TOOL_USES, `max=${maxToolUses}, min=${MIN_PARALLEL_TOOL_USES}`);
  check("ReadFile count reached target", (toolCounts.ReadFile || 0) >= TARGET_PARALLEL_CALLS, `ReadFile=${toolCounts.ReadFile || 0}`);
  check("StatFile count reached target", (toolCounts.StatFile || 0) >= TARGET_PARALLEL_CALLS, `StatFile=${toolCounts.StatFile || 0}`);
  check("dependent CountPattern branch ran", (toolCounts.CountPattern || 0) === expectedNeedleFiles, `CountPattern=${toolCounts.CountPattern || 0}, expected=${expectedNeedleFiles}`);
  check("script reported expected total needles", totalNeedlesRe.test(validation.finalText), `expected=${expectedNeedles}`);
  check("bridge counted code call", deltas.codeCalls > 0, `delta=${deltas.codeCalls}`);
  check("bridge counted many subcalls", deltas.codeSubCalls >= TARGET_PARALLEL_CALLS * 2 + expectedNeedleFiles, `delta=${deltas.codeSubCalls}`);
  check("bridge counted dependent waves", deltas.codeWaves >= 3, `delta=${deltas.codeWaves}`);
  check("bridge codeErrors unchanged", deltas.codeErrors === 0, `delta=${deltas.codeErrors}`);
  check("driver loop did not fail", !validation.failed, validation.failed?.message || "");

  console.log("--- summary ---");
  console.log(`turn tool counts: ${JSON.stringify(turnToolCounts)}`);
  console.log(`tool counts: ${JSON.stringify(toolCounts)}`);
  console.log(`healthz deltas: ${JSON.stringify(deltas)}`);
  console.log(`final text: ${validation.finalText.slice(0, 500)}`);

  const ok = checks.every((c) => c.ok);
  if (ok && !KEEP) rmSync(root, { recursive: true, force: true });
  else console.log(`preserved fixture root: ${root}`);
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error("fatal:", e?.stack || e);
  process.exit(1);
});
