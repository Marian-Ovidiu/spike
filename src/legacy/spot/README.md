# Legacy spot **execution** (`MARKET_MODE=spot`)

This folder holds code paths that simulate **long/short vs Binance bid/ask** with TP/SL in **basis points**. They are **not** used when `MARKET_MODE=binary` (the default product path).

- **`spotExitConditions.ts`** — bps TP/SL/timeout for the legacy spot paper position.
- **`spotBookQuotes.ts`** — fill and mark helpers for that model.

`SimulationEngine` still dispatches here when `marketMode === "spot"` and `LEGACY_SPOT_MARKET_MODE=1` is set at process startup (see `assertLegacySpotMarketModeAcknowledged`).

**Not legacy:** Binance Spot WebSocket/REST as the **underlying signal** for binary mode lives under `src/adapters/binanceSpotFeed.ts` and `src/market/marketFeedFactory.ts` — that stays first-class.
