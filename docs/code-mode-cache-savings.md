# Code Mode — Cache-Cost Savings Analysis

_How the `code({ script })` meta-tool reduces Anthropic prompt-cache spend. Prices are the Opus 4.8 card ($/MTok): input $5.00, cache read $0.50 (0.1×), **cache write $10.00 (1h TTL, 2×)**, output $25.00. Writes are priced at the 1-hour TTL throughout because the bundled Claude Code (v2.1.196) puts the SDK `querySource` on the `tengu_prompt_cache_1h_config` allowlist, so all SDK traffic uses 1h caching (the cheaper 5m write at $6.25/1.25× only applies if you force it via `FORCE_PROMPT_CACHING_5M`, which we don't), and the measured corpus confirms 98.7% of cache-creation tokens are 1h._

> Status: **measured from receipts.** The code-mode figures below come from **1,645 code-mode turns across 302 conversations** captured by `--cache-log` (per-turn `read`/`create`/`input`/`output` + `codeWaves`/`codeSubCalls`/`scriptOutBytes`), priced with the Opus card for apples-to-apples projections. The normal-mode comparison baseline is **2,889 Claude Code sessions / 101,936 API responses** mined from local transcripts.

## TL;DR

Code mode cuts prompt-cache cost two ways at once:

1. **Fewer model round-trips** — each round-trip re-reads the *entire* cached prefix. Real Claude Code serializes tools (**1.12 ops/round-trip**, parallelizing only 7.4% of the time); code mode runs **5.53 tool calls per synthetic wave** (measured), doing the same work in ~4.9× fewer full-prefix reads.
2. **Less transcript bloat** — raw tool outputs never enter the model context; only the script's return value does (measured compression **0.38×**). This shrinks every subsequent cache read **and** the one-time cache write.

| Lever | Reduction (short-session → long-session) |
|---|---|
| cache **read** | **80% → 92%** (grows with session length; reads are quadratic in length) |
| cache **write** | **~62%** (long-session limit; lower for short sessions where the fixed baseline dominates) |

**Org extrapolation (hypothetical):** on **$1M/yr** of agentic (Claude-Code-style) spend — ~84% of which is cache operations (read 46% + write 38%) — applying these bands with a batchability haircut yields **~$370K/yr (conservative) → ~$530K/yr (aggressive)** in avoided cache spend, i.e. **~37% → ~53% of the bill**. For scale, a cache-break *preservation* lever (recovering the ~2% of requests that miss cache) tops out at ~$16K/yr on the same $1M; code mode acts on the read/write **volume of the 98% that already hit**, a structurally larger lever.

---

## 1. Mechanism

In the standard agentic loop, every tool round is a separate `/v1/messages` call, and every call re-reads the whole conversation prefix as a cache read (0.1×) plus writes the new delta as a cache write (1h, 2×). So cost has two structural drivers: **how many round-trips** and **how big the prefix is**.

Code mode attacks both:

- **Round-trips.** The model emits one `code` call; the script calls tools via `await tools.X(args)`, and the bridge drives each `await`ed call as a wave of synthetic client tool calls. **Dependent chains collapse into one `code` call** — the script branches/loops on results and calls the next tool from inside the same script, so a K-step chain (read → decide → grep → read) becomes 1 model round-trip instead of K. Fewer round-trips → fewer full-prefix reads. This is the dominant lever because real Claude Code overwhelmingly does **one tool per round-trip** (§2).
- **Bloat.** Raw tool outputs go into the script's sandbox, not the transcript. Only the script's return value (often a tiny processed summary) is appended to the model's context. Every later turn re-reads that small value instead of the full raw output, and the one-time write is smaller too.

---

## 2. Measured parameters

Normal-mode baseline mined from `~/.claude-/projects/**/*.jsonl` (2,889 sessions), **grouped by `message.id`** so one API response counts once while still unioning split `tool_use` chunks (Claude Code splits a response across several JSONL lines — naive per-line counting double-counts usage; naive first-line dedupe hides parallel tools). Code-mode figures come from the live `cache-log.jsonl` files under `.claude`, `.claude-`, and `.claude-work`.

| Symbol | Meaning | Value | Source |
|---|---|---|---|
| `ρ` | raw tool output per op (tokens) | **719** | mean of **95,037** real `tool_result` bodies (median 80 B, p90 4.6 KB) |
| `p_n` | tool ops per round-trip, normal mode | **1.12** | 75,839 tool-bearing responses; median 1, p90 1, max 35; **only 7.4% parallelize** |
| `p_c` | tool calls per synthetic code wave | **5.53** | measured: 1,201 sub-calls / 217 waves across 1,645 code-mode turns — real in-script parallelism (`subcalls/wave`) |
| `c` | code-return compression = `r / (s·ρ)` | **0.38** | 332,129 returned tok / 863,138 raw-equiv tok |
| `B` | cached baseline (system + tool schemas + seed) | **~12,000** | estimate; matters only for short sessions |

**Real Claude Code is serial.** Across 101,936 API responses, the model emits ~1 tool per turn and parallelizes only 7.4% of the time — so the round-trip lever (`p_n → p_c`) is ~4.9× (1.12 → 5.53 measured).

**Cache TTL is 1h** (priced $10/MTok, 2× — see header). In the code-mode corpus, **98.7%** of cache-creation tokens are 1h, matching the normal-mode tendency toward 1h writes.

**Measured code-mode bill shape (1,645 turns / 302 conversations, $392 total spend under Opus pricing):** cache **create 66%** / cache **read 25%** / output 9% / input 0.2% — cache ops = **91.1%** of the bill. read:create token ratio **7.6 : 1**. Mean cache **hit ratio 0.884**. Per conversation: mean **$1.30**, median **$0.78**, p90 **$2.85**, max **$14.43**.

**The shape inverts under code mode.** Normal mode is read-dominated (46% read / 38% write) because each serial round-trip re-reads a growing raw-output transcript. Code mode is **write-dominated** (66% create / 25% read): slim script-return transcripts mean far less read *growth*, so the one-time-ish 1h cache **writes** (system + tool schemas at 2×) become the larger bucket. This is the bloat lever working — read volume is suppressed, leaving writes as the dominant cost.

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

- cache read, short-session limit (baseline-dominated): `p_n/p_c` = **0.20 → 80% reduction**
- cache read, long-session limit (the W² term dominates): `c · p_n/p_c` = **0.08 → 92% reduction**
- cache write, long-session limit: `c` = **0.38 → 62% reduction**

The read win *grows with session length* because the quadratic term rewards slimmer per-turn growth — long agentic sessions benefit most.

---

## 4. Per-session projection (Opus 4.8, 1h pricing)

| W (tool ops) | round-trips n→c | cache-read reduction | cache-write reduction | $ saved / session |
|---|---|---|---|---|
| 20 | 18 → 4 | 84% | 34% | $0.23 |
| 50 | 45 → 10 | 87% | 46% | $0.80 |
| 100 | 90 → 19 | 89% | 53% | $2.34 |
| 300 | 268 → 55 | 91% | 58% | $15.87 |
| 800 | 713 → 145 | 92% | 60% | $101.30 |

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
| Conservative | read −60%, 60% batchable; write −54% | $165K | $203K | **$368K (~37%)** |
| Moderate | read −72%, 75% batchable; write −54% | $248K | $203K | **$451K (~45%)** |
| Aggressive | read −80%, 90% batchable; write −54% | $330K | $203K | **$534K (~53%)** |

**Context vs a cache-preservation lever:** a *preservation* play (recovering the ~2% of requests that miss cache) tops out at **~$16K/yr** on the same $1M because it recovers only the miss tail. Code mode reduces the read/write **volume on the 98% that hit**, so it operates on the whole bill, not the break tail — an order of magnitude larger, at the cost of changing model behavior (and the reliability tax in §2).

---

## 6. Caveats

- **`p_c` and `c` are now measured at larger scale.** The batching rate (5.53 subcalls/wave) and bill shape come from 1,645 code-mode turns across 302 conversations. The Opus-only slice is more conservative (2.96 subcalls/wave, `c = 0.84`) because a few large script returns dominate that smaller sample; the all-log corpus better reflects mixed real server usage.
- **Code mode is write-dominated in practice.** The measured shape (66% create / 25% read) means the biggest remaining lever is the one-time 1h cache *write* of the system + tool schemas at 2×, not read growth — worth watching if the tool catalog grows.
- **Batchability is the real uncertainty.** The mechanics give an 80–92% read lever, but realized savings = `batchability × lever`. Data-dependent chains (read → decide → act) can't collapse into one manifest. The §5 spread is mostly this knob.
- **`ρ` and `c` vary widely.** Tool results are tiny at the median (80 B) but heavy-tailed (p90 4.6 KB); a few large script dumps erode the bloat win. The typed-signature description and the "return only what you need" nudge push `c` down.
- **No live A/B yet.** These compare a historical normal-mode corpus to a separate code-mode session, not the *same* task both ways.
- **Baseline `B`** affects only short-session reductions; the long-session regime is dominated by the quadratic term and is insensitive to `B`.

## 7. Reproduce

- Normal-mode baseline: scan `~/.claude-/projects/**/*.jsonl`, **group assistant events by `message.id`** (dedupe usage, but union split `tool_use` blocks per response), and read `tool_result` body sizes from user events.
- Code-mode receipts (implemented): run with `--cache-log` (or `CACHE_LOG=1`) to append per-turn `read`/`create`(5m/1h)/`input`/`output` rows plus `codeSubCalls`/`codeWaves`/`scriptOutBytes` to `<profileDir>/cache-log.jsonl`, keyed by `conv`. `p_c = Σ codeSubCalls / Σ codeWaves`; `c = Σ scriptOutBytes/4 / (Σ codeSubCalls · ρ)`.
- Org bill: scale the per-$1M table in §5 to your own annual agentic spend.

---

## 8. Shipped levers (2026-07-01)

The write-dominated shape in §6 drove a batch of changes targeting the remaining cost drivers. All `code` tool-description text changes shipped together in one release (a description edit invalidates the cached tools block exactly once).

- **Truncate-and-spill output cap** — `CODE_SCRIPT_MAX_OUTPUT_BYTES` now defaults to 16 KB. Over-cap returns are truncated head+tail (never errored — the old error-and-discard forced a full redo round-trip) and the full text is stored as a session artifact fetchable via `codemode.recall(id)` (resolved inline by the bridge: zero client turns, zero transcript bytes). Console output is capped per-line (2 KB) and per-run (8 KB). Attacks the heavy tail in `ρ`/`c` directly.
- **Persistent `state` global** — scripts carry a `state` object across `code` calls in one conversation (2 MB cap, survives script errors, dies with the session). Follow-up scripts read `state.index` instead of re-reading files: fewer client tool executions, shorter scripts (`scriptInBytes` is transcript, written at 2×), smaller returns.
- **Structured script errors** — a failing script now returns the error with the failing line (`code-mode-script.vm:N`), a completed-call ledger (`ok Read(...)` / `ERR Edit(...)`), and capped console, so the model continues instead of redoing completed waves.
- **Deterministic tool ordering** — the `code` description sorts tool blocks by name, so clients that vary tool order still share the cross-conversation prefix.
- **Wider SDK resume** — resume-index TTL 30 min → 24 h (resume validity is transcript-based, not cache-based; even past the 1h cache TTL a resume beats re-priming), 64 → 256 entries, and code-mode conversations now use mimicry-safe `resume-catchup` for small non-tool_result tails (tool_result tails stay hard-excluded — synthetic ids are unroutable after resume).
- **`sleep(ms)` + `codemode.retry()`** — the sandbox previously denied `setTimeout`, so model-written backoff loops threw; retry loops are a proven script shape in the harness corpus.
- **Telemetry for receipts** — per-turn rows now add `scriptInBytes`, `spills`, `stateBytes`, `codeErrors`, and `coldReason` (`resume-rejected(prefix-mismatch)`, `cwd-mismatch(...)`, ...), so the next re-run of §7 can attribute write reductions to each lever and quantify cache-cold causes.

Re-run the §7 analysis after ~2 weeks of cache-log under these changes; expected movement: `scriptOutBytes` p90 down (cap), repeat-Read rate down (`state`), post-error redo rate down (ledger), and `action` distribution shifting cold → resume/resume-catchup.

---

## 9. Frozen toolsets: tool mutability without cache invalidation (2026-07-01)

The §8 "ship all description edits in one release" constraint is now enforced mechanically and extended to tool-set drift. The rule: **the `code` description's bytes may change only when the cache is already dead.**

- **Live sessions** freeze the description at creation (unchanged behavior).
- **Warm-window resumes** (`CACHE_WARM_WINDOW_MS` = 1h, matching the CLI's 1h write TTL) reuse the exact persisted bytes from the conversation's frozen-toolset blob (`<config>/toolsets/<hash>.json`, content-addressed, referenced by `toolsetHash` in `resume-index.json`) — a daemon restart or self-update release can no longer re-write a warm prefix. Past-TTL resumes re-render freely; the full prefix write was happening anyway.
- **Late tools merge, they don't invalidate.** Tools the client adds mid-conversation (e.g. ToolSearch deferred tools) merge into the script runtime (the worker catalog and arg parsers rebuild from `session.clientTools` at every run) and are announced in-band on the next code tool_result — an incremental cache append, never a prefix re-write. The old behavior (inline "unavailable until a new conversation" error) is gone.
- **Enforcement + receipts**: `test/code-description.golden.test.mjs` fails on any description byte change (regenerate deliberately with `UPDATE_GOLDEN=1`). Cache-log rows carry `descHash`; `scripts/cache-bust-report.mjs` proves per-conversation byte stability from receipts and prices any re-write suspects.

---

## 10. Shipped levers (2026-07-02): one-call doctrine + prefix compression

One batched description release targeting the two remaining shapes in §6: the write-dominated prefix and the round-trip "dribble" (models issuing small single-call scripts instead of one conditional program).

- **Sectioned description rewrite with explicit cost framing** — the `code` prose is now markdown sections led by "## Why one call": each `code` call is named as a full-prefix re-read/re-extend, the only valid reasons to return are enumerated (done / needs model-user judgment / unrecoverable), and a 14-line worked example demonstrates batch recon → in-script `if/else` → edit → `codemode.verify` → `state` stash → compact return. New doctrine: verify-failures are repaired in the same run, scripts start by checking `state`, error ledgers are continued from rather than redone, and returns target ~1-2 KB.
- **Per-tool prose budget** (`CODE_TOOL_DESC_MAX_CHARS`, default 700) — the rendered description embeds client tool prose truncated at a word boundary with a `codemode.describe("Name")` pointer; TS signatures always survive. The worker catalog keeps full docs, so `describe()`/`search()` are lossless in-script. Attacks the dominant cache-create bucket directly (real Claude Code toolsets carry tens of KB of tool prose, written at 2x per conversation).
- **Anchor-note dedupe** — the ~1.6KB anchored-editing note previously prepended to BOTH `Edit` and `MultiEdit` is now a one-line pointer; the full doctrine lives once in the description's "Editing files" section.
- **Frozen `script` schema description** — the `code` input schema's `script` field now carries a one-line doctrine reminder at the point of generation. Like the description, it is frozen per conversation via the toolset blob (`scriptDesc`); legacy blobs resume with the bare schema their prefix cached, so no warm resume re-writes.
- **Consolidation nudge + `singleCallRuns` receipts** — a successful run that fabricated exactly one client tool call gets an in-band note (append-only transcript, max `CODE_NUDGE_MAX_PER_SESSION`=2 per session) telling the model to fold surrounding steps into one script; every such run increments `singleCallRuns` in the cache-log row so the dribble rate is measurable.

Expected movement on the next §7 re-run: cache-create tokens per conversation down (prefix compression), `p_c` up and turns per task down (doctrine + example + nudge), `c` down (return-size target), `singleCallRuns/codeCalls` trending toward zero.


## 11. Caveman prose compression (2026-07-02)

Deterministic rule-based compression (`src/caveman.mjs`, on by default at `full`) shrinks the prompt-bound prose itself before it is ever cache-written: the `code` description head, per-tool prose (compressed *before* the `CODE_TOOL_DESC_MAX_CHARS` cut, so more substance survives the cap), the frozen `script`-field prose, and the client system append. Protected spans (fences, backticks, headings, signatures, URLs, paths, quoted literals, tags, ALL-CAPS, JSON-ish lines) pass through byte-identical, and the worker catalog stays uncompressed so `codemode.describe()` remains the lossless fallback.

Cache mechanics are unchanged by construction: compression happens at render time only, so compressed bytes freeze into the toolset blob and replay verbatim on warm resumes; pre-caveman conversations keep their uncompressed frozen bytes. Rule-table edits are description-byte changes (bump `CAVEMAN_RULES_VERSION`, regenerate both goldens, batch releases). The canonical test toolset shows ~3% off the already-tight authored description; the real win scales with verbose client toolsets (tens of KB of tool prose, written at 2x per conversation) and CLAUDE.md-heavy system appends. Receipts: `cavemanSaved` / `cavemanSystemSaved` per cache-log row, plus a per-fresh-render stderr line.
