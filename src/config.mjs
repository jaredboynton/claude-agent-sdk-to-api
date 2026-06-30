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
      codeMode: p.codeMode === false ? false : true,
      cacheLog: p.cacheLog === true,
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
