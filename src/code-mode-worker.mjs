// Worker-side code-mode sandbox. Loaded inside a Worker so the parent stays
// responsive while a model script runs (and can terminate it on abort). The
// script may run as long as it needs — no time/wave/call caps by default.
//
// Protocol with the parent:
//   parent -> worker: { type: "run", script, toolNames, maxWaves, maxCalls }
//   worker -> parent: { type: "wave", wave: N, calls: [{name, args}] }
//   parent -> worker: { type: "wave_result", wave: N, results: [{text, raw, isError}] | {error} }
//   worker -> parent: { type: "done", value, logs, waves, calls }
//                  | { type: "done", error }
//
// Each `await tools.X(args)` enqueues a call; a microtask flush batches all
// pending calls into one wave. Sequential awaits = multiple waves;
// Promise.all([tools.A(), tools.B()]) = one wave (microtask batch).

import vm from "node:vm";
import { parentPort } from "node:worker_threads";

let pending = [];
let flushing = false;
let waveSeq = 0;
let callCount = 0;
let maxWaves = 0; // 0 = unlimited
let maxCalls = 0; // 0 = unlimited
let toolDocs = [];

const toolResultTargets = new WeakMap();

function postToParent(msg) {
  parentPort.postMessage(msg);
}

function ToolResult(result = {}) {
  return makeToolResult(result);
}

function textOf(result) {
  if (typeof result?.text === "string") return result.text;
  if (result?.text == null) return "";
  return String(result.text);
}

function makeToolResult(result = {}) {
  const target = {
    text: textOf(result),
    raw: result.raw ?? null,
    isError: !!result.isError,
  };
  Object.setPrototypeOf(target, ToolResult.prototype);
  if (Object.prototype.hasOwnProperty.call(result, "anchored")) target.anchored = result.anchored;

  const proxy = new Proxy(target, {
    get(obj, prop, receiver) {
      if (prop === Symbol.toPrimitive) return () => obj.text;
      if (prop === "toString" || prop === "valueOf") return () => obj.text;
      if (prop === "json") return () => JSON.parse(obj.text);
      if (prop === "lines") {
        return (opts = {}) => {
          let lines = obj.text.split(/\r?\n/);
          if (opts.trim) lines = lines.map((line) => line.trim());
          if (opts.nonEmpty) lines = lines.filter(Boolean);
          return lines;
        };
      }
      if (Reflect.has(obj, prop)) return Reflect.get(obj, prop, receiver);
      const textValue = obj.text;
      const textProp = textValue[prop];
      return typeof textProp === "function" ? textProp.bind(textValue) : textProp;
    },
    has(obj, prop) {
      return prop in obj || prop in obj.text;
    },
  });
  toolResultTargets.set(proxy, target);
  return proxy;
}

function plainToolResult(value) {
  const target = toolResultTargets.get(value);
  if (!target) return null;
  const out = {
    text: target.text,
    raw: target.raw,
    isError: target.isError,
  };
  if (Object.prototype.hasOwnProperty.call(target, "anchored")) out.anchored = target.anchored;
  return out;
}

function dehydrateValue(value, seen = new WeakMap()) {
  if (value == null || typeof value !== "object") {
    if (typeof value === "function") return undefined;
    return value;
  }
  const plain = plainToolResult(value);
  if (plain) return dehydrateValue(plain, seen);
  if (seen.has(value)) return seen.get(value);
  const tag = Object.prototype.toString.call(value);
  if (
    tag === "[object Date]"
    || tag === "[object RegExp]"
    || tag === "[object ArrayBuffer]"
    || ArrayBuffer.isView(value)
  ) {
    return value;
  }
  if (tag === "[object Map]") {
    const out = new Map();
    seen.set(value, out);
    for (const [key, item] of value.entries()) {
      out.set(dehydrateValue(key, seen), dehydrateValue(item, seen));
    }
    return out;
  }
  if (tag === "[object Set]") {
    const out = new Set();
    seen.set(value, out);
    for (const item of value.values()) out.add(dehydrateValue(item, seen));
    return out;
  }
  if (Array.isArray(value)) {
    const out = [];
    seen.set(value, out);
    for (const item of value) out.push(dehydrateValue(item, seen));
    return out;
  }
  const out = {};
  seen.set(value, out);
  for (const [key, item] of Object.entries(value)) {
    const dehydrated = dehydrateValue(item, seen);
    if (dehydrated !== undefined) out[key] = dehydrated;
  }
  return out;
}

function makeCallTool(name) {
  return (args) => callTool(name, args);
}

