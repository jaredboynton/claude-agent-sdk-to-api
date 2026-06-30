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
import { join } from "node:path";
import { readFileSync } from "node:fs";

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

// Convenience: resolve + apply, returning the plan and the resolved account.
export function setupAuth({ profile, tokenFile, env = process.env, home = homedir() } = {}) {
  const plan = resolveAuthPlan({ profile, tokenFile, env, home });
  applyAuth(plan, env);
  const account = readProfileAccount(plan.configDir);
  return { ...plan, account };
}
