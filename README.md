# Spike trading bot

> **Futures core (new stack):** neutral signal → risk → **paper futures** pipeline without YES/NO execution. Run **`npm run monitor:futures`** (live) or **`npm run replay:futures`** (CSV/JSONL). Details: **[`docs/FUTURES_MIGRATION.md`](docs/FUTURES_MIGRATION.md)**.  
> The paths below (`npm run monitor`, `src/binary/*`, Polymarket/synthetic 0–1) remain the **legacy binary-first product** and are **not** removed.

Mean-reversion spike strategy on a **rolling price window**: stable range → spike → contrarian entry → exit on reversion, TP, SL, or timeout. The repo is **binary-first** (`MARKET_MODE=binary` by default). A **legacy** single-feed spot execution mode remains behind `LEGACY_SPOT_MARKET_MODE=1` (see below).

| Mode | Price feed | Paper execution |
|------|------------|-----------------|
| **binary** (default) | **Signal:** Binance Spot mid for `BINARY_SIGNAL_SYMBOL` (default `BTCUSDT`, see `BINARY_SIGNAL_SOURCE`). **Execution (default dev path):** **synthetic** YES/NO book — no Polymarket env required (`createBinaryExecutionFeed` → `BinarySyntheticFeed`). **Optional:** Polymarket **Gamma** YES/NO when a market selector or auto-discovery is configured. | Outcome-token paper: buy YES or NO from the execution quotes; exits in **absolute price Δ** on the held leg |
| **spot** (legacy) | Binance Spot **bookTicker** + **aggTrade** (`BINANCE_SYMBOL`) — same stack as **signal** | Long/short vs bid/ask, exits in **bps** — requires **`LEGACY_SPOT_MARKET_MODE=1`** at startup |

Public market data only — **no API keys** and **no real orders** in the shipped paths.

### Binary: core lab path vs optional Gamma integration

| Path | Purpose | Network / env |
|------|---------|----------------|
| **Core synthetic lab** (primary development) | Strategy, probability engine, paper sim, monitor JSONL — full loop on a **demo YES/NO book** | Default **`.env.example`**: no Gamma selector, **`AUTO_DISCOVER_BINARY_MARKET=false`**. Optional **`BINARY_UP_PRICE` / `BINARY_DOWN_PRICE`** (defaults **0.51 / 0.49** in code if unset). |
| **Optional Gamma integration** | Live Polymarket quotes for the same pipeline | Set **`BINARY_MARKET_ID`**, **`BINARY_MARKET_SLUG`**, or **`BINARY_CONDITION_ID`**, or **`AUTO_DISCOVER_BINARY_MARKET=true`**. Tune **`BINARY_POLL_*`**, **`BINARY_QUOTE_STALE_MAX_MS`**. Use **`npm run validate-binary-market`** to debug Gamma + CLOB wiring (exits **`2`** when no Gamma path — normal for synthetic-only env). |

Module map: **`src/binary/venue/README.md`**.

## Quick start — core synthetic lab (default)

```bash
npm install
cp .env.example .env
```

1. **`.env.example`** is tuned for the **synthetic lab**: **`MARKET_MODE=binary`**, **`AUTO_DISCOVER_BINARY_MARKET=false`**, no **`BINARY_MARKET_*`** / **`BINARY_CONDITION_ID`** — **`npm run monitor`** runs end-to-end with Binance **signal** + **synthetic** execution (no Polymarket calls). CI / offline friendly.
2. Optional: set **`BINARY_UP_PRICE`**, **`BINARY_DOWN_PRICE`**, **`BINARY_SYNTHETIC_SPREAD_BPS`**, or **`SYNTHETIC_MARKET_*`** / **`SYNTHETIC_MARKET_PROFILE`** to stress the venue layer (`syntheticVenuePricing.ts`, `syntheticBinaryMarket.ts`).
3. **`npm run validate-binary-market`** is **not** required for the lab; it only validates **Gamma** selectors (see optional section below).

```bash
npm run monitor
```

Other commands: `npm test`, `npm run build`, `npm run backtest` (binary-first CSV replay by default), `npm run replay-opportunities`.

## Optional: Polymarket Gamma live integration

Turn this on when you want **real YES/NO quotes** from Polymarket instead of the synthetic book.

