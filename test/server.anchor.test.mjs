// Integration tests for anchor editing wired into the server seams:
// Read-result annotation, native Edit buffer-rewrite, and schema advertisement.
//
// Run: node --test test/server.anchor.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  maybeAnchorReadResult,
  writeNativeEvent,
  advertisedToolSchema,
  toCallToolResult,
  resolveTool,
} from "../src/server.mjs";
import { createAnchorState } from "../src/anchor-edit.mjs";

function nativeSession(overrides = {}) {
  const events = [];
  return {
    session: {
      anchorEdit: true,
      codeMode: false,
      anchorState: createAnchorState(),
      toolMeta: new Map(),
      anchorRewrite: new Set(),
      anchorPendingInput: new Map(),
      anchorEditPlans: new Map(),
      pendingTools: new Map(),
      orphanResolvers: [],
      resolvedResults: new Map(),
      nonStream: null,
      res: { writableEnded: false, write: (s) => { const m = s.match(/^data: (.+)\n\n$/m); if (m) events.push(JSON.parse(m[1])); } },
      ...overrides,
    },
    events,
  };
}

function gutter(lines, startLine = 1) {
  return lines.map((l, i) => `${String(i + startLine).padStart(6)}\u2192${l}`).join("\n");
}
function anchorsOf(text) {
  return [...text.matchAll(/\u27e6([a-z0-9]+)\u27e7/g)].map((m) => m[1]);
}

test("maybeAnchorReadResult annotates a Read result and caches the snapshot", () => {
  const { session } = nativeSession();
  session.toolMeta.set("toolu_read1", { name: "Read", input: { file_path: "/x.js" } });
  const raw = toCallToolResult({ content: [{ type: "text", text: gutter(["const a = 1;", "const b = 2;"]) }] });
  const out = maybeAnchorReadResult(session, "toolu_read1", raw);
  const anchors = anchorsOf(out.content[0].text);
  assert.equal(anchors.length, 2);
  assert.ok(session.anchorState.files.has("/x.js"));
  assert.deepEqual(session.anchorState.files.get("/x.js").lines, ["const a = 1;", "const b = 2;"]);
});

test("maybeAnchorReadResult is a no-op for non-Read tools and when disabled", () => {
  const { session } = nativeSession();
  session.toolMeta.set("toolu_bash", { name: "Bash", input: { command: "ls" } });
  const raw = toCallToolResult({ content: [{ type: "text", text: gutter(["x"]) }] });
  assert.equal(maybeAnchorReadResult(session, "toolu_bash", raw), raw);

  const off = nativeSession({ anchorEdit: false }).session;
  off.toolMeta.set("toolu_read", { name: "Read", input: { file_path: "/x.js" } });
  assert.equal(maybeAnchorReadResult(off, "toolu_read", raw), raw);
});

// Drive the streaming events the way consumeSession does: start, input_json
// deltas (anchor shape), then stop (where consumeSession records pendingInput).
function streamEdit(session, events, { index, id, name, input }) {
  writeNativeEvent(session, { type: "content_block_start", index, content_block: { type: "tool_use", id, name, input: {} } });
  const json = JSON.stringify(input);
  for (const chunk of [json.slice(0, 5), json.slice(5)]) {
    writeNativeEvent(session, { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: chunk } });
  }
  // consumeSession sets anchorPendingInput at the accumulation stop hook:
  session.anchorPendingInput.set(index, { id, name, input });
  writeNativeEvent(session, { type: "content_block_stop", index });
}

test("native Edit: anchor input is withheld and re-emitted as native old/new_string", () => {
  const { session, events } = nativeSession();
  session.toolMeta.set("toolu_read1", { name: "Read", input: { file_path: "/x.js" } });
  const annotated = maybeAnchorReadResult(
    session,
    "toolu_read1",
    toCallToolResult({ content: [{ type: "text", text: gutter(["alpha", "  beta;", "gamma"]) }] }),
  );
  const [, mid] = anchorsOf(annotated.content[0].text);

  streamEdit(session, events, {
    index: 0,
    id: "toolu_edit1",
    name: "Edit",
    input: { file_path: "/x.js", start_anchor: `\u27e6${mid}\u27e7`, end_anchor: `\u27e6${mid}\u27e7`, new_string: "  BETA;" },
  });

  // No raw anchor input_json_delta leaked to the client.
  const deltas = events.filter((e) => e.type === "content_block_delta");
  assert.equal(deltas.length, 1, "exactly one synthetic delta emitted");
  const native = JSON.parse(deltas[0].delta.partial_json);
  assert.deepEqual(native, { file_path: "/x.js", old_string: "  beta;", new_string: "  BETA;" });
  assert.ok(events.some((e) => e.type === "content_block_start"));
  assert.ok(events.some((e) => e.type === "content_block_stop"));
});

