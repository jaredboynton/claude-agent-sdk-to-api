# claude-agent-sdk-to-api — agent notes

Anthropic-compatible HTTP bridge over the Claude Agent SDK. See [README.md](README.md) for architecture and usage.

## Safe-Change Rules

### No timeout backstops

Do not add clock-based timeouts (turn watchdogs, park timers, HTTP turn deadlines, vm timeouts, etc.) to mask slow or hung work. They hide real failures and silently drop context instead of surfacing the bug to fix.

Agentic coding interfaces legitimately have long tool calls — large searches, builds, test runs, multi-wave code mode, client-side approval flows. Let work run until it completes or fails for a real, observable reason.

Turn teardown is event-driven off the SDK `query()` lifecycle: when the async iterator ends, errors, or is aborted, settle the turn immediately. A turn that never settles means the SDK stream genuinely never closed; root-cause that from the event stream rather than papering over it with a timer.

### The `code` description is cache-critical

The rendered `code` tool description sits in every conversation's cached prompt prefix; changing its bytes re-writes that prefix at 2x. Its bytes may change only when the cache is already dead: fresh sessions and past-TTL resumes. Never re-render it for a live or warm-resumed conversation (warm resumes reuse the persisted frozen-toolset blob), and never edit the prose or schema rendering without deliberately regenerating `test/fixtures/code-description.golden.txt` — batch such edits into as few releases as possible. Tools that appear mid-conversation merge into the script runtime and are announced inside a code tool_result (append-only), never via the description.

## Commands

- Test: `npm test`
