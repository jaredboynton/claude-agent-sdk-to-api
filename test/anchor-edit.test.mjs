// Unit tests for the pure anchor-edit translation layer.
//
// Run: node --test test/anchor-edit.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createAnchorState,
  annotateReadResult,
  translateEditInput,
  reconcileEdit,
  patchEditSchema,
  patchEditDescription,
  mergeAnchorEditSchema,
  patchCodeEditDescription,
  ANCHORED_READ_TOOLS,
  ANCHORED_EDIT_TOOLS,
} from "../src/anchor-edit.mjs";

const OPEN = "\u27e6";
const CLOSE = "\u27e7";

// Build a Claude Code style guttered Read result (arrow separator).
function gutter(lines, startLine = 1) {
  return lines
    .map((l, i) => `${String(i + startLine).padStart(6)}\u2192${l}`)
    .join("\n");
}

function anchorsOf(annotated) {
  return [...annotated.matchAll(/\u27e6([a-z0-9]+)\u27e7/g)].map((m) => m[1]);
}

test("annotateReadResult prefixes each guttered line with an anchor and caches bytes", () => {
  const state = createAnchorState();
  const text = gutter(["function foo() {", "  return 1;", "}"]);
  const { text: out, anchored } = annotateReadResult(state, "/a.js", text);
  assert.equal(anchored, true);
  const anchors = anchorsOf(out);
  assert.equal(anchors.length, 3);
  // Original guttered line text is preserved verbatim after the anchor.
  assert.ok(out.split("\n")[0].startsWith(`${OPEN}${anchors[0]}${CLOSE}`));
  assert.ok(out.includes("function foo() {"));
  const file = state.files.get("/a.js");
  assert.deepEqual(file.lines, ["function foo() {", "  return 1;", "}"]);
  assert.equal(file.partial, false);
});

test("annotateReadResult passes through non-guttered text untouched", () => {
  const state = createAnchorState();
  const text = "no gutters here\njust prose";
  const { text: out, anchored } = annotateReadResult(state, "/a.txt", text);
  assert.equal(anchored, false);
  assert.equal(out, text);
  assert.equal(state.files.has("/a.txt"), false);
});

test("annotateReadResult keeps trailing non-guttered remainder verbatim", () => {
  const state = createAnchorState();
  const text = gutter(["line a", "line b"]) + "\n\n<system-reminder>note</system-reminder>";
  const { text: out, anchored } = annotateReadResult(state, "/a.js", text);
  assert.equal(anchored, true);
  assert.ok(out.includes("<system-reminder>note</system-reminder>"));
  assert.equal(state.files.get("/a.js").lines.length, 2);
});

test("annotateReadResult accepts tab-separated gutters too", () => {
  const state = createAnchorState();
  const text = ["     1\talpha", "     2\tbeta"].join("\n");
  const { anchored } = annotateReadResult(state, "/t.js", text);
  assert.equal(anchored, true);
  assert.deepEqual(state.files.get("/t.js").lines, ["alpha", "beta"]);
});

test("Edit: single-line anchored range -> byte-exact native old_string", () => {
  const state = createAnchorState();
  const { text: out } = annotateReadResult(state, "/a.js", gutter(["a", "  weird   spacing", "c"]));
  const [, mid] = anchorsOf(out);
  const r = translateEditInput(state, "Edit", {
    file_path: "/a.js",
    start_anchor: `${OPEN}${mid}${CLOSE}`,
    end_anchor: `${OPEN}${mid}${CLOSE}`,
    new_string: "  fixed spacing",
  });
  assert.equal(r.ok, true);
  assert.equal(r.input.old_string, "  weird   spacing");
  assert.equal(r.input.new_string, "  fixed spacing");
  assert.equal(r.input.file_path, "/a.js");
});

