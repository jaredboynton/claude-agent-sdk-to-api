// Verifies the bridge passes caller tool schemas through to the model with high
// fidelity and restores caller tool names from the SDK's mcp__<id>__ namespace.
//
// Run: node --test test/server.schema-roundtrip.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

import { toolInputShape, stripBridgeToolName } from "../src/server.mjs";
import { z } from "../src/sdk.mjs";

// A schema using every construct a hand-rolled converter would drop.
const COMPLEX_SCHEMA = {
  type: "object",
  description: "probe",
  properties: {
    severity: { type: "string", enum: ["low", "high", "critical"], description: "sev" },
    assignee: {
      anyOf: [
        { type: "string" },
        { type: "object", properties: { team: { type: "string" } }, required: ["team"] },
      ],
    },
    filters: {
      type: "object",
      properties: { limit: { type: "integer", minimum: 1, maximum: 10 } },
      required: ["limit"],
    },
    mode: { $ref: "#/$defs/Mode" },
  },
  required: ["severity"],
  $defs: { Mode: { type: "string", enum: ["fast", "slow"] } },
};

test("toolInputShape returns a Zod raw shape (every value is a Zod schema)", () => {
  const shape = toolInputShape(COMPLEX_SCHEMA);
  assert.deepEqual(Object.keys(shape).sort(), ["assignee", "filters", "mode", "severity"]);
  for (const [k, v] of Object.entries(shape)) {
    assert.ok(v && typeof v === "object" && "_zod" in v, `${k} is a Zod schema`);
  }
});

test("complex keywords survive the round-trip to JSON Schema (no z.unknown collapse)", () => {
  const shape = toolInputShape(COMPLEX_SCHEMA);
  const out = JSON.stringify(z.toJSONSchema(z.object(shape)));
  assert.ok(out.includes('"low"') && out.includes("critical"), "enum preserved");
  assert.ok(out.includes("anyOf") && out.includes("team"), "anyOf + nested object preserved");
  assert.ok(out.includes('"minimum":1') && out.includes('"maximum":10'), "numeric bounds preserved");
  assert.ok(out.includes("fast") && out.includes("slow"), "$ref/$defs resolved");
});

test("stripBridgeToolName restores caller names from the SDK namespace", () => {
  const original = new Set(["LS", "Read", "mcp__exa__web_search_exa", "mcp__play_wright__nav"]);
  assert.equal(stripBridgeToolName("mcp__0__LS", original), "LS");
  assert.equal(stripBridgeToolName("mcp__0__mcp__exa__web_search_exa", original), "mcp__exa__web_search_exa");
  assert.equal(stripBridgeToolName("Read", original), "Read");
  assert.equal(stripBridgeToolName("mcp__7__mcp__play_wright__nav", original), "mcp__play_wright__nav");
});
