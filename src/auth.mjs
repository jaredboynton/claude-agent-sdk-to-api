// Native-first credential resolution.
//
// The Claude Agent SDK spawns a bundled `claude` binary that authenticates the
// SAME way the Claude Code CLI does: it reads the OAuth credentials for the
// profile named by CLAUDE_CONFIG_DIR (macOS Keychain item "Claude Code-
// credentials", namespaced per config dir, with a `<profile>/.credentials.json`
// plaintext fallback). So to use an already-logged-in profile we simply point
// CLAUDE_CONFIG_DIR at it and let the SDK authenticate natively. We do NOT pull
// the token into a separate store.
//
// Precedence (native-first): an explicitly supplied token wins, otherwise the
// profile's own login is used.
//   1. --token-file <path>            (explicit; highest)
//   2. CLAUDE_CODE_OAUTH_TOKEN in env (explicit)
//   3. native profile login           (default)
//
// Anything that could shadow the OAuth path (API keys, Bedrock/Vertex, base-URL
// overrides) is stripped, mirroring the `oauth` mode of a Claude Code launcher.

import { homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { readFileSync, lstatSync, statSync, mkdirSync, readlinkSync, readdirSync } from "node:fs";

// Variables that would redirect the SDK away from native OAuth. Always cleared.
const SHADOWING_VARS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "AWS_PROFILE",
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
  "AWS_BEARER_TOKEN_BEDROCK",
];

// Expand a leading ~ to the home directory.
export function expandHome(p, home = homedir()) {
  if (!p) return p;
  if (p === "~") return home;
  if (p.startsWith("~/")) return join(home, p.slice(2));
  return p;
}

// Resolve the profile (config) directory: explicit --profile, else
// CLAUDE_CONFIG_DIR from env, else ~/.claude.
export function resolveProfileDir({ profile, env = process.env, home = homedir() } = {}) {
  const raw = profile || env.CLAUDE_CONFIG_DIR || join(home, ".claude");
  return expandHome(raw, home);
}

// Read the non-secret account metadata a profile records, to confirm/log which
// login a port is bound to. Returns null when it can't be determined (the SDK is
// still the source of truth; absence is a warning, not a failure).
export function readProfileAccount(configDir) {
  try {
    const j = JSON.parse(readFileSync(join(configDir, ".claude.json"), "utf8"));
    const o = j.oauthAccount || {};
    const email = o.emailAddress || o.email || null;
    const org = o.organizationName || o.organizationRole || null;
    if (email || org) return { email, org };
    return null;
  } catch {
    return null;
  }
}

// Pure: compute the auth plan (env mutations) without applying them.
export function resolveAuthPlan({ profile, tokenFile, env = process.env, home = homedir() } = {}) {
  const configDir = resolveProfileDir({ profile, env, home });

  let token = null;
  let tokenSource = null;
  if (tokenFile) {
    token = readFileSync(expandHome(tokenFile, home), "utf8").trim();
    if (!token) throw new Error(`OAuth token file is empty: ${tokenFile}`);
    tokenSource = "file";
  } else if (env.CLAUDE_CODE_OAUTH_TOKEN && env.CLAUDE_CODE_OAUTH_TOKEN.trim()) {
    token = env.CLAUDE_CODE_OAUTH_TOKEN.trim();
    tokenSource = "env";
  }

  const mode = token ? "token" : "native";
  const set = { CLAUDE_CONFIG_DIR: configDir };
  const unset = [...SHADOWING_VARS];

  if (mode === "token") {
    set.CLAUDE_CODE_OAUTH_TOKEN = token;
  } else {
    // Native: make sure no inherited token shadows the profile login.
    unset.push("CLAUDE_CODE_OAUTH_TOKEN");
  }

  return { mode, configDir, tokenSource, token, set, unset };
}

// Apply an auth plan to a process environment (defaults to process.env).
export function applyAuth(plan, env = process.env) {
  for (const [k, v] of Object.entries(plan.set)) env[k] = v;
  for (const k of plan.unset) delete env[k];
  return plan;
}

// Directories the bundled `claude` binary writes into during a session. A
// dangling symlink here is unrecoverable for the CLI: the path component
// lstat()s fine so mkdir won't replace it, but resolving through it ENOENTs
// (e.g. `mkdir <profile>/session-env/<id>` fails mid-session). Only recreating
// the symlink *target* fixes it, which is what the preflight does.
const REQUIRED_PROFILE_DIRS = ["session-env", "shell-snapshots", "projects", "todos", "statsig", "debug"];

