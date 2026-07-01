// Anchor-based editing translation layer.
//
// The proxy already caches the exact bytes a model reads (the client executes
// Read and POSTs the result back through us). That lets us free the model from
// reproducing whitespace-perfect `old_string` for Edit/MultiEdit: we annotate
// every Read result with stable per-line anchor tokens, advertise an
// anchor-shaped Edit schema to the model, and translate the model's anchored
// edits back into native `old_string`/`new_string` using the cached snapshot.
//
// This module is PURE (no I/O beyond reading the static anchor pool spec, no
// server/session coupling). The server owns one AnchorState per session and
// calls annotateReadResult / translateEditInput at the relevant seams.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));

export const ANCHORED_READ_TOOLS = new Set(["Read"]);
export const ANCHORED_EDIT_TOOLS = new Set(["Edit", "MultiEdit"]);

// Read tool gutter: `<spaces><lineno><sep><content>` where sep is a tab or the
// rightwards-arrow Claude Code renders. Capture the absolute line number and the
// verbatim content bytes (group 4) so the cached snapshot is byte-exact.
const GUTTER_RE = /^(\s*)(\d+)(\t|\u2192)([\s\S]*)$/;

let _pool = null;
function pool() {
  if (_pool) return _pool;
  const spec = JSON.parse(readFileSync(join(__dir, "anchor-pool.json"), "utf8"));
  _pool = {
    open: spec.open || "\u27e6",
    close: spec.close || "\u27e7",
    alphabet: spec.alphabet || "abcdefghijkmnpqrstuvwxyz23456789",
    widths: Array.isArray(spec.widths) && spec.widths.length ? spec.widths : [2, 3, 4],
  };
  return _pool;
}

// Deterministic n-th anchor core (no brackets). Sequential over the configured
// widths so early lines get the shortest, cheapest tokens.
function anchorCore(n) {
  const { alphabet, widths } = pool();
  const base = alphabet.length;
  let idx = n;
  for (const w of widths) {
    const span = base ** w;
    if (idx < span) {
      let s = "";
      let v = idx;
      for (let i = 0; i < w; i++) {
        s = alphabet[v % base] + s;
        v = Math.floor(v / base);
      }
      return s;
    }
    idx -= span;
  }
  // Exhausted the pool (enormous files): fall back to a plain numeric core.
  return `n${n}`;
}

function wrapAnchor(core) {
  const p = pool();
  return `${p.open}${core}${p.close}`;
}

// Pull the anchor core out of a model-supplied reference. Tolerant of missing
// brackets and surrounding whitespace (`"\u27e6a5\u27e7"`, `" a5 "`, `"a5"`).
function parseAnchorCore(ref) {
  if (typeof ref !== "string") return null;
  const m = ref.match(/[a-z0-9]+/i);
  return m ? m[0].toLowerCase() : null;
}

export function createAnchorState() {
  return {
    files: new Map(), // normalizedPath -> { lines, anchors, startLine, partial, lineByCore: Map, fullText }
    seq: 0,           // session-global monotonic anchor counter (cross-file unique)
  };
}

function normPath(p) {
  return typeof p === "string" ? p.trim() : "";
}

