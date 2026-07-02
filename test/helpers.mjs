// Shared teardown for server-seam tests. A test that fails mid-run must not
// leave a live code-mode Worker (a ref'd handle) pinning the test process:
// node --test waits for each file's event loop to drain, so one leaked run
// idles the suite until the 5-minute stall watchdog reaps it. Draining aborts
// the run (terminating its Worker) without touching resolvedResults, so a test
// can still assert on the collapsed result it captured before teardown.

import { clearAllCodeState } from "../src/server.mjs";

export function drainSession(session) {
  if (!session) return;
  session.currentTurn = null;
  session.res = null;
  try { clearAllCodeState(session); } catch {}
}
