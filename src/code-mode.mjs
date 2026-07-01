// Code mode: dynamic `code({ script })` meta-tool helpers.
//
// The model writes one async script that calls client tools via
// `await tools.<Name>(args)` / `await callTool(name, args)`. The bridge runs the
// script inside a Worker-contained VM; each awaited tool call becomes a wave of
// synthetic client tool_use blocks. The SDK stays parked on the single `code`
// MCP handler the whole time, so a K-step dependent tool chain collapses from
// K model round-trips to 1.
//
// node:vm is NOT a hard security boundary — acceptable for v1 on a local daemon
// where the model is already authorized to request tool calls. The Worker lets
// the parent enforce wall-clock time and terminate, since vm timeout does not
// bound async continuations after an await.

import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// No execution caps by default: a code script may run as long as it needs and
// make as many tool waves/calls as it needs. The parked `code` MCP handler and
// the bridge's own session lifecycle are the real backstops. Set the env vars
// to a positive number only if you explicitly want a ceiling.
const DEFAULT_SCRIPT_TIMEOUT_MS = Number(process.env.CODE_SCRIPT_TIMEOUT_MS || 0);
const DEFAULT_MAX_WAVES = Number(process.env.CODE_MAX_WAVES || 0);
const DEFAULT_MAX_CALLS = Number(process.env.CODE_MAX_CALLS || 0);
const DEFAULT_SCRIPT_OUTPUT_MAX_BYTES = Number(process.env.CODE_SCRIPT_MAX_OUTPUT_BYTES || 0); // 0 = no cap

const WORKER_PATH = join(dirname(fileURLToPath(import.meta.url)), "code-mode-worker.mjs");

export class CodeValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "CodeValidationError";
  }
}

const JS_IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function jsonLiteral(value) {
  try { return JSON.stringify(value); } catch { return "unknown"; }
}

function propertyName(name) {
  return JS_IDENT_RE.test(name) ? name : jsonLiteral(name);
}

export function normalizeClientToolMeta(_name, meta = {}) {
  const raw = meta.input_schema;
  const inputSchema = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  return {
    description: typeof meta.description === "string" ? meta.description : "",
    input_schema: Object.keys(inputSchema).length ? inputSchema : { type: "object", properties: {} },
  };
}

/**
 * Render a JSON Schema into a TypeScript type string. Ported from codex's
 * code-mode description renderer: handles const/enum/anyOf/oneOf/allOf, type
 * unions, arrays, nested objects, and property-level description comments.
 */
function jsonSchemaToTs(schema, indent = "") {
  if (schema === true || schema == null) return "unknown";
  if (schema === false) return "never";
  if (typeof schema !== "object") return "unknown";

  if ("const" in schema) return jsonLiteral(schema.const);

  if (Array.isArray(schema.enum) && schema.enum.length) {
    return schema.enum.map(jsonLiteral).join(" | ");
  }

  for (const key of ["anyOf", "oneOf"]) {
    if (Array.isArray(schema[key]) && schema[key].length) {
      return schema[key].map((s) => jsonSchemaToTs(s, indent)).join(" | ");
    }
  }
  if (Array.isArray(schema.allOf) && schema.allOf.length) {
    return schema.allOf.map((s) => jsonSchemaToTs(s, indent)).join(" & ");
  }

  const t = schema.type;
  if (Array.isArray(t)) {
    return t.map((tt) => renderTypeKeyword(schema, tt, indent)).join(" | ");
  }
  if (typeof t === "string") return renderTypeKeyword(schema, t, indent);

  if ("properties" in schema || "additionalProperties" in schema || "required" in schema) {
    return renderObject(schema, indent);
  }
  if ("items" in schema || "prefixItems" in schema) return renderArray(schema, indent);
  return "unknown";
}

function renderTypeKeyword(schema, t, indent) {
  switch (t) {
    case "string": return "string";
    case "number": case "integer": return "number";
    case "boolean": return "boolean";
    case "null": return "null";
    case "array": return renderArray(schema, indent);
    case "object": return renderObject(schema, indent);
    default: return "unknown";
  }
}

function renderArray(schema, indent) {
  if (schema.items != null) return `Array<${jsonSchemaToTs(schema.items, indent)}>`;
  if (Array.isArray(schema.prefixItems) && schema.prefixItems.length) {
    return `[${schema.prefixItems.map((s) => jsonSchemaToTs(s, indent)).join(", ")}]`;
  }
  return "unknown[]";
}