// Annotate a Read tool_result's text with per-line anchors and cache the exact
// (gutter-stripped) bytes. Returns { text, anchored }. On any shape we don't
// recognize (no gutter), returns the original text with anchored:false so the
// caller passes it through untouched.
//
// `complete` (tri-state): the caller may assert the text covers the whole file
// (true — e.g. a server-stitched chunked read) or definitely does not (false).
// When unset, the heuristic treats a from-line-1 read of >= 2000 lines as
// truncated: Claude Code's default Read stops at 2000 lines with NO error
// marker, so a 2761-line file would otherwise be cached as a complete snapshot
// and minimizeEdit's uniqueness minimization could emit old_strings that are
// ambiguous against the real disk bytes. A genuinely-2000-line file gets
// misflagged partial — safely conservative (minimization is skipped and the
// full-span old_string is always correct).
export function annotateReadResult(state, filePath, text, { complete } = {}) {
  const path = normPath(filePath);
  if (!path || typeof text !== "string" || !text) return { text, anchored: false };

  const rawLines = text.split("\n");
  const lines = [];          // gutter-stripped content bytes
  const anchors = [];        // anchor core per line index (parallel to lines)
  const out = [];            // model-facing annotated lines
  const lineByCore = new Map();
  let startLine = null;
  let i = 0;

  for (; i < rawLines.length; i++) {
    const m = rawLines[i].match(GUTTER_RE);
    if (!m) break; // first non-guttered line ends the annotated region
    const lineNo = Number(m[2]);
    const content = m[4];
    if (startLine === null) startLine = lineNo;
    const core = anchorCore(state.seq++);
    lineByCore.set(core, lines.length);
    anchors.push(core);
    lines.push(content);
    out.push(`${wrapAnchor(core)}${rawLines[i]}`);
  }

  if (!lines.length) return { text, anchored: false };

  // Trailing non-guttered remainder (e.g. <system-reminder>) passes verbatim.
  const remainder = rawLines.slice(i);
  const annotated = out.concat(remainder).join("\n");

  state.files.set(path, {
    lines,
    anchors,
    startLine,
    partial: complete === true ? false
      : complete === false ? true
      : (startLine !== 1 || lines.length >= 2000),
    lineByCore,
    fullText: lines.join("\n"),
  });
  return { text: annotated, anchored: true };
}

function commonPrefixLen(a, b) {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}
function commonSuffixLen(a, b, max) {
  let i = 0;
  while (i < max && a[a.length - 1 - i] === b[b.length - 1 - i]) i++;
  return i;
}
function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  return haystack.split(needle).length - 1;
}

// Minimize a contiguous line-range replacement to the tightest unique window.
// Prefix/suffix trimming is provably minimal for the single contiguous hunk a
// native Edit can express; we only trim while the resulting old_string stays
// unique within the cached snapshot, otherwise we keep more context. Only runs
// for full-file snapshots (startLine===1) where uniqueness is meaningful.
function minimizeEdit(oldLines, newLines, file) {
  if (file.partial) return { oldStr: oldLines.join("\n"), newStr: newLines.join("\n") };

  let p = commonPrefixLen(oldLines, newLines);
  const maxSuf = Math.min(oldLines.length - p, newLines.length - p);
  let s = commonSuffixLen(oldLines, newLines, maxSuf);

  // Grow back out until old_string is non-empty and unique in the snapshot.
  for (;;) {
    const oldMid = oldLines.slice(p, oldLines.length - s);
    const oldStr = oldMid.join("\n");
    if (oldStr && countOccurrences(file.fullText, oldStr) === 1) {
      return { oldStr, newStr: newLines.slice(p, newLines.length - s).join("\n") };
    }
    if (s > 0) { s--; continue; }   // prefer pulling context from the tail first
    if (p > 0) { p--; continue; }
    break; // cannot expand further; fall through to full span
  }
  return { oldStr: oldLines.join("\n"), newStr: newLines.join("\n") };
}