1. Set exactly **one** manual Gamma path: **`BINARY_MARKET_ID`**, **`BINARY_MARKET_SLUG`**, or **`BINARY_CONDITION_ID`** (legacy `POLYMARKET_MARKET_*` / `POLYMARKET_CONDITION_ID` still work). **`npm run monitor` fails fast** if a selector is set but the first Gamma poll does not return a parseable quote — there is **no silent fallback** to synthetic in that case.
2. Or enable rolling-window auto-pick: **`AUTO_DISCOVER_BINARY_MARKET=true`** (requires network; **`BINARY_MARKET_SLUG` from `.env` is ignored** until a window is picked unless **`BINARY_MARKET_ID`** / **`BINARY_CONDITION_ID`** block discovery).

**Slug gotcha (root cause of many “invalid book” / bootstrap failures):** Polymarket **event** pages use a slug that identifies a *parent event* (`/event/presidential-election-winner-2024`), while Gamma’s tradable rows live on **child market** slugs (`will-donald-trump-win-the-2024-us-presidential-election`). The old client called `GET /markets?slug=…`, which often returns `[]` even for valid URLs. The bot now uses `GET /markets/slug/{slug}` first, then **`GET /events/slug/{slug}`** and picks the first child market with parseable outcome prices. Many short-lived markets omit **`outcomePrices`** on Gamma; the resolver then derives per-outcome mids from the public **CLOB `GET /book?token_id=…`** ladder using `clobTokenIds`. Prefer **`BINARY_MARKET_ID`** (numeric) or the **child** `BINARY_MARKET_SLUG` when you want zero ambiguity. For a **condition id** hex, the resolver hits **`GET https://clob.polymarket.com/markets/{condition}`** to read `market_slug`, then loads the Gamma row.

**Diagnostics:** run **`npm run validate-binary-market`** after env edits — it prints selector, each HTTP URL, `market_id` / `slug` / `conditionId` / outcomes / outcome prices / mapped YES–NO mids, `clobTokenIds`, Gamma `bestBid`/`bestAsk`, trading heuristics, executable book (same gate as the monitor), a **`MARKET_VALID`** line (**`false`** when the market is **closed**, the book is **invalid**, or **trading suitability** heuristics fail), a JSON **`normalizedConfig`** snapshot (same object shape as **`session-summary.json`**), then exits **`0`** if valid, **`1`** if invalid, **`2`** if there is no Gamma path (**synthetic-only env — expected** for the default lab `.env`). Set **`BINARY_GAMMA_BOOTSTRAP_LOG=1`** before `npm run monitor` to print step-by-step `[gamma-bootstrap]` lines from `src/binary/venue/binaryMarketFeed.ts` on startup (suppressed under Vitest unless overridden).

| Selector example | Valid? | Notes |
|--------------------|--------|--------|
| `BINARY_MARKET_ID=253591` | Yes | Numeric Gamma id via `GET /markets/{id}`. |
| `BINARY_MARKET_SLUG=will-donald-trump-win-the-2024-us-presidential-election` | Yes | Child **market** slug via `GET /markets/slug/…`. |
| `BINARY_MARKET_SLUG=presidential-election-winner-2024` | Usually yes | **Event** slug — resolved via `GET /events/slug/…` then first parseable child market (may be wrong if many children; prefer child slug or id). |
| `BINARY_CONDITION_ID=0xdd2247…` | Yes | Uses CLOB `GET /markets/{condition_id}` → `market_slug` → Gamma. |
| `GET /markets?slug=…` (legacy client) | No | Gamma often returns `[]`; do not rely on list query for slug/id. |

### Rolling BTC 5-minute Up/Down (auto-discovery)

Short-lived Polymarket **Bitcoin Up or Down ~5m** windows rotate slugs frequently. Enable:

```env
MARKET_MODE=binary
AUTO_DISCOVER_BINARY_MARKET=true
```

With **`AUTO_DISCOVER_BINARY_MARKET=true`**, **`BINARY_MARKET_SLUG` is ignored** (even if set in `.env`) until a market is picked; only **`BINARY_MARKET_ID`** or **`BINARY_CONDITION_ID`** (and legacy `POLYMARKET_*` equivalents) block auto-discovery and force manual Gamma selection.

