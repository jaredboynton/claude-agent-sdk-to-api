# claude-agent-sdk-to-api

Expose the [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) as an Anthropic-compatible `/v1/messages` HTTP API, authenticating natively off your already-logged-in Claude OAuth profiles.

Any client that speaks the Anthropic Messages API (Factory Droid, custom agents, scripts) can drive a **multi-turn tool loop** through the SDK while billing against your Claude subscription, with no API key and no token copied into a separate store.

## Why this exists

The Claude Agent SDK owns tool execution and the assistant transcript. Its streaming input accepts **only user frames**, so a stateless one-shot `query()` per request cannot drive a client that executes its own tools across turns (it can't ingest a pre-baked assistant/`tool_use` history).

A client like Factory Droid speaks the stateless Anthropic API: it POSTs the full history each turn, executes `tool_use` blocks itself, and POSTs back `tool_result`. This bridge reconciles the two models by holding **one live `query()` per conversation**:

- **Session identity** = hash(system + first user message) + a prefix match of the already-processed history. Two conversations that diverge at any turn get separate sessions and cannot bleed into each other.
- **Tools become real MCP handlers.** When the model calls a tool, the handler *parks* on a promise and the `tool_use` streams to the client as SSE; the HTTP turn ends so the client can execute it. The client POSTs the `tool_result` on the next request, the bridge resolves the parked promise by `(tool name, input)` correlation, and the same live session continues.
- **Cold start** (model swap / idle eviction / restart): a fresh session is primed with the full prior transcript so context is recovered; the live loop still drives every new tool call.

## Requirements

- Node.js >= 20
- Logged-in Claude Code profile(s). The SDK's bundled `claude` reads OAuth credentials for the profile named by `CLAUDE_CONFIG_DIR` (macOS Keychain, with a `<profile>/.credentials.json` fallback). Log in with `claude` / `claude setup-token` as usual.

## Quickstart

```bash
npx claude-agent-api --profile ~/.claude --port 32809
# or, from a clone:
npm install && npm start -- --profile ~/.claude --port 32809
```

Health check:

```bash
curl -s http://127.0.0.1:32809/healthz
# {"ok":true,"service":"claude-agent-api","port":32809,"account":"you@example.com","sessions":0}
```

## Authentication (native-first)

The bridge points `CLAUDE_CONFIG_DIR` at a profile and lets the SDK authenticate itself. Precedence:

1. `--token-file <path>` (explicit)
2. `CLAUDE_CODE_OAUTH_TOKEN` in env (explicit)
3. **native profile login** (default)

Variables that could shadow the OAuth path (`ANTHROPIC_API_KEY`, Bedrock/Vertex, base-URL overrides) are stripped automatically.

## Multiple logins, one port each

Run one bridge per profile. Create a `profiles.json` (see `examples/profiles.json`):

```json
{
  "profiles": [
    { "name": "personal", "configDir": "~/.claude", "port": 32809 },
    { "name": "work", "configDir": "~/.claude-work", "port": 32810 }
  ]
}
```

```bash
claude-agent-api start-all --config profiles.json   # foreground, one child per profile
claude-agent-api install   --config profiles.json   # launchd (macOS) / systemd (Linux) per profile
claude-agent-api list      --config profiles.json
claude-agent-api status    --config profiles.json
claude-agent-api doctor    --config profiles.json   # preflight: login + port availability
```

Separate processes mean separate session stores, so profiles never bleed into each other.

## Use from Factory Droid

Add a custom model pointing at the bridge port (see `examples/factory-model.json`). `provider` is `anthropic` (the bridge speaks the standard Messages API) and `apiKey` is unused (the bridge authenticates natively off the Claude profile), but a non-empty placeholder is required by the client:

```json
{
  "model": "claude-opus-4-8",
  "id": "custom:Claude-Opus-OAuth",
  "displayName": "Claude Opus (OAuth)",
  "provider": "anthropic",
  "baseUrl": "http://127.0.0.1:32809",
  "apiKey": "not-used"
}
```

## Use from any client

See `examples/curl-and-client.mjs` for a complete tool round-trip: POST a message, get a `tool_use` back, execute it, POST the `tool_result`, and let the live session continue.

## Code mode (opt-out by default)

When enabled (the default), the bridge collapses the client's N tools into one deterministic `code({ calls, script })` meta-tool for the model. The model declares all client tool invocations upfront in `calls[]`; the bridge expands them into normal `tool_use` blocks for the unchanged client, collapses N `tool_result`s, runs the script in a JS sandbox, and returns only the script's output to the model. This reduces context growth (especially raw tool results) and improves cache-read efficiency on multi-tool turns.

The original client tools are still exposed alongside `code`, so clients keep their native schemas and interactive/approval/user-input flows can run directly instead of being forced through batching.

**Contract:** every sub-tool call must be listed in `calls[]` up front. The `script` processes results but cannot add new tool calls after seeing them. Data-dependent chaining requires a second `code` call on the next turn.

**Opt out:** set `"codeMode": false` on a profile in `profiles.json`, pass `--code-mode 0` to `claude-agent-api run`, or send `X-Code-Mode: 0` on a request.

**Security:** scripts run in `node:vm`, which is not a hard sandbox. The daemon is local and the model is already authorized to request tools, but do not expose this to untrusted callers without hardening (e.g. `isolated-vm`).

Live validation (requires a running bridge):

- `node scripts/live-code-mode.mjs <port>` — smoke test: one expand/collapse round-trip with mocked tool results; confirms the client stream is transparent (no `code` block) and the collapse completes without a park timeout.
- `node scripts/live-code-mode-agent-task.mjs <port>` — thorough agent workflow: drives a real research-to-code-to-validate task (web search, multi-file generation in a temp project, allowlisted command validation, iterative fixes) and asserts code mode stayed transparent under a multi-turn, multi-tool workload. Requires network for `WebSearch`. Env: `MAX_TURNS`, `KEEP_CODE_MODE_FIXTURE=1`, `MODEL`.

## Environment knobs

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `32809` | Listen port (also `--port`) |
| `HOST` | `127.0.0.1` | Listen host (also `--host`) |
| `SESSION_TTL_MS` | `300000` | Idle session eviction (matches Claude prompt cache) |
| `TOOL_TIMEOUT_MS` | `1800000` | Parked-tool watchdog; returns an error result so the loop survives |
| `HEARTBEAT_MS` | `15000` | SSE keep-alive interval |
| `CODE_SCRIPT_TIMEOUT_MS` | `10000` | Code-mode script sandbox timeout |
| `CODE_SCRIPT_MAX_OUTPUT_BYTES` | `32768` | Maximum collapsed code result before returning a "summarize smaller" error |
| `X-Code-Mode` | (default on) | Per-request header: `0` disables, `1` enables code mode |
| `CACHE_LOG` | (off) | `1`/`true` → append a per-turn usage row to `<profileDir>/cache-log.jsonl`; or set a path. Also `--cache-log [path]` on `run`, or `"cacheLog": true` per profile |

## Cache log (per-turn usage receipts)

With `--cache-log` (or `CACHE_LOG=1`), the bridge appends one JSON line per completed HTTP turn capturing the turn's `read`/`create` (cache-read / cache-creation), `input`, and `output` tokens, plus `conv` (conversation id), `model`, `codeMode`, `codeSubCalls`, and `scriptOutBytes`. Cache tokens come from the authoritative `message_start` usage and are summed across all upstream messages in the turn (including code-mode internal continuations). Group by `conv` and price with the Opus card to turn the [code-mode savings model](docs/code-mode-cache-savings.md) into measured receipts. The writer is opt-in, append-only (survives restarts), and never throws into the request path. `/healthz` reports the active `cacheLog` path.

## Tests

```bash
npm test   # node --test test/*.test.mjs
```

## License

MIT
