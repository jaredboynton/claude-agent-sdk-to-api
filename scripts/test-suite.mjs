#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { availableParallelism } from "node:os";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FULL_SUITE_SOURCES = new Set([
  "src/server.mjs",
  "src/code-mode.mjs",
  "src/code-mode-worker.mjs",
  "src/anchor-edit.mjs",
  "src/read-recovery.mjs",
  "src/resume-index.mjs",
]);
const FULL_SUITE_META = new Set(["package.json", "package-lock.json"]);

function toRel(root, path) {
  return relative(root, resolve(root, path)).split(sep).join("/");
}

function normalizeRel(path) {
  return path.split(/[\\/]+/).filter(Boolean).join("/");
}

export function parseShard(value) {
  if (!value) return null;
  const m = /^(\d+)\/(\d+)$/.exec(String(value));
  if (!m) throw new Error(`invalid shard "${value}" (expected index/total)`);
  const index = Number(m[1]);
  const total = Number(m[2]);
  if (!Number.isInteger(index) || !Number.isInteger(total) || index < 1 || total < 1 || index > total) {
    throw new Error(`invalid shard "${value}" (expected 1 <= index <= total)`);
  }
  return { index, total };
}

export function defaultConcurrency() {
  const env = Number(process.env.TEST_CONCURRENCY || 0);
  if (Number.isInteger(env) && env > 0) return env;
  return Math.max(1, Math.min(availableParallelism?.() || 1, 8));
}

export function discoverTestFiles(root = ROOT) {
  const dir = join(root, "test");
  return readdirSync(dir)
    .filter((name) => name.endsWith(".test.mjs"))
    .map((name) => `test/${name}`)
    .sort();
}

function countTests(text) {
  return (text.match(/\btest\s*\(/g) || []).length;
}

function loadTimings(root, path) {
  if (!path) return new Map();
  const full = resolve(root, path);
  if (!existsSync(full)) return new Map();
  const raw = JSON.parse(readFileSync(full, "utf8"));
  const entries = Array.isArray(raw)
    ? raw.map((r) => [r.file || r.path, r.meanMs ?? r.ms ?? r.durationMs])
    : Object.entries(raw);
  return new Map(entries.filter(([file, ms]) => file && Number(ms) > 0).map(([file, ms]) => [normalizeRel(file), Number(ms)]));
}

function fileWeight(root, rel, timings) {
  const timed = timings.get(rel);
  if (Number(timed) > 0) return timed;
  const full = join(root, rel);
  const text = readFileSync(full, "utf8");
  return text.split("\n").length + countTests(text) * 20;
}

export function shardFiles(files, shard, { root = ROOT, timings = new Map() } = {}) {
  if (!shard) return [...files].sort();
  const buckets = Array.from({ length: shard.total }, () => ({ weight: 0, files: [] }));
  const weighted = files
    .map((file) => ({ file, weight: fileWeight(root, file, timings) }))
    .sort((a, b) => (b.weight - a.weight) || a.file.localeCompare(b.file));
  for (const item of weighted) {
    buckets.sort((a, b) => (a.weight - b.weight) || a.files.join("\0").localeCompare(b.files.join("\0")));
    buckets[0].files.push(item.file);
    buckets[0].weight += item.weight;
  }
  return buckets[shard.index - 1].files.sort();
}

function parseArgs(argv) {
  const opts = {
    profile: false,
    changed: false,
    hotspots: false,
    list: false,
    repeat: 3,
    base: "HEAD",
    concurrency: defaultConcurrency(),
    shard: process.env.TEST_SHARD || null,
    timings: process.env.TEST_TIMINGS_JSON || null,
    nodeArgs: [],
    explicitFiles: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === "--") {
      opts.nodeArgs.push(...argv.slice(i + 1));
      break;
    } else if (arg === "--profile") opts.profile = true;
    else if (arg === "--changed") opts.changed = true;
    else if (arg === "--hotspots") opts.hotspots = true;
    else if (arg === "--list") opts.list = true;
    else if (arg === "--repeat") opts.repeat = Number(next());
    else if (arg.startsWith("--repeat=")) opts.repeat = Number(arg.slice("--repeat=".length));
    else if (arg === "--base") opts.base = next();
    else if (arg.startsWith("--base=")) opts.base = arg.slice("--base=".length);
    else if (arg === "--shard") opts.shard = next();
    else if (arg.startsWith("--shard=")) opts.shard = arg.slice("--shard=".length);
    else if (arg === "--concurrency") opts.concurrency = Number(next());
    else if (arg.startsWith("--concurrency=")) opts.concurrency = Number(arg.slice("--concurrency=".length));
    else if (arg === "--timings") opts.timings = next();
    else if (arg.startsWith("--timings=")) opts.timings = arg.slice("--timings=".length);
    else if (arg === "--help" || arg === "-h") opts.help = true;
    else if (arg.startsWith("--test-") || arg.startsWith("--experimental-test-")) opts.nodeArgs.push(arg);
    else if (arg.endsWith(".mjs") || arg.startsWith("test/")) opts.explicitFiles.push(normalizeRel(arg));
    else opts.nodeArgs.push(arg);
  }
  if (!Number.isInteger(opts.repeat) || opts.repeat < 1) throw new Error("--repeat must be a positive integer");
  if (!Number.isInteger(opts.concurrency) || opts.concurrency < 1) throw new Error("--concurrency/TEST_CONCURRENCY must be a positive integer");
  opts.shard = parseShard(opts.shard);
  return opts;
}

