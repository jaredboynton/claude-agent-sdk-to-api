// Deterministic "caveman" prose compression for gateway-bound prompt text.
//
// Pure rule-based transform (ordered phrase dictionary + regex, no model
// calls, no dependencies) applied to prose that lands in cached prompt
// prefixes: client tool descriptions, the bridge's own `code` description
// head, and the client system append. Two invariants govern everything here:
//
// Determinism: output is a pure function of (input bytes, level,
// CAVEMAN_RULES_VERSION) — plain string ops only, no locale APIs, no
// Date/random. Same input must produce identical bytes on every machine,
// every run, or warm-cache resumes re-write their prefix at 2x.
//
// Cache coupling: compressed bytes are frozen into toolset blobs and cached
// prefixes. Any rule-table edit changes fresh-render bytes and is therefore
// a description-byte change: bump CAVEMAN_RULES_VERSION, regenerate the
// golden fixtures, and batch with other description releases.
//
// Protected spans (code fences, inline backticks, headings, URLs, paths,
// quoted literals, tags, ALL-CAPS tokens, JSON-ish lines) are masked with
// NUL-delimited placeholders before any rule runs and restored after. The
// bias is to over-protect: a missed compression costs bytes, a mangled code
// span is a bug. If the restore round-trip is ever imperfect, the ORIGINAL
// text is returned unchanged (all-or-nothing fail-safe).

export const CAVEMAN_RULES_VERSION = 1;

/** Normalize a level knob value ("full" | "lite" | "off"). */
export function normalizeCavemanLevel(v, fallback = "off") {
  if (v === undefined || v === null || v === "") return fallback;
  const s = String(v).trim().toLowerCase();
  if (s === "full" || s === "true" || s === "1" || s === "on") return "full";
  if (s === "lite" || s === "light") return "lite";
  if (s === "off" || s === "0" || s === "false" || s === "none" || s === "no") return "off";
  return fallback;
}

// Module-level levels: one bridge process serves one profile, so process-wide
// state (mirroring cache-log.mjs) is the per-profile setting. Product default
// is full; CAVEMAN=lite|0 downgrades, CAVEMAN_SYSTEM overrides the system
// append independently (unset -> inherits the tools level).
let levelTools = normalizeCavemanLevel(process.env.CAVEMAN, "full");
let levelSystem = normalizeCavemanLevel(process.env.CAVEMAN_SYSTEM, levelTools);

export function configureCaveman({ caveman, cavemanSystem } = {}) {
  levelTools = normalizeCavemanLevel(caveman ?? process.env.CAVEMAN, "full");
  levelSystem = normalizeCavemanLevel(cavemanSystem ?? process.env.CAVEMAN_SYSTEM, levelTools);
  return { tools: levelTools, system: levelSystem };
}

export function cavemanLevels() {
  return { tools: levelTools, system: levelSystem };
}

/** Compact settings fingerprint for resume-index entries; "" when fully off. */
export function cavemanTag() {
  if (levelTools === "off" && levelSystem === "off") return "";
  return `${levelTools}/${levelSystem}/v${CAVEMAN_RULES_VERSION}`;
}

// ---------------------------------------------------------------------------
// Protected spans
// ---------------------------------------------------------------------------

// One combined alternation, leftmost-first: at any position the earliest
// listed alternative wins, so masking precedence is total and deterministic.
const PROTECT_RE = new RegExp(
  [
    "```[\\s\\S]*?(?:```|(?![\\s\\S]))", // fenced code (unterminated fence -> protect to EOF; (?![\\s\\S]) is true end-of-input, since $ under the m flag stops at line ends)
    "^#{1,6}[^\\n]*$", // markdown heading lines (### Name tool headers)
    "^[ \\t]*[{}\\[\\]\"|][^\\n]*$", // JSON/schema/table-looking lines
    "`[^`\\n]*`", // inline code spans
    "https?://[^\\s<>()\"'`]+", // URLs
    "(?:~|\\.)?/(?:[\\w.@+-]+/)*[\\w.@+-]+/?", // filesystem paths
    "\"[^\"\\n]{0,200}\"", // double-quoted literals (single line)
    "'[^'\\s]{1,80}'", // single-quoted literals (no whitespace, so prose apostrophes never pair)
    "<[^>\\s][^>\\n]{0,80}>", // XML-ish tags (<env>, </system-reminder>, Array<T>)
    "\\b[A-Z][A-Z0-9_]{2,}\\b", // ALL-CAPS env/const tokens
  ].join("|"),
  "gm"
);

const PLACEHOLDER_RE = /\u0000(\d+)\u0000/g;

/** Mask protected spans with NUL-delimited indexes. Input must be NUL-free. */
export function protectSpans(text) {
  const store = [];
  const masked = text.replace(PROTECT_RE, (m) => {
    store.push(m);
    return `\u0000${store.length - 1}\u0000`;
  });
  return { masked, store };
}

/** Restore placeholders; reports how many distinct slots were consumed. */
export function restoreSpans(masked, store) {
  const consumed = new Set();
  const text = masked.replace(PLACEHOLDER_RE, (_, i) => {
    consumed.add(Number(i));
    return store[Number(i)];
  });
  return { text, consumed: consumed.size };
}