On **`npm run monitor`** / **`npm start`** / **`npm run validate-binary-market`**, discovery first performs **`GET https://gamma-api.polymarket.com/events?active=true&closed=false&limit=100`**, logs the **first 10 events’** shape (id, slug, title, dates, first nested market), flattens each event’s **`markets[]`**, and keeps rows that pass **relaxed** matching (**`bitcoin` / `btc` + `up or down` phrasing**, or market slug **`btc-updown-5m`**, using **event title, event slug, market slug, and market question**), **`startDate`→`endDate` ≈ 4–8 minutes**, **`active=true`**, **`closed=false`**. If that yields **no** candidates, it paginates **`GET /markets?active=true&closed=false&limit=100&offset=…`** (short windows are often missing from `/events`). Then for each candidate **`GET /markets/slug/…` or `/markets/{id}`**, requires **`enableOrderBook=true`**, two **`clobTokenIds`**, and **`acceptingOrders=true` when that field exists**. It then **`GET`s CLOB `/book?token_id=…`** for both tokens; invalid books are skipped. The **best** pick prefers the **latest `startDate`**, then the **tightest combined bid/ask spread**. **`BINARY_MARKET_SLUG`** is set in-process for the run; logs print **`[auto-discovery]`** lines (including per-phase **fail** counts) and the monitor banner shows **`AUTO DISCOVER ACTIVE`** plus slug, title, ids, token ids, and a **validation** summary. If nothing qualifies, startup **throws** with a **stats summary** (no silent fallback to synthetic).

Monitor writes JSONL + `session-summary.json` under `MONITOR_OUTPUT_DIR` (default `output/monitor/`).

### Binary run analytics (`session-summary.json` + CLI)

On shutdown in **`MARKET_MODE=binary`**, `session-summary.json` includes a top-level **`binaryRunAnalytics`** object (schema `binary_run_analytics_v1`) with:

- **`opportunities_total`**, **`opportunities_by_type`**, **`opportunities_by_quality`** — from the in-memory opportunity tracker (same rows as `opportunities.jsonl`).
- **`opened_trades`** — funnel counter (`counters.tradesExecuted`); **`closed_trades`** — binary rows in the trade history / `trades.jsonl`.
- **`win_rate`**, **`pnl_total`**, **`avg_pnl_per_trade`**, **`timeout_rate`** — over closed binary paper trades.
- **`edge_bucket_breakdown`** — model edge at entry (`P(bought leg) − ask`), buckets: `<0.01`, `0.01-0.03`, `0.03-0.05`, `>0.05`, `unknown` (older rows without `entryModelEdge` in JSONL land in `unknown`).
- **`quality_bucket_breakdown`** — closed trades by `entryQualityProfile`.
- **`borderline_funnel_breakdown`** — `borderlineEntered`, `borderlinePromoted`, `borderlineRejectedTimeout`, `borderlineRejectedWeak`.
- **`trade_outcome_breakdown`** — nested counts/PnL by **YES/NO**, by **quality**, and by exit **TP / SL / timeout** (`exitReason` `profit` → take_profit, `stop` → stop_loss).

Recompute the same report offline from artifacts:

```bash
npm run analyze-run -- output/monitor
```

Optional JSON file:

```bash
npm run analyze-run -- output/monitor --json-out output/monitor/analyze-report.json
```

### Probability calibration (`probability-calibration-events.jsonl`)

The monitor records **resolved** rows comparing **`estimatedProbabilityUp`** (strategy `probability_up`) to **realized BTC signal direction** over **`PROBABILITY_TIME_HORIZON_MS`** (default `30000`). The label is **1** when the first Binance signal mid **at or after** `referenceTimeMs + horizon` is **strictly above** the mid at reference time; **ties** count as **0** (DOWN).

- **Trades:** on each binary paper close, once wall-clock has passed the horizon from open (or deferred until then), one line is appended to **`probability-calibration-events.jsonl`** under `MONITOR_OUTPUT_DIR`.
- **Opportunities:** on shutdown, opportunities that **did not** become trades can still emit a row if the session end is past `opportunity time + horizon` (entered trades are **not** duplicated from opportunities).

Each JSON line uses schema **`probability_calibration_event_v1`** (`predictedProbabilityUp`, `referenceSignalMid`, `horizonEndSignalMid`, `realizedUp`, optional `entryModelEdge`, `source`: `trade` | `opportunity`).

Recompute buckets and a short **reliability summary** (predicted vs realized frequency per half-decade bucket, mean |p−y|, heuristic **verdict**):

```bash
npm run analyze-probability-calibration -- output/monitor
```

Optional JSON report:

```bash
npm run analyze-probability-calibration -- output/monitor --json-out output/monitor/probability-calibration-report.json
```

