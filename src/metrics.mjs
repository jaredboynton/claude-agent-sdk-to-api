// metrics.mjs - process-wide observability counters shared across the bridge
// modules, surfaced in /healthz. A single mutable object (not per-module let
// bindings) because ESM forbids reassigning an imported binding across modules.

const LOG_PREFIX = "[claude-agent-api]";

// Process-wide counters. FIFO fallbacks make correlation regressions a
// visible metric instead of a silent park timeout; code counters feed /healthz
// and per-turn cache receipts.
const metrics = {
  totalFifoFallbacks: 0,
  totalCodeCalls: 0,
  totalCodeSubCalls: 0,
  totalCodeErrors: 0,
  totalCodeWaves: 0,
  totalCodeRecoveries: 0,
  totalCacheReadTokens: 0,
  totalCacheCreationTokens: 0,
  totalMimicryDetections: 0,
};

export { LOG_PREFIX, metrics };