// ---------------------------------------------------------------------------
// Rule tables (authored lowercase; compiled once at module load)
// ---------------------------------------------------------------------------
//
// { find, replace }  word-bounded phrase swap, first-letter case preserved.
// { drop }           delete the phrase: sentence-initial occurrences
//                    recapitalize the following word; mid-sentence
//                    occurrences delete with their leading space. initialOnly
//                    skips the mid-sentence form (for phrases that are only
//                    safe to remove as sentence openers).
//
// Ordering is load-bearing where one phrase contains another ("make sure
// that" before "make sure"; lite's "will be able to" runs before full's
// "will be") — the hygiene test in test/caveman.test.mjs enforces it.

export const LITE_RULES = [
  { drop: "it is important to note that" },
  { drop: "it should be noted that" },
  { drop: "please note that" },
  { drop: "note that" },
  { drop: "keep in mind that" },
  { find: "due to the fact that", replace: "because" },
  { find: "because of the fact that", replace: "because" },
  { find: "in the event that", replace: "if" },
  { find: "in the case that", replace: "if" },
  { find: "in order to", replace: "to" },
  { find: "in order for", replace: "for" },
  { find: "for the purpose of", replace: "for" },
  { find: "with the exception of", replace: "except" },
  { find: "on a regular basis", replace: "regularly" },
  { find: "a large number of", replace: "many" },
  { find: "a small number of", replace: "a few" },
  { find: "a wide variety of", replace: "many" },
  { find: "a variety of", replace: "various" },
  { find: "the majority of", replace: "most of" },
  { find: "has the ability to", replace: "can" },
  { find: "have the ability to", replace: "can" },
  { find: "will be able to", replace: "can" },
  { find: "is able to", replace: "can" },
  { find: "are able to", replace: "can" },
  { find: "can be used to", replace: "can" },
  { find: "may be used to", replace: "can" },
  { find: "make sure that", replace: "ensure" },
  { find: "make sure", replace: "ensure" },
  { find: "in addition to", replace: "besides" },
  { find: "in addition,", replace: "also," },
  { find: "in conjunction with", replace: "with" },
  { find: "in combination with", replace: "with" },
  { find: "with respect to", replace: "regarding" },
  { find: "with regard to", replace: "regarding" },
  { find: "takes into account", replace: "considers" },
  { find: "taking into account", replace: "considering" },
  { find: "take into account", replace: "consider" },
  { find: "for example", replace: "e.g." },
  { find: "for instance", replace: "e.g." },
  { find: "in other words", replace: "i.e." },
  { find: "that is to say", replace: "i.e." },
  { find: "prior to", replace: "before" },
  { find: "in spite of", replace: "despite" },
  { find: "if you want to", replace: "to" },
  { find: "if you need to", replace: "to" },
  { find: "when it comes to", replace: "for" },
  { find: "utilizing", replace: "using" },
  { find: "utilizes", replace: "uses" },
  { find: "utilized", replace: "used" },
  { find: "utilize", replace: "use" },
  { find: "approximately", replace: "about" },
  { find: "in most cases", replace: "usually" },
  { find: "in many cases", replace: "often" },
  { find: "in some cases", replace: "sometimes" },
  { find: "it is recommended to", replace: "prefer to" },
  { find: "as well as", replace: "and" },
];

export const FULL_RULES = [
  { drop: "please" },
  { drop: "simply" },
  { drop: "basically" },
  { drop: "essentially" },
  { drop: "actually" },
  { drop: "really" },
  { drop: "very" },
  { drop: "extremely" },
  { drop: "definitely" },
  { drop: "certainly" },
  { drop: "obviously" },
  // Only safe as a sentence opener: mid-sentence "you should" is usually a
  // relative clause ("files you should check"), and mid-sentence "this tool"
  // is a reference, not filler.
  { drop: "you should", initialOnly: true },
  { drop: "be aware that" },
  { drop: "this tool", initialOnly: true },
  { find: "ensures that", replace: "ensures" },
  { find: "ensure that", replace: "ensure" },
  { find: "verifies that", replace: "verifies" },
  { find: "verify that", replace: "verify" },
  { find: "checks that", replace: "checks" },
  { find: "check that", replace: "check" },
  { find: "confirm that", replace: "confirm" },
  { find: "means that", replace: "means" },
  { find: "indicates that", replace: "indicates" },
  { find: "requires that", replace: "requires" },
  { find: "assumes that", replace: "assumes" },
  { find: "will not be", replace: "is not" },
  { find: "will be", replace: "is" },
  { find: "there is no need to", replace: "no need to" },
  { find: "it is not necessary to", replace: "no need to" },
  { find: "you do not need to", replace: "no need to" },
  { find: "you may want to", replace: "optionally" },
];

// ---------------------------------------------------------------------------
// Compilation
// ---------------------------------------------------------------------------

const REGEX_ESC = /[.*+?^${}()|[\]\\]/g;
const esc = (s) => s.replace(REGEX_ESC, "\\$&");

