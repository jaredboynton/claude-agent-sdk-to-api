// Code mode: deterministic code({ calls, script }) meta-tool helpers.
//
// The model declares all client tool invocations upfront in calls[]; the bridge
// expands them for the client, collapses results, and runs script over a frozen
// results map. node:vm is NOT a hard security boundary — acceptable for v1 on a
// local daemon where the model is already authorized to request tool calls.

import vm from "node:vm";

const CALL_ID_RE = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
const DEFAULT_SCRIPT_TIMEOUT_MS = Number(process.env.CODE_SCRIPT_TIMEOUT_MS || 10000);

export const CODE_MODE_APPEND = `

<tool_use_guidance>
When you need multiple tools in one turn, use ONE \`code\` tool call instead of separate tool calls.
Put every client tool invocation in \`calls[]\` with a unique \`id\`, \`tool\` name, and \`args\`.
Use \`script\` only to process the \`results\` object (keyed by call id) and return your final output.
Only the script's return value is visible to you — raw tool results are not added to your context individually.
Example:
code({
  calls: [
    { id: "grep", tool: "Grep", args: { pattern: "foo", path: "/repo" } },
    { id: "files", tool: "Glob", args: { pattern: "**/*.md", folder: "/repo" } }
  ],
  script: \`return { grepLines: results.grep.text.split("\\\\n").length, files: results.files.text };\`
})
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
  const hasDescriptions = names.some((n) => typeof props[n]?.description === "string" && props[n].description.trim());

  const renderProp = (name) => {
    const opt = required.has(name) ? "" : "?";
    return `${propertyName(name)}${opt}: ${jsonSchemaToTs(props[name], hasDescriptions ? indent + "  " : indent)};`;
  };

  if (hasDescriptions) {
    const inner = indent + "  ";
    const lines = ["{"];
    for (const name of names) {
      const desc = typeof props[name]?.description === "string" ? props[name].description : "";
      for (const dl of desc.split("\n").map((l) => l.trim()).filter(Boolean)) {
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

/** Build a typed declaration block for one client tool (codex-style). */
function describeClientTool(name, meta) {
  const argsType = jsonSchemaToTs(meta?.input_schema || { type: "object", properties: {} });
  const desc = typeof meta?.description === "string" ? meta.description.trim() : "";
  const heading = `### ${name}`;
  const sig = `${name}(args: ${argsType})`;
  return desc ? `${heading}\n${desc}\n${sig}` : `${heading}\n${sig}`;
}

/** Build dynamic description for the single `code` MCP tool. */
export function buildCodeToolDescription(clientTools) {
  const entries = [...(clientTools instanceof Map ? clientTools.entries() : Object.entries(clientTools || {}))];
  const toolBlocks = entries.map(([name, meta]) => describeClientTool(name, meta));
  return (
    "Run multiple client tools with one model-visible tool call. "
    + "Declare every client tool invocation in calls[] up front, each as { id, tool, args }. "
    + "args MUST match the TypeScript signature for that tool below: a trailing ? marks an optional field, "
    + "\"a\" | \"b\" lists the allowed literal values, and Array<T> is an array. "
    + "The bridge executes all calls for the client in parallel, then runs script with a results object keyed by call id. "
    + "Return only the data you actually need from script — do not dump full file or search contents — "
    + "since only the script's return value is seen by the assistant.\n\n"
    + (toolBlocks.length ? `Available tools:\n\n${toolBlocks.join("\n\n")}` : "Available tools: (none)")
  );
}

/**
 * Validate code({ calls, script }) and normalize call args through client schemas.
 * @param {object} input - raw code tool input
 * @param {Map|object} clientTools - name -> { description, input_schema }
 * @param {{ toolInputShape: Function, z: object }} deps
 * @returns {{ script: string, calls: Array<{ id, tool, args, syntheticArgs }> }}
 */
