# Code Mode — Cache-Cost Savings Analysis

_How the `code({ script })` meta-tool reduces Anthropic prompt-cache spend. Prices are the Opus 4.8 card ($/MTok): input $5.00, cache read $0.50 (0.1×), **cache write $10.00 (1h TTL, 2×)**, output $25.00. Writes are priced at the 1-hour TTL throughout because the bundled Claude Code (v2.1.196) puts the SDK `querySource` on the `tengu_prompt_cache_1h_config` allowlist, so all SDK traffic uses 1h caching (the cheaper 5m write at $6.25/1.25× only applies if you force it via `FORCE_PROMPT_CACHING_5M`, which we don't), and the measured corpus confirms 99.7% of cache-creation tokens are 1h._

> Status: **measured from receipts.** The code-mode figures below come from **594 code-mode turns across 64 conversations** captured by `--cache-log` (per-turn `read`/`create`/`input`/`output` + `codeWaves`/`codeSubCalls`/`scriptOutBytes`), priced with the Opus card. The normal-mode comparison baseline is **2,411 Claude Code sessions / 101,524 API responses** mined from local transcripts.

## TL;DR

Code mode cuts prompt-cache cost two ways at once:

1. **Fewer model round-trips** — each round-trip re-reads the *entire* cached prefix. Real Claude Code serializes tools (**1.12 ops/round-trip**, parallelizing only 7.3% of the time); code mode runs **2.85 tool calls per `code` call** (measured), doing the same work in ~2.5× fewer full-prefix reads.
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
| `p_c` | tool calls per `code` call (across all waves) | **2.85** | measured: 279 sub-calls / 98 waves across 594 code-mode turns — real in-script parallelism (`subcalls/wave`) |
| `c` | code-return compression = `r / (s·ρ)` | **0.46** | 11,901 returned tok / 25,884 raw-equiv tok |
| `B` | cached baseline (system + tool schemas + seed) | **~12,000** | estimate; matters only for short sessions |

**Real Claude Code is serial.** Across 101,524 API responses, the model emits ~1 tool per turn and parallelizes only 7.3% of the time — so the round-trip lever (`p_n → p_c`) is ~2.5× (1.12 → 2.85 measured), roughly **double** an earlier per-line estimate (2.27) that was inflated by message splitting.

**Cache TTL is 1h** (priced $10/MTok, 2× — see header). In the code-mode corpus, **99.7%** of cache-creation tokens are 1h, matching the normal-mode 92%.

**Measured code-mode bill shape (594 turns / 64 conversations, $133 total spend):** cache **create 59%** / cache **read 31%** / output 9% / input 0.4% — cache ops = **90.5%** of the bill. read:create token ratio **10.7 : 1** (vs 23.6:1 normal mode — code mode roughly halves it). Mean cache **hit ratio 0.887**. Per conversation: mean **$2.08**, median **$1.40**, max $12.51.

**The shape inverts under code mode.** Normal mode is read-dominated (46% read / 38% write) because each serial round-trip re-reads a growing raw-output transcript. Code mode is **write-dominated** (59% create / 31% read): slim script-return transcripts mean far less read *growth*, so the one-time-ish 1h cache **writes** (system + ~32 tool schemas at 2×) become the larger bucket. This is the bloat lever working — read volume is suppressed, leaving writes as the dominant cost.

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

- **`p_c` and `c` now measured at scale.** The batching rate (2.85 calls/code-call) and bill shape come from 594 code-mode turns across 64 conversations; compression `c` (0.46) is still a smaller sample. `p_n`, `ρ`, TTL are robust (2,411 sessions).
- **Code mode is write-dominated in practice.** The measured shape (59% create / 31% read) means the biggest remaining lever is the one-time 1h cache *write* of the system + ~32 tool schemas at 2×, not read growth — worth watching if the tool catalog grows.
- **Batchability is the real uncertainty.** The mechanics give a 56–80% read lever, but realized savings = `batchability × lever`. Data-dependent chains (read → decide → act) can't collapse into one manifest. The §5 spread is mostly this knob.
- **`ρ` and `c` vary widely.** Tool results are tiny at the median (51 B) but heavy-tailed (p90 4.4 KB); a few large script dumps erode the bloat win. The 0.1.6 typed-signature description and the "return only what you need" nudge push `c` down.
- **No live A/B yet.** These compare a real normal-mode corpus to a separate code-mode session, not the *same* task both ways. Run `scripts/live-code-mode-agent-task.mjs` with code mode on vs `X-Code-Mode: 0` to diff one task directly.
- **Baseline `B`** affects only short-session reductions; the long-session regime is dominated by the quadratic term and is insensitive to `B`.

## 7. Reproduce

- Normal-mode baseline: scan `~/.claude-/projects/**/*.jsonl`, **group assistant events by `message.id`** (dedupe usage; count `tool_use` blocks per response), and read `tool_result` body sizes from user events.
- Code-mode receipts (implemented): run with `--cache-log` (or `CACHE_LOG=1`) to append per-turn `read`/`create`(5m/1h)/`input`/`output` rows plus `codeSubCalls`/`scriptOutBytes` to `<profileDir>/cache-log.jsonl`, keyed by `conv`. `p_c = Σ codeSubCalls / #code-calls`; `c = Σ scriptOutBytes/4 / (Σ codeSubCalls · ρ)`.
- Org bill: scale the per-$1M table in §5 to your own annual agentic spend.
