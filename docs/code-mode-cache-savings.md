# Code Mode — Cache-Cost Savings Analysis

_How the `code({ calls, script })` meta-tool reduces Anthropic prompt-cache spend. Prices are the Opus 4.8 card ($/MTok): input $5.00, cache read $0.50 (0.1×), output $25.00, and cache write **$10.00 (1h, 2×)** — the bundled Claude Code (v2.1.196) puts SDK `querySource` on the `tengu_prompt_cache_1h_config` allowlist, so writes use the 1-hour TTL (5m at $6.25/1.25× applies only if forced via `FORCE_PROMPT_CACHING_5M`)._

> Status: **measured, not modeled.** Parameters below come from (a) a real normal-mode baseline of **2,411 Claude Code sessions / 101,524 API responses** mined from local transcripts, and (b) a live `--cache-log` code-mode conversation (16 turns). The one soft spot is `p_c` (batching rate), which is one conversation; the bands in §5 hinge on workload batchability, not on the cache mechanics.

## TL;DR

Code mode cuts prompt-cache cost two ways at once:

1. **Fewer model round-trips** — each round-trip re-reads the *entire* cached prefix. Real Claude Code serializes tools (**1.12 ops/round-trip**, parallelizing only 7.3% of the time); code mode declares **2.57 ops per call**, so it does the same work in ~2.3× fewer full-prefix reads.
2. **Less transcript bloat** — raw tool outputs never enter the model context; only the script's return value does (measured compression **0.46×**). This shrinks every subsequent cache read **and** the one-time cache write.

| Lever | Reduction (short-session → long-session) |
|---|---|
| cache **read** | **56% → 80%** (grows with session length; reads are quadratic in length) |
| cache **write** | **~54%** (all session lengths) |

**Org extrapolation (hypothetical):** on **$1M/yr** of agentic (Claude-Code-style) spend — ~84% of which is cache operations (read 46% + write 38%) — applying these bands with a batchability haircut yields **~$290K/yr (conservative) → ~$510K/yr (aggressive)** in avoided cache spend, i.e. **~29% → ~51% of the bill**. For scale, a cache-break *preservation* lever (recovering the ~2% of requests that miss cache) tops out at ~$16K/yr on the same $1M; code mode acts on the read/write **volume of the 98% that already hit**, a structurally larger lever.

---

## 1. Mechanism

In the standard agentic loop, every tool round is a separate `/v1/messages` call, and every call re-reads the whole conversation prefix as a cache read (0.1×) plus writes the new delta as a cache write (1h, 2×). So cost has two structural drivers: **how many round-trips** and **how big the prefix is**.

Code mode attacks both:

- **Round-trips.** The model emits one `code` call; the script calls tools via `await tools.X(args)`, and the bridge drives each `await`ed call as a wave of synthetic client tool calls. **Dependent chains collapse into one `code` call** — the script branches/loops on results and calls the next tool from inside the same script, so a K-step chain (read → decide → grep → read) becomes 1 model round-trip instead of K. Fewer round-trips → fewer full-prefix reads. This is the dominant lever because real Claude Code overwhelmingly does **one tool per round-trip** (§2).
- **Bloat.** Raw tool outputs go into the script's sandbox, not the transcript. Only the script's return value (often a tiny processed summary) is appended to the model's context. Every later turn re-reads that small value instead of the full raw output, and the one-time write is smaller too.

---

## 2. Measured parameters

Normal-mode baseline mined from `~/.claude-/projects/**/*.jsonl` (2,411 sessions), **keyed by `message.id`** so one API response counts once (Claude Code splits a response across several JSONL lines — naive per-line counting double-counts usage and hides parallel tools). Code-mode figures from the live `cache-log.jsonl`.

| Symbol | Meaning | Value | Source |
|---|---|---|---|
| `ρ` | raw tool output per op (tokens) | **719** | mean of **90,948** real `tool_result` bodies (median 51 B, p90 4.4 KB) |
| `p_n` | tool ops per round-trip, normal mode | **1.12** | 75,344 tool-bearing responses; median 1, p90 1, max 15; **only 7.3% parallelize** |
| `p_c` | tool calls per `code` call (across all waves) | **2.57** | 14 code calls (36 tool calls / waves), one live conversation — now counts dynamic in-script calls, not a static manifest |
| `c` | code-return compression = `r / (s·ρ)` | **0.46** | 11,901 returned tok / 25,884 raw-equiv tok |
| `B` | cached baseline (system + tool schemas + seed) | **~12,000** | estimate; matters only for short sessions |

**Real Claude Code is serial.** Across 101,524 API responses, the model emits ~1 tool per turn and parallelizes only 7.3% of the time — so the round-trip lever (`p_n → p_c`) is ~2.3×, roughly **double** an earlier per-line estimate (2.27) that was inflated by message splitting.

**Cache TTL is 1h.** 55,155 responses created 1h cache vs 4,962 at 5m (92% 1h), so writes are priced at $10/MTok (2×), not $6.25.

**Bill shape (priced 1h, real corpus):** read **46%** / cache write **38%** / output **15%** / base input **1%** — read:create token ratio **23.6 : 1**. Per session: mean **$3.86**, median **$0.96** (long tail).

