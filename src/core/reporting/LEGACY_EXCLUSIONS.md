# Legacy monitor fields intentionally excluded (futures reporting)

The futures-neutral schema in this folder deliberately **does not** carry **binary / Polymarket / prediction-market** concepts that appear in `src/monitorPersistence.ts`, `opportunityTracker`, or binary monitor JSONL.

## Excluded (do not map into `FuturesJsonlEvent`)

| Area | Examples (legacy / binary) |
|------|----------------------------|
| Outcome legs | `yesPrice`, `noPrice`, `entryOutcomeSide`, `outcomeTokenBought`, `sideBought` |
| Probabilities | `estimatedProbabilityUp`, `probabilityTimeHorizonMs`, any P(up) in \([0,1]\) as a “fair” outcome price |
| Gamma / Polymarket identifiers | `binaryMarketId`, `binarySlug`, `binaryQuestion`, `binaryConditionId`, Polymarket URLs |
| Binary quote health (venue) | `binaryQuoteStale`, `binaryQuoteAgeMs` (use execution `mid` / spread / staleness under a **single** instrument in the runtime layer, not separate YES/NO books) |
| Synthetic binary pricing | Synthetic mid/spread diagnostics tied to YES/NO replication, `invalidMarketPricesAudit` in the binary sense |
| Session summary (binary-only) | `binaryRunAnalytics`, `multiSessionAggregate`, `binaryQuoteSession`, `binaryOutcomeExitAudit` |
| Funnel wording tied to binary opportunities | `candidateOpportunities`, `validOpportunities`, `entryRejectionPrimaryBlocker` **as named in legacy** — futures session summary uses its own counter names |

## Allowed in futures (examples)

- **Instrument**: `instrumentId` (e.g. `binance:spot:BTCUSDT`), not market slug.
- **Book / risk**: bid, ask, mid, `spreadBps`, staleness as interpreted by the **single** execution path.
- **Signal**: neutral `SignalEvaluation` fields (no outcome token, no 0..1 YES price).
- **P/L**: quote-denominated realized / unrealized for linear-style paper engines.

When adding fields, prefer **one instrument, one book, one P/L curve** — not a pair of outcome prices.
