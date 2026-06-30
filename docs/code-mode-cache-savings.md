# Code Mode — Cache-Cost Savings Analysis

_How the `code({ calls, script })` meta-tool reduces Anthropic prompt-cache spend. Prices are the Opus 4.8 card ($/MTok): input $5.00, cache read $0.50 (0.1×), cache write 5m $6.25 (1.25×), output $25.00._

> Status: **model, not yet measured receipts.** The per-session and org numbers below come from a parameterized model whose inputs are measured from real logs/transcripts, but the round-trip and compression factors are small-sample. The companion logger — per-turn `cache_read`/`cache_creation` to `cache-log.jsonl` (now shipped; run with `--cache-log`) — replaces this model with ground truth once enough sessions accumulate.

## TL;DR

Code mode cuts prompt-cache cost two ways at once:

1. **Fewer model round-trips** — each round-trip re-reads the *entire* cached prefix. Code mode does more tool work per round (and collapses dependent chains into one script), so there are fewer full-prefix reads.
2. **Less transcript bloat** — raw tool outputs never enter the model context; only the script's return value does. This shrinks every subsequent cache read **and** the one-time cache write.

| Lever | Reduction (measured-floor → long-session) |
|---|---|
| cache **read** | **25% → 61%** (grows with session length; reads are quadratic in length) |
| cache **write** | **~48%** (all session lengths) |

**Org extrapolation (hypothetical):** on **$1M/yr** of agentic (Claude-Code-style) spend — ~79% of which is cache operations — applying these bands to the cache buckets yields **~$170K/yr (conservative) → ~$380K/yr (aggressive)** in avoided cache spend, i.e. **~17% → ~38% of the bill**. For scale, a cache-break *preservation* lever (recovering the ~2% of requests that miss cache) tops out at ~$16K/yr on the same $1M; code mode acts on the read/write **volume of the 98% that already hit**, a structurally larger lever.

---

## 1. Mechanism

In the standard agentic loop, every tool round is a separate `/v1/messages` call, and every call re-reads the whole conversation prefix as a cache read (0.1×) plus writes the new delta as a cache write (1.25×). So cost has two structural drivers: **how many round-trips** and **how big the prefix is**.

Code mode attacks both:

- **Round-trips.** The model emits one `code` call declaring N sub-calls; the bridge expands them to N client tool calls, runs them, and feeds the results to the model's `script`. Independent *and dependent* operations resolve in a single round-trip (the script does the branching that would otherwise require returning to the model). Fewer round-trips → fewer full-prefix reads.
- **Bloat.** Raw tool outputs go into the script's sandbox, not the transcript. Only the script's return value (often a tiny processed summary) is appended to the model's context. Every later turn re-reads that small value instead of the full raw output, and the one-time write is smaller too.

---

## 2. Measured parameters (from this daemon)

From `claude-agent-api.oauth-pers.err.log` (code-mode sessions) and a 1,388-sample tool-output corpus across all local transcripts:

| Symbol | Meaning | Value | Source |
|---|---|---|---|
| `ρ` | raw tool output per op (tokens) | **764** | mean of 1,388 real `tool_result` bodies |
| `p_n` | tool ops per round-trip, normal mode | **2.27** | 22 normal-mode assistant turns w/ tools |
| `p_c` | sub-calls per code call (ops/round-trip) | **3.04** | 23 code calls (70 sub-calls) |
| `c` | code-return compression = `r / (s·ρ)` | **0.52** | 27,937 returned tok / 53,480 raw-equiv tok |
| `B` | cached baseline (system + 15 tool schemas + seed) | **~12,000** | estimate; sensitivity noted |

Code-call shape (n=23): mean **3.04** sub-calls, median 3, max 6; distribution `{1:3, 2:5, 3:8, 4:3, 5:3, 6:1}`. Tool mix: `Read 25, LS 11, Execute 9, Grep 6, Glob 6, WriteFile 4, Create 4, AskUser 2, WebSearch 2, RunValidation 1`.

Script returns (n=21): total **111,747 B** (~27,937 tok), mean 5,321 B, median **1,270 B** — the median shows most calls return a small summary; the mean is pulled up by a few large dumps.

**Reliability tax (observed):** of 23 code calls, **3 validation failures, 1 script failure, 1 park-timeout**. These recover (retry in the same conversation) but add latency and a small number of wasted turns; the model below does not credit this tax.

---