test("Edit: multi-line range joins exact cached bytes with newlines", () => {
  const state = createAnchorState();
  const { text: out } = annotateReadResult(state, "/a.js", gutter(["a", "b", "c", "d"]));
  const anchors = anchorsOf(out);
  const r = translateEditInput(state, "Edit", {
    file_path: "/a.js",
    start_anchor: anchors[1],
    end_anchor: anchors[2],
    new_string: "B\nC",
  });
  assert.equal(r.ok, true);
  assert.equal(r.input.old_string, "b\nc");
  assert.equal(r.input.new_string, "B\nC");
});

test("Edit: brackets optional and start/end order tolerant", () => {
  const state = createAnchorState();
  const { text: out } = annotateReadResult(state, "/a.js", gutter(["a", "b", "c"]));
  const anchors = anchorsOf(out);
  const r = translateEditInput(state, "Edit", {
    file_path: "/a.js",
    start_anchor: anchors[2], // reversed
    end_anchor: anchors[0],
    new_string: "x",
  });
  assert.equal(r.ok, true);
  assert.equal(r.input.old_string, "a\nb\nc");
});

test("Edit: minimization trims common prefix/suffix when unique (full-file snapshot)", () => {
  const state = createAnchorState();
  const { text: out } = annotateReadResult(state, "/a.js", gutter([
    "header unique line",
    "keep1",
    "OLD",
    "keep2",
    "footer unique line",
  ]));
  const anchors = anchorsOf(out);
  const r = translateEditInput(state, "Edit", {
    file_path: "/a.js",
    start_anchor: anchors[1], // keep1
    end_anchor: anchors[3],   // keep2
    new_string: "keep1\nNEW\nkeep2",
  });
  assert.equal(r.ok, true);
  assert.equal(r.input.old_string, "OLD");
  assert.equal(r.input.new_string, "NEW");
});

test("Edit: minimization keeps context when trimmed text would be ambiguous", () => {
  const state = createAnchorState();
  // "x" repeats, so a bare "x" old_string is not unique; must keep context.
  const { text: out } = annotateReadResult(state, "/a.js", gutter(["x", "x", "x"]));
  const anchors = anchorsOf(out);
  const r = translateEditInput(state, "Edit", {
    file_path: "/a.js",
    start_anchor: anchors[0],
    end_anchor: anchors[2],
    new_string: "x\nY\nx",
  });
  assert.equal(r.ok, true);
  assert.equal(r.input.old_string.split("\n").length === 1, false);
  assert.equal(r.input.old_string.split("x\n").length - 1 >= 1, true);
});

test("partial snapshot (startLine>1) skips minimization, uses full span", () => {
  const state = createAnchorState();
  const { text: out } = annotateReadResult(state, "/a.js", gutter(["keepA", "OLD", "keepB"], 50));
  assert.equal(state.files.get("/a.js").partial, true);
  const anchors = anchorsOf(out);
  const r = translateEditInput(state, "Edit", {
    file_path: "/a.js",
    start_anchor: anchors[0],
    end_anchor: anchors[2],
    new_string: "keepA\nNEW\nkeepB",
  });
  assert.equal(r.ok, true);
  assert.equal(r.input.old_string, "keepA\nOLD\nkeepB");
});

test("MultiEdit: translates each edit and rejects overlap", () => {
  const state = createAnchorState();
  const { text: out } = annotateReadResult(state, "/a.js", gutter(["a", "b", "c", "d", "e"]));
  const anchors = anchorsOf(out);
  const ok = translateEditInput(state, "MultiEdit", {
    file_path: "/a.js",
    edits: [
      { start_anchor: anchors[0], end_anchor: anchors[0], new_string: "A" },
      { start_anchor: anchors[2], end_anchor: anchors[3], new_string: "C\nD" },
    ],
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.input.edits.length, 2);
  assert.equal(ok.input.edits[0].old_string, "a");
  assert.equal(ok.input.edits[1].old_string, "c\nd");

  const bad = translateEditInput(state, "MultiEdit", {
    file_path: "/a.js",
    edits: [
      { start_anchor: anchors[1], end_anchor: anchors[3], new_string: "x" },
      { start_anchor: anchors[2], end_anchor: anchors[4], new_string: "y" },
    ],
  });
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /overlap/);
});

