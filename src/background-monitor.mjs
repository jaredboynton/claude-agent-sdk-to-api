// Background-command monitoring: pure helpers behind codemode.monitor() and
// the worker's auto-monitor seam. When a client backgrounds a shell command
// ("Command running in background with ID: ..."), the worker keeps watching it
// through the client's own monitor tool in synthetic waves - zero model
// round-trips - and resolves the original await with the finished output,
// instead of the model babysitting an output file one poll per turn.

// Poll pacing. Env-tunable so tests can run at millisecond cadence; the code
// worker thread inherits the daemon's env at spawn.
export const DEFAULT_POLL_START_MS = Number(process.env.CODE_MONITOR_POLL_MS || 2_000);
export const DEFAULT_POLL_MAX_MS = Number(process.env.CODE_MONITOR_POLL_MAX_MS || 15_000);
export const DEFAULT_MONITOR_MAX_MS = Number(process.env.CODE_MONITOR_MAX_MS || 30 * 60 * 1000);
// A blocking TaskOutput wave produces no tool_result while the client waits;
// re-issue the block every 4 minutes to stay inside the bridge's park/stall
// ceilings while still letting the client do all the waiting.
export const TASK_BLOCK_TIMEOUT_MS = Number(process.env.CODE_MONITOR_BLOCK_MS || 240_000);

/**
 * Parse a client "backgrounded" banner out of a tool result. Known shapes:
 *   Claude Code Bash:  "Command running in background with ID: bash_3"
 *   Task harnesses:    "Command running in background with ID: abc123.
 *                       Output is being written to: /path/task.output."
 */
export function parseBackgroundBanner(text) {
  const s = String(text ?? "");
  const id = s.match(/running in background with ID:?\s*([A-Za-z0-9][\w.-]*)/i);
  if (!id) return null;
  const path = s.match(/output is being written to:?\s*(\S+)/i);
  return {
    id: id[1].replace(/[.,]+$/, ""),
    outputPath: path ? path[1].replace(/[.,]+$/, "") : null,
  };
}

/** Exit/status markers across clients (BashOutput tags, task/exec trailers). */
export function parseCompletion(text) {
  const s = String(text ?? "");
  const exit = s.match(/<exit_code>\s*(-?\d+)\s*<\/exit_code>/i)
    || s.match(/\[Process exited with code (-?\d+)\]/i)
    || s.match(/\bprocess exited with code (-?\d+)/i)
    || s.match(/\(exit code:?\s*(-?\d+)\)/i);
  if (exit) return { done: true, exitCode: Number(exit[1]) };
  const status = s.match(/<status>\s*(completed|failed|killed)\s*<\/status>/i)
    || s.match(/\bstatus:?\s*(completed|failed|killed)\b/i);
  if (status) return { done: true, exitCode: /completed/i.test(status[1]) ? 0 : null };
  return { done: false, exitCode: null };
}

/** A blocking monitor call that reports the task is still going. */
export function looksRunning(text) {
  return /<status>\s*running\s*<\/status>|\bstatus:?\s*running\b|\bstill running\b|\bin[- ]progress\b/i
    .test(String(text ?? ""));
}

/**
 * Choose how to watch a backgrounded command with this client's toolset.
 * Preference: blocking TaskOutput (the client waits; ~zero polls) >
 * BashOutput increments > Read on the reported output file. Returns
 * { kind, tool, incremental, buildArgs(remainingMs) } or null.
 */
export function pickMonitorStrategy(toolDocs, banner, toolOverride = "") {
  const names = new Set(
    (Array.isArray(toolDocs) ? toolDocs : []).map((d) => d?.name).filter((n) => typeof n === "string"),
  );
  const build = {
    TaskOutput: () => ({
      kind: "task",
      tool: "TaskOutput",
      incremental: false,
      buildArgs: (remainingMs) => ({
        task_id: banner.id,
        block: true,
        timeout: Math.max(5_000, Math.min(TASK_BLOCK_TIMEOUT_MS, Math.floor(remainingMs) || TASK_BLOCK_TIMEOUT_MS)),
      }),
    }),
    BashOutput: () => ({
      kind: "bashout",
      tool: "BashOutput",
      incremental: true,
      buildArgs: () => ({ bash_id: banner.id }),
    }),
    Read: () => (banner.outputPath ? {
      kind: "read",
      tool: "Read",
      incremental: false,
      buildArgs: () => ({ file_path: banner.outputPath }),
    } : null),
  };
  const order = toolOverride ? [String(toolOverride)] : ["TaskOutput", "BashOutput", "Read"];
  for (const name of order) {
    if (!build[name] || (!toolOverride && !names.has(name))) continue;
    const s = build[name]();
    if (s) return s;
  }
  return null;
}

/** Strip the Read tool's line-number gutter when most lines carry it. */
export function stripReadGutter(text) {
  const s = String(text ?? "");
  const lines = s.split("\n");
  const guttered = lines.filter((l) => /^\s*\d+→/.test(l)).length;
  if (!guttered || guttered < Math.ceil(lines.length * 0.5)) return s;
  return lines.map((l) => {
    const m = l.match(/^\s*\d+→(.*)$/);
    return m ? m[1] : l;
  }).join("\n");
}

/** 1.5x backoff from startMs, capped at maxMs. */
export function nextPollDelay(attempt, startMs = DEFAULT_POLL_START_MS, maxMs = DEFAULT_POLL_MAX_MS) {
  const n = Math.max(0, Number(attempt) || 0);
  return Math.min(Math.round(startMs * Math.pow(1.5, n)), Math.max(startMs, maxMs));
}