function callTool(name, args) {
  if (maxCalls > 0 && callCount >= maxCalls) {
    return Promise.resolve(makeToolResult({
      text: `code call limit reached (${maxCalls} calls)`,
      raw: null,
      isError: true,
    }));
  }
  callCount++;
  const call = { name, args: args && typeof args === "object" ? args : {} };
  const result = new Promise((resolve, reject) => {
    call.__resolve = resolve;
    call.__reject = reject;
  });
  pending.push(call);
  if (!flushing) {
    flushing = true;
    Promise.resolve().then(flush).catch(() => {});
  }
  return result;
}

async function flush() {
  if (pending.length === 0) { flushing = false; return; }
  const batch = pending;
  pending = [];
  waveSeq++;
  if (maxWaves > 0 && waveSeq > maxWaves) {
    for (const c of batch) c.__resolve(makeToolResult({ text: `code wave limit reached (${maxWaves} waves)`, raw: null, isError: true }));
    flushing = false;
    return;
  }
  const waveNum = waveSeq;
  const req = {
    type: "wave",
    wave: waveNum,
    calls: batch.map((c) => ({ name: c.name, args: c.args })),
  };
  try {
    postToParent(req);
  } catch (e) {
    for (const c of batch) c.__reject(new Error(`wave post failed: ${e?.message || e}`));
    flushing = false;
    return;
  }
  // Wait for the parent's wave_result. We use a pending-results map keyed by
  // wave number so concurrent waves (unusual but possible via independent
  // async branches) don't cross-wire.
  await new Promise((resolveWave) => {
    pendingWaves.set(waveNum, { batch, resolveWave });
  });
  flushing = false;
  // If more calls accumulated while we were waiting, flush again.
  if (pending.length > 0) {
    flushing = true;
    Promise.resolve().then(flush).catch(() => {});
  }
}

const pendingWaves = new Map();

function handleWaveResult(msg) {
  const entry = pendingWaves.get(msg.wave);
  if (!entry) return;
  pendingWaves.delete(msg.wave);
  const { batch, resolveWave } = entry;
  if (msg.error) {
    for (const c of batch) c.__reject(new Error(msg.error));
  } else {
    const results = msg.results || [];
    for (let i = 0; i < batch.length; i++) {
      const r = results[i] || { text: "(no result)", raw: null, isError: true };
      batch[i].__resolve(makeToolResult(r));
    }
  }
  resolveWave();
}

function normalizeToolDocs(docs = [], toolNames = []) {
  const byName = new Map();
  for (const doc of Array.isArray(docs) ? docs : []) {
    if (!doc || typeof doc.name !== "string") continue;
    byName.set(doc.name, {
      name: doc.name,
      path: typeof doc.path === "string" && doc.path ? doc.path : toolPath(doc.name),
      summary: typeof doc.summary === "string" ? doc.summary : "",
      docs: typeof doc.docs === "string" ? doc.docs : "",
    });
  }
  for (const name of Array.isArray(toolNames) ? toolNames : []) {
    if (typeof name !== "string" || byName.has(name)) continue;
    byName.set(name, {
      name,
      path: toolPath(name),
      summary: "",
      docs: `${name}(args: {})`,
    });
  }
  return [...byName.values()];
}

function toolPath(name) {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)
    ? `tools.${name}`
    : `tools[${JSON.stringify(name)}]`;
}

function findToolDoc(nameOrPath) {
  const needle = String(nameOrPath || "").trim();
  if (!needle) return null;
  return toolDocs.find((doc) => (
    doc.name === needle
    || doc.path === needle
    || doc.path.endsWith(`.${needle}`)
    || doc.path.endsWith(`["${needle}"]`)
  )) || null;
}

function searchToolDocs(query = "") {
  const terms = String(query || "").toLowerCase().split(/[^a-z0-9_$.-]+/).filter(Boolean);
  const scored = toolDocs.map((doc) => {
    const haystack = `${doc.name} ${doc.path} ${doc.summary} ${doc.docs}`.toLowerCase();
    const score = terms.length ? terms.reduce((n, term) => n + (haystack.includes(term) ? 1 : 0), 0) : 1;
    return {
      path: doc.path,
      name: doc.name,
      score,
      summary: doc.summary,
    };
  });
  return scored
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, 8)
    .map(({ score: _score, ...item }) => item);
}

function describeToolDoc(nameOrPath) {
  const doc = findToolDoc(nameOrPath);
  if (doc) return doc.docs || `${doc.name}(args: {})`;
  const matches = searchToolDocs(nameOrPath).map((item) => item.path);
  if (matches.length) return `No exact tool match for ${String(nameOrPath)}. Closest: ${matches.join(", ")}`;
  return `No tool match for ${String(nameOrPath)}`;
}