test("translate fails gracefully on unknown anchor / missing snapshot", () => {
  const state = createAnchorState();
  annotateReadResult(state, "/a.js", gutter(["a", "b"]));
  const noFile = translateEditInput(state, "Edit", {
    file_path: "/missing.js",
    start_anchor: "a2",
    end_anchor: "a2",
    new_string: "x",
  });
  assert.equal(noFile.ok, false);
  const badAnchor = translateEditInput(state, "Edit", {
    file_path: "/a.js",
    start_anchor: "zzzz",
    end_anchor: "zzzz",
    new_string: "x",
  });
  assert.equal(badAnchor.ok, false);
  assert.match(badAnchor.reason, /unknown anchor/);
});

test("anchors are session-global unique across multiple files", () => {
  const state = createAnchorState();
  const a = anchorsOf(annotateReadResult(state, "/a.js", gutter(["a", "b"])).text);
  const b = anchorsOf(annotateReadResult(state, "/b.js", gutter(["c", "d"])).text);
  const all = new Set([...a, ...b]);
  assert.equal(all.size, 4);
});

test("MultiEdit: edits supplied out of order are sorted, not rejected as overlap", () => {
  const state = createAnchorState();
  const { text: out } = annotateReadResult(state, "/a.js", gutter(["a", "b", "c", "d", "e"]));
  const anchors = anchorsOf(out);
  // Disjoint edits given bottom-to-top: must succeed and emit ascending order.
  const r = translateEditInput(state, "MultiEdit", {
    file_path: "/a.js",
    edits: [
      { start_anchor: anchors[3], end_anchor: anchors[4], new_string: "D\nE" },
      { start_anchor: anchors[0], end_anchor: anchors[0], new_string: "A" },
    ],
  });
  assert.equal(r.ok, true);
  assert.equal(r.input.edits.length, 2);
  // Emitted ascending: edit[0] is the top edit (a), edit[1] is the bottom (d\ne).
  assert.equal(r.input.edits[0].old_string, "a");
  assert.equal(r.input.edits[1].old_string, "d\ne");
  // The plan ranges are ascending and disjoint.
  assert.ok(r.plan.edits[0].i0 < r.plan.edits[1].i0);
});

test("reconcileEdit keeps unchanged-line anchors stable after a top edit", () => {
  const state = createAnchorState();
  const { text: out } = annotateReadResult(state, "/a.js", gutter(["a", "b", "c", "d"]));
  const anchors = anchorsOf(out);
  // Edit line 0 (a -> A1\nA2): grows the file by one line.
  const r = translateEditInput(state, "Edit", {
    file_path: "/a.js",
    start_anchor: anchors[0],
    end_anchor: anchors[0],
    new_string: "A1\nA2",
  });
  assert.equal(r.ok, true);
  reconcileEdit(state, r.plan);
  const file = state.files.get("/a.js");
  // Lines below the edit keep their ORIGINAL anchors despite the line shift.
  assert.equal(file.lineByCore.has(anchors[1]), true); // b
  assert.equal(file.lineByCore.has(anchors[2]), true); // c
  assert.equal(file.lineByCore.has(anchors[3]), true); // d
  assert.deepEqual(file.lines, ["A1", "A2", "b", "c", "d"]);
  // And those anchors now point at the shifted positions.
  assert.equal(file.lines[file.lineByCore.get(anchors[1])], "b");
});

