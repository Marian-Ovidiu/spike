# Binary-first cleanup report (2026)

Scope: execution/simulation defaults and naming; **Binance Spot remains the underlying signal** for `MARKET_MODE=binary` (`BINARY_SIGNAL_SOURCE` / `BINARY_SIGNAL_SYMBOL`). No change to that signal path.

## Bucket 1 — KEEP (required for binary runtime)

| Area | Notes |
|------|--------|
| `MARKET_MODE=binary` default in `config.ts` | Unchanged default. |
| `createBinarySignalDataFeed` + `BinanceSpotFeed` / `PaperBinanceFeed` | Signal feed for binary. |
| `createBinaryExecutionFeed`, Gamma / synthetic venue | Binary execution. |
| `binary/*` paper, exit, entry, venue | Core product. |
| `entryConditions` + **execution** spread gate | Uses `evaluateExecutionSpreadFilter` from `executionSpreadFilter.ts` (renamed from spot-prefixed helpers). |
| `borderlineCandidate` / `strongSpikeCandidate` / `strategyDecisionPipeline` | `evaluateExecutionBookPipeline` for invalid/wide-spread book. |
| `CONFIG_KEY_GROUP` value `"spot"` | Still labels **bps position exits** (`takeProfitBps`, `stopLossBps`, `exitTimeoutMs`) in grouped config output — keys unchanged to avoid churn; semantically “legacy spot **position** exits”. |
| `MarketMode` type `"spot" \| "binary"` | `spot` remains for explicit legacy execution mode. |
| `marketFeedFactory` spot branch | Required until legacy removed; logs one deprecation warning per process. |
| `liveMonitor` / `index` startup | `assertLegacySpotMarketModeAcknowledged` + existing `assertBinaryOnlyRuntime`. |

## Bucket 2 — KEEP FOR NOW (tests / tooling)

| Area | Notes |
|------|--------|
| `simulationEngine.onTickSpot` | Still in engine; **isolated by docs** under `src/legacy/spot/README.md`; imports `legacy/spot/spotExitConditions` + `legacy/spot/spotBookQuotes`. |
| `npm run backtest` / `runBacktestReplay` | Still drives **legacy spot** `simulation.onTick({ marketMode: "spot" })`; requires `LEGACY_SPOT_MARKET_MODE=1` via `assertLegacySpotMarketModeAcknowledged` at replay entry (tests set env in `beforeAll`). |
| `replayOpportunities` CLI | `--market-mode spot\|binary\|auto` for JSONL re-analysis; no full spot monitor. |
| Vitest fixtures using `marketMode: "spot"` | Strategy / pipeline tests for stale-feed and spot-shaped books. |
| `buildNormalizedMonitorConfigSummary` spot branch | Observability when `cfg.marketMode === "spot"`. |
| `monitorPersistence` `tradeToJsonlRecord` | Still emits `marketMode: "spot"` for trades without `executionModel: "binary"`. |

## Bucket 3 — REMOVE / ISOLATE (done in this pass)

| Before | After |
|--------|--------|
| Root `spotExitConditions.ts` | `src/legacy/spot/spotExitConditions.ts` |
| Root `spotSpreadFilter.ts` (ambiguous name) | **`src/executionSpreadFilter.ts`** — `syntheticExecutableBookFromMid`, `evaluateExecutionSpreadFilter`, `evaluateExecutionBookPipeline`, `ExecutableBookQuote` |
| Spot-only fill/mark on shared module | **`src/legacy/spot/spotBookQuotes.ts`** — `legacySpotEntryFillPrice`, `legacySpotMarkForPosition` |
| Hidden default `marketMode ?? "spot"` | Defaults **`?? "binary"`** in `simulationEngine.onTick`, `strategyDecisionPipeline` stale block, `monitorPersistence` opportunity JSONL default, `monitorConsole` opportunity rows. |
| Implicit spot monitor / CLI | **`LEGACY_SPOT_MARKET_MODE=1`** required when `MARKET_MODE=spot` (`assertLegacySpotMarketModeAcknowledged` in `liveMonitor.ts`, `index.ts`). |
| Misleading `"spot"` banner arg for Binance **signal** | **`liveMonitorBinanceSignalBannerDetail`** in `marketDiagnostics.ts` (dual-feed banner). |

## Follow-ups (optional)

- Narrow `SimulationEngine` spot surface into `legacy/spot/spotPaperOnTick.ts` with a thin host interface (larger refactor).
- Rename `CONFIG_KEY_GROUP` internal key `"spot"` → `"spotPositionExits"` (touches tests + `logConfig` output).
- Extend `npm run backtest` to optional `MARKET_MODE=binary` replay (separate project).