function renderObject(schema, indent) {
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  const props = schema.properties && typeof schema.properties === "object" ? schema.properties : {};
  const names = Object.keys(props).sort();
  const propComments = new Map(names.map((n) => [n, propCommentLines(props[n])]));
  const hasDescriptions = names.some((n) => propComments.get(n).length);

  const renderProp = (name) => {
    const opt = required.has(name) ? "" : "?";
    return `${propertyName(name)}${opt}: ${jsonSchemaToTs(props[name], hasDescriptions ? indent + "  " : indent)};`;
  };

  if (hasDescriptions) {
    const inner = indent + "  ";
    const lines = ["{"];
    for (const name of names) {
      for (const dl of propComments.get(name)) {
        lines.push(`${inner}// ${dl}`);
      }
      lines.push(`${inner}${renderProp(name)}`);
    }
    if (schema.additionalProperties === true) lines.push(`${inner}[key: string]: unknown;`);
    lines.push(`${indent}}`);
    return lines.join("\n");
  }

  const parts = names.map(renderProp);
  if (schema.additionalProperties === true) parts.push("[key: string]: unknown;");
  return parts.length ? `{ ${parts.join(" ")} }` : "{}";
}

function propCommentLines(schema) {
  if (!schema || typeof schema !== "object") return [];
  const lines = [];
  if (typeof schema.description === "string") {
    lines.push(...schema.description.split("\n").map((l) => l.trim()).filter(Boolean));
  }
  if ("default" in schema) lines.push(`Default: ${jsonLiteral(schema.default)}`);
  if (Array.isArray(schema.examples) && schema.examples.length) {
    lines.push(`Examples: ${schema.examples.map(jsonLiteral).join(", ")}`);
  }
  if (typeof schema.format === "string") lines.push(`Format: ${schema.format}`);
  if (typeof schema.pattern === "string") lines.push(`Pattern: ${schema.pattern}`);
  for (const [key, label] of [
    ["minimum", "Minimum"],
    ["maximum", "Maximum"],
    ["exclusiveMinimum", "Exclusive minimum"],
    ["exclusiveMaximum", "Exclusive maximum"],
    ["minLength", "Minimum length"],
    ["maxLength", "Maximum length"],
    ["minItems", "Minimum items"],
    ["maxItems", "Maximum items"],
  ]) {
    if (schema[key] != null) lines.push(`${label}: ${schema[key]}`);
  }
  return lines;
}

/** Build a typed declaration block for one client tool (codex-style). */
function describeClientTool(name, meta) {
  const normalized = normalizeClientToolMeta(name, meta);
  const argsType = jsonSchemaToTs(normalized.input_schema);
  const desc = normalized.description.trim();
  const heading = `### ${name}`;
  const sig = `${name}(args: ${argsType})`;
  return desc ? `${heading}\n${desc}\n${sig}` : `${heading}\n${sig}`;
}