test("reconcileEdit lets a second sequential edit resolve without re-Read", () => {
  const state = createAnchorState();
  const { text: out } = annotateReadResult(state, "/a.js", gutter(["one", "two", "three", "four"]));
  const anchors = anchorsOf(out);
  // First edit near the top.
  const r1 = translateEditInput(state, "Edit", {
    file_path: "/a.js",
    start_anchor: anchors[0], end_anchor: anchors[0], new_string: "ONE\ninserted",
  });
  assert.equal(r1.ok, true);
  reconcileEdit(state, r1.plan);
  // Second edit using an anchor from the ORIGINAL read (line "four") must still
  // resolve to the correct byte-exact old_string after the snapshot shifted.
  const r2 = translateEditInput(state, "Edit", {
    file_path: "/a.js",
    start_anchor: anchors[3], end_anchor: anchors[3], new_string: "FOUR",
  });
  assert.equal(r2.ok, true);
  assert.equal(r2.input.old_string, "four");
  reconcileEdit(state, r2.plan);
  assert.deepEqual(state.files.get("/a.js").lines, ["ONE", "inserted", "two", "three", "FOUR"]);
});

test("reconcileEdit mints fresh anchors only for genuinely changed middle lines", () => {
  const state = createAnchorState();
  const { text: out } = annotateReadResult(state, "/a.js", gutter(["keep1", "OLD", "keep2"]));
  const anchors = anchorsOf(out);
  const r = translateEditInput(state, "Edit", {
    file_path: "/a.js",
    start_anchor: anchors[0], end_anchor: anchors[2],
    new_string: "keep1\nNEW\nkeep2",
  });
  assert.equal(r.ok, true);
  reconcileEdit(state, r.plan);
  const file = state.files.get("/a.js");
  // keep1/keep2 anchors preserved; the OLD line's anchor is gone (replaced).
  assert.equal(file.lineByCore.has(anchors[0]), true);
  assert.equal(file.lineByCore.has(anchors[2]), true);
  assert.equal(file.lineByCore.has(anchors[1]), false);
  assert.deepEqual(file.lines, ["keep1", "NEW", "keep2"]);
});

test("reconcileEdit is a safe no-op for a path that was never read", () => {
  const state = createAnchorState();
  const res = reconcileEdit(state, { path: "/never.js", edits: [{ i0: 0, i1: 0, newLines: ["x"] }] });
  assert.equal(res.changed, false);
});

test("patchEditSchema / description shapes are well-formed", () => {
  const edit = patchEditSchema("Edit");
  assert.deepEqual(edit.required, ["file_path", "start_anchor", "end_anchor", "new_string"]);
  // Native anchor schema must NOT advertise replace_all (an anchored range is a
  // single contiguous span; replace_all contradicts the anchor model).
  assert.equal(edit.properties.replace_all, undefined);
  const multi = patchEditSchema("MultiEdit");
  assert.equal(multi.properties.edits.type, "array");
  assert.equal(multi.properties.edits.items.properties.file_path, undefined);
  assert.equal(multi.properties.edits.items.properties.replace_all, undefined);
  // Self-contained, example-bearing description (no contradictory old_string text).
  const desc = patchEditDescription("Edit");
  assert.match(desc, /anchor token/i);
  assert.match(desc, /start_anchor/);
  assert.match(desc, /Example:/);
  assert.doesNotMatch(desc, /old_string/);
  assert.match(patchEditDescription("MultiEdit"), /Example:/);
  assert.ok(ANCHORED_READ_TOOLS.has("Read"));
  assert.ok(ANCHORED_EDIT_TOOLS.has("Edit") && ANCHORED_EDIT_TOOLS.has("MultiEdit"));
});

test("Edit translation never emits replace_all", () => {
  const state = createAnchorState();
  const { text: out } = annotateReadResult(state, "/a.js", gutter(["x", "y", "z"]));
  const anchors = anchorsOf(out);
  const r = translateEditInput(state, "Edit", {
    file_path: "/a.js",
    start_anchor: anchors[0],
    end_anchor: anchors[0],
    new_string: "X",
    replace_all: true, // model should not send this, but if it does we ignore it
  });
  assert.equal(r.ok, true);
  assert.equal("replace_all" in r.input, false);
});

