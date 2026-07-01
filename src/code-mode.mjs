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

function toolAccessPath(name) {
  return JS_IDENT_RE.test(name) ? `tools.${name}` : `tools[${jsonLiteral(name)}]`;
}

export function buildCodeToolCatalog(clientTools) {
  const entries = [...(clientTools instanceof Map ? clientTools.entries() : Object.entries(clientTools || {}))];
  return entries.map(([name, meta]) => {
    const normalized = normalizeClientToolMeta(name, meta);
    const docs = describeClientTool(name, normalized);
    const summary = normalized.description.trim().split("\n").map((l) => l.trim()).filter(Boolean)[0] || `${name} tool`;
    return {
      name,
      path: toolAccessPath(name),
      summary,
      docs,
    };
  });
}

/** Build dynamic description for the single `code` MCP tool. */
export function buildCodeToolDescription(clientTools) {
  const entries = [...(clientTools instanceof Map ? clientTools.entries() : Object.entries(clientTools || {}))];
  const toolBlocks = entries.map(([name, meta]) => describeClientTool(name, meta));
  return (
    "Run a full async JavaScript program that calls the client's tools and returns a summary. "
    + "Favor intelligent logic, batching, and parallelism: every independent tool call should run in one `Promise.all` or `codemode.batch` wave. Push branching, loops, retries, and aggregation into this script instead of returning to the model between dependent steps. There is no time, wave, or call limit by default. "
    + "All client tools are available only through this script runtime; do not expect original tools outside `code`. "
    + "Runtime API: `await tools.<Name>(args)`, `await tools[\"Any-Name\"](args)`, `await callTool(name, args)`, or `await codemode.call(name, args)`. `codemode.batch([['Tool', args], ...])` starts independent calls together. `codemode.search(query)` finds matching tool docs, and `codemode.describe(nameOrPath)` returns focused TypeScript-shaped docs for one tool. "
    + "Each tool call returns a string-like `ToolResult` with `{ text, raw, isError }`, optional `.anchored`, `.json()` for JSON text, and `.lines({ trim, nonEmpty })` for line processing. Prefer `.text` for clarity, but string methods like `.includes()` and `.split()` work directly on the result. "
    + "Only batch independent calls. If B's args depend on A's result, or the calls have ordered side effects, use separate awaits. For edits, read first; use exact bytes from the read result or start_anchor/end_anchor from `.anchored` when available, and never parallelize multiple edits to the same file. "
    + "Return a compact decision-ready object: status, counts, paths with line numbers, first failing assertion or error tail, and exact snippets needed for the next step. Keep raw reads, full diffs, test logs, and large arrays inside local variables. "
    + "The signatures below are TypeScript-shaped docs only; write executable JavaScript, not TypeScript syntax. Args must match the signature: ? means optional, literal unions list allowed values, and Array<T> is an array. Schema descriptions, defaults, examples, formats, and patterns are authoritative.\n\n"
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
 * @param {{ toolNames: string[], toolDocs?: Array<{name:string,path?:string,summary?:string,docs?:string}>, dispatchWave: Function, timeoutMs?: number, maxWaves?: number, maxCalls?: number, signal?: AbortSignal }} opts
 * @returns {Promise<{ value: *, logs: string[], waves: number, calls: number }>}
 */
export function runCodeScriptDynamic(script, {
  toolNames = [],
  toolDocs = [],
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
        toolDocs,
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
