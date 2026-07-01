#!/usr/bin/env node
// Receipts-based cache-bust report over a cache-log.jsonl (enable logging with
// --cache-log / CACHE_LOG=1; see docs/code-mode-cache-savings.md).
//
// Per conversation (grouped by `conv`), flags:
//   - descHash changing between rows closer together than the warm window —
//     a frozen-toolset violation: the `code` description re-wrote a prefix
//     that was still cached. Must be zero.
//   - non-first rows with cache_creation > cache_read — prefix re-write
//     suspects (expected only on past-TTL resumes and cold re-primes).
// Prices flagged turns with the Opus card ($/MTok: read 0.50, 5m write 6.25,
// 1h write 10.00) so busts show up in dollars.
//
// Usage: node scripts/cache-bust-report.mjs <path/to/cache-log.jsonl>

import { readFileSync } from "node:fs";
import { CACHE_WARM_WINDOW_MS } from "../src/resume-index.mjs";

const WRITE_5M_PER_MTOK = 6.25;
const WRITE_1H_PER_MTOK = 10;

const path = process.argv[2];
if (!path) {
  console.error("usage: node scripts/cache-bust-report.mjs <cache-log.jsonl>");
  process.exit(2);
}

const rows = readFileSync(path, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => { try { return JSON.parse(l); } catch { return null; } })
  .filter((r) => r && r.conv);

const convs = new Map();
for (const r of rows) {
  if (!convs.has(r.conv)) convs.set(r.conv, []);
  convs.get(r.conv).push(r);
}

const writeCost = (r) => ((r.create5m || 0) * WRITE_5M_PER_MTOK + (r.create1h || 0) * WRITE_1H_PER_MTOK) / 1e6;

let descViolations = 0;
let rewriteSuspects = 0;
let suspectCost = 0;
for (const [conv, list] of convs) {
  list.sort((a, b) => new Date(a.ts) - new Date(b.ts));
  for (let i = 1; i < list.length; i++) {
    const prev = list[i - 1];
    const cur = list[i];
    const gap = new Date(cur.ts) - new Date(prev.ts);
    if (prev.descHash && cur.descHash && prev.descHash !== cur.descHash && gap < CACHE_WARM_WINDOW_MS) {
      descViolations++;
      console.log(`DESC-CHANGE conv=${conv.slice(0, 8)} ts=${cur.ts} gap=${Math.round(gap / 1000)}s ${prev.descHash} -> ${cur.descHash} action=${cur.action} ($${writeCost(cur).toFixed(4)})`);
    }
    if ((cur.create || 0) > (cur.read || 0)) {
      rewriteSuspects++;
      suspectCost += writeCost(cur);
      console.log(`REWRITE-SUSPECT conv=${conv.slice(0, 8)} ts=${cur.ts} action=${cur.action} read=${cur.read || 0} create=${cur.create || 0} gap=${Math.round(gap / 1000)}s ($${writeCost(cur).toFixed(4)})`);
    }
  }
}

console.log("---");
console.log(`${convs.size} conversations, ${rows.length} turns`);
console.log(`warm-window descHash violations: ${descViolations} (must be 0)`);
console.log(`mid-conversation re-write suspects: ${rewriteSuspects} ($${suspectCost.toFixed(4)} in cache writes)`);
process.exit(descViolations ? 1 : 0);
