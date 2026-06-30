#!/usr/bin/env node
// claude-agent-api — CLI entrypoint.
//
// Subcommands:
//   (default) / run   Run one bridge in the foreground for a single profile.
//   start-all         Spawn one bridge process per profile in profiles.json.
//   install           Render + load per-profile services (launchd / systemd).
//   uninstall         Unload + remove the per-profile services.
//   list              Print configured profiles (name, configDir, port).
//   status            GET /healthz for each configured profile's port.
//   doctor            Preflight: profile login + port availability.
//
// Auth is native-first (src/auth.mjs): the bridge points CLAUDE_CONFIG_DIR at an
// already-logged-in Claude profile and lets the SDK authenticate itself. A token
// is only used if --token-file or CLAUDE_CODE_OAUTH_TOKEN is explicitly set.

import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir, platform } from "node:os";
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from "node:fs";

import { setupAuth, resolveProfileDir, readProfileAccount, expandHome } from "../src/auth.mjs";
import { startServer } from "../src/server.mjs";
import { loadProfilesConfig, defaultConfigPath } from "../src/config.mjs";
import { startAutoUpdateLoop, defaultStatePath } from "../src/self-update.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(__dirname, "..");
const HOME = homedir();
const PKG = JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf8"));

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        args[key] = true;
      } else {
        args[key] = next;
        i++;
      }
    } else {
      args._.push(a);
    }
  }
  return args;
}

function die(msg, code = 1) {
  process.stderr.write(`claude-agent-api: ${msg}\n`);
  process.exit(code);
}

// ---------------------------------------------------------------------------
// run — one bridge, foreground.
// ---------------------------------------------------------------------------
function cmdRun(args) {
  const port = Number(args.port || process.env.PORT || process.env.ACP_BRIDGE_PORT || 32809);
  const host = args.host || process.env.HOST || process.env.ACP_BRIDGE_HOST || "127.0.0.1";
  const profile = args.profile || args["config-dir"];
  const tokenFile = args["token-file"];

  const auth = setupAuth({ profile, tokenFile });
  process.stderr.write(
    `claude-agent-api: auth mode=${auth.mode}` +
      (auth.tokenSource ? ` (token from ${auth.tokenSource})` : "") +
      ` profile=${auth.configDir}` +
      (auth.account?.email ? ` account=${auth.account.email}` : "") +
      "\n"
  );
  startServer({
    port, host, account: auth.account, profileDir: auth.configDir, version: PKG.version,
    codeMode: args["code-mode"] !== "0" && args["code-mode"] !== "false",
    cacheLog: args["cache-log"] ?? process.env.CACHE_LOG,
  });

  if (!args["no-self-update"] && process.env.CLAUDE_AGENT_API_NO_SELF_UPDATE !== "1") {
    startAutoUpdateLoop({
      pkgName: PKG.name,
      ownInstallDir: PKG_ROOT,
      currentVersion: PKG.version,
      statePath: defaultStatePath(HOME),
    });
  }
}

// ---------------------------------------------------------------------------
// config helpers
// ---------------------------------------------------------------------------
function resolveConfig(args) {
  const path = args.config ? expandHome(args.config, HOME) : defaultConfigPath();
  if (!existsSync(path)) {
    die(
      `no profiles config at ${path}\n` +
        `  create one (see examples/profiles.json) or pass --config <path>.`
    );
  }
  return { path, config: loadProfilesConfig(path, { home: HOME }) };
}

