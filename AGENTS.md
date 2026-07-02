# claude-agent-sdk-to-api — agent notes

Anthropic-compatible HTTP bridge over the Claude Agent SDK. See [README.md](README.md) for architecture and usage.

## Safe-Change Rules

### No timeout backstops that mask work

Do not add clock-based timeouts (park timers, HTTP turn deadlines, vm timeouts, etc.) that silently cut off slow-but-healthy work. Agentic coding interfaces legitimately have long tool calls — large searches, builds, test runs, multi-wave code mode, client-side approval flows. Let work run until it completes or fails for a real, observable reason.

Turn teardown is event-driven off the SDK `query()` lifecycle: when the async iterator ends, errors, or is aborted, settle the turn immediately. The one sanctioned clock is the turn stall watchdog (`TURN_STALL_TIMEOUT_MS`): it fires only when an attached turn's session has had ZERO activity (no SDK events, no tool traffic) for the whole window, and it must LOUDLY dump session state and fail the turn with a real SSE error — never silently drop or retry. Healthy slow work bumps `lastActivity` and never trips it; a trip is a bug report, not a recovery.

### The `code` description is cache-critical

The rendered `code` tool description sits in every conversation's cached prompt prefix; changing its bytes re-writes that prefix at 2x. Its bytes may change only when the cache is already dead: fresh sessions and past-TTL resumes. Never re-render it for a live or warm-resumed conversation (warm resumes reuse the persisted frozen-toolset blob), and never edit the prose or schema rendering without deliberately regenerating `test/fixtures/code-description.golden.txt` — batch such edits into as few releases as possible. Tools that appear mid-conversation merge into the script runtime and are announced inside a code tool_result (append-only), never via the description.

## Commands

- Test: `npm test`
