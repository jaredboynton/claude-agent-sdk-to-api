// Worker-side code-mode sandbox. Loaded inside a Worker so the parent stays
// responsive while a model script runs (and can terminate it on abort). The
// script may run as long as it needs — no time/wave/call caps by default.
//
// Protocol with the parent:
//   parent -> worker: { type: "run", script, toolNames, maxWaves, maxCalls, autoMonitor }
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
import { createHash, randomUUID } from "node:crypto";
import { pickShellTool, buildExecCommand } from "./exec-command.mjs";
import {
  DEFAULT_MONITOR_MAX_MS,
  DEFAULT_POLL_START_MS,
  looksRunning,
  nextPollDelay,
  parseBackgroundBanner,
  parseCompletion,
  pickMonitorStrategy,
  stripReadGutter,
} from "./background-monitor.mjs";

let pending = [];
let flushing = false;
let waveSeq = 0;
let callCount = 0;
let maxWaves = 0; // 0 = unlimited
let maxCalls = 0; // 0 = unlimited
let toolDocs = [];
let sandboxState = {}; // persistent `state` global; round-trips parent <-> worker per run
let autoMonitor = true; // auto-attach to client-backgrounded commands (run msg can disable)

// The vm context denies timers so a script can't schedule work the parent
// can't see — but a host-scope sleep is safe (the parent can still terminate
// the worker) and unblocks model-written retry/backoff loops, which otherwise
// throw on setTimeout. Capped per call so one await can't park a run forever.
const SLEEP_MAX_MS = 30_000;
function sleep(ms) {
  const delay = Math.min(Math.max(Number(ms) || 0, 0), SLEEP_MAX_MS);
  return new Promise((resolve) => setTimeout(resolve, delay));
}

// Retry an async thunk with linear backoff. A ToolResult with isError counts
// as a failure (tool errors don't throw), so `codemode.retry(() => tools.X(a))`
// works without the script unwrapping results.
async function retry(fn, { attempts = 3, delayMs = 250 } = {}) {
  if (typeof fn !== "function") throw new Error("codemode.retry expects an async function");
  const max = Math.max(1, Number(attempts) || 1);
  let last;
  for (let i = 0; i < max; i++) {
    try {
      const out = await fn(i);
      const target = toolResultTargets.get(out);
      if (!target || !target.isError) return out;
      last = out;
    } catch (e) {
      last = e;
    }
    if (i < max - 1) await sleep((Number(delayMs) || 0) * (i + 1));
  }
  if (last instanceof Error) throw last;
  return last;
}

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
  // Client-injected notices (system reminders / truncation banners) extracted
  // from `.text` by the bridge so they never pollute data processing.
  if (Array.isArray(result.notes) && result.notes.length) target.notes = result.notes;
  if (result.truncated) target.truncated = true;

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
  if (Object.prototype.hasOwnProperty.call(target, "notes")) out.notes = target.notes;
  if (Object.prototype.hasOwnProperty.call(target, "truncated")) out.truncated = target.truncated;
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
  return (args) => monitoredCall(name, args);
}

// Auto-monitor seam: every script-visible tool call routes through here. If
// the client answers by backgrounding the command ("Command running in
// background with ID: ..."), keep watching it in client-side waves and resolve
// the original await with the finished output. A script that set
// run_in_background: true asked for the handle - leave it alone.
async function monitoredCall(name, args) {
  const r = await callTool(name, args);
  if (!autoMonitor) return r;
  if (args && typeof args === "object" && args.run_in_background === true) return r;
  const target = toolResultTargets.get(r);
  const banner = target ? parseBackgroundBanner(target.text) : null;
  if (!banner || !pickMonitorStrategy(toolDocs, banner)) return r;
  workerLogs.push(`[monitor] ${name} was backgrounded by the client (id ${banner.id}); watching it`);
  return monitorLoop(banner, {});
}