/** First letter matches either case; the rest is literal. */
function flexPhrase(p) {
  const c = p[0];
  return /[a-z]/.test(c) ? `[${c.toUpperCase()}${c}]${esc(p.slice(1))}` : esc(p);
}

function capitalized(p) {
  return esc(p[0].toUpperCase() + p.slice(1));
}

function compileReplace({ find, replace }) {
  const head = /\w/.test(find[0]) ? "\\b" : "";
  const tail = /\w/.test(find[find.length - 1]) ? "\\b" : "";
  const re = new RegExp(head + flexPhrase(find) + tail, "g");
  return (s) =>
    s.replace(re, (m) =>
      /[A-Z]/.test(m[0]) && /[a-z]/.test(replace[0] || "")
        ? replace[0].toUpperCase() + replace.slice(1)
        : replace
    );
}

function compileDrop({ drop, initialOnly = false }) {
  // Sentence-initial detection rides on the phrase's own capitalization: a
  // line-wrapped lowercase continuation ("...is\nvery fast") is left alone
  // instead of being falsely recapitalized.
  const initial = new RegExp(`(^|[.!?:]\\s+|\\n)${capitalized(drop)}[ \\t]+([a-z])`, "g");
  const mid = initialOnly ? null : new RegExp(`[ \\t]${esc(drop)}(?=[ \\t])`, "g");
  return (s) => {
    let out = s.replace(initial, (_, pre, ch) => pre + ch.toUpperCase());
    if (mid) out = out.replace(mid, "");
    return out;
  };
}

function compileTable(rules) {
  return rules.map((r) => (r.drop ? compileDrop(r) : compileReplace(r)));
}

const COMPILED_LITE = compileTable(LITE_RULES);
const COMPILED_FULL = compileTable(FULL_RULES);

// Telegraphic article dropping (full level only), after all phrase rules so
// multi-word LHS containing articles ("in the event that") match first.
// Lookaheads require a following alphanumeric word, so an article before a
// protected span ("the `code` tool" -> "the \u0000n\u0000") is kept — readable and
// idempotent by construction.
const ARTICLE_NOUN_STOP = "(?!(?:few|lot|bit|couple|little)\\b)";
const COMPILED_ARTICLES = [
  (s) => s.replace(/(^|[.!?:]\s+|\n)The ([a-z])/g, (_, pre, ch) => pre + ch.toUpperCase()),
  (s) => s.replace(/(?<=[\s([])[Tt]he (?=[A-Za-z0-9])/g, ""),
  (s) =>
    s.replace(
      new RegExp(`(^|[.!?:]\\s+|\\n)An? (${ARTICLE_NOUN_STOP}[a-z][a-z]{2,}\\b)`, "g"),
      (_, pre, word) => pre + word[0].toUpperCase() + word.slice(1)
    ),
  (s) => s.replace(new RegExp(`(?<=[\\s([])[Aa]n? (?=${ARTICLE_NOUN_STOP}[A-Za-z][a-z]{2,})`, "g"), ""),
];

// Whitespace/punctuation normalization (both levels; every rule is a fixpoint).
const COMPILED_WS = [
  (s) => s.replace(/[ \t]+$/gm, ""), // trailing spaces
  (s) => s.replace(/\n{3,}/g, "\n\n"), // repeated blank lines
  (s) => s.replace(/(\S)[ \t]{2,}/g, "$1 "), // interior runs (leading indent untouched)
  (s) => s.replace(/[ \t]+([,.;:!?])/g, "$1"), // space left behind by deletions
];

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Compress prose deterministically. Returns { text, savedBytes, level,
 * rulesVersion }. Unknown/off levels and empty input return the input
 * unchanged with savedBytes 0.
 */
export function compressProse(text, { level = "off" } = {}) {
  const original = String(text ?? "");
  const lvl = level === "full" || level === "lite" ? level : "off";
  const identity = { text: original, savedBytes: 0, level: lvl, rulesVersion: CAVEMAN_RULES_VERSION };
  if (lvl === "off" || !original) return identity;

  // Strip NUL up front: afterwards every NUL byte in the string is one of our
  // placeholders, so collision is impossible by construction.
  const { masked, store } = protectSpans(original.replace(/\u0000/g, ""));
  let out = masked;
  for (const rule of COMPILED_LITE) out = rule(out);
  if (lvl === "full") {
    for (const rule of COMPILED_FULL) out = rule(out);
    for (const rule of COMPILED_ARTICLES) out = rule(out);
  }
  for (const rule of COMPILED_WS) out = rule(out);

  const restored = restoreSpans(out, store);
  // All-or-nothing fail-safe: a placeholder that went missing (content loss)
  // or survived (mangled span) means the transform is not trustworthy for
  // this input — ship the original bytes.
  if (restored.consumed !== store.length || /\u0000/.test(restored.text)) return identity;
  return {
    text: restored.text,
    savedBytes: Buffer.byteLength(original, "utf8") - Buffer.byteLength(restored.text, "utf8"),
    level: lvl,
    rulesVersion: CAVEMAN_RULES_VERSION,
  };
}
