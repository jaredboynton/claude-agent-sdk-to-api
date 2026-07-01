// Live validation for Cloudflare-style code-mode ergonomics.
//
// Drives a real /v1/messages session through a running bridge using Haiku by
// default. The model must use one code script that exercises:
//   - ToolResult string helpers and template coercion
//   - codemode.search() / codemode.describe()
//   - codemode.call() and codemode.batch()
//   - MCP-shaped tool names
//   - one parallel wave plus an if/then dependent wave
//
//   node bin/cli.mjs run --no-self-update --profile <dir> --port 32831 &
//   MODEL=claude-haiku-4-5 node scripts/live-code-mode-ergonomics.mjs 32831
//
// Exit 0 = pass, 1 = fail.

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, readdirSync, rmSync } from "node:fs";
import { join, resolve, relative, sep } from "node:path";
import { tmpdir } from "node:os";

const PORT = Number(process.argv[2] || process.env.PORT || 32831);
const HOST = "127.0.0.1";
const BASE = process.env.BASE_URL || `http://${HOST}:${PORT}`;
const MODEL = process.env.MODEL || "claude-haiku-4-5";
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 240000);
const MAX_TURNS = Number(process.env.MAX_TURNS || 8);
const KEEP = process.env.KEEP_CODE_MODE_FIXTURE === "1";

const TOOL_LIST = "mcp__fixture__ListFiles";
const TOOL_READ = "mcp__fixture__ReadFile";
const TOOL_STAT = "mcp__fixture__StatFile";
const TOOL_COUNT = "mcp__fixture__CountPattern";

const TOOLS = [
  {
    name: TOOL_LIST,
    description: "List files under a path in the fixture root. Returns newline-separated relative paths.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string", default: "." } },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: TOOL_READ,
    description: "Read one file in the fixture root. The text may contain the literal marker needle.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: TOOL_STAT,
    description: "Return JSON stats for one file in the fixture root.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: TOOL_COUNT,
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
  const root = mkdtempSync(join(tmpdir(), "claude-agent-api-ergonomics-"));
  mkdirSync(join(root, "notes"), { recursive: true });
  const markers = ["needle needle", "plain", "needle", "plain", "needle needle", "needle"];
  for (let i = 0; i < markers.length; i++) {
    writeFileSync(
      join(root, "notes", `file-${i}.txt`),
      `name=file-${i}\nmarker=${markers[i]}\n`,
    );
  }
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
    case TOOL_LIST: return listFiles(root, t.input || {});
    case TOOL_READ: return readFile(root, t.input || {});
    case TOOL_STAT: return statFile(root, t.input || {});
    case TOOL_COUNT: return countPattern(root, t.input || {});
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
  const script = `
const hits = codemode.search("ReadFile marker");
const described = codemode.describe("${TOOL_READ}");
const listed = await codemode.call("${TOOL_LIST}", { path: "." });
const files = listed.lines({ trim: true, nonEmpty: true }).filter((f) => f.endsWith(".txt")).sort();
if (files.length < 6) return { ok: false, reason: "too few files", files, hits, described };
const wave1 = await codemode.batch(files.flatMap((path) => [
  ["${TOOL_READ}", { path }],
  { name: "${TOOL_STAT}", args: { path } }
]));
const reads = wave1.filter((_, i) => i % 2 === 0);
const needleFiles = files.filter((_, i) => reads[i].includes("needle"));
let counts = [];
if (needleFiles.length > 0) {
  counts = await codemode.batch(needleFiles.map((path) => ({ name: "${TOOL_COUNT}", args: { path, pattern: "needle" } })));
}
const totalNeedles = counts.reduce((sum, r) => sum + r.json().count, 0);
return {
  ok: true,
  searchHit: hits[0] && hits[0].path,
  described: described.includes("Read one file"),
  files: files.length,
  wave1Calls: wave1.length,
  needleFiles: needleFiles.length,
  countCalls: counts.length,
  totalNeedles,
  firstLine: \`\${reads[0]}\`.split("\\n")[0]
};`;

  return (
    `Fixture root: ${root}\n`
    + "Use exactly one code tool call. Copy this JavaScript into the code script and return its result to me:\n"
    + "```js\n"
    + script.trim()
    + "\n```\n"
    + "Do not call fixture tools directly outside code. The tool names are MCP-shaped on purpose."
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
    "You are validating code-mode ergonomics. Use exactly one code tool call, not native tools directly. "
    + "The user's script is the test; copy it faithfully into code({script}) so codemode.search, describe, batch, ToolResult string behavior, and the dependent if branch all run.";

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

  const final = validation.finalText;
  const maxToolUses = Math.max(0, ...turnToolCounts);
  const checks = [];
  const check = (name, ok, detail) => {
    checks.push({ name, ok, detail });
    console.log(`${ok ? "PASS" : "FAIL"}: ${name}${detail ? ` - ${detail}` : ""}`);
  };

  check("client stream never exposed code tool_use", !validation.sawCode, validation.sawCode ? "code leaked" : "");
  check("parallel batch wave exposed 12 tool calls", maxToolUses >= 12, `max=${maxToolUses}`);
  check("MCP-shaped ListFiles invoked", (toolCounts[TOOL_LIST] || 0) === 1, `count=${toolCounts[TOOL_LIST] || 0}`);
  check("MCP-shaped ReadFile invoked in batch", (toolCounts[TOOL_READ] || 0) === 6, `count=${toolCounts[TOOL_READ] || 0}`);
  check("MCP-shaped StatFile invoked in batch", (toolCounts[TOOL_STAT] || 0) === 6, `count=${toolCounts[TOOL_STAT] || 0}`);
  check("dependent CountPattern branch invoked", (toolCounts[TOOL_COUNT] || 0) === 4, `count=${toolCounts[TOOL_COUNT] || 0}`);
  check("final includes expected ToolResult/codemode summary", /"ok"\s*:\s*true|ok:\s*true|successfully/i.test(final), final.slice(0, 160));
  check("search/describe succeeded", /"described"\s*:\s*true|described:\s*true|description[\s\S]{0,120}read one file/i.test(final), final.slice(0, 160));
  check("string coercion firstLine returned", /name=file-0/.test(final), final.slice(0, 160));
  check("total needles expected", /"totalNeedles"\s*:\s*6|totalNeedles:\s*6|total needles[\s\S]{0,80}\b6\b/i.test(final), final.slice(0, 160));
  check("bridge counted code call", deltas.codeCalls > 0, `delta=${deltas.codeCalls}`);
  check("bridge counted subcalls", deltas.codeSubCalls >= 17, `delta=${deltas.codeSubCalls}`);
  check("bridge counted dependent waves", deltas.codeWaves >= 3, `delta=${deltas.codeWaves}`);
  check("bridge codeErrors unchanged", deltas.codeErrors === 0, `delta=${deltas.codeErrors}`);
  check("driver loop did not fail", !validation.failed, validation.failed?.message || "");

  console.log("--- summary ---");
  console.log(`turn tool counts: ${JSON.stringify(turnToolCounts)}`);
  console.log(`tool counts: ${JSON.stringify(toolCounts)}`);
  console.log(`healthz deltas: ${JSON.stringify(deltas)}`);
  console.log(`final text: ${final.slice(0, 500)}`);

  const ok = checks.every((c) => c.ok);
  if (ok && !KEEP) rmSync(root, { recursive: true, force: true });
  else console.log(`preserved fixture root: ${root}`);
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error("fatal:", e?.stack || e);
  process.exit(1);
});