**Reading `calibrationVerdict`:** this is a **heuristic** from sample size, global mean (p−y), and bucket gaps — not a formal statistical test. **`roughly_calibrated`** means bucket frequencies sit in a loose band around predictions; **`overconfident_up`** suggests predicted P(up) tends to exceed empirical UP frequency (especially in mid/high buckets); **`underconfident_up`** the opposite; **`insufficient_data`** when there are too few events (see printed notes).

**Example console excerpt** (values depend on your session):

```text
=== Binary run analytics ===
Directory: …/output/monitor
Schema: binary_run_analytics_v1

Opportunities (total): 42
  By type: {"strong_spike":30,"borderline":12}
  By quality: {"strong":18,"weak":20,"exceptional":4}

Trades opened (binary): 3
Trades closed (binary): 3
Win rate %: 33.33
PnL total (USDT): -0.1200
Avg PnL / trade (USDT): -0.0400
Timeout rate %: 66.67

Edge buckets (entry model edge): {"<0.01":1,"0.01-0.03":1,"0.03-0.05":0,">0.05":1,"unknown":0}
…
```

**Binary diagnostics:** session shutdown prints **BTC signal vs YES/NO repricing** (max tick moves, rolling-buffer range, quote-change count, flat-quote %). Set **`BINARY_COMPARE_DIAG=1`** for an extra compact `[sig×bin]` line each ready tick (spike % vs venue deltas). Closed trades in `trades.jsonl` include **`underlyingSignalPriceAtEntry` / `AtExit`** next to YES/NO entry/exit prices for “good signal / bad repricing” post-mortems.

**Session `interpretation` strings** (in `session-summary.json` under `extended`): in **`MARKET_MODE=binary`**, **`market too flat`** is reserved for a **sticky YES/NO book** (high `flatQuotePercent` from `binaryQuoteSession`, with enough valid-quote ticks)—not for “most ticks were `no_signal` on BTC”. When the venue is repricing actively (low flat % / high `quoteChangeCount`) but spikes are rare, the summary uses lines such as **venue repriced often; underlying path stayed below spike/borderline thresholds** or **moderate venue churn**; very few valid quotes vs tick count triggers a **stale venue / feed** hint. Legacy **`MARKET_MODE=spot`** still uses the BTC-centric **market too flat** when no-signal moves dominate.

### How binary paper PnL works

- **Spikes and the rolling buffer** use the **underlying signal** (`BINARY_SIGNAL_SOURCE` + `BINARY_SIGNAL_SYMBOL`, default Binance spot `BTCUSDT`) — the same statistical pipeline as spot, but the price series is independent of the YES/NO execution book. On **synthetic** execution, YES/NO mids further follow `syntheticVenuePricing.ts` (lag / noise / bias / reaction), so the venue is not hard-wired to the same number as `estimatedProbabilityUp` (see **Strategy estimate vs synthetic venue price** above).
- On entry, **UP** → paper buy **YES** at the ask side of the internal book; **DOWN** → buy **NO**.
- **Take profit / stop** use `BINARY_TAKE_PROFIT_PRICE_DELTA` and `BINARY_STOP_LOSS_PRICE_DELTA`: exit when the **held outcome’s mark** moves by that many **price points** (not basis points).
- **Fees**: `PAPER_FEE_ROUND_TRIP_BPS` still applies to the paper notional where the sim charges it.
- **Quote gate** (binary only): `BINARY_MAX_OPPOSITE_SIDE_ENTRY_PRICE` (legacy `MAX_OPPOSITE_SIDE_ENTRY_PRICE`), optional max entry-side price, optional neutral band — see `src/binary/entry/binaryQuoteEntryFilter.ts`.

### Underlying signal vs execution market (binary)

- **`BINARY_SIGNAL_SOURCE`** / **`BINARY_SIGNAL_SYMBOL`** (optional alias **`SIGNAL_MODE`** for the source only): configure **what moves the strategy** (today: `binance_spot` + a Binance pair such as `BTCUSDT`).
- **Execution venue (YES/NO quotes):** **default** = **synthetic** book (`BINARY_UP_PRICE` / `BINARY_DOWN_PRICE` with in-code defaults **0.51 / 0.49** if unset). **Optional Gamma:** if **`BINARY_MARKET_ID`**, **`BINARY_MARKET_SLUG`**, or **`BINARY_CONDITION_ID`** resolves, or **`AUTO_DISCOVER_BINARY_MARKET=true`** runs discovery (slug from `.env` ignored until picked unless blocked by id/condition), the feed is **`BinaryMarketFeed`** (Polymarket). Within each tier, `BINARY_*` is preferred over the matching `POLYMARKET_*` legacy name. See `src/binary/venue/binaryMarketSelector.ts`, `discoverBtc5mUpDownMarket.ts`, and **`src/binary/venue/README.md`**.

