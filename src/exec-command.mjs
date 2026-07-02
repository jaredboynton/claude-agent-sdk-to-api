// codemode.exec command composition: run an inline script through the
// client's shell tool with zero quoting hazards.
//
// Models keep reaching for `node -e '<script>'` / `python -c '...'` one-liners
// through the client's shell tool. The shell arithmetic-expands `$[...]`,
// splits on embedded quotes, and eats backslashes, so a correct script arrives
// mangled ("syntax error: operand expected"). The observed fallback -- write a
// temp file with one tool call, run it with another -- adds a second failure
// mode when the write silently errors or lands outside the sandbox the shell
// sees. buildExecCommand() collapses both steps into ONE shell command with no
// model-authored bytes exposed to shell parsing: the source travels as base64
// (shell-inert alphabet), is decoded into a mktemp file, executed, and cleaned
// up, with the interpreter's exit status preserved. Execution still happens
// through the client's own shell tool, so the client's permission system stays
// in the loop -- this module only composes strings.

const MAX_SOURCE_BYTES = 256 * 1024; // stays well under ARG_MAX after base64 expansion

// Shell tools recognized across client harnesses (Claude Code Bash,
// Droid/Factory Execute, ...). Ordered: first present name wins.
const PREFERRED_SHELL_TOOLS = [
  "Bash", "Execute", "Shell", "bash", "shell", "execute",
  "run_command", "run_shell_command", "run_terminal_cmd", "terminal",
];
const SHELLISH_NAME_RE = /bash|shell|terminal|exec|command/i;
const COMMAND_ARG_RE = /\bcommand\??:\s*string\b/;

/** POSIX single-quote: safe for any byte except NUL. */
export function shQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/** File extension for the temp script. Only node truly cares (ESM vs CJS). */
export function inferExt(interpreter, source, ext) {
  if (ext) {
    const norm = ext.startsWith(".") ? ext : `.${ext}`;
    if (!/^\.[A-Za-z0-9]+$/.test(norm)) throw new Error(`invalid ext: ${ext}`);
    return norm;
  }
  const base = String(interpreter).split("/").pop() || "";
  if (/^node/i.test(base)) {
    const esm = /^\s*(import|export)\s/m.test(source) && !/\brequire\s*\(/.test(source);
    return esm ? ".mjs" : ".cjs";
  }
  if (/^python/i.test(base)) return ".py";
  if (/^(ba|z|da|k)?sh$/i.test(base)) return ".sh";
  return "";
}

/**
 * Compose the single shell command. The interpreter runs in a subshell so a
 * `cwd` never leaks into persistent client shells; the temp dir is removed
 * afterward with the interpreter's exit status preserved.
 */
export function buildExecCommand({ source, interpreter = "node", args = [], cwd = "", ext = "" } = {}) {
  const src = String(source ?? "");
  if (!src.trim()) throw new Error("source is empty");
  const bytes = Buffer.byteLength(src, "utf8");
  if (bytes > MAX_SOURCE_BYTES) throw new Error(`source too large (${bytes} bytes; max ${MAX_SOURCE_BYTES})`);
  const b64 = Buffer.from(src, "utf8").toString("base64");
  const runner = String(interpreter || "node");
  const fileExt = inferExt(runner, src, String(ext || ""));
  const file = `"$__cma_d/exec${fileExt}"`;
  const argv = (Array.isArray(args) ? args : [args]).map((a) => ` ${shQuote(String(a))}`).join("");
  const run = `${shQuote(runner)} ${file}${argv}`;
  const inner = cwd ? `cd ${shQuote(String(cwd))} && ${run}` : run;
  return `__cma_d="$(mktemp -d)" && printf '%s' '${b64}' | base64 --decode > ${file} && (${inner}); __cma_s=$?; [ -n "\${__cma_d:-}" ] && rm -rf "$__cma_d"; (exit $__cma_s)`;
}

/** Pick the client's shell tool from normalized tool docs. Null if none. */
export function pickShellTool(toolDocs = []) {
  const docs = Array.isArray(toolDocs) ? toolDocs : [];
  const names = new Set(docs.map((d) => d?.name).filter((n) => typeof n === "string"));
  for (const name of PREFERRED_SHELL_TOOLS) {
    if (names.has(name)) return name;
  }
  for (const doc of docs) {
    if (!doc || typeof doc.name !== "string") continue;
    if (SHELLISH_NAME_RE.test(doc.name) && COMMAND_ARG_RE.test(String(doc.docs || ""))) return doc.name;
  }
  return null;
}
