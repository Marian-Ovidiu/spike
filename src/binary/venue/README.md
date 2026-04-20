# Binary execution venue (`src/binary/venue/`)

Two stacks share one entry point: **`createBinaryExecutionFeed.ts`** chooses **synthetic** (default, no network) vs **Gamma** (optional Polymarket HTTP + CLOB) from env.

## Core research path — synthetic lab (default)

Use this for **offline / CI / strategy tuning** without Polymarket config.

| Concern | Modules |
|--------|---------|
| Feed factory | `createBinaryExecutionFeed.ts` → `BinarySyntheticFeed` when no Gamma selector |
| YES/NO book + spread | `syntheticBinaryMarket.ts`, `syntheticVenuePricing.ts`, `syntheticMarketProfile.ts` |
| Diagnostics | Synthetic branch in monitor / `synthetic-pricing-diagnostics.json` |

No **`BINARY_MARKET_*`**, **`BINARY_CONDITION_ID`**, or **`AUTO_DISCOVER_BINARY_MARKET=true`** is required. Optional env: **`BINARY_UP_PRICE`**, **`BINARY_DOWN_PRICE`**, **`BINARY_SYNTHETIC_SPREAD_BPS`**, **`SYNTHETIC_MARKET_*`**, etc.

## Optional integration — Polymarket Gamma (live quotes)

Add **exactly one** selector (`BINARY_MARKET_ID`, `BINARY_MARKET_SLUG`, or `BINARY_CONDITION_ID`) or enable **`AUTO_DISCOVER_BINARY_MARKET=true`**. Then `createBinaryExecutionFeed` builds **`BinaryMarketFeed`**.

| Concern | Modules |
|--------|---------|
| Selector + banner | `binaryMarketSelector.ts` |
| REST + CLOB bootstrap | `binaryMarketFeed.ts`, `gammaMarketResolve.ts`, `gammaMarketQuoteParse.ts`, `gammaClobOutcomePrices.ts` |
| Rolling BTC 5m discovery | `discoverBtc5mUpDownMarket.ts` |
| One-shot validation CLI | `npm run validate-binary-market` → `src/validateBinaryMarket.ts` (repo root) |

**`npm run validate-binary-market`** is a **Gamma-only** diagnostic; exit code **`2`** means “no Gamma path” (normal for synthetic-only `.env`). It does not exercise the synthetic feed.