/** Build dynamic description for the single `code` MCP tool. */
export function buildCodeToolDescription(clientTools) {
  const entries = [...(clientTools instanceof Map ? clientTools.entries() : Object.entries(clientTools || {}))];
  const toolBlocks = entries.map(([name, meta]) => describeClientTool(name, meta));
  return (
    "Run a full async JavaScript program that calls the client's tools and returns a summary. "
    + "ALWAYS favor intelligent logic, and ALWAYS favor maximum batching and parallelism ALL the time: every independent tool call goes in one `Promise.all` wave, every time — no exceptions. Drive every call through the script's tool call functions (`tools.<Name>(args)`, `callTool(name, args)`) and wrap independent calls in `Promise.all`. Push branching/loops/retries/aggregation into the script. There is no time, wave, or call limit — one code call can do an entire task. "
    + "All client tools are available only through this script runtime; do not expect original tools outside `code`. "
    + "Call tools with `await tools.<Name>(args)`, `await tools[\"Any-Name\"]`, or `await callTool(name, args)`; each returns `{ text, raw, isError }` (JSON.parse r.text when the tool returns JSON). "
    + "The signatures below are TypeScript-shaped docs only; write executable JavaScript, not TypeScript syntax (no type annotations, interfaces, or generics). "
    + "args MUST match the TypeScript signature for that tool below: a trailing ? marks an optional field, "
    + "\"a\" | \"b\" lists the allowed literal values, and Array<T> is an array. "
    + "Descriptions, comments, defaults, examples, formats, and patterns come from the client schema; follow them exactly. "
    + "Bake branching/loops into the script — if the next step DEPENDS on a tool's result, do NOT return to the model: feed one call's output into the next call's args, loop over a result set, branch on a status, retry on failure — all in the same script. A dependent chain is a reason to write more JavaScript, not to split into more code calls or model turns. "
    + "DECISION RULE: before each wave, list all calls needed; batch every pair where you can write B's args before A returns into one `await Promise.all([...])`. "
    + "Read-only commands and tools (file reads, grep/glob/search, `git status`, `git diff`, `gh release view`, validation/tests that do not depend on an earlier mutation) with no cross-deps → always one wave. Sequential `await`s for independent reads are the top mistake. "
    + "Only batch calls that are independent: if one call's args depend on another's result, or calls have ordering side-effects (`git fetch` → `git log origin/main..HEAD`; create dir → write into it; `git add` → `git commit`), sequence them with separate `await`s. "
    + "Write real logic: loops, bounded retry/validate, fan-out+reduce, guards/early-return — not one await per script. "
    + "Edit via the client's anchored search/replace tool: read the file, then either copy old_string VERBATIM from the bytes you read (exact whitespace) or, if the tool offers start_anchor/end_anchor and your read result has an .anchored view, point at those anchors instead — the top cause of failed edits is a mismatched old_string — use the smallest unique snippet, edit in the same script, and avoid full-file or whole-line rewrites. One file with many changes: prefer a single MultiEdit, else await edits to that path one at a time (never two edits to the same file in one parallel wave); different files edit in parallel. "
    + "Do not put order-dependent or side-effect-chained calls (create dir → write into it) in one wave. "
    + "OUTPUT MECHANICS: raw tool results are for the script only; the assistant sees only your final return. Keep bulky data in variables and return a small, decision-ready object: verdict/status, counts, paths with line numbers, first failing assertion or error tail, and only the exact snippets needed for the answer or next edit. Do not return raw Read/file contents, full diffs, full test logs, or large JSON arrays. Filter/map/reduce inside JavaScript; for large result sets return totals plus the top matches/failures and enough context to act. "
    + "Return only the conclusion — the verdict/summary/fields; intermediate results stay inside the script and only the script's return value is seen by the assistant. "
    + "Ex — dependent chain (one call's output drives the next, then fan out over the discovered set): "
    + "const status = (await tools.Execute({ command: \"git status --porcelain\" })).text; "
    + "if (!status.trim()) return { clean: true }; "
    + "const files = status.split(\"\\n\").map(l => l.slice(3)).filter(Boolean); "
    + "const diffs = await Promise.all(files.map(f => tools.Execute({ command: `git diff -- ${f}` }))); "
    + "return { changed: files.length, files: diffs.map((d, i) => ({ file: files[i], lines: d.text.split(\"\\n\").length })) }; "
    + "Ex — bounded retry/validate loop (fix and re-run in-script, no model round-trip per attempt): "
    + "let out; for (let i = 0; i < 3; i++) { out = JSON.parse((await tools.RunValidation({ argv: [\"node\", \"--test\"] })).text); if (out.exitCode === 0) break; await tools.Edit({ /* derive a fix from out.stderr, then loop */ }); } "
    + "return { passed: out.exitCode === 0, attempts: i + 1, stderr: out.stderr.slice(0, 400) }.\n\n"
    + (toolBlocks.length ? `Available tools:\n\n${toolBlocks.join("\n\n")}` : "Available tools: (none)")
  );
}

/**
 * Validate `code({ script })`. Tool args are validated at call time, not here.
 */
export function validateCodeInput(input) {
  if (!input || typeof input !== "object") throw new CodeValidationError("code input must be an object");
  const { script } = input;
  if (typeof script !== "string" || !script.trim()) {
    throw new CodeValidationError("code input requires a non-empty script string");
  }
  return { script };
}

/** Convert script return value (+ optional captured logs) to MCP CallToolResult text. */
export function formatCodeResult(value, logs = [], { maxBytes = DEFAULT_SCRIPT_OUTPUT_MAX_BYTES } = {}) {
  let text;
  if (value === undefined || value === null) text = "";
  else if (typeof value === "string") text = value;
  else text = JSON.stringify(value, null, 2);
  const logText = (logs || []).filter(Boolean).join("\n");
  if (logText) text = text ? `${text}\n\n[console]\n${logText}` : `[console]\n${logText}`;
  if (maxBytes > 0 && Buffer.byteLength(text, "utf8") > maxBytes) {
    return {
      content: [{ type: "text", text: `code script output exceeded ${maxBytes} bytes; return a smaller summary instead of raw tool output` }],
      isError: true,
    };
  }
  return { content: [{ type: "text", text }] };
}

