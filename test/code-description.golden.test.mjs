// Golden-byte guard for the `code` tool description.
//
// The rendered description is part of every conversation's cached prompt
// prefix; editing its bytes re-writes that prefix at 2x for every conversation
// resumed inside the warm window. Any change must be deliberate: batch prose
// and rendering edits into as few releases as possible, then regenerate with
//   UPDATE_GOLDEN=1 node --test test/code-description.golden.test.mjs
// Run: node --test test/code-description.golden.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { buildCodeToolDescription } from "../src/code-mode.mjs";
import { configureCaveman } from "../src/caveman.mjs";
import { registerClientTool } from "../src/server.mjs";

// The fixture locks the PRODUCTION rendering: caveman full is the shipped
// default, pinned here so the byte-lock is deterministic under any CAVEMAN env.
configureCaveman({ caveman: "full" });

const GOLDEN_PATH = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "code-description.golden.txt");

// Canonical toolset: plain tools, enum/nested/optional rendering, both
// anchored edit tools (Edit + MultiEdit) so anchor-schema/note drift changes
// bytes here too, and one long-description tool (Task) so the per-tool prose
// budget's truncation rendering is byte-locked as well.
const LONG_TASK_DESCRIPTION = [
  "Launch a new agent to handle complex, multi-step tasks autonomously. The agent runs with its own context window and returns a single final report when it completes, so give it a fully self-contained prompt with the goal, the relevant paths, the constraints, and the exact output format you expect back.",
  "Each agent invocation is stateless: it cannot ask follow-up questions, receive additional messages, or see anything outside the prompt you provide. When you need parallel research, launch several agents in one message and merge their reports yourself.",
  "Avoid using this tool when you already know which one or two files matter — direct reads are faster and cheaper. Prefer it for open-ended exploration, broad searches across an unfamiliar codebase, or work that would otherwise flood your own context with intermediate results.",
].join("\n\n");

const CANONICAL_TOOLS = [
  {
    name: "Read",
    description: "Reads a file from the local filesystem.",
    input_schema: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "Absolute path to the file" },
        offset: { type: "number" },
        limit: { type: "number" },
      },
      required: ["file_path"],
    },
  },
  {
    name: "Edit",
    description: "Performs exact string replacements in files.",
    input_schema: {
      type: "object",
      properties: {
        file_path: { type: "string" },
        old_string: { type: "string" },
        new_string: { type: "string" },
        replace_all: { type: "boolean", default: false },
      },
      required: ["file_path", "old_string", "new_string"],
    },
  },
  {
    name: "MultiEdit",
    description: "Makes multiple edits to a single file in one operation.",
    input_schema: {
      type: "object",
      properties: {
        file_path: { type: "string" },
        edits: {
          type: "array",
          items: {
            type: "object",
            properties: {
              old_string: { type: "string" },
              new_string: { type: "string" },
              replace_all: { type: "boolean", default: false },
            },
            required: ["old_string", "new_string"],
          },
        },
      },
      required: ["file_path", "edits"],
    },
  },
  {
    name: "Task",
    description: LONG_TASK_DESCRIPTION,
    input_schema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "The task for the agent to perform" },
        subagent_type: { type: "string" },
      },
      required: ["prompt", "subagent_type"],
    },
  },
  {
    name: "Bash",
    description: "Executes a bash command.",
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string" },
        timeout: { type: "number" },
        run_in_background: { type: "boolean" },
      },
      required: ["command"],
    },
  },
  {
    name: "Zeta-Search",
    description: "Search with modes.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string" },
        mode: { type: "string", enum: ["fast", "deep"] },
        filters: {
          type: "object",
          properties: {
            lang: { type: "string" },
            tags: { type: "array", items: { type: "string" } },
          },
        },
      },
      required: ["query"],
    },
  },
];

// Second fixture: the authored (uncompressed) render — what pre-caveman frozen
// sessions replay and what CAVEMAN=0 users cache. Levels are also passed
// explicitly per render so neither fixture depends on module state.
const OFF_GOLDEN_PATH = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "code-description.off.golden.txt");

function render(toolsArr, caveman = "full") {
  const session = { clientTools: new Map(), inputParsers: new Map() };
  for (const t of toolsArr) registerClientTool(session, t);
  return buildCodeToolDescription(session.clientTools, { caveman });
}

function checkGolden(rendered, path) {
  if (process.env.UPDATE_GOLDEN) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, rendered);
    return;
  }
  const golden = readFileSync(path, "utf8");
  assert.equal(
    rendered,
    golden,
    "code tool description bytes changed. This re-writes the cached prefix (2x write) of every conversation resumed inside the warm window. If deliberate, batch ALL prose/rendering/caveman-rule changes into this release and regenerate: UPDATE_GOLDEN=1 node --test test/code-description.golden.test.mjs",
  );
}

test("code description (caveman full, the default) matches the golden fixture byte-for-byte", () => {
  checkGolden(render(CANONICAL_TOOLS, "full"), GOLDEN_PATH);
});

test("code description (caveman off) matches the off golden fixture byte-for-byte", () => {
  checkGolden(render(CANONICAL_TOOLS, "off"), OFF_GOLDEN_PATH);
});

test("compression invariants: shorter, headings/signatures byte-identical, truncation pointer survives", () => {
  const off = render(CANONICAL_TOOLS, "off");
  const full = render(CANONICAL_TOOLS, "full");
  assert.ok(full.length < off.length, "compressed render must be shorter than authored render");
  // Tool headings and signature lines are protected spans / never compressed:
  // every one in the authored render must appear byte-identical in the
  // compressed render, so the model's callable surface is untouched.
  for (const line of off.split("\n")) {
    if (/^### /.test(line) || /^[A-Za-z_$][\w$-]*\(args: /.test(line)) {
      assert.ok(full.includes(line), `protected line missing from compressed render: ${line}`);
    }
  }
  for (const rendered of [off, full]) {
    assert.match(rendered, /\[truncated — full docs: codemode\.describe\("Task"\)\]/);
  }
});

test("code description is byte-stable across tool insertion order", () => {
  for (const level of ["off", "full"]) {
    assert.equal(render(CANONICAL_TOOLS, level), render([...CANONICAL_TOOLS].reverse(), level));
  }
});