## 3. The formula

Cache-read cost is **quadratic in session length**: every round re-reads the whole growing prefix.

```
ReadTokens  = B·T + (p · growth_per_op) · T²/2
WriteTokens = W · growth_per_op            (writes telescope to the final prefix)

  normal:  T = W/p_n,   growth_per_op = ρ         (raw output enters transcript)
  code:    T = W/p_c,   growth_per_op = c·ρ       (only script return enters transcript)
```

where `W` = total tool operations in the session, `T` = round-trips, priced at read $0.50 / write $6.25 per MTok.

**Asymptotic reduction ratios (code ÷ normal):**

- cache read, short-session limit (baseline-dominated): `p_n/p_c` = **0.75 → 25% reduction**
- cache read, long-session limit (the T² term dominates): `c · p_n/p_c` = **0.39 → 61% reduction**
- cache write (all lengths): `c` = **0.52 → 48% reduction**

The read win *grows with session length* because the quadratic term rewards slimmer per-turn growth — long agentic sessions benefit most.

---

## 4. Per-session projection (Opus 4.8)

| W (tool ops) | round-trips n→c | cache-read reduction | cache-write reduction | $ saved / session |
|---|---|---|---|---|
| 20 | 9 → 7 | 39% | 48% | $0.08 |
| 50 | 22 → 16 | 47% | 48% | $0.28 |
| 100 | 44 → 33 | 52% | 48% | $0.81 |
| 300 | 132 → 99 | 58% | 48% | $5.50 |
| 800 | 352 → 263 | 60% | 48% | $35.21 |

---

## 5. Org extrapolation

Take a **hypothetical $1M/yr** agentic (Claude-Code-style) bill. Cache operations dominate at ~79%:

| token type | $/yr (per $1M bill) | share |
|---|---|---|
| cache read | $440K | 44% |
| cache write (5m+1h) | $350K | 35% |
| output | $120K | 12% |
| base input | $90K | 9% |

Applying the reduction bands to the cache buckets, with a batchability haircut (not every tool call is batchable):

| Scenario | assumptions | cache-read saved | cache-write saved | **Total /yr (per $1M)** |
|---|---|---|---|---|
| Conservative | short sessions (25%), 60% batchable | $66K | $101K | **$167K (~17%)** |
| Moderate | mixed lengths (45%), 75% batchable | $155K | $126K | **$281K (~28%)** |
| Aggressive | long sessions (56%), 90% batchable | $230K | $151K | **$381K (~38%)** |

**Context vs a cache-preservation lever:** a *preservation* play (recovering the ~2% of requests that miss cache) tops out at **~$16K/yr** on the same $1M because it recovers only the miss tail. Code mode reduces the read/write **volume on the 98% that hit**, so it operates on the whole bill, not the break tail — an order of magnitude larger, at the cost of changing model behavior (and the reliability tax in §2).

---

## 6. Caveats

- **Small samples.** `p_n` (22 turns) and `p_c` (23 calls) are the most load-bearing parameters and come from one machine's traffic; re-measure at scale.
- **`ρ` and `c` vary widely.** Scripts sometimes return large payloads (a 31 KB dump was observed), which erodes the bloat win. The 0.1.6 typed-signature description and the "return only what you need" nudge push `c` down.
- **Deployment assumption.** The org figures assume the code-mode pattern is applied across the org's agentic traffic, not just this bridge.
- **Reliability tax excluded.** Validation/script failures and the one park-timeout (§2) add latency and a few wasted turns not debited here.
- **Baseline `B`** affects only short-session reductions; the interesting (long-session) regime is dominated by the quadratic term and is insensitive to `B`.

## 7. Reproduce

- Log stats: parse `~/Library/Logs/claude-agent-api.oauth-pers.err.log` for `code call … sub-calls` and `scriptOut=… bytes`.
- Tool-output corpus: scan `~/.claude/projects/**/*.jsonl` `tool_result` block sizes.
- Org bill: scale the per-$1M table in §5 to your own annual agentic spend; for ground truth, use the cache log below.
- Ground truth (implemented): run with `--cache-log` (or `CACHE_LOG=1`) to append per-turn `read`/`create`/`input`/`output` rows to `<profileDir>/cache-log.jsonl`, keyed by `conv`. Group by `conv` and price with the Opus card to replace this model's `p_n`/`p_c`/`c` estimates with measured per-conversation cache spend.
