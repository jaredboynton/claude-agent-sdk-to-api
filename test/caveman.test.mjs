// Unit tests for src/caveman.mjs — deterministic prose compression.
// Run: node --test test/caveman.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CAVEMAN_RULES_VERSION,
  normalizeCavemanLevel,
  configureCaveman,
  cavemanLevels,
  cavemanTag,
  compressProse,
  protectSpans,
  restoreSpans,
  LITE_RULES,
  FULL_RULES,
} from "../src/caveman.mjs";

const lite = (s) => compressProse(s, { level: "lite" }).text;
const full = (s) => compressProse(s, { level: "full" }).text;

// ---------------------------------------------------------------------------
// Level normalization + module state
// ---------------------------------------------------------------------------

test("normalizeCavemanLevel maps aliases and falls back", () => {
  assert.equal(normalizeCavemanLevel(undefined, "full"), "full");
  assert.equal(normalizeCavemanLevel("", "lite"), "lite");
  assert.equal(normalizeCavemanLevel("full"), "full");
  assert.equal(normalizeCavemanLevel(true), "full");
  assert.equal(normalizeCavemanLevel("1"), "full");
  assert.equal(normalizeCavemanLevel("lite"), "lite");
  assert.equal(normalizeCavemanLevel("0"), "off");
  assert.equal(normalizeCavemanLevel("off"), "off");
  assert.equal(normalizeCavemanLevel(false), "off");
  assert.equal(normalizeCavemanLevel("junk", "lite"), "lite");
});

test("configureCaveman sets levels; system inherits tools level unless overridden", () => {
  const prev = cavemanLevels();
  try {
    assert.deepEqual(configureCaveman({ caveman: "lite", cavemanSystem: null }), { tools: "lite", system: "lite" });
    assert.deepEqual(configureCaveman({ caveman: "full", cavemanSystem: "off" }), { tools: "full", system: "off" });
    assert.equal(cavemanTag(), `full/off/v${CAVEMAN_RULES_VERSION}`);
    configureCaveman({ caveman: "off", cavemanSystem: "off" });
    assert.equal(cavemanTag(), "");
  } finally {
    configureCaveman({ caveman: prev.tools, cavemanSystem: prev.system });
  }
});

// ---------------------------------------------------------------------------
// Lite rules
// ---------------------------------------------------------------------------

test("lite: phrase replacements", () => {
  assert.equal(lite("Run this in order to verify."), "Run this to verify.");
  assert.equal(lite("It fails due to the fact that the port is busy."), "It fails because the port is busy.");
  assert.equal(lite("This can be used to search files."), "This can search files.");
  assert.equal(lite("The runner is able to retry."), "The runner can retry.");
  assert.equal(lite("for example, batch the calls"), "e.g., batch the calls");
  assert.equal(lite("Set a flag, in other words a marker."), "Set a flag, i.e. a marker.");
  assert.equal(lite("Run it prior to committing."), "Run it before committing.");
  assert.equal(lite("Utilize the cache. It utilizes memory."), "Use the cache. It uses memory.");
  assert.equal(lite("make sure that the file exists"), "ensure the file exists");
  assert.equal(lite("as well as the tests"), "and the tests");
  assert.equal(lite("in most cases this works"), "usually this works");
});

test("lite: drops with sentence-initial recapitalization", () => {
  assert.equal(lite("Note that the cap applies."), "The cap applies.");
  assert.equal(lite("Please note that retries are free."), "Retries are free.");
  assert.equal(lite("It is important to note that order matters."), "Order matters.");
  // Mid-sentence drop keeps the sentence flowing.
  assert.equal(lite("Batch calls, and note that order matters."), "Batch calls, and order matters.");
});

test("lite: case is preserved on replacements", () => {
  assert.equal(lite("In order to run it, retry."), "To run it, retry.");
  assert.equal(lite("For example, use batch."), "E.g., use batch.");
});

test("lite: chained rewrites converge in one pass", () => {
  // "is able to" -> "can", creating "can be used to" which a later rule folds.
  assert.equal(lite("It is able to be used to search."), "It can search.");
});

