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
- `src/server.mjs`: HTTP routes (/v1/messages, health, models, update, debug), Anthropic structured-output/OAuth passthroughs, and barrel re-exports of every module below (tests and bin/cli.mjs import through it).
- `src/session.mjs`: session store and lifecycle — `createSession`, the live SDK `query()` consumer, TTL sweeper, cwd resolution, resume-index persistence.
- `src/session-identity.mjs`: content-derived session identity (bucket/hash), transcript rendering, mimicry-safe cold-start priming, warm-action classification.
- `src/wire.mjs`: SSE plumbing, usage shaping, rate-limit header synthesis, Anthropic frame helpers.
- `src/turn-io.mjs`: turn lifecycle primitives shared by the session and code-run layers (writeEvent/endTurn/resolveTool, input queue).
- `src/client-tools.mjs`: client tool registration, JSON-Schema-to-Zod parsing, tool_use correlation, the parking MCP server, late-tool merging.
- `src/code-run.mjs`: dynamic code-run orchestration — wave dispatch, fabricated client turns, SDK event projection, tool-round teardown.
- `src/code-recovery.mjs`: code-mode tool_result routing plus stale-edit and chunked-read recovery turns.
- `src/metrics.mjs`: process-wide counters surfaced in /healthz.
- `src/caveman.mjs`: deterministic rule-based prose compression for cache-critical description bytes (versioned via CAVEMAN_RULES_VERSION).
- `src/debug-ring.mjs`: always-on in-memory debug ring with disk mirror, served at /debug/recent.
- `src/exec-command.mjs`: quoting-safe command construction for codemode.exec.
- `src/auth.mjs`: native-first Claude profile credential resolution and profile-dir preflight repair.
- `src/config.mjs`: `profiles.json` loading and validation for multi-profile runs.
- `src/code-mode.mjs` and `src/code-mode-worker.mjs`: `code({ script })` meta-tool description, ToolResult API, VM worker execution, batching, state, spill artifacts, script error formatting.
- `src/anchor-edit.mjs`: anchored Read/Edit/MultiEdit translation and cached byte snapshots.
- `src/read-recovery.mjs`: client Read/Edit failure classification, windowed Read planning, stale-read edit recovery.
- `src/local-checks.mjs`: daemon-side syntax checks and git snapshot helpers for code mode.
- `src/resume-index.mjs`: persistent SDK resume index, resume-catchup, frozen toolset blobs, cache-warm window rules.
- `src/cache-log.mjs`: opt-in per-turn cache receipt logging.
- `src/self-update.mjs`: npm registry polling, global-install gate, drain-aware relaunch, manual `POST /update` ticks via `registerManualUpdate()`.
- `scripts/`: live/integration validations that require a running bridge unless noted in the script header.
- `service/`: launchd/systemd templates rendered by `bin/cli.mjs install`.
- `test/`: focused `node:test` coverage; server tests use test seams exported from `src/server.mjs`.

## Development Docs

- `README.md`: architecture, setup, profile usage, code mode contract, env knobs, live validation commands.
- `docs/code-mode-cache-savings.md`: cache-cost model, measured receipts, frozen toolset rationale, cache-bust reporting workflow.
- `examples/`: sample profiles, Factory model config, and a curl/client tool round-trip.
- `test/fixtures/code-description.golden.txt`: byte-for-byte fixture for the rendered `code` tool description (caveman full, the production default); `code-description.off.golden.txt` locks the authored uncompressed render.

### Auto-update during development

Background npm polling is **off** on local launchd/systemd services while this repo is under active development. Installed services pass `--no-self-update`, set `CLAUDE_AGENT_API_NO_SELF_UPDATE=1`, and the operator kill switch at `~/Library/Application Support/claude-agent-api/auto-update.disabled` parks polling even when flags are removed.

Manual updates remain available over HTTP (polling not required):

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/update` | Update status snapshot (`pollActive`, `manualCheckAvailable`, `latestSeen`, `lastOutcome`, `installing`, `draining`, …) |
| `POST` | `/update` or `/update/check` | Run one registry check + gated `npm install -g` apply tick; drain-aware relaunch when a newer version lands |

`/healthz` also embeds the same `update` object for quick health probes. Re-enable background polling only after a fixed release is on npm: remove the kill switch, drop `--no-self-update` from the service template, and `claude-agent-api install` to rewrite LaunchAgents.

## Coding Conventions

- Keep modules ESM and use Node built-ins with the `node:` prefix, matching existing source.
- Prefer small pure helper modules for isolated behavior; keep `src/server.mjs` changes limited to HTTP/session orchestration and integration glue.
- Tests SHOULD exercise pure helpers directly and server behavior through existing exported test seams instead of spawning the daemon when unit coverage is enough.
- Comments SHOULD explain protocol, cache, lifecycle, or security invariants; avoid restating ordinary control flow.
- Do not add new runtime dependencies for behavior that Node core or existing helpers already cover.
- Keep generated or persisted runtime state out of the repo; `.env*`, logs, tarballs, and `node_modules/` stay ignored.

## File Placement Rules

- CLI behavior belongs in `bin/cli.mjs`; reusable config/auth/self-update logic belongs under `src/`.
- HTTP routing/passthrough changes belong in `src/server.mjs`; session lifecycle in `src/session.mjs`; identity/priming in `src/session-identity.mjs`; code-run orchestration in `src/code-run.mjs` / `src/code-recovery.mjs`. New seams must be re-exported from `src/server.mjs` (the barrel).
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

Never edit the `code` prose or schema rendering without deliberately regenerating both golden fixtures (`test/fixtures/code-description.golden.txt` and `code-description.off.golden.txt`); batch such edits into as few releases as possible. Tools that appear mid-conversation merge into the script runtime and are announced inside a `code` tool_result append-only, never via the description.

Caveman rule-table or protection-regex edits in `src/caveman.mjs` ARE description-byte changes: they rewrite the compressed render for every fresh session. Bump `CAVEMAN_RULES_VERSION`, regenerate both goldens, review the golden diff line-by-line for garbled prose (that diff is the compression QA gate), and batch with other description releases. Compression runs at the render layer only — never compress `session.toolsetRawTools`, the worker catalog (`codemode.describe` full docs), or anything inside a frozen blob.

### Auth and local state

- Native Claude profile auth is the default path. Do not copy OAuth tokens into project files or new stores; `src/auth.mjs` points `CLAUDE_CONFIG_DIR` at the selected profile and strips env vars that would shadow OAuth.
- Keep profile/session/cache-log/resume-index data outside the repo. Examples may use `~` paths, never hardcoded absolute user paths.
- Preserve profile separation: one bridge process per profile/port; do not share mutable session stores across profiles.

## Testing and Quality

- Run `npm test` for normal verification.
- If `src/code-mode.mjs`, `src/anchor-edit.mjs`, `src/caveman.mjs`, tool schema rendering, or the `code` description changes, run `node --test test/code-description.golden.test.mjs`.
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
