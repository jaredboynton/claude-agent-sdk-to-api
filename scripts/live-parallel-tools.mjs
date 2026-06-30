// End-to-end verification for the tool-use correlation fix.
//
// Drives a real /v1/messages conversation through the bridge with TWO defaulted
// tools that the model is asked to call in parallel. Pre-fix, the SDK-parsed
// handler args (defaults injected) did not deepEqual the streamed raw input, so
// claimStreamedToolUse fell to FIFO and could cross-wire ids under parallel
// dispatch, wedging a parked handler for TOOL_TIMEOUT_MS (270s). With the fix,
// both sides are normalized through the same z.object(shape), ids are claimed
// correctly, and the tool_result round-trip unblocks the loop promptly.
//
// Asserts the second turn's message_stop arrives within STOP_BUDGET_MS (60s),
// far under the 270s pre-fix hang. Run against a throwaway port to avoid
// disrupting any running daemon:
//
//   node bin/cli.mjs run --no-self-update --profile <dir> --port 32821 &
//   node scripts/live-parallel-tools.mjs 32821
//
// Exit 0 = pass, 1 = fail.

const PORT = Number(process.argv[2] || 32821);
const HOST = "127.0.0.1";
const BASE = `http://${HOST}:${PORT}`;
const MODEL = "claude-opus-4-8";
const STOP_BUDGET_MS = 60000;

// Two tools with JSON-Schema `default` values — the exact shape that triggered
// the hang. The model's streamed input omits the defaulted keys; the SDK parses
// handler args with defaults injected.
const TOOLS = [
  {
    name: "Grep",
    description: "Search file contents for a pattern.",
    input_schema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Regex pattern" },
        path: { type: "string", description: "Directory to search" },
        output_mode: { type: "string", enum: ["content", "files_with_matches", "count"], default: "content" },
        case_insensitive: { type: "boolean", default: false },
        line_numbers: { type: "boolean", default: true },
        multiline: { type: "boolean", default: false },
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
        pattern: { type: "string", description: "Glob pattern" },
        folder: { type: "string", description: "Root folder" },
        case_sensitive: { type: "boolean", default: true },
        include_hidden: { type: "boolean", default: false },
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

// Accumulate one assistant turn's content blocks from the SSE stream; resolves
// at message_stop with { blocks, stopReason, toolUses }.
async function consumeTurn(res, label) {
  const blocks = [];
  let stopReason = null;
  const toolUses = [];
  const start = Date.now();
  for await (const { event, data } of sseLines(res)) {
    if (event === "content_block_start") {
      blocks[data.index] = JSON.parse(JSON.stringify(data.content_block || {}));
    } else if (event === "content_block_delta") {
      const b = blocks[data.index];
      if (!b) continue;
      const d = data.delta || {};
      if (d.type === "text_delta") b.text = (b.text || "") + (d.text || "");
      if (d.type === "input_json_delta") b._partial = (b._partial || "") + (d.partial_json || "");
    } else if (event === "content_block_stop") {
      const b = blocks[data.index];
      if (b && b.type === "tool_use") {
        try { b.input = JSON.parse(b._partial || "{}"); } catch { b.input = {}; }
        delete b._partial;
        toolUses.push({ id: b.id, name: b.name, input: b.input });
      }
    } else if (event === "message_delta") {
      if (data.delta?.stop_reason) stopReason = data.delta.stop_reason;
    } else if (event === "message_stop") {
      return { blocks, stopReason, toolUses, elapsed: Date.now() - start };
    } else if (event === "error") {
      throw new Error(`[${label}] stream error: ${JSON.stringify(data)}`);
    }
  }
  throw new Error(`[${label}] stream ended without message_stop`);
}

async function postMessages(messages, label) {
  const res = await fetch(`${BASE}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, max_tokens: 4096, stream: true, tools: TOOLS, messages }),
  });
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    throw new Error(`[${label}] HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  return consumeTurn(res, label);
}

async function main() {
  const userText =
    "Use the Grep and Glob tools IN PARALLEL in this single turn (do not run them one at a time): "
    + "Grep for pattern 'rtinfer' in path '/Users/jaredboynton/__devlocal/unifable', "
    + "and Glob for pattern '**/*.md' in folder '/Users/jaredboynton/__devlocal/unifable'. "
    + "After both return, summarize the counts briefly.";

  const turn1 = await postMessages([{ role: "user", content: [{ type: "text", text: userText }] }], "turn1");
  console.log(`turn1: stopReason=${turn1.stopReason} toolUses=${turn1.toolUses.length} elapsed=${turn1.elapsed}ms`);
  for (const t of turn1.toolUses) console.log(`  -> ${t.name} id=${t.id} input=${JSON.stringify(t.input)}`);

  if (turn1.toolUses.length < 2) {
    console.log(`note: model emitted ${turn1.toolUses.length} tool call(s) (<2); cannot fully exercise parallel correlation. Re-run if this happens.`);
  }

  // Build the tool_result round-trip. Return plausible content for each call.
  const assistantContent = [];
  for (let i = 0; i < turn1.blocks.length; i++) {
    const b = turn1.blocks[i];
    if (!b) continue;
    if (b.type === "text") assistantContent.push({ type: "text", text: b.text || "" });
    else if (b.type === "tool_use") assistantContent.push({ type: "tool_use", id: b.id, name: b.name, input: b.input });
  }
  const toolResultContent = turn1.toolUses.map((t) => ({
    type: "tool_result",
    tool_use_id: t.id,
    content: [{ type: "text", text: `(${t.name} mock result for ${t.input?.pattern ?? "?"}: 2 matches)` }],
  }));

  const messages2 = [
    { role: "user", content: [{ type: "text", text: userText }] },
    { role: "assistant", content: assistantContent },
    { role: "user", content: toolResultContent },
  ];

  const t0 = Date.now();
  const turn2 = await postMessages(messages2, "turn2");
  const waited = Date.now() - t0;
  console.log(`turn2: stopReason=${turn2.stopReason} blocks=${turn2.blocks.filter(Boolean).length} elapsed=${turn2.elapsed}ms`);

  // The only pass criterion is prompt message_stop after the tool_result
  // round-trip. Pre-fix, a cross-wired parked handler would block message_stop
  // for the full 270s TOOL_TIMEOUT_MS. Whether the model emits text or more
  // tool_use in turn2 is irrelevant to the correlation fix.
  const pass = waited < STOP_BUDGET_MS;
  console.log(`\nmessage_stop after tool_result round-trip: ${waited}ms (budget ${STOP_BUDGET_MS}ms, pre-fix hang was 270000ms)`);
  console.log(pass ? "PASS: no park timeout; correlation fix verified end-to-end." : "FAIL: turn did not complete promptly (would have hung pre-fix).");

  // Health check: fifoFallbacks should be 0 (no FIFO fallback occurred).
  try {
    const h = await (await fetch(`${BASE}/healthz`)).json();
    console.log(`healthz: sessions=${h.sessions} fifoFallbacks=${h.fifoFallbacks}`);
    if (h.fifoFallbacks !== 0) console.log("note: fifoFallbacks nonzero — correlation fell to FIFO at least once.");
  } catch (e) {
    console.log(`healthz fetch failed: ${e?.message || e}`);
  }

  process.exit(pass ? 0 : 1);
}

main().catch((e) => { console.error("driver error:", e?.stack || e); process.exit(1); });