### Strategy estimate vs synthetic venue price (anti self-confirmation)

The pipeline intentionally separates three ideas:

1. **Signal features** — rolling Binance mids in the buffer (spike / range inputs).
2. **Fair value estimate** — `estimatedProbabilityUp` from `src/binary/signal/binaryProbabilityEngine.ts` (strategy P(up); used for borderline fast-promote, edge vs **market**, sizing gates).
3. **Execution market pricing** — on **synthetic** execution only, YES/NO mids come from `src/binary/venue/syntheticVenuePricing.ts`: the venue reacts to the fair series with optional **lag**, **partial adjustment** (`SYNTHETIC_MARKET_REACTION_ALPHA`), **deterministic noise** (`SYNTHETIC_MARKET_NOISE_BPS` + `SYNTHETIC_MARKET_NOISE_SEED`), and **bias** (`SYNTHETIC_MARKET_BIAS_BPS`), then the existing spread / optional EMA in `SyntheticBinaryMarket` builds the book.

With defaults (`LAG_TICKS=0`, `REACTION_ALPHA=1`, zero noise/bias), the synthetic mid still tracks fair closely, but it is no longer wired as “set mid = P(up)” in one line of code — the venue layer is explicit.

**Treat synthetic paper runs as a behaviour lab**, not proof that the model has edge: edge compares the strategy estimate to **venue** asks; tuning the venue knobs changes fills without changing the spot signal. For **Gamma** execution, venue prices are external; these `SYNTHETIC_MARKET_*` keys apply only to the synthetic feed.

#### Synthetic market profiles (`SYNTHETIC_MARKET_PROFILE`)

When **`SYNTHETIC_MARKET_PROFILE`** is unset, venue and spread defaults behave as before (explicit `SYNTHETIC_MARKET_*` / `SYNTHETIC_*` env only). When set to one of **`slow` \| `balanced` \| `reactive` \| `noisy`**, the bot loads a bundled tuning curve (reaction speed, lag, noise, bias, baseline spread, slippage, mid EMA weight) from `src/binary/venue/syntheticMarketProfile.ts`. You can still override any single knob with the usual env vars (they win over the profile).

| Profile | Reaction / lag | Spread / noise | Intent |
|--------|----------------|------------------|--------|
| **slow** | High lag, low alpha | Wider baseline, light noise, smoother mid | Sticky quotes, late repricing |
| **balanced** | Moderate lag and alpha | Mid spread, moderate noise | Default “lab” mix |
| **reactive** | Low lag, high alpha | Tighter baseline, moderate noise | Venue tracks fair quickly |
| **noisy** | Medium alpha, short lag | Wide spread, heavy noise, slight bias | Stress-test filters and sizing |

**Dynamic spread:** **`SYNTHETIC_MARKET_WIDEN_ON_VOLATILITY`** (default `0`) scales how much extra spread is added from an EWM of fair jumps and “signal instability” (fair vs lagged fair). **`SYNTHETIC_MARKET_MAX_SPREAD_BPS`** caps the quoted width (default derived from baseline spread when unset). The live quoted spread is clamped to `[baseline, max]`.

**Diagnostics:** on monitor shutdown, if the execution feed is synthetic and at least one venue tick ran, the monitor writes **`synthetic-pricing-diagnostics.json`** next to `session-summary.json` (mid moves vs flat ticks, mean repricing gap vs published mid, mean/final spread, spread-regime counts, EWM instability). The same payload is embedded under **`extended.marketFeedDiagnostics`** for the synthetic branch (`syntheticPricingDiagnostics`, `widenOnVolatility`, `syntheticMarketProfile`, etc.).

**Logging:** set **`SYNTHETIC_VENUE_PRICE_LOG=1`** for a compact `[synthetic-venue]` line each ready tick (`prob_up`, `fair`, `synth_mid`, asks, `edge_vs_*`). With **`DEBUG_MONITOR=true`**, the same line goes through the debug logger.

