// profiles.json loading + validation for the multi-profile orchestrator.
//
// Shape:
//   {
//     "profiles": [
//       { "name": "personal", "configDir": "~/.claude-",     "port": 32809 },
//       { "name": "work",     "configDir": "~/.claude-work", "port": 32810 }
//     ]
//   }
//
// Each entry becomes one bridge process: one profile, one port, one credential
// set. Separate processes mean separate session stores, so profiles cannot bleed
// into each other.

import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { expandHome } from "./auth.mjs";

// Default search order for the orchestrator config.
export function defaultConfigPath({ env = process.env, home = homedir() } = {}) {
  if (env.CLAUDE_AGENT_API_CONFIG) return expandHome(env.CLAUDE_AGENT_API_CONFIG, home);
  return join(home, ".config", "claude-agent-api", "profiles.json");
}

// Per-profile caveman compression level. Absent -> null (bridge default,
// full). Boolean shorthands map to the extremes; anything else must name a
// level explicitly so a typo cannot silently change cached-prefix bytes.
function normalizeProfileCaveman(v, name) {
  if (v === undefined || v === null) return null;
  if (v === true) return "full";
  if (v === false) return "off";
  const s = String(v).trim().toLowerCase();
  if (s === "full" || s === "lite") return s;
  if (s === "off" || s === "0") return "off";
  throw new Error(`profile "${name}" has invalid "caveman" value ${JSON.stringify(v)} (use "full", "lite", or "off")`);
}

// Pure validation + normalization. Throws on the first structural problem.
export function validateProfilesConfig(obj, { home = homedir() } = {}) {
  if (!obj || typeof obj !== "object") throw new Error("config must be a JSON object");
  const list = obj.profiles;
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error('config must have a non-empty "profiles" array');
  }

  const seenPorts = new Map();
  const seenNames = new Set();
  const profiles = list.map((p, i) => {
    if (!p || typeof p !== "object") throw new Error(`profiles[${i}] must be an object`);
    const name = p.name;
    if (!name || typeof name !== "string") throw new Error(`profiles[${i}] needs a string "name"`);
    if (seenNames.has(name)) throw new Error(`duplicate profile name: ${name}`);
    seenNames.add(name);

    const configDir = p.configDir || p.profile || p.dir;
    if (!configDir || typeof configDir !== "string") {
      throw new Error(`profile "${name}" needs a string "configDir"`);
    }

    const port = p.port;
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`profile "${name}" needs an integer "port" in 1..65535`);
    }
    if (seenPorts.has(port)) {
      throw new Error(`duplicate port ${port} (used by "${seenPorts.get(port)}" and "${name}")`);
    }
    seenPorts.set(port, name);

    return {
      name,
      configDir: expandHome(configDir, home),
      port,
      host: typeof p.host === "string" ? p.host : "127.0.0.1",
      cacheLog: p.cacheLog === true,
      caveman: normalizeProfileCaveman(p.caveman, name),
    };
  });

  return { profiles };
}

// Read + parse + validate a profiles.json file.
export function loadProfilesConfig(path, { home = homedir() } = {}) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    throw new Error(`cannot read config at ${path}: ${e.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`invalid JSON in ${path}: ${e.message}`);
  }
  return validateProfilesConfig(parsed, { home });
}
