// Daemon-side local checks: syntax verification of real files and a git
// snapshot of the session cwd. The daemon runs on the same machine as the
// files, so these run at zero client round-trips and zero model round-trips —
// the whole point (see docs: a model otherwise spends a full model turn on
// `Bash("node --check ...")` after every edit).
//
// Security posture: fixed argv shapes only (execFile, never a shell), the only
// user-controlled argv position is the resolved file path, and that path must
// realpath-resolve inside the session cwd (defeats ../ and symlink escapes).
// Out-of-tree files get a clear refusal — the script can still use the
// client's Bash tool, which goes through the client's own permission system.

import { execFile } from "node:child_process";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, resolve, sep, extname } from "node:path";

const CHECK_MAX_FILE_BYTES = 5 * 1024 * 1024;
const EXEC_MAX_BUFFER = 256 * 1024;

const CHECKERS = new Map([
  [".js", "node"], [".cjs", "node"], [".mjs", "node"],
  [".py", "python"],
  [".json", "json"],
  [".sh", "bash"], [".bash", "bash"],
]);

/** Which checker (if any) handles this path, by extension. */
export function checkerFor(filePath) {
  const id = CHECKERS.get(extname(String(filePath || "")).toLowerCase());
  return id ? { id } : null;
}

/** True if candidateRealpath is rootRealpath or inside it (sep-safe). */
export function containsPath(rootRealpath, candidateRealpath) {
  if (!rootRealpath || !candidateRealpath) return false;
  return candidateRealpath === rootRealpath || candidateRealpath.startsWith(rootRealpath + sep);
}

function execCheck(cmd, argv, { cwd, timeoutMs, env }) {
  return new Promise((done) => {
    execFile(cmd, argv, {
      cwd,
      timeout: timeoutMs,
      killSignal: "SIGKILL",
      maxBuffer: EXEC_MAX_BUFFER,
      // HOME must survive: git resolves config/credential paths from it and
      // fails outright ("mkdir /.local: read-only") when it's absent.
      env: { PATH: process.env.PATH, HOME: process.env.HOME, ...(env || {}) },
    }, (err, stdout, stderr) => {
      done({ err, stdout: String(stdout || ""), stderr: String(stderr || "") });
    });
  });
}

/**
 * Syntax-check the real file on disk. Never throws.
 * @returns {Promise<{ok:boolean, checker:string|null, path:string, resolvedPath:string|null, output:string, reason?:string}>}
 */
export async function runSyntaxCheck(filePath, { cwd, timeoutMs = 5000 } = {}) {
  const path = String(filePath || "").trim();
  const fail = (reason, extra = {}) => ({ ok: false, checker: null, path, resolvedPath: null, output: "", reason, ...extra });
  if (!path) return fail("no path");
  const checker = checkerFor(path);
  if (!checker) return fail(`no checker for extension: ${extname(path) || "(none)"}`);

  let resolvedPath;
  let rootReal;
  try {
    rootReal = realpathSync(resolve(cwd || process.cwd()));
    resolvedPath = realpathSync(isAbsolute(path) ? path : resolve(cwd || process.cwd(), path));
  } catch (e) {
    return fail(`path unresolvable: ${e?.code || e?.message || e}`);
  }
  if (!containsPath(rootReal, resolvedPath)) {
    return fail("path outside session cwd (use the Bash tool for out-of-tree files)");
  }
  let st;
  try {
    st = statSync(resolvedPath);
  } catch (e) {
    return fail(`stat failed: ${e?.code || e?.message || e}`);
  }
  if (!st.isFile()) return fail("not a regular file");
  if (st.size > CHECK_MAX_FILE_BYTES) return fail(`file too large to check (${st.size} bytes)`);

  const base = { checker: checker.id, path, resolvedPath };

  if (checker.id === "json") {
    try {
      JSON.parse(readFileSync(resolvedPath, "utf8"));
      return { ok: true, ...base, output: "" };
    } catch (e) {
      return { ok: false, ...base, output: String(e?.message || e) };
    }
  }

  let cmd;
  let argv;
  if (checker.id === "node") {
    cmd = process.execPath;
    argv = ["--check", resolvedPath];
  } else if (checker.id === "python") {
    // ast.parse (not py_compile): pure — no __pycache__ side effects — and it
    // reports the failing line number.
    cmd = "python3";
    argv = ["-c", "import ast,sys; ast.parse(open(sys.argv[1],'rb').read(), sys.argv[1])", resolvedPath];
  } else {
    cmd = "bash";
    argv = ["-n", resolvedPath];
  }

  const { err, stdout, stderr } = await execCheck(cmd, argv, { cwd: rootReal, timeoutMs });
  if (!err) return { ok: true, ...base, output: "" };
  if (err.code === "ENOENT") return { ok: false, ...base, output: "", reason: `checker unavailable: ${cmd}` };
  if (err.killed) return { ok: false, ...base, output: "", reason: `check timed out after ${timeoutMs}ms` };
  const output = `${stderr}\n${stdout}`.trim();
  return { ok: false, ...base, output: output || String(err.message || err) };
}

const GIT_ENV = { GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" };
const GIT_CHANGES_MAX_LINES = 100;
const GIT_CHANGES_MAX_BYTES = 4096;

/**
 * Snapshot the git state of a directory: branch, upstream ahead/behind, dirty
 * changes (capped), recent commits. Returns null when the dir is not a repo or
 * git is unavailable/slow — callers treat the snapshot as best-effort ambient
 * context, never a hard dependency.
 */
export async function collectGitSnapshot(cwd, { timeoutMs = 1500 } = {}) {
  if (!cwd) return null;
  const opts = { cwd, timeoutMs, env: GIT_ENV };
  const [branchRes, statusRes, logRes] = await Promise.all([
    execCheck("git", ["rev-parse", "--abbrev-ref", "HEAD"], opts),
    execCheck("git", ["status", "--porcelain=v1", "--branch"], opts),
    execCheck("git", ["log", "--oneline", "-n", "5", "--no-decorate"], opts),
  ]);
  if (branchRes.err || statusRes.err) return null;

  const branch = branchRes.stdout.trim();
  const statusLines = statusRes.stdout.split("\n").filter(Boolean);
  let upstream = null;
  let ahead = 0;
  let behind = 0;
  if (statusLines[0]?.startsWith("##")) {
    const header = statusLines.shift();
    const up = header.match(/\.\.\.(\S+)/);
    if (up) upstream = up[1];
    const a = header.match(/ahead (\d+)/);
    const b = header.match(/behind (\d+)/);
    if (a) ahead = Number(a[1]);
    if (b) behind = Number(b[1]);
  }
  let changes = statusLines.slice(0, GIT_CHANGES_MAX_LINES);
  let bytes = 0;
  changes = changes.filter((l) => (bytes += l.length + 1) <= GIT_CHANGES_MAX_BYTES);

  return {
    branch,
    upstream,
    ahead,
    behind,
    dirty: changes.length > 0 || statusLines.length > 0,
    changes,
    recentCommits: logRes.err ? [] : logRes.stdout.split("\n").filter(Boolean),
    capturedAt: new Date().toISOString(),
  };
}