function usage() {
  return [
    "Usage: node scripts/test-suite.mjs [--profile] [--changed] [--hotspots] [--list] [--shard i/n] [--concurrency n] [--timings path] [-- node test args...]",
    "",
    "Environment: TEST_CONCURRENCY, TEST_SHARD=index/total, TEST_CHANGED_BASE, TEST_TIMINGS_JSON",
  ].join("\n");
}

function containsAny(text, needles) {
  return needles.some((needle) => text.includes(needle));
}

export function hotspotSummary(files, { root = ROOT } = {}) {
  const rows = files.map((file) => {
    const text = readFileSync(join(root, file), "utf8");
    return {
      file,
      lines: text.split("\n").length,
      tests: countTests(text),
      tmp: containsAny(text, ["mkdtemp", "tmpdir", "/tmp"]),
      networkOrServer: containsAny(text, ["node:http", "fetch", "startServer(", "listen("]),
      childProcess: containsAny(text, ["execFileSync", "spawn", "child_process"]),
      timers: containsAny(text, ["setTimeout(", "Promise.race"]),
    };
  });
  return {
    counts: {
      files: rows.length,
      tests: rows.reduce((n, r) => n + r.tests, 0),
      tmpFiles: rows.filter((r) => r.tmp).length,
      networkOrServerFiles: rows.filter((r) => r.networkOrServer).length,
      childProcessFiles: rows.filter((r) => r.childProcess).length,
      timerFiles: rows.filter((r) => r.timers).length,
    },
    largest: [...rows].sort((a, b) => (b.lines - a.lines) || a.file.localeCompare(b.file)).slice(0, 8),
    candidates: rows
      .filter((r) => r.networkOrServer || r.childProcess || r.tmp || r.timers || r.lines > 500)
      .sort((a, b) => (
        Number(b.networkOrServer) - Number(a.networkOrServer)
        || Number(b.childProcess) - Number(a.childProcess)
        || Number(b.timers) - Number(a.timers)
        || b.lines - a.lines
        || a.file.localeCompare(b.file)
      ))
      .slice(0, 12),
  };
}

function gitNames(args, root) {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  if (r.status !== 0) return [];
  return r.stdout.split("\n").map((s) => s.trim()).filter(Boolean).map(normalizeRel);
}

function changedFiles(root, base) {
  const names = new Set();
  const add = (items) => { for (const item of items) names.add(item); };
  const diffFilter = "--diff-filter=ACMRTUXB";
  if (base) add(gitNames(["diff", "--name-only", diffFilter, `${base}...HEAD`], root));
  add(gitNames(["diff", "--name-only", diffFilter], root));
  add(gitNames(["diff", "--name-only", "--cached", diffFilter], root));
  return [...names].sort();
}

function allCodeFiles(root) {
  const out = [];
  const walk = (relDir) => {
    const fullDir = join(root, relDir);
    if (!existsSync(fullDir)) return;
    for (const ent of readdirSync(fullDir, { withFileTypes: true })) {
      const rel = `${relDir}/${ent.name}`;
      if (ent.isDirectory()) walk(rel);
      else if (/\.(mjs|js|json)$/.test(ent.name)) out.push(normalizeRel(rel));
    }
  };
  walk("src");
  walk("test");
  return out.sort();
}

function resolveImport(root, fromRel, spec) {
  if (!spec.startsWith(".")) return null;
  const base = resolve(root, dirname(fromRel), spec);
  const candidates = extname(base)
    ? [base]
    : [`${base}.mjs`, `${base}.js`, `${base}.json`, join(base, "index.mjs"), join(base, "index.js")];
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return toRel(root, candidate);
  }
  return null;
}