// Resolve one anchored edit { file_path, start_anchor, end_anchor, new_string }
// against the cached snapshot into { ok, old_string, new_string, i0, i1, newLines }.
// i0/i1 are the FULL anchored line range; old_string/new_string are minimized for
// the native client; newLines is the full replacement (used by the reconciler).
function resolveOne(file, startRef, endRef, newString) {
  const c0 = parseAnchorCore(startRef);
  const c1 = parseAnchorCore(endRef);
  if (c0 == null || c1 == null) return { ok: false, reason: "missing or unparseable anchor" };
  if (!file.lineByCore.has(c0)) return { ok: false, reason: `unknown anchor ${startRef} (re-Read the file)` };
  if (!file.lineByCore.has(c1)) return { ok: false, reason: `unknown anchor ${endRef} (re-Read the file)` };
  let i0 = file.lineByCore.get(c0);
  let i1 = file.lineByCore.get(c1);
  if (i0 > i1) { const t = i0; i0 = i1; i1 = t; }
  const oldLines = file.lines.slice(i0, i1 + 1);
  const newLines = String(newString ?? "").split("\n");
  const { oldStr, newStr } = minimizeEdit(oldLines, newLines, file);
  if (!oldStr) return { ok: false, reason: "empty old_string after resolution" };
  return { ok: true, old_string: oldStr, new_string: newStr, i0, i1, newLines };
}

// Translate an anchor-shaped Edit/MultiEdit input into native shape. Returns
// { ok, input, plan } on success, or { ok:false, reason } so the caller can
// pass the original through (graceful degradation for stale/cold anchors).
// `plan` ({ path, edits:[{ i0, i1, newLines }] }, ascending + disjoint) is handed
// to reconcileEdit AFTER the client confirms success, to keep the snapshot live.
export function translateEditInput(state, toolName, input) {
  if (!input || typeof input !== "object") return { ok: false, reason: "no input" };
  const path = normPath(input.file_path);
  if (!path) return { ok: false, reason: "no file_path" };
  const file = state.files.get(path);
  if (!file) return { ok: false, reason: `no cached Read snapshot for ${path} (Read it first)` };

  if (toolName === "Edit") {
    const r = resolveOne(file, input.start_anchor, input.end_anchor, input.new_string);
    if (!r.ok) return r;
    // No replace_all: an anchored range already designates exactly one
    // contiguous span, and minimizeEdit guarantees the reconstructed old_string
    // is unique within a full-file snapshot, so a single replacement is correct.
    return {
      ok: true,
      input: { file_path: path, old_string: r.old_string, new_string: r.new_string },
      plan: { path, edits: [{ i0: r.i0, i1: r.i1, newLines: r.newLines }] },
    };
  }

  if (toolName === "MultiEdit") {
    const edits = Array.isArray(input.edits) ? input.edits : null;
    if (!edits || !edits.length) return { ok: false, reason: "no edits[]" };
    // Resolve every edit first, then sort by start line. The anchor schema
    // promises edits may be given in ANY order (they resolve against one
    // snapshot), so we must not reject disjoint-but-unsorted edits as
    // "overlapping" — we order them ascending before the overlap check and
    // before emitting native edits[] (ascending application of disjoint ranges
    // is order-independent and byte-identical).
    const resolved = [];
    for (const e of edits) {
      const r = resolveOne(file, e.start_anchor, e.end_anchor, e.new_string);
      if (!r.ok) return r;
      resolved.push(r);
    }
    resolved.sort((a, b) => a.i0 - b.i0);
    for (let k = 1; k < resolved.length; k++) {
      if (resolved[k].i0 <= resolved[k - 1].i1) {
        return { ok: false, reason: `overlapping anchored edit ranges (lines ${resolved[k - 1].i0}-${resolved[k - 1].i1} and ${resolved[k].i0}-${resolved[k].i1})` };
      }
    }
    return {
      ok: true,
      input: { file_path: path, edits: resolved.map((r) => ({ old_string: r.old_string, new_string: r.new_string })) },
      plan: { path, edits: resolved.map((r) => ({ i0: r.i0, i1: r.i1, newLines: r.newLines })) },
    };
  }

  return { ok: false, reason: `tool ${toolName} not anchor-translatable` };
}