export function validateCodeInput(input, clientTools, { toolInputShape, z }) {
  if (!input || typeof input !== "object") throw new CodeValidationError("code input must be an object");
  const { calls, script } = input;
  if (typeof script !== "string" || !script.trim()) {
    throw new CodeValidationError("code input requires a non-empty script string");
  }
  if (!Array.isArray(calls)) throw new CodeValidationError("code input requires calls[] array");

  const toolsMap = clientTools instanceof Map ? clientTools : new Map(Object.entries(clientTools || {}));
  const parsers = new Map();
  for (const [name, meta] of toolsMap) {
    try {
      const shape = toolInputShape(meta?.input_schema || { type: "object", properties: {} });
      parsers.set(name, z.object(shape));
    } catch {
      parsers.set(name, null);
    }
  }

  const seenIds = new Set();
  const normalized = [];
  for (let i = 0; i < calls.length; i++) {
    const c = calls[i];
    if (!c || typeof c !== "object") throw new CodeValidationError(`calls[${i}] must be an object`);
    const { id, tool, args } = c;
    if (typeof id !== "string" || !CALL_ID_RE.test(id)) {
      throw new CodeValidationError(`calls[${i}].id must match ${CALL_ID_RE}`);
    }
    if (seenIds.has(id)) throw new CodeValidationError(`duplicate call id: ${id}`);
    seenIds.add(id);
    if (typeof tool !== "string" || !toolsMap.has(tool)) {
      throw new CodeValidationError(`calls[${i}].tool unknown or missing: ${String(tool)}`);
    }
    const rawArgs = args && typeof args === "object" && !Array.isArray(args) ? args : {};
    const parser = parsers.get(tool);
    let syntheticArgs = rawArgs;
    if (parser) {
      const r = parser.safeParse(rawArgs);
      if (!r.success) {
        throw new CodeValidationError(`calls[${i}].args invalid for ${tool}: ${r.error.message}`);
      }
      syntheticArgs = r.data;
    }
    normalized.push({ id, tool, args: syntheticArgs });
  }

  return { script, calls: normalized };
}

/** Convert script return value (+ optional captured logs) to MCP CallToolResult text. */
export function formatCodeResult(value, logs = []) {
  let text;
  if (value === undefined || value === null) text = "";
  else if (typeof value === "string") text = value;
  else text = JSON.stringify(value, null, 2);
  const logText = (logs || []).filter(Boolean).join("\n");
  if (logText) text = text ? `${text}\n\n[console]\n${logText}` : `[console]\n${logText}`;
  return { content: [{ type: "text", text }] };
}

/**
 * Run the model's script in a sandbox over frozen calls/results.
 * @returns {Promise<{ value: *, logs: string[] }>}
 */
export function runCodeScript(script, { calls = [], results = {}, timeoutMs = DEFAULT_SCRIPT_TIMEOUT_MS } = {}) {
  const logs = [];
  const sandboxConsole = {
    log: (...a) => logs.push(a.map(String).join(" ")),
    warn: (...a) => logs.push(`[warn] ${a.map(String).join(" ")}`),
    error: (...a) => logs.push(`[error] ${a.map(String).join(" ")}`),
  };

  const frozenCalls = Object.freeze(structuredClone(calls));
  const frozenResults = Object.freeze(
    Object.fromEntries(
      Object.entries(results).map(([k, v]) => [k, Object.freeze({ text: toolResultText(v), raw: v })]),
    ),
  );

  const deny = (key) => {
    const err = () => { throw new Error(`access to ${key} is denied in code mode scripts`); };
    return err;
  };

  const context = vm.createContext({
    calls: frozenCalls,
    results: frozenResults,
    JSON,
    Math,
    console: sandboxConsole,
    text: (x) => toolResultText(x?.raw ?? x),
    json: (x) => {
      const t = toolResultText(x?.raw ?? x);
      try { return JSON.parse(t); } catch { return t; }
    },
    require: deny("require"),
    process: { exit: deny("process.exit"), env: Object.freeze({}) },
    globalThis: Object.freeze({}),
    global: Object.freeze({}),
    Buffer: deny("Buffer"),
    fetch: deny("fetch"),
    setTimeout: deny("setTimeout"),
    setInterval: deny("setInterval"),
  });

  const wrapped = `(async () => { ${script} })()`;
  const scriptObj = new vm.Script(wrapped, { filename: "code-mode-script.vm" });

  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`code script did not complete within ${timeoutMs}ms`);
      err.code = "code_script_timeout";
      reject(err);
    }, timeoutMs);
  });

  const run = (async () => {
    const out = scriptObj.runInContext(context, { timeout: timeoutMs });
    return out instanceof Promise ? await out : out;
  })();

  return Promise.race([run, timeout])
    .then((value) => ({ value, logs }))
    .finally(() => clearTimeout(timer));
}

/** Zod raw shape for the code tool's input_schema (used by buildParkingMcpServer). */
export function codeToolInputShape(z) {
  return {
    calls: z.array(z.object({
      id: z.string(),
      tool: z.string(),
      args: z.record(z.string(), z.unknown()).optional(),
    })),
    script: z.string(),
  };
}
