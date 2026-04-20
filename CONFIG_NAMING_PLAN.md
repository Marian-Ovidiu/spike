# Config and naming plan (binary-first)

This document tracks **ambiguous “spot” naming** vs **execution-neutral / binary-first** names, env canonicalization, and what changed in the codebase.

## Execution: synthetic lab vs Gamma

- **Core path (default):** no Gamma selector → synthetic YES/NO execution (`BinarySyntheticFeed`). **`.env.example`** follows this path (`AUTO_DISCOVER_BINARY_MARKET=false`, no `BINARY_MARKET_*`).
- **Optional integration:** Polymarket Gamma modules under `src/binary/venue/` (see **`README.md`** in that folder). **`npm run validate-binary-market`** is Gamma-only.

## Principles

1. **Canonical env name** — one primary `process.env` key per `AppConfig` field (`ENV_KEYS` in `src/config.ts`). Legacy aliases remain supported but emit **warnings** where noted.
2. **Startup provenance** — grouped config lines show `canonical=<ENV_KEYS>` and `from=<actual var>` (or `default` / provenance text).
3. **Gamma selectors** — prefer `BINARY_MARKET_*` / `BINARY_CONDITION_ID` over `POLYMARKET_*`. Internal `BINARY_*` → `POLYMARKET_*` hydration (when legacy slots are empty) is silent; a **warning** runs when only `POLYMARKET_*` is set for a tier without the matching `BINARY_*`.

## Renames and clarifications (done)

| Area | Before | After |
|------|--------|--------|
| Spread / book helpers | `spotSpreadFilter` (historical) | `executionSpreadFilter.ts` — `evaluateExecutionSpreadFilter`, `ExecutableBookQuote` |
| Sim types | `SpotBookSides` | `ExecutableBookQuote` (`simulationEngine.ts`) |
| Replay helper | `spotBookFromRow` | `executionBookQuoteFromJsonlRow` |
| Normalized monitor JSON | `staleFeeds.signalOrSpotBookStaleMaxAgeMs` | `signalFeedStaleMaxAgeMs` (Binance signal / legacy spot book age) |
| Grouped config section | “Spot-only …” | “**Legacy spot execution** …” |
| Entry pipeline docs | “SpotMicrostructure” wording | “Execution venue top-of-book” (`entryConditions.ts`) |
| Shutdown diagnostics var | `spotFeed` | `binanceBookFeed` (`marketDiagnostics.ts`) |

## Intentionally unchanged (larger refactors deferred)

| Item | Reason |
|------|--------|
| `NormalizedSpotBook` in `binanceSpotFeed.ts` | Shared L1 shape for Binance + synthetic adapter; rename would touch many imports without behaviour gain. |
| `MarketMode` / `executionModel: "spot"` | Runtime mode string; changing would break env and persisted JSON. |
| `CONFIG_KEY_GROUP` value `"spot"` | Internal tag for “legacy spot execution keys”; display strings are user-facing. |
| `POLYMARKET_POLL_*` in `monitorNormalizedConfigSummary` env reads | Post-hydration env still exposes those names; canonical read order can be tightened in a follow-up. |

## Legacy env aliases (warn-only)

Listed in `DEPRECATED_CONFIG_ENV_ALIASES` and `parseEnvNumberPrimaryOrLegacy` / `parseBinarySignalSource` / `parseBinarySignalSymbol` in `config.ts`, including: `SIGNAL_MODE`, `PAPER_SLIPPAGE_BPS`, `MAX_OPPOSITE_SIDE_ENTRY_PRICE`, `MAX_ENTRY_SIDE_PRICE`, `NEUTRAL_QUOTE_BAND_*`, and `BINANCE_SYMBOL` as fallback for `BINARY_SIGNAL_SYMBOL` (binary mode warns when used without `BINARY_SIGNAL_SYMBOL`).
