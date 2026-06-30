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

export const CODE_MODE_APPEND = `

<tool_use_guidance>
You have one tool, \`code\`, that runs an async JavaScript program. Inside it, call the client's tools and return a small result:

\`\`\`
const r = await tools.<Name>(args);            // any client tool listed below
const r = await tools["Some-Tool-Name"](args); // names that aren't JS identifiers
const r = await callTool(name, args);          // generic form
\`\`\`

Each call returns \`{ text, raw, isError }\`; use \`r.text\`, or \`JSON.parse(r.text)\` for JSON tools. Only the script's return value reaches you — raw tool output never enters your context.

<principle>
Favor intelligent logic and maximum parallelism. Do as much as possible in one \`code\` call: gather everything you can in parallel, then branch, loop, and aggregate in JavaScript. One \`code\` call is a single model round-trip no matter how many tools it touches, and the tool waves inside it cost nothing against your context. There is no time, wave, or call limit. Return for another \`code\` call only when you must show the user intermediate output or get their input.
</principle>

<calling_tools>
- Independent calls run together in one wave with \`await Promise.all([...])\`. Sequential \`await\`s for calls that don't depend on each other are the main thing to avoid — each is a wasted client round-trip. To survey a repo, fetch \`git status\`, \`git log\`, and \`git diff\` in one wave, not three.
- Dependent calls stay in the script: feed one call's output into the next call's args, loop over a discovered set, branch on a status, retry on failure. A dependency is a reason to write a few more lines here, not to split into another \`code\` call or model turn.
- Calls in one wave run in parallel with no ordering guarantee. Sequence steps that depend on each other's side effects (create a dir, then write into it) with separate \`await\`s.
</calling_tools>

<working_with_results>
- Process results in the script: filter, count, join, diff, extract, summarize. Return the conclusion — a verdict, a few fields, a short summary — not raw file or search contents.
- Editing: prefer the client's anchored search/replace editor (an \`old_string\`/\`new_string\`-style pair — read its signature below, don't assume a name) over rewriting whole files or lines. The #1 cause of failed edits is an \`old_string\` that doesn't byte-match the file, so COPY \`old_string\` VERBATIM from the bytes you just read (exact whitespace, indentation, and quotes) — never retype or reformat it from memory. Use the smallest snippet that is unique; if it isn't unique, extend it (add an adjacent line) rather than rewriting more, and match by content, not line numbers. Read the file and compute the exact old/new strings in the same script so its body never round-trips through you. Batch edits across different files in one wave; keep multiple edits to one file sequential. If there's no anchored editor, fall back to a write tool but still compute the content in-script from the read.
- Use the client's tools directly (outside \`code\`) only for interactive, approval, user-input, or handoff tools whose native flow matters. Use \`code\` for ordinary read/search/write/shell/validation work.
</working_with_results>

<examples>
Parallel gather, then summarize:
\`\`\`
const [status, log, diff] = await Promise.all([
  tools.Execute({ command: "git status" }),
  tools.Execute({ command: "git log --oneline -15" }),
  tools.Execute({ command: "git diff --stat" }),
]);
return { status: status.text, log: log.text, diffstat: diff.text };
\`\`\`

Dependent chain — one call's output drives the next, then fan out over the discovered set:
\`\`\`
const status = (await tools.Execute({ command: "git status --porcelain" })).text;
if (!status.trim()) return { clean: true };
const files = status.split("\\n").map(l => l.slice(3)).filter(Boolean);
const diffs = await Promise.all(files.map(f => tools.Execute({ command: \\\`git diff -- \\\${f}\\\` })));
return { changed: files.length, files: diffs.map((d, i) => ({ file: files[i], lines: d.text.split("\\n").length })) };
\`\`\`

Bounded retry/validate loop — fix and re-run in-script, no model round-trip per attempt:
\`\`\`
let out;
for (let i = 0; i < 3; i++) {
  out = JSON.parse((await tools.RunValidation({ argv: ["node", "--test"] })).text);
  if (out.exitCode === 0) break;
  await tools.Edit({ /* derive a fix from out.stderr, then loop */ });
}
return { passed: out.exitCode === 0, attempts: i + 1, stderr: out.stderr.slice(0, 400) };
\`\`\`
</examples>
</tool_use_guidance>`;

