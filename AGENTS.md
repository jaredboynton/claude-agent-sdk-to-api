# claude-agent-sdk-to-api — agent notes

Anthropic-compatible HTTP bridge over the Claude Agent SDK. See [README.md](README.md) for architecture and usage.

## Safe-Change Rules

### No timeout backstops

Do not add clock-based timeouts (turn watchdogs, park timers, HTTP turn deadlines, vm timeouts, etc.) to mask slow or hung work. They hide real failures and silently drop context instead of surfacing the bug to fix.

Agentic coding interfaces legitimately have long tool calls — large searches, builds, test runs, multi-wave code mode, client-side approval flows. Let work run until it completes or fails for a real, observable reason.

Turn teardown is event-driven off the SDK `query()` lifecycle: when the async iterator ends, errors, or is aborted, settle the turn immediately. A turn that never settles means the SDK stream genuinely never closed; root-cause that from the event stream rather than papering over it with a timer.

## Commands

- Test: `npm test`