/**
 * Run the model's script in a Worker-contained VM. `dispatchWave(batch)` is
 * called for each await wave; it must return an array of `{ text, raw, isError }`
 * results in the same order as `batch` (or throw / return an `{ error }` shape
 * which rejects the wave's calls).
 *
 * @param {string} script
 * @param {{ toolNames: string[], dispatchWave: Function, timeoutMs?: number, maxWaves?: number, maxCalls?: number, signal?: AbortSignal }} opts
 * @returns {Promise<{ value: *, logs: string[], waves: number, calls: number }>}
 */
export function runCodeScriptDynamic(script, {
  toolNames = [],
  dispatchWave,
  timeoutMs = DEFAULT_SCRIPT_TIMEOUT_MS,
  maxWaves = DEFAULT_MAX_WAVES,
  maxCalls = DEFAULT_MAX_CALLS,
  signal,
} = {}) {
  return new Promise((resolve, reject) => {
    let worker;
    let settled = false;
    let timer;

    const cleanup = () => {
      if (timer) { clearTimeout(timer); timer = null; }
      if (worker) {
        try { worker.removeAllListeners(); } catch {}
        try { worker.terminate(); } catch {}
        worker = null;
      }
    };

    const finish = (result) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    const fail = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    if (signal?.aborted) {
      reject(new Error("code script aborted before start"));
      return;
    }

    try {
      worker = new Worker(WORKER_PATH);
    } catch (e) {
      reject(new Error(`failed to start code worker: ${e?.message || e}`));
      return;
    }

    worker.on("message", async (msg) => {
      if (!msg || typeof msg !== "object") return;
      if (msg.type === "wave") {
        try {
          const results = await dispatchWave(msg.wave, msg.calls || []);
          if (settled) return;
          let payload;
          if (results && results.error) {
            payload = { type: "wave_result", wave: msg.wave, error: results.error };
          } else if (Array.isArray(results)) {
            payload = { type: "wave_result", wave: msg.wave, results };
          } else {
            payload = { type: "wave_result", wave: msg.wave, error: "dispatchWave returned non-array" };
          }
          try { worker?.postMessage(payload); } catch {}
        } catch (err) {
          if (settled) return;
          try {
            worker?.postMessage({ type: "wave_result", wave: msg.wave, error: err?.message || String(err) });
          } catch {}
        }
        return;
      }
      if (msg.type === "done") {
        if (msg.error) {
          finish({
            value: null,
            error: msg.error,
            logs: msg.logs || [],
            waves: msg.waves || 0,
            calls: msg.calls || 0,
          });
        } else {
          finish({
            value: msg.value,
            logs: msg.logs || [],
            waves: msg.waves || 0,
            calls: msg.calls || 0,
          });
        }
      }
    });

    worker.on("error", (err) => {
      fail(new Error(`code worker error: ${err?.message || err}`));
    });

    worker.on("exit", (code) => {
      if (!settled) {
        fail(new Error(`code worker exited unexpectedly (code=${code})`));
      }
    });

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        if (settled) return;
        // Give the worker a brief grace period, then terminate and resolve.
        setTimeout(() => {
          if (!settled) {
            settled = true;
            cleanup();
            resolve({
              value: null,
              error: `code script did not complete within ${timeoutMs}ms`,
              logs: [],
              waves: 0,
              calls: 0,
              timedOut: true,
            });
          }
        }, 250);
      }, timeoutMs);
    }

    if (signal) {
      signal.addEventListener("abort", () => {
        if (settled) return;
        fail(new Error("code script aborted"));
      }, { once: true });
    }

    try {
      worker.postMessage({
        type: "run",
        script,
        toolNames,
        maxWaves,
        maxCalls,
      });
    } catch (e) {
      fail(new Error(`failed to post run to worker: ${e?.message || e}`));
    }
  });
}

/** Zod raw shape for the code tool's input_schema (used by buildParkingMcpServer). */
export function codeToolInputShape(z) {
  return {
    script: z.string(),
  };
}
