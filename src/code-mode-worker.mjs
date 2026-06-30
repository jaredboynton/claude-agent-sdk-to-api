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

function postToParent(msg) {
  parentPort.postMessage(msg);
}

function makeCallTool(name) {
  return (args) => callTool(name, args);
}

function callTool(name, args) {
  if (maxCalls > 0 && callCount >= maxCalls) {
    return Promise.resolve({
      text: `code call limit reached (${maxCalls} calls)`,
      raw: null,
      isError: true,
    });
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
    for (const c of batch) c.__resolve({ text: `code wave limit reached (${maxWaves} waves)`, raw: null, isError: true });
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
      batch[i].__resolve(r);
    }
  }
  resolveWave();
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

  const sandboxConsole = {
    log: (...a) => workerLogs.push(a.map(String).join(" ")),
    warn: (...a) => workerLogs.push(`[warn] ${a.map(String).join(" ")}`),
    error: (...a) => workerLogs.push(`[error] ${a.map(String).join(" ")}`),
  };
  const deny = (key) => () => { throw new Error(`access to ${key} is denied in code mode scripts`); };

  const context = vm.createContext({
    tools,
    callTool,
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
    try {
      const value = await runScript(msg.script, msg.toolNames || []);
      postToParent({
        type: "done",
        value: value === undefined ? null : value,
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
