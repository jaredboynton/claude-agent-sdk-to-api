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

/** Build dynamic description for the single `code` MCP tool. */
export function buildCodeToolDescription(clientTools) {
  const entries = [...(clientTools instanceof Map ? clientTools.entries() : Object.entries(clientTools || {}))];
  const toolLines = entries.map(([name, meta]) => {
    const props = Object.keys(meta?.input_schema?.properties || {}).join(",");
    return `${name}({${props}})`;
  });
  return (
    "Run multiple client tools with one model-visible tool call. "
    + "Declare every client tool invocation in calls[] up front with unique id, tool name, and args. "
    + "The bridge executes all calls for the client in parallel, then runs script with a results object keyed by call id. "
    + "Return the final output from script — only the returned value is seen by the assistant. "
    + `Available tools: ${toolLines.join(", ") || "(none)"}`
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
