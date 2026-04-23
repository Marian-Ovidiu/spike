/**
 * Futures-oriented domain types (neutral, no prediction-market semantics).
 *
 * ## Relation to `src/market/types.ts`
 *
 * - **`ExecutableTopOfBook`** ↔ **`TopOfBookL1`**: same numeric layout; migrate by mapping fields
 *   when adapters produce book snapshots.
 * - **`MarketDataFeed`**: remains the legacy integration surface (binary + spot); a futures engine
 *   should introduce a narrower port (e.g. `FuturesMarketPort`) that returns `MarketTick` /
 *   `TopOfBookL1` without `getBinaryOutcomePrices`.
 * - **`MarketMode` / `BinaryOutcomePrices`**: not imported here — binary-only types should stay in
 *   `market/types.ts` until legacy paths are deleted or wrapped.
 */

export type { VenueId, SymbolCode, VenueSymbol } from "./symbol.js";
export type {
  InstrumentId,
  InstrumentKind,
  Instrument,
} from "./instrument.js";
export type { OrderSide, PositionSide } from "./sides.js";
export type { TopOfBookL1 } from "./book.js";
export type { MarketTick } from "./marketTick.js";
export type { Position } from "./position.js";
export type { Fill } from "./fill.js";
export type { ExecutionStatus, ExecutionResult } from "./executionResult.js";
export type { FeeSlippageSummary } from "./costs.js";