// Watch one backgrounded command to completion. Poll waves are client-side
// only - the model is never woken. Every return path carries a notes entry
// saying what the monitor observed.
async function monitorLoop(banner, opts = {}) {
  const o = opts && typeof opts === "object" ? opts : {};
  const startedAt = Date.now();
  const maxMs = Math.max(1_000, Number(o.maxMs) || DEFAULT_MONITOR_MAX_MS);
  const intervalMs = Math.max(10, Number(o.intervalMs) || DEFAULT_POLL_START_MS);
  const until = o.until == null ? null
    : (typeof o.until.test === "function" ? o.until : new RegExp(String(o.until), "m"));
  const strategy = pickMonitorStrategy(toolDocs, banner, o.tool);
  if (!strategy) {
    return makeToolResult({
      text: `codemode.monitor: no monitor-capable client tool (TaskOutput/BashOutput, or Read + an output path) for id ${banner.id}`,
      raw: null,
      isError: true,
    });
  }
  let acc = "";
  let lastSnapshot = null;
  let stable = 0;
  let polls = 0;
  const finish = ({ text, exitCode = null, done, isError, note }) => {
    workerLogs.push(`[monitor] ${note}`);
    return makeToolResult({
      text,
      raw: { monitored: true, id: banner.id, tool: strategy.tool, polls, exitCode, done },
      isError: isError ?? (exitCode != null && exitCode !== 0),
      notes: [note],
    });
  };
  while (Date.now() - startedAt < maxMs) {
    if (polls > 0 || strategy.kind !== "task") {
      // Blocking TaskOutput does the waiting itself; others back off 1.5x.
      await sleep(strategy.kind === "task" ? Math.min(intervalMs, 1_000) : nextPollDelay(polls, intervalMs));
    }
    polls++;
    const r = await callTool(strategy.tool, strategy.buildArgs(maxMs - (Date.now() - startedAt)));
    const target = toolResultTargets.get(r);
    const text = target ? target.text : String(r ?? "");
    if (target?.isError) {
      // An unknown/reaped id usually means the process already finished;
      // return what we captured instead of failing the script.
      return finish({
        text: acc || text,
        done: false,
        isError: !acc,
        note: `monitor: ${strategy.tool} errored after ${polls} poll(s): ${text.slice(0, 160)}`,
      });
    }
    if (strategy.incremental) acc += (acc && text ? "\n" : "") + text;
    else acc = strategy.kind === "read" ? stripReadGutter(text) : text;
    const completion = parseCompletion(text);
    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    if (completion.done || (until && until.test(acc))) {
      return finish({
        text: acc,
        exitCode: completion.exitCode,
        done: true,
        note: `monitor: ${banner.id} finished after ${elapsed}s (${polls} ${strategy.tool} poll(s)${completion.exitCode != null ? `, exit ${completion.exitCode}` : ""})`,
      });
    }
    if (strategy.kind === "task" && text.trim() && !looksRunning(text)) {
      // A blocking TaskOutput that returns without a running marker returned
      // because the task ended, even when the client omits exit markers.
      return finish({
        text: acc,
        done: true,
        note: `monitor: ${banner.id} returned via blocking ${strategy.tool} after ${elapsed}s (${polls} call(s))`,
      });
    }
    if (strategy.kind === "read") {
      // No exit marker in the file: only assume completion once non-empty
      // output has stopped changing across several backed-off reads.
      stable = text === lastSnapshot && acc.trim() ? stable + 1 : 0;
      lastSnapshot = text;
      if (stable >= 3) {
        return finish({
          text: acc,
          done: null,
          note: `monitor: ${banner.id} output stable across ${stable + 1} reads (${elapsed}s); assuming complete - no exit marker seen, the process may still be running`,
        });
      }
    }
  }
  return finish({
    text: acc,
    done: false,
    isError: !acc,
    note: `monitor: gave up on ${banner.id} after ${Math.round(maxMs / 1000)}s (${polls} poll(s)); pass { maxMs } to codemode.monitor to wait longer`,
  });
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

// Name-weighted scoring: an exact-name hit must outrank a tool whose long docs
// merely mention the term. Cap 20 (was 8 — too small to page through a large
// MCP-heavy catalog; codemode.list() covers full enumeration).
function searchToolDocs(query = "") {
  const terms = String(query || "").toLowerCase().split(/[^a-z0-9_$.-]+/).filter(Boolean);
  const scored = toolDocs.map((doc) => {
    const name = doc.name.toLowerCase();
    const path = doc.path.toLowerCase();
    const summary = doc.summary.toLowerCase();
    const docs = doc.docs.toLowerCase();
    const score = terms.length
      ? terms.reduce((n, term) => n
          + (name === term ? 8 : 0)
          + (name !== term && name.includes(term) ? 4 : 0)
          + (path.includes(term) ? 2 : 0)
          + (summary.includes(term) || docs.includes(term) ? 1 : 0), 0)
      : 1;
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
    .slice(0, 20)
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
    if (Array.isArray(item)) return monitoredCall(item[0], item[1] || {});
    if (item && typeof item === "object" && (typeof item.name === "string" || typeof item.tool === "string")) {
      return monitoredCall(item.name || item.tool, item.args || {});
    }
    return Promise.resolve(makeToolResult({ text: "invalid batch item", raw: null, isError: true }));
  });
  return Promise.all(calls);
}

function buildCodemodeGlobal() {
  return Object.freeze({
    call: monitoredCall,
    batch,
    search: searchToolDocs,
    describe: describeToolDoc,
    retry,
    // Attach to a backgrounded command (a ToolResult carrying the client's
    // banner, an id string, or { id, outputPath }) and wait for completion via
    // the client's monitor tool. The worker already does this automatically
    // when a client backgrounds a call on its own; this is for deliberate
    // run_in_background: true handles and re-attaching after a monitor timeout.
    monitor: (handle, opts = {}) => {
      const o = opts && typeof opts === "object" ? opts : {};
      let banner = null;
      if (typeof handle === "string" && handle.trim()) {
        banner = { id: handle.trim(), outputPath: null };
      } else if (handle && typeof handle === "object") {
        const target = toolResultTargets.get(handle);
        if (target) banner = parseBackgroundBanner(target.text);
        else if (typeof handle.id === "string" || typeof handle.task_id === "string") {
          banner = { id: String(handle.id || handle.task_id), outputPath: handle.outputPath || null };
        }
      }
      if (!banner) {
        return Promise.resolve(makeToolResult({
          text: "codemode.monitor: pass a backgrounded ToolResult, an id string, or { id, outputPath }",
          raw: null,
          isError: true,
        }));
      }
      if (!banner.outputPath && typeof o.outputPath === "string") banner.outputPath = o.outputPath;
      return monitorLoop(banner, o);
    },
    // Fetch the full text of a previously truncated result. Resolved inline by
    // the bridge from the session artifact store — no client turn is fabricated.
    recall: (id) => callTool("__recall", { id: String(id ?? "") }),
    // Daemon-side syntax check of the real file (js/mjs/cjs, py, json, sh) —
    // resolved inline by the bridge, no client turn. Check `.isError`.
    verify: (path) => callTool("__verify", { path: String(path ?? "") }),
    // Run an inline script through the client's shell tool with zero quoting
    // hazards: the source travels as base64 into a mktemp file and executes in
    // one atomic command (no separate write-then-run steps to race or mangle).
    exec: (source, opts = {}) => {
      const o = opts && typeof opts === "object" ? opts : {};
      const toolName = typeof o.tool === "string" && o.tool ? o.tool : pickShellTool(toolDocs);
      if (!toolName) {
        return Promise.resolve(makeToolResult({
          text: 'codemode.exec: no shell-capable client tool found; pass { tool: "Name" }',
          raw: null,
          isError: true,
        }));
      }
      let command;
      try {
        command = buildExecCommand({ source, interpreter: o.interpreter, interpreterArgs: o.interpreterArgs, args: o.args, cwd: o.cwd, ext: o.ext });
      } catch (e) {
        return Promise.resolve(makeToolResult({ text: `codemode.exec: ${e?.message || e}`, raw: null, isError: true }));
      }
      const extra = o.toolArgs && typeof o.toolArgs === "object" ? o.toolArgs : {};
      const key = typeof o.commandKey === "string" && o.commandKey ? o.commandKey : "command";
      return monitoredCall(toolName, { ...extra, [key]: command });
    },
    // Full catalog enumeration (worker-local, zero waves). search() caps at 20;
    // this is the complete list.
    list: () => toolDocs.map((d) => ({ name: d.name, path: d.path, summary: d.summary })),
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

// The single most confusing compile failure models hit: an unescaped backtick
// inside a template literal (usually embedded script source or prose) closes
// the literal early, and the literal's tail is parsed as code — V8 then blames
// innocent text. Flag the hazard when a naive lex of the script ends inside an
// open template literal, or when the offending line itself carries a backtick.
// Advisory only (it decorates an already-failed compile), so a rare false
// positive from e.g. a regex literal containing a backtick is acceptable.
export function backtickHazardLikely(script, errLineText = "") {
  if (errLineText.includes("`")) return true;
  let state = "code";
  const braces = []; // per-${ expression brace depth inside templates
  for (let i = 0; i < script.length; i++) {
    const c = script[i];
    const n = script[i + 1];
    if (state === "code") {
      if (c === "`") state = "template";
      else if (c === "'") state = "sq";
      else if (c === '"') state = "dq";
      else if (c === "/" && n === "/") state = "line";
      else if (c === "/" && n === "*") { state = "block"; i++; }
      else if (c === "{" && braces.length) braces[braces.length - 1]++;
      else if (c === "}" && braces.length) {
        if (braces[braces.length - 1] === 0) { braces.pop(); state = "template"; }
        else braces[braces.length - 1]--;
      }
    } else if (state === "template") {
      if (c === "\\") i++;
      else if (c === "`") state = "code";
      else if (c === "$" && n === "{") { braces.push(0); state = "code"; i++; }
    } else if (state === "sq" || state === "dq") {
      if (c === "\\") i++;
      else if ((state === "sq" && c === "'") || (state === "dq" && c === '"') || c === "\n") state = "code";
    } else if (state === "line") {
      if (c === "\n") state = "code";
    } else if (state === "block") {
      if (c === "*" && n === "/") { state = "code"; i++; }
    }
  }
  return state === "template";
}

async function runScript(script, toolNames) {
  const tools = buildToolsProxy(toolNames);
  const codemode = buildCodemodeGlobal();

  const sandboxConsole = {
    log: (...a) => workerLogs.push(a.map(String).join(" ")),
    warn: (...a) => workerLogs.push(`[warn] ${a.map(String).join(" ")}`),
    error: (...a) => workerLogs.push(`[error] ${a.map(String).join(" ")}`),
  };
  // Aliases models reach for constantly; a missing console.info is a whole
  // wasted run ("console.info is not a function"), not a safety win.
  sandboxConsole.info = sandboxConsole.log;
  sandboxConsole.debug = sandboxConsole.log;
  const deny = (key) => () => { throw new Error(`access to ${key} is denied in code mode scripts`); };

  const context = vm.createContext({
    tools,
    callTool,
    ToolResult,
    batch,
    codemode,
    state: sandboxState,
    sleep,
    JSON,
    Math,
    console: sandboxConsole,
    TextEncoder,
    TextDecoder,
    // Pure data helpers models expect everywhere. None grant I/O or scheduling
    // (the actual sandbox concerns); their absence just crashes otherwise-fine
    // scripts with a bare ReferenceError.
    structuredClone,
    URL,
    URLSearchParams,
    atob,
    btoa,
    queueMicrotask,
    crypto: Object.freeze({
      randomUUID,
      // Sync hex sha256 — webcrypto's async ArrayBuffer subtle.digest is a
      // footgun in short scripts; this covers dedupe keys and content hashes.
      sha256: (data) => createHash("sha256").update(String(data ?? "")).digest("hex"),
    }),
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

  // Newline-wrap + lineOffset so stack line numbers match the script's own
  // numbering (the old single-line wrapper put everything on line 1).
  const wrapped = `(async () => {\n${script}\n})()`;
  // Deny dynamic import() — never let a script load modules out of the sandbox.
  // We provide a throwing callback, but node still surfaces its own message
  // unless run with --experimental-vm-modules; normalizeRunError() below
  // rewrites either form into a clear denial the script can catch/recover from.
  let scriptObj;
  try {
    scriptObj = new vm.Script(wrapped, {
      filename: "code-mode-script.vm",
      lineOffset: -1,
      importModuleDynamically: () => {
        throw new Error("dynamic import() is denied in code mode scripts");
      },
    });
  } catch (e) {
    // Compile-time SyntaxError: its stack head is `code-mode-script.vm:N`, the
    // offending source line, and a caret — but the message alone carries no
    // location, so the model would guess (each guess is a paid round-trip).
    // Bake the line number and the stack head into the message.
    if (e instanceof SyntaxError) {
      const head = String(e.stack || "").split("\n").slice(0, 3).join("\n");
      const m = head.match(/code-mode-script\.vm:(\d+)/);
      const errLineText = m ? String(script.split("\n")[Number(m[1]) - 1] ?? "") : "";
      let msgText = m ? `${e.message} (line ${m[1]})\n${head}` : e.message;
      if (backtickHazardLikely(script, errLineText)) {
        msgText += "\nhint: an unescaped backtick inside a template literal ends the literal early, so the parse error may point at innocent text far from the real mistake. Escape embedded backticks as \\` or build embedded source from regular quoted strings.";
      }
      const err = new SyntaxError(msgText);
      err.stack = ""; // location already in the message; no script-owned frames exist
      throw err;
    }
    throw e;
  }
  // No vm timeout: scripts may run as long as they need (long tool waves,
  // big in-script aggregation). The bridge's session lifecycle is the backstop.
  const out = scriptObj.runInContext(context);
  return out instanceof Promise ? await out : out;
}

const workerLogs = [];

// Rewrite node's dynamic-import internals message into a clear denial.
// Otherwise keep up to 3 script-owned stack frames so the model sees WHERE in
// its script the throw happened AND the call path that got there (line numbers
// align via lineOffset). Only true `at ...` frames qualify — SyntaxError stacks
// carry source/caret lines that must not be mistaken for frames (their
// location is already baked into the message at compile time).
function normalizeRunError(err) {
  const msg = err?.message || String(err);
  if (/dynamic import callback|experimental-vm-modules/i.test(msg)) {
    return "dynamic import() is denied in code mode scripts";
  }
  const stack = typeof err?.stack === "string" ? err.stack : "";
  const frames = stack.split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("at ") && l.includes("code-mode-script.vm"))
    .slice(0, 3)
    .map((l) => l.replace(/^at\s+/, ""));
  return frames.length ? `${msg} (at ${frames.join(" <- ")})` : msg;
}

parentPort.on("message", async (msg) => {
  if (msg?.type === "wave_result") {
    handleWaveResult(msg);
    return;
  }
  if (msg?.type === "run") {
    maxWaves = msg.maxWaves ?? 0;
    maxCalls = msg.maxCalls ?? 0;
    autoMonitor = msg.autoMonitor !== false;
    toolDocs = normalizeToolDocs(msg.toolDocs || [], msg.toolNames || []);
    sandboxState = msg.state && typeof msg.state === "object" ? msg.state : {};
    // `state` returns on success AND error: a script that threw after stashing
    // progress must not lose it. dehydrateValue unwraps ToolResult proxies so
    // the object survives the structured-clone postMessage boundary.
    try {
      const value = await runScript(msg.script, msg.toolNames || []);
      postToParent({
        type: "done",
        value: value === undefined ? null : dehydrateValue(value),
        logs: workerLogs.slice(),
        waves: waveSeq,
        calls: callCount,
        state: dehydrateValue(sandboxState),
      });
    } catch (err) {
      postToParent({
        type: "done",
        error: normalizeRunError(err),
        logs: workerLogs.slice(),
        waves: waveSeq,
        calls: callCount,
        state: dehydrateValue(sandboxState),
      });
    }
    return;
  }
});

// Parent signals timeout by terminate(); we just stop touching state after that.
parentPort.on("messageerror", () => {});