export class CodeValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "CodeValidationError";
  }
}

function toolResultText(result) {
  if (!result) return "";
  if (typeof result === "string") return result;
  if (result.text != null) return String(result.text);
  if (Array.isArray(result.content)) {
    return result.content.map((c) => (c?.type === "text" ? c.text : JSON.stringify(c))).join("\n");
  }
  return JSON.stringify(result);
}

const JS_IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function jsonLiteral(value) {
  try { return JSON.stringify(value); } catch { return "unknown"; }
}

function propertyName(name) {
  return JS_IDENT_RE.test(name) ? name : jsonLiteral(name);
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export function normalizeClientToolMeta(name, meta = {}) {
  const inputSchema = asObject(meta.input_schema);
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
  const hasDescriptions = names.some((n) => propCommentLines(props[n]).length);

  const renderProp = (name) => {
    const opt = required.has(name) ? "" : "?";
    return `${propertyName(name)}${opt}: ${jsonSchemaToTs(props[name], hasDescriptions ? indent + "  " : indent)};`;
  };

  if (hasDescriptions) {
    const inner = indent + "  ";
    const lines = ["{"];
    for (const name of names) {
      for (const dl of propCommentLines(props[name])) {
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
  const argsType = jsonSchemaToTs(normalized.input_schema || { type: "object", properties: {} });
  const desc = typeof normalized.description === "string" ? normalized.description.trim() : "";
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
    + "ALWAYS favor intelligent logic, and ALWAYS favor maximum batching and parallelism: push branching/loops/retries/aggregation into the script and run every independent operation together in one parallel wave. There is no time, wave, or call limit — one code call can do an entire task. "
    + "Prefer this for non-interactive read/search/write/shell/validation work; use original tools directly for interactive, approval, handoff, or native-UI flows. "
    + "Call tools with `await tools.<Name>(args)`, `await tools[\"Any-Name\"]`, or `await callTool(name, args)`; each returns `{ text, raw, isError }` (JSON.parse r.text when the tool returns JSON). "
    + "args MUST match the TypeScript signature for that tool below: a trailing ? marks an optional field, "
    + "\"a\" | \"b\" lists the allowed literal values, and Array<T> is an array. "
    + "Descriptions, comments, defaults, examples, formats, and patterns come from the client schema; follow them exactly. "
    + "Bake branching/loops into the script — if the next step DEPENDS on a tool's result, do NOT return to the model: feed one call's output into the next call's args, loop over a result set, branch on a status, retry on failure — all in the same script. A dependent chain is a reason to write more JavaScript, not to split into more code calls or model turns. "
    + "DEFAULT TO BATCHING: issue all independent calls in one wave with `await Promise.all([...])` (e.g. git status + git log + git diff together, not as separate awaits). Sequential `await`s for independent calls are the most common mistake. "
    + "Write real logic: loops, bounded retry/validate, fan-out+reduce, guards/early-return — not one await per script. "
    + "Edit via the client's anchored search/replace tool: read the file, copy old_string VERBATIM from the bytes you read (exact whitespace) — the top cause of failed edits is a mismatched old_string — use the smallest unique snippet, edit in the same script, and avoid full-file or whole-line rewrites. "
    + "Do not put order-dependent or side-effect-chained calls (create dir → write into it) in one wave. "
    + "Return only the conclusion — only the script's return value is seen by the assistant.\n\n"
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
        // Dispatch to the bridge; bridge fabricates client tool calls and
        // resolves with an array of { text, raw, isError } once all wave
        // results arrive. Pipe the results (or error) back to the worker.
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
        timeoutMs,
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
