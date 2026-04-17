# Spike trading bot (Binance Spot paper mode)

Mean-reversion spike strategy on **Binance Spot** prices (default **BTCUSDT**). The bot uses **public** REST + WebSocket market data only and **does not place real orders**. Signals and paper fills use **best bid / best ask** from the live book.

Official reference: [Binance Spot API documentation](https://binance-docs.github.io/apidocs/spot/en/).

## How to run

Prerequisites: Node.js 20+ and npm.

```bash
npm install
cp .env.example .env
# Optional: edit .env (strategy thresholds, BINANCE_SYMBOL, etc.)

npm run monitor
```

Other scripts:

- `npm test` — unit tests
- `npm run build` — TypeScript compile to `dist/`
- `npm run backtest` — offline backtest runner
- `npm run replay-opportunities` — replay persisted `output/monitor/opportunities.jsonl` through the pipeline

Monitor output and JSONL files default under `output/monitor/` (see `MonitorFilePersistence`).

## Migration from Polymarket (binary YES/NO)

**What changed**

- **Price source**: Binance Spot `bookTicker` (+ `aggTrade` for last trade) instead of Polymarket Gamma quotes.
- **Strategy anchor**: percentage moves and ranges are computed from **BTCUSDT mid / last** from the rolling buffer, not binary share prices.
- **Paper PnL**: spot-style **LONG / SHORT** vs entry/exit prices derived from the book (long: enter ask / exit bid; short: enter bid / exit ask), with **bps** take-profit, stop-loss, slippage, and fee estimates.
- **Rejection reasons**: stale-feed blocks use `feed_stale` (legacy logs may still show `quote_feed_stale`).

**Removed / deprecated config**

- `POLYMARKET_*`, `BINARY_MARKET_SOURCE`, `UP_SIDE_PRICE`, `DOWN_SIDE_PRICE`, and related binary-market fields are **deprecated**. If present in `.env`, they are **ignored** and a warning is printed (see `warnDeprecatedPolymarketEnv` in `src/config.ts`).

**New / primary config**

- `BINANCE_SYMBOL` (default `BTCUSDT`)
- Spot bps: `TAKE_PROFIT_BPS`, `STOP_LOSS_BPS`, `PAPER_SLIPPAGE_BPS`, `PAPER_FEE_ROUND_TRIP_BPS`, `MAX_ENTRY_SPREAD_BPS`
- Feed: `FEED_STALE_MAX_AGE_MS`, `BLOCK_ENTRIES_ON_STALE_FEED`

See `.env.example` for the full list aligned with `AppConfig`.

## Architecture note

Core flow is unchanged in spirit: rolling prices → spike / range detection → quality gates → strong/borderline pipeline → paper simulation → monitor persistence. Adapters live under `src/adapters/` (`binanceSpotFeed.ts`).