**Reliability tax (observed earlier):** a minority of code calls hit validation/script/park-timeout failures that recover in-conversation but add latency and a few wasted turns; the model below does not debit this tax.

---

## 3. The formula

Cache-read cost is **quadratic in session length**: every round re-reads the whole growing prefix.

```
ReadTokens  = B·(W/p) + growth_per_op · W²/(2p)
WriteTokens = B + W · growth_per_op            (writes telescope to the final prefix)

  normal:  p = p_n,   growth_per_op = ρ         (raw output enters transcript)
  code:    p = p_c,   growth_per_op = c·ρ       (only script return enters transcript)
```

where `W` = total tool operations, `T = W/p` round-trips, priced at read $0.50 / write $10.00 per MTok.

**Asymptotic reduction ratios (code ÷ normal):**

- cache read, short-session limit (baseline-dominated): `p_n/p_c` = **0.44 → 56% reduction**
- cache read, long-session limit (the W² term dominates): `c · p_n/p_c` = **0.20 → 80% reduction**
- cache write (all lengths): `c` = **0.46 → 54% reduction**

The read win *grows with session length* because the quadratic term rewards slimmer per-turn growth — long agentic sessions benefit most.

---

## 4. Per-session projection (Opus 4.8, 1h pricing)

| W (tool ops) | round-trips n→c | cache-read reduction | cache-write reduction | $ saved / session |
|---|---|---|---|---|
| 20 | 18 → 8 | 65% | 29% | $0.19 |
| 50 | 45 → 19 | 71% | 40% | $0.67 |
| 100 | 89 → 39 | 74% | 46% | $1.97 |
| 300 | 268 → 117 | 78% | 51% | $13.62 |
| 800 | 714 → 311 | 79% | 53% | $87.65 |

(Assumes every op is batchable — the ceiling. §5 applies a batchability haircut.)

---

## 5. Org extrapolation

Take a **hypothetical $1M/yr** agentic (Claude-Code-style) bill, split with the **measured** bucket shares from §2:

| token type | $/yr (per $1M bill) | share |
|---|---|---|
| cache read | $459K | 46% |
| cache write (1h) | $376K | 38% |
| output | $154K | 15% |
| base input | $11K | 1% |

Applying the reduction bands to the cache buckets, with a batchability haircut (not every serial call can be merged into one manifest — data-dependent chains still need separate code calls):

| Scenario | assumptions | cache-read saved | cache-write saved | **Total /yr (per $1M)** |
|---|---|---|---|---|
| Conservative | read −60%, 60% batchable | $165K | $122K | **$287K (~29%)** |
| Moderate | read −72%, 75% batchable | $248K | $152K | **$400K (~40%)** |
| Aggressive | read −80%, 90% batchable | $330K | $183K | **$513K (~51%)** |

**Context vs a cache-preservation lever:** a *preservation* play (recovering the ~2% of requests that miss cache) tops out at **~$16K/yr** on the same $1M because it recovers only the miss tail. Code mode reduces the read/write **volume on the 98% that hit**, so it operates on the whole bill, not the break tail — an order of magnitude larger, at the cost of changing model behavior (and the reliability tax in §2).

---

## 6. Caveats

- **`p_c` is one conversation.** The batching rate (2.57) and compression (0.46) come from a single 16-turn live session; re-measure as `cache-log.jsonl` accumulates. `p_n`, `ρ`, TTL, and bill shape are robust (2,411 sessions).
- **Batchability is the real uncertainty.** The mechanics give a 56–80% read lever, but realized savings = `batchability × lever`. Data-dependent chains (read → decide → act) can't collapse into one manifest. The §5 spread is mostly this knob.
- **`ρ` and `c` vary widely.** Tool results are tiny at the median (51 B) but heavy-tailed (p90 4.4 KB); a few large script dumps erode the bloat win. The 0.1.6 typed-signature description and the "return only what you need" nudge push `c` down.
- **No live A/B yet.** These compare a real normal-mode corpus to a separate code-mode session, not the *same* task both ways. Run `scripts/live-code-mode-agent-task.mjs` with code mode on vs `X-Code-Mode: 0` to diff one task directly.
- **Baseline `B`** affects only short-session reductions; the long-session regime is dominated by the quadratic term and is insensitive to `B`.

## 7. Reproduce

- Normal-mode baseline: scan `~/.claude-/projects/**/*.jsonl`, **group assistant events by `message.id`** (dedupe usage; count `tool_use` blocks per response), and read `tool_result` body sizes from user events.
- Code-mode receipts (implemented): run with `--cache-log` (or `CACHE_LOG=1`) to append per-turn `read`/`create`(5m/1h)/`input`/`output` rows plus `codeSubCalls`/`scriptOutBytes` to `<profileDir>/cache-log.jsonl`, keyed by `conv`. `p_c = Σ codeSubCalls / #code-calls`; `c = Σ scriptOutBytes/4 / (Σ codeSubCalls · ρ)`.
- Org bill: scale the per-$1M table in §5 to your own annual agentic spend.