function batch(items = []) {
  if (!Array.isArray(items)) return Promise.reject(new Error("codemode.batch expects an array"));
  const calls = items.map((item) => {
    if (item && typeof item.then === "function") return item;
    if (Array.isArray(item)) return callTool(item[0], item[1] || {});
    if (item && typeof item === "object" && (typeof item.name === "string" || typeof item.tool === "string")) {
      return callTool(item.name || item.tool, item.args || {});
    }
    return Promise.resolve(makeToolResult({ text: "invalid batch item", raw: null, isError: true }));
  });
  return Promise.all(calls);
}

function buildCodemodeGlobal() {
  return Object.freeze({
    call: callTool,
    batch,
    search: searchToolDocs,
    describe: describeToolDoc,
  });
}

function buildToolsProxy(toolNames = []) {
  const cache = new Map();
  for (const name of toolNames) {
    if (typeof name === "string") cache.set(name, makeCallTool(name));
  }
  return new Proxy({}, {
    get(_, prop) {
      if (typeof prop !== "string" || prop === "then") return undefined;
      let fn = cache.get(prop);
      if (!fn) {
        fn = makeCallTool(prop);
        cache.set(prop, fn);
      }
      return fn;
    },
  });
}

async function runScript(script, toolNames) {
  const tools = buildToolsProxy(toolNames);
  const codemode = buildCodemodeGlobal();

  const sandboxConsole = {
    log: (...a) => workerLogs.push(a.map(String).join(" ")),
    warn: (...a) => workerLogs.push(`[warn] ${a.map(String).join(" ")}`),
    error: (...a) => workerLogs.push(`[error] ${a.map(String).join(" ")}`),
  };
  const deny = (key) => () => { throw new Error(`access to ${key} is denied in code mode scripts`); };

  const context = vm.createContext({
    tools,
    callTool,
    ToolResult,
    batch,
    codemode,
    JSON,
    Math,
    console: sandboxConsole,
    require: deny("require"),
    process: { exit: deny("process.exit"), env: Object.freeze({}) },
    globalThis: Object.freeze({}),
    global: Object.freeze({}),
    Buffer: deny("Buffer"),
    fetch: deny("fetch"),
    setTimeout: deny("setTimeout"),
    setInterval: deny("setInterval"),
    setImmediate: deny("setImmediate"),
    Promise,
  });

  const wrapped = `(async () => { ${script} })()`;
  // Deny dynamic import() — never let a script load modules out of the sandbox.
  // We provide a throwing callback, but node still surfaces its own message
  // unless run with --experimental-vm-modules; normalizeRunError() below
  // rewrites either form into a clear denial the script can catch/recover from.
  const scriptObj = new vm.Script(wrapped, {
    filename: "code-mode-script.vm",
    importModuleDynamically: () => {
      throw new Error("dynamic import() is denied in code mode scripts");
    },
  });
  // No vm timeout: scripts may run as long as they need (long tool waves,
  // big in-script aggregation). The bridge's session lifecycle is the backstop.
  const out = scriptObj.runInContext(context);
  return out instanceof Promise ? await out : out;
}

const workerLogs = [];

// Rewrite node's dynamic-import internals message into a clear denial.
function normalizeRunError(err) {
  const msg = err?.message || String(err);
  if (/dynamic import callback|experimental-vm-modules/i.test(msg)) {
    return "dynamic import() is denied in code mode scripts";
  }
  return msg;
}

parentPort.on("message", async (msg) => {
  if (msg?.type === "wave_result") {
    handleWaveResult(msg);
    return;
  }
  if (msg?.type === "run") {
    maxWaves = msg.maxWaves ?? 0;
    maxCalls = msg.maxCalls ?? 0;
    toolDocs = normalizeToolDocs(msg.toolDocs || [], msg.toolNames || []);
    try {
      const value = await runScript(msg.script, msg.toolNames || []);
      postToParent({
        type: "done",
        value: value === undefined ? null : dehydrateValue(value),
        logs: workerLogs.slice(),
        waves: waveSeq,
        calls: callCount,
      });
    } catch (err) {
      postToParent({
        type: "done",
        error: normalizeRunError(err),
        logs: workerLogs.slice(),
        waves: waveSeq,
        calls: callCount,
      });
    }
    return;
  }
});

// Parent signals timeout by terminate(); we just stop touching state after that.
parentPort.on("messageerror", () => {});