// ---------------------------------------------------------------------------
// start-all — one child process per profile.
// ---------------------------------------------------------------------------
function cmdStartAll(args) {
  const { path, config } = resolveConfig(args);
  process.stderr.write(`claude-agent-api: starting ${config.profiles.length} profile(s) from ${path}\n`);

  const children = [];
  for (const p of config.profiles) {
    const child = spawn(
      process.execPath,
      [join(__dirname, "cli.mjs"), "run", "--no-self-update", "--profile", p.configDir, "--port", String(p.port), "--host", p.host].concat(
        p.codeMode === false ? ["--code-mode", "0"] : [],
      ).concat(
        // boolean form so each child logs to its own <profileDir>/cache-log.jsonl
        (args["cache-log"] || p.cacheLog) ? ["--cache-log"] : [],
      ),
      { stdio: ["ignore", "inherit", "inherit"], env: { ...process.env, CLAUDE_AGENT_API_NO_SELF_UPDATE: "1" } }
    );
    process.stderr.write(`claude-agent-api: [${p.name}] pid=${child.pid} port=${p.port} configDir=${p.configDir}\n`);
    children.push({ p, child });
  }

  const stop = () => {
    for (const { child } of children) { try { child.kill("SIGTERM"); } catch {} }
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  for (const { p, child } of children) {
    child.on("exit", (code) => {
      process.stderr.write(`claude-agent-api: [${p.name}] exited code=${code}\n`);
    });
  }
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------
function cmdList(args) {
  const { path, config } = resolveConfig(args);
  process.stdout.write(`profiles (${path}):\n`);
  for (const p of config.profiles) {
    process.stdout.write(`  ${p.name.padEnd(16)} ${String(p.port).padEnd(7)} ${p.configDir}\n`);
  }
}

// ---------------------------------------------------------------------------
// status — GET /healthz per port.
// ---------------------------------------------------------------------------
async function cmdStatus(args) {
  const { config } = resolveConfig(args);
  for (const p of config.profiles) {
    let line = `  ${p.name.padEnd(16)} :${p.port} `;
    try {
      const r = await fetch(`http://${p.host}:${p.port}/healthz`, { signal: AbortSignal.timeout(3000) });
      const j = await r.json();
      line += `UP   sessions=${j.sessions ?? "?"} account=${j.account ?? "?"}`;
    } catch (e) {
      line += `DOWN (${e.name === "TimeoutError" ? "timeout" : e.message})`;
    }
    process.stdout.write(line + "\n");
  }
}

// ---------------------------------------------------------------------------
// doctor — preflight login + port availability.
// ---------------------------------------------------------------------------
function portFree(port, host) {
  return new Promise((resolve) => {
    const s = createServer();
    s.once("error", () => resolve(false));
    s.once("listening", () => s.close(() => resolve(true)));
    s.listen(port, host);
  });
}

async function cmdDoctor(args) {
  // Single-profile doctor when --profile is given; else the whole config.
  let entries;
  if (args.profile) {
    const configDir = resolveProfileDir({ profile: args.profile });
    entries = [{ name: "(cli)", configDir, port: Number(args.port || 32809), host: args.host || "127.0.0.1" }];
  } else {
    entries = resolveConfig(args).config.profiles;
  }

  let problems = 0;
  for (const p of entries) {
    const acct = readProfileAccount(p.configDir);
    const loggedIn = !!acct;
    const free = await portFree(p.port, p.host);
    if (!loggedIn) problems++;
    if (!free) problems++;
    process.stdout.write(
      `  ${p.name.padEnd(16)} configDir=${p.configDir}\n` +
        `      login: ${loggedIn ? `OK (${acct.email})` : "NOT CONFIRMED (no oauthAccount in .claude.json)"}\n` +
        `      port ${p.port}: ${free ? "free" : "IN USE"}\n`
    );
  }
  if (problems) die(`${problems} problem(s) found`, 1);
  process.stdout.write("doctor: all checks passed\n");
}

// ---------------------------------------------------------------------------
// install / uninstall — per-profile OS service.
// ---------------------------------------------------------------------------
function renderTemplate(tpl, vars) {
  return tpl.replace(/\{\{(\w+)\}\}/g, (_, k) => (k in vars ? vars[k] : `{{${k}}}`));
}

function cmdInstall(args) {
  const { config } = resolveConfig(args);
  const isMac = platform() === "darwin";
  const nodeBin = process.execPath;
  const serverPath = join(__dirname, "cli.mjs");

  if (isMac) {
    const tpl = readFileSync(join(PKG_ROOT, "service", "launchd.plist.template"), "utf8");
    const dir = join(HOME, "Library", "LaunchAgents");
    mkdirSync(dir, { recursive: true });
    for (const p of config.profiles) {
      const label = `com.jaredboynton.claude-agent-api.${p.name}`;
      const out = join(dir, `${label}.plist`);
      const logDir = join(HOME, "Library", "Logs");
      const xml = renderTemplate(tpl, {
        LABEL: label, NODE: nodeBin, SERVER: serverPath, PROFILE: p.configDir,
        PORT: String(p.port), HOST: p.host,
        HOME,
        PATH: [dirname(nodeBin), join(HOME, ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":"),
        STDOUT: join(logDir, `claude-agent-api.${p.name}.out.log`),
        STDERR: join(logDir, `claude-agent-api.${p.name}.err.log`),
      });
      writeFileSync(out, xml);
      runSync("launchctl", ["unload", out]);
      runSync("launchctl", ["load", out]);
      process.stdout.write(`installed + loaded: ${out}\n`);
    }
  } else {
    const tpl = readFileSync(join(PKG_ROOT, "service", "systemd.service.template"), "utf8");
    const dir = join(HOME, ".config", "systemd", "user");
    mkdirSync(dir, { recursive: true });
    for (const p of config.profiles) {
      const unit = `claude-agent-api@${p.name}.service`;
      const out = join(dir, unit);
      const txt = renderTemplate(tpl, {
        NODE: nodeBin, SERVER: serverPath, PROFILE: p.configDir, PORT: String(p.port), HOST: p.host,
      });
      writeFileSync(out, txt);
      process.stdout.write(`installed: ${out}\n`);
    }
    runSync("systemctl", ["--user", "daemon-reload"]);
    process.stdout.write(`run: systemctl --user enable --now claude-agent-api@<name>\n`);
  }
}

function cmdUninstall(args) {
  const { config } = resolveConfig(args);
  const isMac = platform() === "darwin";
  if (isMac) {
    const dir = join(HOME, "Library", "LaunchAgents");
    for (const p of config.profiles) {
      const out = join(dir, `com.jaredboynton.claude-agent-api.${p.name}.plist`);
      if (existsSync(out)) {
        runSync("launchctl", ["unload", out]);
        unlinkSync(out);
        process.stdout.write(`removed: ${out}\n`);
      }
    }
  } else {
    const dir = join(HOME, ".config", "systemd", "user");
    for (const p of config.profiles) {
      const out = join(dir, `claude-agent-api@${p.name}.service`);
      if (existsSync(out)) { unlinkSync(out); process.stdout.write(`removed: ${out}\n`); }
    }
    runSync("systemctl", ["--user", "daemon-reload"]);
  }
}

function runSync(cmd, cmdArgs) {
  try {
    const { status } = spawnSync(cmd, cmdArgs, { stdio: "ignore" });
    return status === 0;
  } catch {
    return false;
  }
}

function usage() {
  process.stdout.write(
    `claude-agent-api — expose the Claude Agent SDK as an Anthropic /v1/messages API\n\n` +
      `Usage:\n` +
      `  claude-agent-api [run] --profile <configDir> --port <n> [--host h] [--token-file f] [--no-self-update] [--cache-log [path]]\n` +
      `  claude-agent-api start-all [--config profiles.json]\n` +
      `  claude-agent-api install   [--config profiles.json]\n` +
      `  claude-agent-api uninstall [--config profiles.json]\n` +
      `  claude-agent-api list      [--config profiles.json]\n` +
      `  claude-agent-api status    [--config profiles.json]\n` +
      `  claude-agent-api doctor    [--config profiles.json | --profile <dir> --port <n>]\n`
  );
}

async function main() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  const cmd = args._[0] && !args._[0].startsWith("-") ? args._[0] : "run";

  switch (cmd) {
    case "run": return cmdRun(args);
    case "start-all": return cmdStartAll(args);
    case "list": return cmdList(args);
    case "status": return cmdStatus(args);
    case "doctor": return cmdDoctor(args);
    case "install": return cmdInstall(args);
    case "uninstall": return cmdUninstall(args);
    case "help": case "--help": case "-h": return usage();
    default:
      // Treat unknown leading token as run (so `--profile x` with no subcommand works).
      if (cmd && !(cmd in { run: 1 })) {
        usage();
        return die(`unknown command: ${cmd}`);
      }
      return cmdRun(args);
  }
}

main().catch((e) => die(e?.stack || String(e)));
