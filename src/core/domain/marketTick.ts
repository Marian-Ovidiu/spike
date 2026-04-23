import type { InstrumentId } from "./instrument.js";
import type { TopOfBookL1 } from "./book.js";

/**
 * One observation of market state at a point in time (polling or streaming).
 * Prices are absolute quote terms (e.g. USDT per BTC), never probability masses.
 */
export interface MarketTick {
  readonly observedAtMs: number;
  readonly instrumentId: InstrumentId;
  /** Last traded price if available */
  readonly lastPrice?: number;
  /** Mark / index used for liquidation / futures valuation when distinct from last */
  readonly markPrice?: number;
  readonly book?: TopOfBookL1;
  /** Venue sequence or exchange timestamp for ordering / gap detection */
  readonly sequence?: number | bigint;
}