test("mergeAnchorEditSchema relaxes required old_string and adds anchor fields", () => {
  const native = {
    type: "object",
    properties: { file_path: { type: "string" }, old_string: { type: "string" }, new_string: { type: "string" } },
    required: ["file_path", "old_string", "new_string"],
  };
  const merged = mergeAnchorEditSchema("Edit", native);
  assert.ok(merged.properties.start_anchor && merged.properties.end_anchor);
  assert.ok(merged.properties.old_string, "native old_string still present");
  assert.equal(merged.required.includes("old_string"), false, "old_string no longer required");
  assert.equal(merged.required.includes("file_path"), true);

  const nativeMulti = {
    type: "object",
    properties: {
      file_path: { type: "string" },
      edits: { type: "array", items: { type: "object", properties: { old_string: { type: "string" }, new_string: { type: "string" } }, required: ["old_string", "new_string"] } },
    },
    required: ["file_path", "edits"],
  };
  const mergedMulti = mergeAnchorEditSchema("MultiEdit", nativeMulti);
  const items = mergedMulti.properties.edits.items;
  assert.ok(items.properties.start_anchor);
  assert.equal(items.required.includes("old_string"), false);
});

test("patchCodeEditDescription documents both paths and use-one-or-the-other", () => {
  const d = patchCodeEditDescription("Edit", "ORIGINAL NATIVE DESC");
  assert.match(d, /\.anchored/);
  assert.match(d, /start_anchor/);
  assert.match(d, /old_string/);
  assert.match(d, /ORIGINAL NATIVE DESC/);
});

// ---------------------------------------------------------------------------
// Partial-snapshot detection (default Reads cap at 2000 lines with no marker)
// ---------------------------------------------------------------------------

test("annotateReadResult flags a from-line-1 read of exactly 2000 lines as partial", () => {
  const state = createAnchorState();
  const lines = Array.from({ length: 2000 }, (_, i) => `line ${i + 1}`);
  const { anchored } = annotateReadResult(state, "/big.js", gutter(lines));
  assert.equal(anchored, true);
  const file = state.files.get("/big.js");
  assert.equal(file.partial, true);
  // Partial snapshots skip minimization: translate emits the full-span old_string.
  const anchors = file.anchors;
  const t = translateEditInput(state, "Edit", {
    file_path: "/big.js",
    start_anchor: anchors[0],
    end_anchor: anchors[2],
    new_string: "line 1\nCHANGED\nline 3",
  });
  assert.equal(t.ok, true);
  assert.equal(t.input.old_string, "line 1\nline 2\nline 3");
});

test("annotateReadResult with complete:true trusts the caller on large stitched reads", () => {
  const state = createAnchorState();
  const lines = Array.from({ length: 2500 }, (_, i) => `line ${i + 1}`);
  annotateReadResult(state, "/stitched.js", gutter(lines), { complete: true });
  const file = state.files.get("/stitched.js");
  assert.equal(file.partial, false);
  // Minimization is active and unique against the full snapshot.
  const t = translateEditInput(state, "Edit", {
    file_path: "/stitched.js",
    start_anchor: file.anchors[9],
    end_anchor: file.anchors[11],
    new_string: "line 10\nCHANGED\nline 12",
  });
  assert.equal(t.ok, true);
  // Minimized below the full span ("line 11" alone is a substring of "line 110"
  // etc., so the minimizer grows back one suffix line to stay unique).
  assert.equal(t.input.old_string, "line 11\nline 12");
});

test("annotateReadResult with complete:false forces partial on a short read", () => {
  const state = createAnchorState();
  annotateReadResult(state, "/short.js", gutter(["a", "b", "c"]), { complete: false });
  assert.equal(state.files.get("/short.js").partial, true);
});
