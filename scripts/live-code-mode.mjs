// End-to-end verification for dynamic code mode (script-first).
//
// Boot bridge with codeMode on (default), POST a prompt whose answer requires
// Grep+Glob. Confirm the client SSE shows TWO tool_use (Grep, Glob) and NO
// `code` block (transparent expand). POST tool_results; confirm the script
// completes and the model emits a final answer promptly (no park timeout).
//
//   node bin/cli.mjs run --no-self-update --profile <dir> --port 32822 &
//   node scripts/live-code-mode.mjs 32822
//
// Exit 0 = pass, 1 = fail.

const PORT = Number(process.argv[2] || 32822);
const HOST = "127.0.0.1";
const BASE = `http://${HOST}:${PORT}`;
const MODEL = process.env.MODEL || "claude-opus-4-8";
const STOP_BUDGET_MS = 120000;

const TOOLS = [
  {
    name: "Grep",
    description: "Search file contents for a pattern.",
    input_schema: {
      type: "object",
      properties: {
        pattern: { type: "string" },
        path: { type: "string" },
        output_mode: { type: "string", enum: ["content", "files_with_matches", "count"], default: "content" },
      },
      required: ["pattern", "path"],
      additionalProperties: false,
    },
  },
  {
    name: "Glob",
    description: "Find files matching a glob pattern.",
    input_schema: {
      type: "object",
      properties: {
        pattern: { type: "string" },
        folder: { type: "string" },
        case_sensitive: { type: "boolean", default: true },
      },
      required: ["pattern", "folder"],
      additionalProperties: false,
    },
  },
];

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

// Read one HTTP response to body close, collecting all blocks across any
// internal continuations. A single response may contain multiple assistant
// messages (fabricated waves + final answer).
async function consumeResponse(res, label) {
  const blocks = [];
  let stopReason = null;
  const toolUses = [];
  const start = Date.now();
  let currentBlocks = [];
  for await (const { event, data } of sseLines(res)) {
    if (event === "message_start") {
      currentBlocks = [];
    } else if (event === "content_block_start") {
      const cb = JSON.parse(JSON.stringify(data.content_block || {}));
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
      blocks.push(b);
    } else if (event === "message_delta") {
      if (data.delta?.stop_reason) stopReason = data.delta.stop_reason;
    } else if (event === "message_stop") {
      // keep reading — body close is the real turn boundary
    } else if (event === "error") {
      throw new Error(`[${label}] stream error: ${JSON.stringify(data)}`);
    }
  }
  return { blocks, stopReason, toolUses, elapsed: Date.now() - start };
}

async function postMessages(messages, { label, codeModeHeader } = {}) {
  const headers = { "content-type": "application/json" };
  if (codeModeHeader != null) headers["X-Code-Mode"] = codeModeHeader;
  const res = await fetch(`${BASE}/v1/messages`, {
    method: "POST",
    headers,
    body: JSON.stringify({ model: MODEL, max_tokens: 4096, stream: true, tools: TOOLS, messages }),
    signal: AbortSignal.timeout(STOP_BUDGET_MS),
  });
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    throw new Error(`[${label}] HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  return consumeResponse(res, label);
}

async function healthz() {
  return (await fetch(`${BASE}/healthz`)).json();
}

async function main() {
  const h0 = await healthz().catch(() => ({}));
  console.log(`healthz: codeMode=${h0.codeMode} codeCalls=${h0.codeCalls} codeWaves=${h0.codeWaves}`);

  const userText =
    "Use ONE code tool call to search pattern 'agent' in path "
    + "'/Users/jaredboynton/__devlocal/claude-agent-sdk-to-api' with Grep, and glob '**/*.mjs' in the same folder with Glob. "
    + "In your script, use Promise.all to call both tools in parallel, then return a JSON summary { grepLineCount, fileCount }.";

  const turn1 = await postMessages([{ role: "user", content: [{ type: "text", text: userText }] }], { label: "turn1" });
  console.log(`turn1: stopReason=${turn1.stopReason} toolUses=${turn1.toolUses.length} elapsed=${turn1.elapsed}ms`);
  for (const t of turn1.toolUses) console.log(`  -> ${t.name} id=${t.id}`);

  const hasCode = turn1.toolUses.some((t) => t.name === "code");
  const grep = turn1.toolUses.filter((t) => t.name === "Grep");
  const glob = turn1.toolUses.filter((t) => t.name === "Glob");
  const transparentOk = !hasCode && grep.length >= 1 && glob.length >= 1;

  if (!transparentOk) {
    console.log("FAIL: client stream should show Grep+Glob tool_use blocks, no `code` block.");
    console.log(`  hasCode=${hasCode} grep=${grep.length} glob=${glob.length}`);
    process.exit(1);
  }
  console.log("PASS: transparent expand — client sees Grep+Glob, not code.");

  const assistantContent = [];
  for (const b of turn1.blocks) {
    if (!b) continue;
    if (b.type === "text") assistantContent.push({ type: "text", text: b.text || "" });
    else if (b.type === "tool_use") assistantContent.push({ type: "tool_use", id: b.id, name: b.name, input: b.input });
  }
  const toolResultContent = turn1.toolUses.map((t) => ({
    type: "tool_result",
    tool_use_id: t.id,
    content: [{ type: "text", text: t.name === "Grep" ? "line1\nline2\nline3" : "a.mjs\nb.mjs" }],
  }));

  const messages2 = [
    { role: "user", content: [{ type: "text", text: userText }] },
    { role: "assistant", content: assistantContent },
    { role: "user", content: toolResultContent },
  ];

  const t0 = Date.now();
  const turn2 = await postMessages(messages2, { label: "turn2" });
  const waited = Date.now() - t0;
  console.log(`turn2: stopReason=${turn2.stopReason} elapsed=${turn2.elapsed}ms total=${waited}ms`);

  const noHang = waited < STOP_BUDGET_MS;
  console.log(noHang ? "PASS: script + final answer completed promptly." : "FAIL: turn2 hung (park timeout?).");

  const h1 = await healthz().catch(() => ({}));
  console.log(`healthz after: codeCalls=${h1.codeCalls} codeSubCalls=${h1.codeSubCalls} codeWaves=${h1.codeWaves} codeErrors=${h1.codeErrors}`);

  process.exit(noHang && transparentOk ? 0 : 1);
}

main().catch((e) => { console.error("driver error:", e?.stack || e); process.exit(1); });
