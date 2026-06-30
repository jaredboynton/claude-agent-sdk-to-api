// Live streaming 2-turn tool round-trip against the running bridge.
// Parses Anthropic SSE; confirms native Keychain auth + streaming + tool loop.
const BASE = "http://127.0.0.1:32809";
const MODEL = process.env.BRIDGE_MODEL || "claude-opus-4-8";

const tools = [
  {
    name: "get_weather",
    description: "Get the current weather for a city.",
    input_schema: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
    },
  },
];

// Drain an SSE stream and reconstruct the final message content + stop_reason.
async function streamMessages(body) {
  const res = await fetch(`${BASE}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": "not-used" },
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.headers.get("content-type")?.includes("event-stream")) {
    const txt = await res.text().catch(() => "");
    throw new Error(`expected SSE, got ${res.status} ct=${res.headers.get("content-type")} body=${txt.slice(0, 200)}`);
  }
  const blocks = new Map(); // index -> { type, text, id, name, inputJson }
  let stopReason = null;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let sawEvent = false;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    sawEvent = true;
    let idx;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      let event = null, data = null;
      for (const line of chunk.split("\n")) {
        if (line.startsWith("event: ")) event = line.slice(7);
        else if (line.startsWith("data: ")) data = line.slice(6);
      }
      if (!data) continue;
      let j;
      try { j = JSON.parse(data); } catch { continue; }
      if (j.type === "content_block_start" && j.content_block) {
        blocks.set(j.index, { ...j.content_block, text: j.content_block.text || "", inputJson: "" });
      } else if (j.type === "content_block_delta" && j.delta) {
        const b = blocks.get(j.index);
        if (!b) continue;
        if (j.delta.type === "text_delta") b.text += j.delta.text || "";
        else if (j.delta.type === "input_json_delta") b.inputJson += j.delta.partial_json || "";
      } else if (j.type === "message_delta" && j.delta?.stop_reason) {
        stopReason = j.delta.stop_reason;
      } else if (j.type === "error") {
        throw new Error("SSE error: " + JSON.stringify(j.error || j));
      }
    }
  }
  if (!sawEvent) throw new Error("no SSE events received");
  const content = [...blocks.values()].map((b) => {
    if (b.type === "tool_use") {
      let input = {};
      try { input = JSON.parse(b.inputJson || "{}"); } catch {}
      return { type: "tool_use", id: b.id, name: b.name, input };
    }
    return { type: b.type, text: b.text };
  });
  return { content, stop_reason: stopReason };
}

function show(label, msg) {
  console.log(`\n=== ${label} === stop_reason=${msg.stop_reason}`);
  for (const b of msg.content) {
    if (b.type === "text") console.log("text:", b.text.slice(0, 200));
    else if (b.type === "tool_use") console.log("tool_use:", b.name, JSON.stringify(b.input), "id=", b.id);
  }
}

const turn1 = {
  model: MODEL, max_tokens: 1024, stream: true, tools,
  messages: [{ role: "user", content: "What is the weather in Tokyo? Use the get_weather tool." }],
};
const m1 = await streamMessages(turn1);
show("turn 1", m1);
const toolUse = m1.content.find((b) => b.type === "tool_use");
if (!toolUse) { console.error("no tool_use in turn 1"); process.exit(1); }
if (toolUse.name !== "get_weather" || (toolUse.input.city || "").toLowerCase() !== "tokyo") {
  console.error("turn 1 wrong tool/city:", toolUse.name, toolUse.input); process.exit(1);
}
console.log("\nTURN 1 OK: streamed tool_use get_weather({city:\"Tokyo\"}) id=" + toolUse.id);

const turn2 = {
  model: MODEL, max_tokens: 1024, stream: true, tools,
  messages: [
    ...turn1.messages,
    { role: "assistant", content: m1.content },
    { role: "user", content: [{ type: "tool_result", tool_use_id: toolUse.id, content: "72F, sunny, light breeze" }] },
  ],
};
const m2 = await streamMessages(turn2);
show("turn 2", m2);
const text2 = m2.content.find((b) => b.type === "text");
if (!text2 || !/tokyo|72|sunny|weather/i.test(text2.text)) {
  console.error("turn 2 did not ground on tool_result"); process.exit(1);
}
console.log("\nLIVE STREAMING SMOKE PASSED: native Keychain auth + SSE streaming + 2-turn tool loop end-to-end.");
