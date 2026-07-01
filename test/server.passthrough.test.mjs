// Structured-output passthrough tests (Claude Code prompt/agent hooks).
// Run: node --test test/server.passthrough.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import {
  needsStructuredOutputPassthrough,
  anthropicPassthroughHeaders,
  forwardAnthropicMessages,
} from "../src/server.mjs";

test("needsStructuredOutputPassthrough detects output_config.format", () => {
  assert.equal(
    needsStructuredOutputPassthrough({
      model: "claude-haiku-4-5",
      messages: [{ role: "user", content: "eval" }],
      output_config: { format: { type: "json_schema", schema: { type: "object", properties: { ok: { type: "boolean" } } } } },
    }),
    true,
  );
});

test("needsStructuredOutputPassthrough detects legacy output_format", () => {
  assert.equal(
    needsStructuredOutputPassthrough({
      model: "claude-haiku-4-5",
      messages: [{ role: "user", content: "eval" }],
      output_format: { type: "json_schema", schema: { type: "object" } },
    }),
    true,
  );
});

test("needsStructuredOutputPassthrough detects top-level effort (hook/statusline requests)", () => {
  assert.equal(
    needsStructuredOutputPassthrough({
      model: "claude-opus-4-8",
      messages: [{ role: "user", content: "hook eval" }],
      effort: { level: "high" },
    }),
    true,
  );
});

test("needsStructuredOutputPassthrough detects rate_limits (statusline 5h/weekly limits)", () => {
  assert.equal(
    needsStructuredOutputPassthrough({
      model: "claude-opus-4-8",
      messages: [{ role: "user", content: "statusline" }],
      rate_limits: { five_hour: { used_percentage: 23.5 }, seven_day: { used_percentage: 41.2 } },
    }),
    true,
  );
});

test("needsStructuredOutputPassthrough detects cost (statusline cost tracking)", () => {
  assert.equal(
    needsStructuredOutputPassthrough({
      model: "claude-opus-4-8",
      messages: [{ role: "user", content: "statusline" }],
      cost: { total_cost_usd: 0.01234, total_duration_ms: 45000 },
    }),
    true,
  );
});

test("needsStructuredOutputPassthrough detects context_window (statusline usage)", () => {
  assert.equal(
    needsStructuredOutputPassthrough({
      model: "claude-opus-4-8",
      messages: [{ role: "user", content: "statusline" }],
      context_window: { total_input_tokens: 15500, total_output_tokens: 1200 },
    }),
    true,
  );
});

test("needsStructuredOutputPassthrough ignores effort-only output_config", () => {
  assert.equal(
    needsStructuredOutputPassthrough({
      model: "claude-opus-4-8",
      messages: [{ role: "user", content: "hi" }],
      output_config: { effort: "high" },
    }),
    false,
  );
});

test("needsStructuredOutputPassthrough ignores normal agent requests", () => {
  assert.equal(
    needsStructuredOutputPassthrough({
      model: "claude-opus-4-8",
      messages: [{ role: "user", content: "fix the bug" }],
      tools: [{ name: "Read", input_schema: { type: "object" } }],
    }),
    false,
  );
});

test("anthropicPassthroughHeaders forwards auth and anthropic headers", () => {
  const headers = anthropicPassthroughHeaders({
    headers: {
      authorization: "Bearer oauth-token",
      "anthropic-beta": "structured-outputs-2025-12-15",
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
      accept: "text/event-stream",
    },
  });
  assert.equal(headers.authorization, "Bearer oauth-token");
  assert.equal(headers["anthropic-beta"], "structured-outputs-2025-12-15");
  assert.equal(headers["anthropic-version"], "2023-06-01");
  assert.equal(headers["content-type"], "application/json");
  assert.equal(headers.accept, "text/event-stream");
});

test("forwardAnthropicMessages relays body and status from upstream", async () => {
  const prevOrigin = process.env.ANTHROPIC_API_ORIGIN;
  const upstream = http.createServer((req, res) => {
    assert.equal(req.method, "POST");
    assert.equal(req.url, "/v1/messages?beta=true");
    assert.equal(req.headers.authorization, "Bearer test-token");
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      assert.deepEqual(JSON.parse(body), { model: "claude-haiku-4-5", messages: [{ role: "user", content: "hook" }] });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "msg_test", type: "message", role: "assistant", content: [{ type: "text", text: '{"ok":true}' }] }));
    });
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const { port } = upstream.address();
  process.env.ANTHROPIC_API_ORIGIN = `http://127.0.0.1:${port}`;

  const clientReq = {
    headers: {
      authorization: "Bearer test-token",
      "content-type": "application/json",
    },
    url: "/v1/messages?beta=true",
  };
  const rawBody = JSON.stringify({ model: "claude-haiku-4-5", messages: [{ role: "user", content: "hook" }] });

  const result = await new Promise((resolve, reject) => {
    const res = {
      headersSent: false,
      statusCode: null,
      outHeaders: null,
      chunks: [],
      writeHead(status, headers) {
        this.headersSent = true;
        this.statusCode = status;
        this.outHeaders = headers;
      },
      write(chunk) { this.chunks.push(chunk); return true; },
      end(chunk) {
        if (chunk) this.chunks.push(chunk);
        resolve({
          status: this.statusCode,
          body: Buffer.concat(this.chunks).toString("utf8"),
        });
      },
      get writableEnded() { return false; },
    };
    forwardAnthropicMessages(clientReq, res, rawBody, clientReq.url).catch(reject);
  });

  upstream.close();
  process.env.ANTHROPIC_API_ORIGIN = prevOrigin;

  assert.equal(result.status, 200);
  const parsed = JSON.parse(result.body);
  assert.equal(parsed.content[0].text, '{"ok":true}');
});