Spot mode ignores the `BINARY_SIGNAL_*` keys; it continues to use **`BINANCE_SYMBOL`** on the single Binance feed.

### Example `.env` — core lab (synthetic)

```env
MARKET_MODE=binary
AUTO_DISCOVER_BINARY_MARKET=false
BINARY_SIGNAL_SOURCE=binance_spot
BINARY_SIGNAL_SYMBOL=BTCUSDT
BINARY_TAKE_PROFIT_PRICE_DELTA=0.05
BINARY_STOP_LOSS_PRICE_DELTA=0.05
BINARY_EXIT_TIMEOUT_MS=90000
BINARY_MAX_OPPOSITE_SIDE_ENTRY_PRICE=0.78
```

### Example `.env` — optional Gamma (add to above)

```env
BINARY_MARKET_SLUG=your-child-market-slug
BINARY_POLL_INTERVAL_MS=10000
BINARY_QUOTE_STALE_MAX_MS=120000
```

### Optional: Binary real market checklist (Polymarket Gamma)

Use this before `npm run monitor` when you intend **live YES/NO quotes** (not the synthetic demo book):

1. **`MARKET_MODE=binary`**.
2. **Exactly one execution path:** either set **`BINARY_MARKET_ID`**, **`BINARY_MARKET_SLUG`**, or **`BINARY_CONDITION_ID`** (legacy `POLYMARKET_*` equivalents still work), **or** set **`AUTO_DISCOVER_BINARY_MARKET=true`** (slug env is then ignored until a window is picked; see section above). Prefer explicit `BINARY_*` ids/slugs when you need a fixed market.
3. **Underlying signal** — `BINARY_SIGNAL_SOURCE` / `BINARY_SIGNAL_SYMBOL` (default Binance spot `BTCUSDT`) must match what you want the spike detector to track; it is **not** the Polymarket slug.
4. **Outcome exits** — tune `BINARY_TAKE_PROFIT_PRICE_DELTA`, `BINARY_STOP_LOSS_PRICE_DELTA`, `BINARY_EXIT_TIMEOUT_MS`. Do **not** rely on `TAKE_PROFIT_BPS`, `STOP_LOSS_BPS`, or `EXIT_TIMEOUT_MS` in binary mode (they are spot-only; the process logs a warning if set from env).
5. **Venue staleness** — set `BINARY_QUOTE_STALE_MAX_MS`, `BINARY_POLL_INTERVAL_MS`, and `BINARY_POLL_SILENCE_MAX_MS` (or legacy `POLYMARKET_*`) for REST polling health; **`FEED_STALE_MAX_AGE_MS`** applies to the **Binance signal** path, not Gamma quote age.
6. **Remove synthetic-only env** (`BINARY_UP_PRICE`, `BINARY_DOWN_PRICE`, `BINARY_SYNTHETIC_SPREAD_BPS`, legacy `UP_SIDE_PRICE` / `DOWN_SIDE_PRICE`) when Gamma is configured — they are ignored for execution and only add confusion.
7. After a run, open **`session-summary.json`**: the **`normalizedConfig`** object (schema **`normalized_monitor_config_v2`**) records effective market mode, signal, execution venue, TP/SL/timeout units, stale-feed tuning, and **`signalDetection`** — the **effective** spike/range/borderline gate values with **`fromEnv`** / optional **`envSourceKey`** so you can see defaults vs explicit env overrides (`SPIKE_THRESHOLD`, `TRADABLE_SPIKE_MIN_PERCENT`, etc.).

At startup, **`logConfig`** and the **live monitor banner** print one line for execution venue (synthetic vs gamma, selector type, value, and source env key). If you set **`BINARY_MARKET_ID`** and **`BINARY_MARKET_SLUG`**, **only the id** is used.

For the same **logical** setting (e.g. Gamma API base), `config.ts` may copy **`BINARY_*` → `POLYMARKET_*`** only when the legacy slot is empty (silent internal bridge for older readers). Resolution still prefers **`BINARY_*`** when both are set. Prefer defining **only** `BINARY_*` in `.env`; if you set **`POLYMARKET_*` without the matching `BINARY_*`**, a **warning** is logged.

## Legacy spot **execution** mode (`MARKET_MODE=spot`)

Deprecated: one Binance feed for both signal and **long/short paper** with TP/SL in **bps** (`TAKE_PROFIT_BPS`, `STOP_LOSS_BPS`, `EXIT_TIMEOUT_MS`). **`BINARY_*` market selectors are ignored**; the grouped config still lists those keys under **Legacy spot execution** for reference.