// Dirac-style reconciler: after the client confirms an edit succeeded, apply the
// plan to the cached snapshot so the anchors stay LIVE for the next edit without
// a re-Read. Lines outside every edited range keep their original anchors (the
// whole point: an edit near the top does not invalidate anchors below it). Within
// a replaced hunk, matching prefix/suffix lines keep their anchors and only the
// genuinely changed middle lines get fresh ones, minted from the same session
// pool. Rebuilds lines/anchors/lineByCore/fullText. Idempotent no-op if the path
// was never read. Returns { changed } so the caller can surface fresh anchors.
export function reconcileEdit(state, plan) {
  if (!plan || !plan.path) return { changed: false };
  const file = state.files.get(plan.path);
  if (!file) return { changed: false };
  const edits = [...(plan.edits || [])].sort((a, b) => a.i0 - b.i0);
  if (!edits.length) return { changed: false };

  const newLines = [];
  const newAnchors = [];
  let cursor = 0;
  for (const e of edits) {
    for (let k = cursor; k < e.i0 && k < file.lines.length; k++) {
      newLines.push(file.lines[k]);
      newAnchors.push(file.anchors[k]);
    }
    const oldHunk = file.lines.slice(e.i0, e.i1 + 1);
    const oldHunkAnchors = file.anchors.slice(e.i0, e.i1 + 1);
    const repl = Array.isArray(e.newLines) ? e.newLines : [];
    // Preserve anchors for unchanged prefix/suffix lines within the hunk.
    let p = 0;
    while (p < oldHunk.length && p < repl.length && oldHunk[p] === repl[p]) p++;
    let s = 0;
    while (s < (oldHunk.length - p) && s < (repl.length - p) &&
           oldHunk[oldHunk.length - 1 - s] === repl[repl.length - 1 - s]) s++;
    for (let k = 0; k < repl.length; k++) {
      newLines.push(repl[k]);
      if (k < p) newAnchors.push(oldHunkAnchors[k]);
      else if (k >= repl.length - s) newAnchors.push(oldHunkAnchors[oldHunk.length - (repl.length - k)]);
      else newAnchors.push(anchorCore(state.seq++));
    }
    cursor = e.i1 + 1;
  }
  for (let k = cursor; k < file.lines.length; k++) {
    newLines.push(file.lines[k]);
    newAnchors.push(file.anchors[k]);
  }

  const lineByCore = new Map();
  for (let k = 0; k < newAnchors.length; k++) lineByCore.set(newAnchors[k], k);
  file.lines = newLines;
  file.anchors = newAnchors;
  file.lineByCore = lineByCore;
  file.fullText = newLines.join("\n");
  return { changed: true };
}

// Anchor-shaped input schema advertised to the model in place of the native
// Edit/MultiEdit schema. The model points at line ranges by anchor and supplies
// literal replacement text; the proxy reconstructs byte-exact old_string.
//
// Authoritative, self-contained descriptions (Anthropic's guidance: detailed,
// prescriptive text + a concrete example is the single biggest lever on tool
// accuracy). We do NOT prepend the client's native Edit description here: that
// text instructs the model to produce a byte-exact old_string, which directly
// contradicts the anchor schema (there is no old_string field). A self-contained
// description avoids that conflict. Examples live in the description text because
// these tools are advertised through the SDK's MCP layer, where the API-level
// input_examples field is not carried.
const EDIT_DESC =
  "Replace a contiguous range of lines in a file, identified by ANCHOR TOKENS " +
  "instead of by copying the original text.\n\n" +
  "Every line in a Read result is prefixed with a stable anchor token like " +
  "\u27e6a5\u27e7 (the \u27e6 \u27e7 brackets are part of the token; the file " +
  "itself does not contain them). To edit, give the anchor of the first line " +
  "(start_anchor) and the last line (end_anchor) of the range you want to " +
  "replace, plus the full replacement text (new_string). For a single line, " +
  "use the same anchor for both. The proxy reconstructs the exact original " +
  "bytes from the anchors, so you do NOT reproduce the old text, whitespace, or " +
  "indentation \u2014 a mismatch is impossible by construction.\n\n" +
  "new_string is the literal replacement for the whole anchored range: provide " +
  "complete lines with the indentation they should have in the file, and do " +
  "NOT include the \u27e6 \u27e7 anchor tokens or the Read line-number gutter. " +
  "To delete the range, pass an empty new_string. To insert without deleting, " +
  "anchor the line you want to keep and include it in new_string alongside the " +
  "new lines.\n\n" +
  "Anchors come only from a prior Read of THIS file in the current session; if " +
  "you have not read the file (or it changed on disk since), read it again " +
  "first. After a successful edit the proxy keeps your remaining anchors valid, " +
  "so you can make several sequential edits to the same file without re-Reading " +
  "between them. Use this for surgical edits in preference to rewriting whole " +
  "files.\n\n" +
  "Example: to replace the single line shown as \u27e6a7\u27e7    return 1; " +
  "with two lines, call:\n" +
  "{\"file_path\": \"/abs/path/file.js\", \"start_anchor\": \"\u27e6a7\u27e7\", " +
  "\"end_anchor\": \"\u27e6a7\u27e7\", \"new_string\": \"    const x = compute();\\n    return x;\"}";