test("lite: whitespace normalization", () => {
  assert.equal(lite("a  b   c"), "a b c");
  assert.equal(lite("line one   \nline two"), "line one\nline two");
  assert.equal(lite("para\n\n\n\npara"), "para\n\npara");
  // Leading indentation is untouched (markdown lists survive).
  assert.equal(lite("- item\n    nested  x"), "- item\n    nested x");
});

// ---------------------------------------------------------------------------
// Full rules
// ---------------------------------------------------------------------------

test("full: filler drops", () => {
  assert.equal(full("Please run the tests."), "Run tests.");
  assert.equal(full("It is really quite simple, actually fast."), "It is quite simple, fast.");
  assert.equal(full("You should run the linter."), "Run linter.");
  // Mid-sentence "you should" is a relative clause — must survive.
  assert.equal(full("files you should check"), "files you should check");
  assert.equal(full("This tool searches files."), "Searches files.");
  // Mid-sentence "this tool" is a reference — must survive.
  assert.equal(full("Results from this tool are cached."), "Results from this tool are cached.");
});

test("full: complementizer-that and auxiliaries", () => {
  assert.equal(full("Verify that it compiles."), "Verify it compiles.");
  assert.equal(full("It requires that both exist."), "It requires both exist.");
  assert.equal(full("Output will be truncated."), "Output is truncated.");
  assert.equal(full("It will not be retried."), "It is not retried.");
  assert.equal(full("You may want to retry."), "Optionally retry.");
  assert.equal(full("There is no need to re-read it."), "No need to re-read it.");
});

test("full: article dropping with recapitalization", () => {
  assert.equal(full("The file is read in windows."), "File is read in windows.");
  assert.equal(full("Read the file and the index."), "Read file and index.");
  assert.equal(full("A pattern matches many files."), "Pattern matches many files.");
  assert.equal(full("Pass an object with keys."), "Pass object with keys.");
});

test("full: article edge cases are preserved", () => {
  assert.equal(full("Wait a bit and retry a few times."), "Wait a bit and retry a few times.");
  assert.equal(full("option a is faster than option b"), "option a is faster than option b");
  // Article before a protected span is kept (lookahead needs a word char).
  assert.equal(full("Pass the `path` argument."), "Pass the `path` argument.");
});

// ---------------------------------------------------------------------------
// Protected spans
// ---------------------------------------------------------------------------

test("protection: every span class survives byte-identical", () => {
  const spans = [
    "```js\nconst x = 1;  // in order to keep\n```",
    "### ToolName",
    '{ "in order to": true }',
    "`in order to stay`",
    "https://example.com/in-order-to?x=1",
    "/tmp/in.order.to/file.txt",
    '"make sure that this stays"',
    "'utf-8'",
    "<system-reminder>",
    "CACHE_LOG_PATH",
  ];
  for (const span of spans) {
    const text = `Filler in order to test. ${span}\nMore filler, for example this.`;
    const out = full(text);
    assert.ok(out.includes(span), `span mangled at full level: ${JSON.stringify(span)} -> ${JSON.stringify(out)}`);
    assert.ok(out.includes("to test"), "prose around the span should still compress");
  }
});

test("protection: text made only of protected spans round-trips byte-for-byte", () => {
  const text = "```sh\nmake sure that x  y\n```";
  assert.equal(full(text), text);
  const heading = "## In order to (a heading)";
  assert.equal(full(heading), heading);
});

test("protection: unterminated fence protects to end of input", () => {
  const text = "prose in order to compress\n```js\nconst a = 1; // note that this stays";
  const out = full(text);
  assert.ok(out.includes("const a = 1; // note that this stays"));
  assert.ok(out.startsWith("prose to compress"));
});

test("protectSpans/restoreSpans round-trip accounting", () => {
  const { masked, store } = protectSpans("a `b` and `c`");
  assert.equal(store.length, 2);
  assert.ok(!masked.includes("`"));
  const restored = restoreSpans(masked, store);
  assert.equal(restored.text, "a `b` and `c`");
  assert.equal(restored.consumed, 2);
  // A destroyed placeholder is observable as consumed < store.length.
  assert.equal(restoreSpans("no placeholders here", ["x"]).consumed, 0);
});

// ---------------------------------------------------------------------------
// Determinism, idempotence, hygiene
// ---------------------------------------------------------------------------