**Opt-in:** set **`LEGACY_SPOT_MARKET_MODE=1`** (or `true` / `yes`) together with **`MARKET_MODE=spot`** for `npm run monitor` / `npm start`, or the process exits with an error. **`BINARY_ONLY_RUNTIME=1`** continues to refuse `MARKET_MODE=spot` regardless.

**CSV backtest** (`npm run backtest <file.csv>`) defaults to **binary-first replay**: the CSV supplies the **BTC signal** series; the run uses the same stack as live monitor (`estimateProbabilityUpFromPriceBuffer` → `BinarySyntheticFeed` / `SYNTHETIC_MARKET_PROFILE` → `runStrategyDecisionPipeline` → binary paper exits). Use **`--json-out <path>`** for a `backtest_summary_v1` JSON blob that includes **`binaryRunAnalytics`** (same schema as live `session-summary.json`). Flags: **`--spot-legacy`** for the old single-feed spot paper path (sets **`LEGACY_SPOT_MARKET_MODE=1`** for that process only), **`--no-strict-comparison`** to skip the relaxed-vs-strict baseline.

For the default product path, use **`MARKET_MODE=binary`**; Binance spot there is only the **underlying signal**, not the legacy spot **execution** universe.

Feed staleness for legacy spot uses **`FEED_STALE_MAX_AGE_MS`** (Binance WebSocket age). For binary + Gamma, use **`BINARY_QUOTE_STALE_MAX_MS`** / **`BINARY_POLL_SILENCE_MAX_MS`** (or legacy `POLYMARKET_*` names).

See **`CLEANUP_REPORT.md`** and **`BINARY_FIRST_AUDIT.md`** for module buckets and rename notes.

## Configuration reference

- **Source of truth**: `src/config.ts` (`configDefaults`, `ENV_KEYS`, `loadConfig`).
- **Env template**: `.env.example` (**synthetic lab default**; optional Gamma keys commented at bottom; legacy spot keys under **Legacy spot execution** above).

Deprecated env keys (`POLYMARKET_DISCOVERY_*`, etc.) log a **warning** and are ignored — see `warnDeprecatedPolymarketEnv` in `src/config.ts`.

### Canonical env names and startup logging

Each `AppConfig` field maps to one **canonical** env name in `ENV_KEYS` (the name to use in new configs). At startup, **`logConfig()`** prints grouped lines as:

`canonical=<ENV_KEYS name> · from=<actual var>` when the value came from the process environment, or **`(alias — prefer …)`** when a legacy alias supplied it (e.g. `MAX_OPPOSITE_SIDE_ENTRY_PRICE` → canonical `BINARY_MAX_OPPOSITE_SIDE_ENTRY_PRICE`). Defaults show `canonical=… · default` or a short provenance note (e.g. signal symbol inferred from `BINANCE_SYMBOL` when `BINARY_SIGNAL_SYMBOL` is unset).

Gamma execution selectors: prefer **`BINARY_MARKET_ID`**, **`BINARY_MARKET_SLUG`**, or **`BINARY_CONDITION_ID`**. If only `POLYMARKET_*` equivalents are set, a warning is emitted. **`normalizedConfig.staleFeeds.signalFeedStaleMaxAgeMs`** is the max age for the **Binance signal** path (shared with legacy spot book age); Gamma quote tuning uses `BINARY_QUOTE_STALE_MAX_MS` / `BINARY_POLL_*` (see `.env.example`).

See **`CONFIG_NAMING_PLAN.md`** for the audit / rename checklist across the binary-first tree.

## Architecture

Rolling buffer → spike / range detection → quality gates → strong / borderline pipeline → paper simulation → monitor persistence. Adapters: `src/adapters/binanceSpotFeed.ts`. Binary execution hub: **`src/binary/venue/README.md`** — default **`binarySyntheticFeed.ts`** + **`createBinaryExecutionFeed.ts`**; optional Gamma: **`binaryMarketFeed.ts`**, **`gammaClobOutcomePrices.ts`**, **`discoverBtc5mUpDownMarket.ts`**. Shared executable spread helpers: `src/executionSpreadFilter.ts`. Legacy spot bps exits + fill/mark: `src/legacy/spot/`.

Binance API reference: [Binance Spot API documentation](https://binance-docs.github.io/apidocs/spot/en/).