const MULTIEDIT_DESC =
  "Apply several anchored line-range replacements to ONE file in a single call, " +
  "in order. Each entry has the same shape as Edit: start_anchor, end_anchor, " +
  "and new_string, all referencing anchor tokens (like \u27e6a5\u27e7) from a " +
  "prior Read of this file. The proxy reconstructs the exact original bytes for " +
  "each range, so you never reproduce old text or whitespace.\n\n" +
  "Edits must NOT overlap: the line ranges they address must be disjoint. Order " +
  "the edits however you like \u2014 they all resolve against the same Read " +
  "snapshot, so you never adjust for earlier edits shifting line numbers. To " +
  "change one file in several places, prefer a single MultiEdit over many " +
  "separate Edit calls.\n\n" +
  "Example:\n" +
  "{\"file_path\": \"/abs/path/file.js\", \"edits\": [" +
  "{\"start_anchor\": \"\u27e6a3\u27e7\", \"end_anchor\": \"\u27e6a3\u27e7\", \"new_string\": \"import path from 'node:path';\"}, " +
  "{\"start_anchor\": \"\u27e6b1\u27e7\", \"end_anchor\": \"\u27e6b4\u27e7\", \"new_string\": \"function f() {\\n  return path.basename(x);\\n}\"}]}";

function editProps() {
  return {
    file_path: { type: "string", description: "Absolute path to the file to edit." },
    start_anchor: { type: "string", description: "Anchor token of the FIRST line of the range to replace, copied from this file's Read output, e.g. \u27e6a5\u27e7. Include the \u27e6 \u27e7 brackets." },
    end_anchor: { type: "string", description: "Anchor token of the LAST line of the range to replace, inclusive. Use the same value as start_anchor to replace a single line." },
    new_string: { type: "string", description: "Literal replacement text for the entire anchored range. Provide complete lines with correct indentation; do NOT include anchor tokens or the Read line-number gutter. Empty string deletes the range." },
  };
}

export function patchEditSchema(toolName) {
  if (toolName === "Edit") {
    return {
      type: "object",
      properties: editProps(),
      required: ["file_path", "start_anchor", "end_anchor", "new_string"],
    };
  }
  if (toolName === "MultiEdit") {
    return {
      type: "object",
      properties: {
        file_path: { type: "string", description: "Absolute path to the file to edit." },
        edits: {
          type: "array",
          description: "Non-overlapping anchored edits applied to this file. Each resolves against the same Read snapshot.",
          items: {
            type: "object",
            properties: editProps_(),
            required: ["start_anchor", "end_anchor", "new_string"],
          },
        },
      },
      required: ["file_path", "edits"],
    };
  }
  return null;
}

// Per-edit item props for MultiEdit (no file_path; it lives on the parent).
function editProps_() {
  const { file_path, ...rest } = editProps();
  return rest;
}