test("native Edit: unknown anchor forwards original input (graceful degradation)", () => {
  const { session, events } = nativeSession();
  // No Read cached for /x.js -> translation fails.
  streamEdit(session, events, {
    index: 0,
    id: "toolu_edit2",
    name: "Edit",
    input: { file_path: "/x.js", start_anchor: "zzzz", end_anchor: "zzzz", new_string: "x" },
  });
  const deltas = events.filter((e) => e.type === "content_block_delta");
  assert.equal(deltas.length, 1);
  assert.deepEqual(JSON.parse(deltas[0].delta.partial_json), {
    file_path: "/x.js", start_anchor: "zzzz", end_anchor: "zzzz", new_string: "x",
  });
});

test("native non-Edit tool_use passes through unchanged", () => {
  const { session, events } = nativeSession();
  writeNativeEvent(session, { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t", name: "Bash", input: {} } });
  writeNativeEvent(session, { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{\"command\":\"ls\"}" } });
  writeNativeEvent(session, { type: "content_block_stop", index: 0 });
  const deltas = events.filter((e) => e.type === "content_block_delta");
  assert.equal(deltas.length, 1);
  assert.equal(deltas[0].delta.partial_json, "{\"command\":\"ls\"}");
});

test("advertisedToolSchema patches Edit only for native anchor sessions", () => {
  const native = { anchorEdit: true, codeMode: false };
  const edit = { name: "Edit", input_schema: { type: "object", properties: { old_string: { type: "string" } } }, description: "orig" };
  const a = advertisedToolSchema(native, edit);
  assert.ok(a.schema.properties.start_anchor);
  assert.match(a.description, /ANCHOR TOKENS/);

  // Code-mode session keeps native schema.
  const code = advertisedToolSchema({ anchorEdit: true, codeMode: true }, edit);
  assert.deepEqual(code.schema, edit.input_schema);

  // Disabled keeps native schema.
  const off = advertisedToolSchema({ anchorEdit: false, codeMode: false }, edit);
  assert.deepEqual(off.schema, edit.input_schema);

  // Non-edit tool untouched.
  const bash = { name: "Bash", input_schema: { type: "object", properties: {} }, description: "b" };
  assert.deepEqual(advertisedToolSchema(native, bash).schema, bash.input_schema);
});

test("native reconcile: a confirmed edit keeps later anchors valid for a second edit", () => {
  const { session, events } = nativeSession();
  session.toolMeta.set("toolu_read1", { name: "Read", input: { file_path: "/x.js" } });
  const annotated = maybeAnchorReadResult(
    session,
    "toolu_read1",
    toCallToolResult({ content: [{ type: "text", text: gutter(["one", "two", "three", "four"]) }] }),
  );
  const anchors = anchorsOf(annotated.content[0].text);

  // First edit at the top grows the file by one line.
  streamEdit(session, events, {
    index: 0, id: "toolu_edit1", name: "Edit",
    input: { file_path: "/x.js", start_anchor: `\u27e6${anchors[0]}\u27e7`, end_anchor: `\u27e6${anchors[0]}\u27e7`, new_string: "ONE\ninserted" },
  });
  // Plan is staged but NOT yet applied (waiting for client success).
  assert.ok(session.anchorEditPlans.has("toolu_edit1"));

  // Client confirms success -> reconcile fires.
  resolveTool(session, "toolu_edit1", { content: [{ type: "text", text: "ok" }] });
  assert.equal(session.anchorEditPlans.has("toolu_edit1"), false);
  assert.deepEqual(session.anchorState.files.get("/x.js").lines, ["ONE", "inserted", "two", "three", "four"]);

  // Second edit, using the ORIGINAL "four" anchor, still resolves byte-exact.
  streamEdit(session, events, {
    index: 1, id: "toolu_edit2", name: "Edit",
    input: { file_path: "/x.js", start_anchor: `\u27e6${anchors[3]}\u27e7`, end_anchor: `\u27e6${anchors[3]}\u27e7`, new_string: "FOUR" },
  });
  const deltas = events.filter((e) => e.type === "content_block_delta" && e.index === 1);
  assert.equal(deltas.length, 1);
  assert.deepEqual(JSON.parse(deltas[0].delta.partial_json), { file_path: "/x.js", old_string: "four", new_string: "FOUR" });
});

test("native reconcile: a FAILED edit does not mutate the snapshot", () => {
  const { session, events } = nativeSession();
  session.toolMeta.set("toolu_read1", { name: "Read", input: { file_path: "/x.js" } });
  const annotated = maybeAnchorReadResult(
    session,
    "toolu_read1",
    toCallToolResult({ content: [{ type: "text", text: gutter(["a", "b", "c"]) }] }),
  );
  const anchors = anchorsOf(annotated.content[0].text);
  const before = [...session.anchorState.files.get("/x.js").lines];

  streamEdit(session, events, {
    index: 0, id: "toolu_edit1", name: "Edit",
    input: { file_path: "/x.js", start_anchor: `\u27e6${anchors[0]}\u27e7`, end_anchor: `\u27e6${anchors[0]}\u27e7`, new_string: "A" },
  });
  // Client reports the edit FAILED.
  resolveTool(session, "toolu_edit1", { content: [{ type: "text", text: "no match" }], isError: true });
  assert.equal(session.anchorEditPlans.has("toolu_edit1"), false);
  assert.deepEqual(session.anchorState.files.get("/x.js").lines, before, "snapshot unchanged after a failed edit");
});
