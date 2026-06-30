// Minimal client example: call the bridge like the Anthropic Messages API, but
// register your own tools and execute them yourself across turns.
//
//   node examples/curl-and-client.mjs
//
// The bridge holds one live Claude Agent SDK session per conversation and parks
// the SDK's tool calls until you POST the tool_result on the next request.

const BASE = process.env.BRIDGE_URL || "http://127.0.0.1:32809/v1/messages";

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

async function post(messages) {
  const res = await fetch(BASE, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "claude-opus-4-8",
      system: "You are a concise assistant. Use tools when needed.",
      max_tokens: 1024,
      stream: false,
      tools,
      messages,
    }),
  });
  return res.json();
}

// Turn 1: ask a question that needs the tool.
const userTurn = { role: "user", content: [{ type: "text", text: "What's the weather in Paris?" }] };
const r1 = await post([userTurn]);
console.log("turn 1 stop_reason:", r1.stop_reason);

const toolUse = (r1.content || []).find((b) => b.type === "tool_use");
if (!toolUse) {
  console.log("no tool_use returned:", JSON.stringify(r1.content));
  process.exit(0);
}
console.log("tool_use:", toolUse.name, toolUse.input);

// Execute the tool yourself, then POST the result back. The bridge resolves the
// parked SDK handler and the same live session continues.
const r2 = await post([
  userTurn,
  { role: "assistant", content: r1.content },
  { role: "user", content: [{ type: "tool_result", tool_use_id: toolUse.id, content: [{ type: "text", text: "18C, partly cloudy" }] }] },
]);
const text = (r2.content || []).filter((b) => b.type === "text").map((b) => b.text).join(" ");
console.log("turn 2 answer:", text);