function importsFor(root, rel) {
  const text = readFileSync(join(root, rel), "utf8");
  const deps = new Set();
  const re = /(?:import|export)\s+(?:[^'"()]*?\s+from\s+)?["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)/g;
  for (const m of text.matchAll(re)) {
    const resolved = resolveImport(root, rel, m[1] || m[2]);
    if (resolved) deps.add(resolved);
  }
  return deps;
}

function reverseGraph(root) {
  const rev = new Map();
  for (const file of allCodeFiles(root)) {
    for (const dep of importsFor(root, file)) {
      if (!rev.has(dep)) rev.set(dep, new Set());
      rev.get(dep).add(file);
    }
  }
  return rev;
}

export function impactedTestsForChanges(changed, tests, { root = ROOT } = {}) {
  const changedSet = new Set(changed.map(normalizeRel));
  if (changedSet.size === 0) return { files: tests, reason: "no changes detected; full suite fallback" };
  if ([...changedSet].some((f) => FULL_SUITE_META.has(f) || FULL_SUITE_SOURCES.has(f) || f === "scripts/test-suite.mjs")) {
    return { files: tests, reason: "broad-impact file changed; full suite fallback" };
  }

  const selected = new Set([...changedSet].filter((f) => tests.includes(f)));
  const sources = [...changedSet].filter((f) => f.startsWith("src/"));
  const testSupport = [...changedSet].filter((f) => f.startsWith("test/") && !tests.includes(f));
  if (testSupport.length) return { files: tests, reason: "test support or fixture changed; full suite fallback" };

  if (sources.length) {
    const rev = reverseGraph(root);
    const queue = [...sources];
    const seen = new Set(queue);
    let unknown = false;
    while (queue.length) {
      const cur = queue.shift();
      const parents = rev.get(cur);
      if (!parents && sources.includes(cur)) unknown = true;
      for (const parent of parents || []) {
        if (tests.includes(parent)) selected.add(parent);
        if (!seen.has(parent)) {
          seen.add(parent);
          queue.push(parent);
        }
      }
    }
    if (unknown || !selected.size) return { files: tests, reason: "source impact could not be proven; full suite fallback" };
  }

  return { files: [...selected].sort(), reason: "dependency-selected tests" };
}

async function runNodeTests(files, opts) {
  const args = ["--test", `--test-concurrency=${opts.concurrency}`, ...opts.nodeArgs, ...files];
  console.error(`[test-suite] node ${process.version}; concurrency=${opts.concurrency}; files=${files.length}${opts.shard ? `; shard=${opts.shard.index}/${opts.shard.total}` : ""}`);
  const child = spawn(process.execPath, args, { cwd: ROOT, stdio: "inherit" });
  return new Promise((resolve) => child.on("exit", (code, signal) => resolve(signal ? 1 : code ?? 1)));
}

async function profileFiles(files, opts) {
  const rows = [];
  for (const file of files) {
    const durations = [];
    for (let i = 0; i < opts.repeat; i++) {
      const t0 = process.hrtime.bigint();
      const child = spawn(process.execPath, ["--test", ...opts.nodeArgs, file], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => { stdout += d; });
      child.stderr.on("data", (d) => { stderr += d; });
      const code = await new Promise((resolve) => child.on("exit", (c) => resolve(c ?? 1)));
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      durations.push(ms);
      if (code !== 0) {
        process.stdout.write(stdout);
        process.stderr.write(stderr);
        throw new Error(`${file} failed during profiling (exit ${code})`);
      }
    }
    const meanMs = durations.reduce((a, b) => a + b, 0) / durations.length;
    rows.push({ file, meanMs, runs: durations });
  }
  rows.sort((a, b) => b.meanMs - a.meanMs);
  console.log(JSON.stringify({
    node: process.version,
    repeat: opts.repeat,
    generatedAt: new Date().toISOString(),
    hotspots: hotspotSummary(files),
    results: rows.map((r) => ({ file: r.file, meanMs: Math.round(r.meanMs * 10) / 10, runs: r.runs.map((n) => Math.round(n * 10) / 10) })),
  }, null, 2));
}

export async function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  if (opts.help) {
    console.log(usage());
    return 0;
  }

  let files = opts.explicitFiles.length ? opts.explicitFiles : discoverTestFiles(ROOT);
  if (opts.changed) {
    const base = process.env.TEST_CHANGED_BASE || opts.base;
    const selection = impactedTestsForChanges(changedFiles(ROOT, base), files, { root: ROOT });
    files = selection.files;
    console.error(`[test-suite] changed mode: ${selection.reason}`);
  }
  files = shardFiles(files, opts.shard, { root: ROOT, timings: loadTimings(ROOT, opts.timings) });

  if (opts.list) {
    console.log(files.join("\n"));
    return 0;
  }
  if (opts.hotspots) {
    console.log(JSON.stringify(hotspotSummary(files), null, 2));
    return 0;
  }
  if (opts.profile) {
    await profileFiles(files, opts);
    return 0;
  }
  return runNodeTests(files, opts);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => process.exitCode = code).catch((e) => {
    console.error(`[test-suite] ${e.message || e}`);
    process.exitCode = 2;
  });
}