export function patchEditDescription(toolName) {
  return toolName === "MultiEdit" ? MULTIEDIT_DESC : EDIT_DESC;
}

// Does this Edit/MultiEdit input use anchor fields (vs native old_string)?
export function hasAnchorFields(toolName, input) {
  if (!input || typeof input !== "object") return false;
  if (toolName === "Edit") return input.start_anchor != null || input.end_anchor != null;
  if (toolName === "MultiEdit") {
    return Array.isArray(input.edits) && input.edits.some((e) => e && (e.start_anchor != null || e.end_anchor != null));
  }
  return false;
}

// Code mode keeps native old_string/new_string working (scripts derive bytes
// from the Read result) AND offers anchors as an alternative. We therefore merge
// the anchor fields into the native schema as OPTIONAL, rather than replacing it,
// so the rendered `code` tool signature documents both paths without forcing one.
const CODE_ANCHOR_PAIR = {
  start_anchor: { type: "string", description: "Anchor token (e.g. \u27e6a5\u27e7) of the FIRST line to replace, taken from this file's Read result `.anchored` view. Provide start_anchor + end_anchor INSTEAD of old_string and the proxy reconstructs the byte-exact old_string for you (no whitespace mismatches)." },
  end_anchor: { type: "string", description: "Anchor token of the LAST line to replace, inclusive; same value as start_anchor for a single line. Required if start_anchor is given." },
};

// Drop a property name from a JSON Schema "required" array (anchors make the
// native old_string optional: an edit may supply EITHER old_string/new_string
// OR start_anchor/end_anchor/new_string, so neither pairing can be hard-required).
function dropRequired(schema, names) {
  if (Array.isArray(schema?.required)) {
    schema.required = schema.required.filter((r) => !names.includes(r));
    if (!schema.required.length) delete schema.required;
  }
}

export function mergeAnchorEditSchema(toolName, nativeSchema) {
  const base = (nativeSchema && typeof nativeSchema === "object")
    ? JSON.parse(JSON.stringify(nativeSchema))
    : { type: "object", properties: {} };
  base.properties = base.properties || {};
  if (toolName === "Edit") {
    Object.assign(base.properties, CODE_ANCHOR_PAIR);
    dropRequired(base, ["old_string"]);
  } else if (toolName === "MultiEdit") {
    const items = base.properties?.edits?.items;
    if (items && typeof items === "object") {
      items.properties = items.properties || {};
      Object.assign(items.properties, CODE_ANCHOR_PAIR);
      dropRequired(items, ["old_string"]);
    }
  }
  return base;
}

export function patchCodeEditDescription(toolName, original = "") {
  const note =
    "ANCHORED EDITING (recommended): each Read result you get back in this " +
    "script ALSO carries an `.anchored` string \u2014 the same text with a stable " +
    "anchor token (like \u27e6a5\u27e7) prefixed to every line. Instead of " +
    "old_string, you may pass start_anchor + end_anchor (the first and last line " +
    "of the range to change, copied from `.anchored`) plus new_string; the proxy " +
    "reconstructs the byte-exact old_string from the file it cached, so " +
    "whitespace and indentation can never mismatch. Pass new_string as the " +
    "literal replacement WITHOUT anchor tokens or the line-number gutter. " +
    "Anchors are only valid for a file you Read earlier in THIS script, but the " +
    "proxy keeps the remaining anchors valid after each successful edit, so you " +
    "can make several edits to the same file in sequence (await them one after " +
    "another) using anchors from the original Read \u2014 no re-Read needed. The " +
    "native old_string/new_string form still works unchanged if you prefer to " +
    "copy bytes from r.text. Use one form or the other per edit, not both. " +
    "Anchors are the most reliable way to edit large files. Stale-read " +
    "failures are auto-recovered by the proxy; an edit error you still see " +
    "means the file content really changed.";
  return `${note}\n\n${original}`.trim();
}