const CORPUS = [
  [
    "Launch a new agent to handle complex, multi-step tasks autonomously. The agent runs with its own",
    "context window and returns a single final report when it completes, so give it a fully",
    "self-contained prompt. Note that each agent invocation is stateless: it cannot ask follow-up",
    "questions. In order to run parallel research, launch several agents in one message. Avoid using",
    "this tool when you already know which one or two files matter — direct reads are faster. You",
    "should prefer it for open-ended exploration, for example broad searches across an unfamiliar",
    "codebase. Make sure that you merge their reports yourself, as well as the citations.",
  ].join(" "),
  [
    "<env>",
    "Working directory: /Users/dev/project",
    "Platform: darwin",
    "</env>",
    "",
    "IMPORTANT: you should always read `CLAUDE.md` first. It is important to note that the settings",
    "in \"local scope\" take precedence. For example:",
    "",
    "```json",
    '{ "permissions": { "allow": ["Bash(npm test)"] } }',
    "```",
    "",
    "In the event that a hook fails, check https://docs.example.com/hooks and retry. In most cases",
    "the failure is due to the fact that the profile dir moved. There is no need to re-install.",
  ].join("\n"),
  "Reads a file from the local filesystem. The file_path must be absolute. In order to read a range, pass offset and limit.",
  "e.g. already-compressed text stays. Can search files. No need to re-read it.",
];

test("determinism: identical bytes across calls", () => {
  for (const text of CORPUS) {
    assert.equal(full(text), full(text));
    assert.equal(lite(text), lite(text));
  }
});

test("idempotence: compress(compress(x)) === compress(x)", () => {
  for (const text of CORPUS) {
    const once = full(text);
    assert.equal(full(once), once, `full not idempotent for: ${text.slice(0, 60)}...`);
    const onceLite = lite(text);
    assert.equal(lite(onceLite), onceLite, `lite not idempotent for: ${text.slice(0, 60)}...`);
  }
});

test("hygiene: no rule LHS contains NUL; every RHS is a fixpoint", () => {
  for (const r of [...LITE_RULES, ...FULL_RULES]) {
    const phrase = r.drop ?? r.find;
    assert.ok(!phrase.includes("\u0000"), `NUL in rule LHS: ${phrase}`);
    if (r.replace) {
      assert.equal(full(r.replace), r.replace, `RHS not a fixpoint at full: ${r.replace}`);
    }
  }
});

test("hygiene: within the applied order, no earlier phrase is a substring of a later one", () => {
  const phrases = [...LITE_RULES, ...FULL_RULES].map((r) => r.drop ?? r.find);
  for (let i = 0; i < phrases.length; i++) {
    for (let j = i + 1; j < phrases.length; j++) {
      assert.ok(
        !phrases[j].includes(phrases[i]),
        `rule "${phrases[i]}" (earlier) is a substring of "${phrases[j]}" (later); longer phrases must run first`
      );
    }
  }
});

// ---------------------------------------------------------------------------
// Contract details
// ---------------------------------------------------------------------------

test("savedBytes matches the byte delta; off level is identity", () => {
  const text = "Run this in order to verify the outcome.";
  const r = compressProse(text, { level: "lite" });
  assert.equal(r.savedBytes, Buffer.byteLength(text) - Buffer.byteLength(r.text));
  assert.ok(r.savedBytes > 0);
  assert.equal(r.rulesVersion, CAVEMAN_RULES_VERSION);

  const off = compressProse(text, { level: "off" });
  assert.equal(off.text, text);
  assert.equal(off.savedBytes, 0);
  const unknown = compressProse(text, { level: "mystery" });
  assert.equal(unknown.text, text);
});

test("empty and NUL-bearing input is handled deterministically", () => {
  assert.equal(compressProse("", { level: "full" }).text, "");
  assert.equal(compressProse(null, { level: "full" }).text, "");
  const withNul = "in order to\u0000 test";
  const r1 = compressProse(withNul, { level: "full" });
  const r2 = compressProse(withNul, { level: "full" });
  assert.equal(r1.text, r2.text);
  assert.ok(!r1.text.includes("\u0000") || r1.text === withNul);
});