function statOrNull(fn, p) {
  try { return fn(p); } catch { return null; }
}

// Ensure one path resolves to a real directory. Returns {status, target?, reason?}:
// status is "ok" | "repaired" | "would-repair" | "error".
function ensureDirResolves(p, repair) {
  const l = statOrNull(lstatSync, p);
  if (!l) {
    // Missing entirely: a plain dir is what the CLI would create itself.
    if (!repair) return { status: "would-repair", target: p, reason: "missing" };
    try { mkdirSync(p, { recursive: true }); } catch (e) { return { status: "error", reason: `mkdir failed: ${e.message}` }; }
    return { status: "repaired", target: p, reason: "missing" };
  }
  const s = statOrNull(statSync, p);
  if (s) return s.isDirectory() ? { status: "ok" } : { status: "error", reason: "exists but is not a directory" };
  if (!l.isSymbolicLink()) return { status: "error", reason: "unresolvable non-symlink entry" };
  // Dangling symlink: recreate the target, never touch the link or user data.
  let target;
  try { target = resolve(dirname(p), readlinkSync(p)); } catch (e) { return { status: "error", reason: `readlink failed: ${e.message}` }; }
  if (!repair) return { status: "would-repair", target, reason: "dangling symlink" };
  try { mkdirSync(target, { recursive: true }); } catch (e) { return { status: "error", target, reason: `mkdir target failed: ${e.message}` }; }
  const after = statOrNull(statSync, p);
  if (!after?.isDirectory()) return { status: "error", target, reason: "still unresolvable after recreating target (multi-hop dangling chain?)" };
  return { status: "repaired", target, reason: "dangling symlink" };
}

// Validate (and by default repair) the resolved profile dir so the SDK's
// bundled CLI can write into it. Auto-repairs required dirs (data-safe: only
// ever mkdir), errors on what repair can't fix (files squatting on required
// names, permissions), and warns about other dangling symlinks without
// touching them (many targets are files like CLAUDE.md — mkdir would be wrong).
export function preflightProfileDir(configDir, { repair = true, requiredDirs = REQUIRED_PROFILE_DIRS } = {}) {
  const repaired = [];
  const warnings = [];
  const errors = [];

  const root = ensureDirResolves(configDir, repair);
  if (root.status === "error") {
    return { ok: false, configDir, repaired, warnings, errors: [{ entry: ".", reason: root.reason }] };
  }
  if (root.status === "repaired") repaired.push({ entry: ".", target: root.target, reason: root.reason });
  if (root.status === "would-repair") errors.push({ entry: ".", reason: `${root.reason} (repair would create ${root.target})` });

  for (const name of requiredDirs) {
    const r = ensureDirResolves(join(configDir, name), repair);
    if (r.status === "repaired") repaired.push({ entry: name, target: r.target, reason: r.reason });
    else if (r.status === "would-repair") errors.push({ entry: name, reason: `${r.reason} (repair would create ${r.target})` });
    else if (r.status === "error") errors.push({ entry: name, reason: r.reason });
  }

  // Informational: other dangling symlinks in the profile dir (not repaired).
  try {
    for (const d of readdirSync(configDir, { withFileTypes: true })) {
      if (!d.isSymbolicLink() || requiredDirs.includes(d.name)) continue;
      const p = join(configDir, d.name);
      if (!statOrNull(statSync, p)) {
        let target = null;
        try { target = resolve(configDir, readlinkSync(p)); } catch {}
        warnings.push({ entry: d.name, target, reason: "dangling symlink" });
      }
    }
  } catch {}

  return { ok: errors.length === 0, configDir, repaired, warnings, errors };
}

// Convenience: resolve + apply, returning the plan and the resolved account.
export function setupAuth({ profile, tokenFile, env = process.env, home = homedir() } = {}) {
  const plan = resolveAuthPlan({ profile, tokenFile, env, home });
  applyAuth(plan, env);
  const account = readProfileAccount(plan.configDir);
  const preflight = preflightProfileDir(plan.configDir, { repair: true });
  return { ...plan, account, preflight };
}
