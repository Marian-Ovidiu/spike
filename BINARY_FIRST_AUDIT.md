# Binary-first audit (post-cleanup)

This file is the **high-level** pointer after the binary-only cleanup pass. The detailed bucket list lives in **`CLEANUP_REPORT.md`**.

## Product stance

- **Default execution:** `MARKET_MODE=binary` (outcome paper + Gamma or synthetic venue).
- **Default signal for binary:** Binance Spot BTC (`BINARY_SIGNAL_SOURCE` / `BINARY_SIGNAL_SYMBOL`) — unchanged and **not** “legacy spot mode”.
- **Legacy spot execution:** `MARKET_MODE=spot` (single-feed Binance long/short paper, bps TP/SL) is **opt-in** and requires **`LEGACY_SPOT_MARKET_MODE=1`** at process startup (`liveMonitor`, `npm start`). `BINARY_ONLY_RUNTIME=1` still refuses `MARKET_MODE=spot` entirely.

## Code layout

| Concern | Location |
|---------|-----------|
| Shared executable spread / synthetic mid book | `src/executionSpreadFilter.ts` |
| Legacy bps exits for open spot paper position | `src/legacy/spot/spotExitConditions.ts` |
| Legacy spot entry fill / mark | `src/legacy/spot/spotBookQuotes.ts` |
| Spot paper tick implementation (still in engine) | `SimulationEngine` private `onTickSpot` — see `src/legacy/spot/README.md` |
| CSV backtest (legacy spot sim) | `runBacktestReplay` asserts legacy ack — set `LEGACY_SPOT_MARKET_MODE=1` for `npm run backtest` |

## Renames completed

- `spotSpreadFilter` → **`executionSpreadFilter`** (API names above).
- `spotEntryFillPrice` / `spotMarkForPosition` → **`legacySpotEntryFillPrice`** / **`legacySpotMarkForPosition`** (legacy folder).

## Defaults completed

- `input.marketMode ?? "binary"` in simulation and pipeline helpers where a default was implied.
- Opportunity JSONL default `marketMode` when omitted → **`binary`** (artifact aligns with default product).

---

*For the pre-migration audit notes, see git history on this file or `CLEANUP_REPORT.md`.*
