# claude-agent-sdk-to-api - agent notes

Anthropic-compatible HTTP bridge over the Claude Agent SDK. It exposes `/v1/messages` for clients that speak the Anthropic Messages API while authenticating through local Claude Code OAuth profiles. See `README.md` for user-facing setup and protocol details.

## Tech Stack

- Runtime: Node.js >= 20, ESM modules.
- Public entrypoints: `bin/cli.mjs` for the CLI, `src/server.mjs` for the package export.
- Core dependencies: `@anthropic-ai/claude-agent-sdk`, `zod`, `semver`.
- Tests: Node's built-in `node:test`; no separate lint/typecheck command is defined.
- Packaging: npm package `@jaredboynton/claude-agent-api`; published files are controlled by the `files` allowlist in `package.json`.

## Architecture and Navigation

- `bin/cli.mjs`: CLI subcommands (`run`, `start-all`, `install`, `uninstall`, `list`, `status`, `doctor`), auth setup, service orchestration, self-update startup.
- `src/server.mjs`: HTTP server, Anthropic SSE passthrough, session identity, live SDK `query()` lifecycle, parked client-tool handlers, cwd resolution, health/model endpoints.
- `src/auth.mjs`: native-first Claude profile credential resolution and profile-dir preflight repair.
- `src/config.mjs`: `profiles.json` loading and validation for multi-profile runs.
- `src/code-mode.mjs` and `src/code-mode-worker.mjs`: `code({ script })` meta-tool description, ToolResult API, VM worker execution, batching, state, spill artifacts, script error formatting.
- `src/anchor-edit.mjs`: anchored Read/Edit/MultiEdit translation and cached byte snapshots.
- `src/read-recovery.mjs`: client Read/Edit failure classification, windowed Read planning, stale-read edit recovery.
- `src/local-checks.mjs`: daemon-side syntax checks and git snapshot helpers for code mode.
- `src/resume-index.mjs`: persistent SDK resume index, resume-catchup, frozen toolset blobs, cache-warm window rules.
- `src/cache-log.mjs`: opt-in per-turn cache receipt logging.
- `src/self-update.mjs`: npm registry polling, global-install gate, drain-aware relaunch.
- `scripts/`: live/integration validations that require a running bridge unless noted in the script header.
- `service/`: launchd/systemd templates rendered by `bin/cli.mjs install`.
- `test/`: focused `node:test` coverage; server tests use test seams exported from `src/server.mjs`.

## Development Docs

- `README.md`: architecture, setup, profile usage, code mode contract, env knobs, live validation commands.
- `docs/code-mode-cache-savings.md`: cache-cost model, measured receipts, frozen toolset rationale, cache-bust reporting workflow.
- `examples/`: sample profiles, Factory model config, and a curl/client tool round-trip.
- `test/fixtures/code-description.golden.txt`: byte-for-byte fixture for the rendered `code` tool description.

## Coding Conventions

- Keep modules ESM and use Node built-ins with the `node:` prefix, matching existing source.
- Prefer small pure helper modules for isolated behavior; keep `src/server.mjs` changes limited to HTTP/session orchestration and integration glue.
- Tests SHOULD exercise pure helpers directly and server behavior through existing exported test seams instead of spawning the daemon when unit coverage is enough.
- Comments SHOULD explain protocol, cache, lifecycle, or security invariants; avoid restating ordinary control flow.
- Do not add new runtime dependencies for behavior that Node core or existing helpers already cover.
- Keep generated or persisted runtime state out of the repo; `.env*`, logs, tarballs, and `node_modules/` stay ignored.

## File Placement Rules

- CLI behavior belongs in `bin/cli.mjs`; reusable config/auth/self-update logic belongs under `src/`.
- Protocol/session changes belong in `src/server.mjs` unless they can be isolated into a pure helper module.
- Code-mode runtime or description changes belong in `src/code-mode.mjs` / `src/code-mode-worker.mjs`; update the golden fixture only deliberately.
- Edit reliability behavior belongs in `src/anchor-edit.mjs` or `src/read-recovery.mjs`, not ad hoc inside unrelated server paths.
- Add tests next to the closest existing coverage in `test/*.test.mjs`; put stable byte fixtures under `test/fixtures/`.
- Add user-facing examples under `examples/`; add daemon/service templates under `service/`.

## Safe-Change Rules

### No timeout backstops that mask work

Do not add clock-based timeouts (park timers, HTTP turn deadlines, vm timeouts, etc.) that silently cut off slow-but-healthy work. Agentic coding interfaces legitimately have long tool calls: large searches, builds, test runs, multi-wave code mode, client-side approval flows. Let work run until it completes or fails for a real, observable reason.

Turn teardown is event-driven off the SDK `query()` lifecycle: when the async iterator ends, errors, or is aborted, settle the turn immediately. The one sanctioned clock is the turn stall watchdog (`TURN_STALL_TIMEOUT_MS`): it fires only when an attached turn's session has had zero activity (no SDK events, no tool traffic) for the whole window, and it must loudly dump session state and fail the turn with a real SSE error. Healthy slow work bumps `lastActivity` and never trips it; a trip is a bug report, not a recovery.

### The `code` description is cache-critical

The rendered `code` tool description sits in every conversation's cached prompt prefix; changing its bytes re-writes that prefix at 2x. Its bytes may change only when the cache is already dead: fresh sessions and past-TTL resumes. Never re-render it for a live or warm-resumed conversation; warm resumes reuse the persisted frozen-toolset blob.

Never edit the `code` prose or schema rendering without deliberately regenerating `test/fixtures/code-description.golden.txt`; batch such edits into as few releases as possible. Tools that appear mid-conversation merge into the script runtime and are announced inside a `code` tool_result append-only, never via the description.

### Auth and local state

- Native Claude profile auth is the default path. Do not copy OAuth tokens into project files or new stores; `src/auth.mjs` points `CLAUDE_CONFIG_DIR` at the selected profile and strips env vars that would shadow OAuth.
- Keep profile/session/cache-log/resume-index data outside the repo. Examples may use `~` paths, never hardcoded absolute user paths.
- Preserve profile separation: one bridge process per profile/port; do not share mutable session stores across profiles.

## Testing and Quality

- Run `npm test` for normal verification.
- If `src/code-mode.mjs`, `src/anchor-edit.mjs`, tool schema rendering, or the `code` description changes, run `node --test test/code-description.golden.test.mjs`.
- If the golden description change is intentional, regenerate with `UPDATE_GOLDEN=1 node --test test/code-description.golden.test.mjs`, then run `npm test`.
- For live code-mode behavior, start a bridge first (`npm start -- --profile ~/.claude --port 32809`) and run the relevant `scripts/live-*.mjs` command from `README.md`.
- For cache-bust analysis, use `node scripts/cache-bust-report.mjs <cache-log.jsonl>` against logs produced with `--cache-log` or `CACHE_LOG=1`.

## Commands

- Install: `npm install`
- Run one bridge: `npm start -- --profile ~/.claude --port 32809`
- Test: `npm test`
- Code description golden check: `node --test test/code-description.golden.test.mjs`
- Regenerate code description golden: `UPDATE_GOLDEN=1 node --test test/code-description.golden.test.mjs`
- Live code-mode smoke: `node scripts/live-code-mode.mjs <port>`
- Cache-bust report: `node scripts/cache-bust-report.mjs <path/to/cache-log.jsonl>`
