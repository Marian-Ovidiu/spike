import type { InstrumentId } from "../domain/instrument.js";
import type { TopOfBookL1 } from "../domain/book.js";
import type { FeedStaleness } from "./staleness.js";

/**
 * Point-in-time cross-section for logging, joins, and strategy ticks.
 * No venue-specific payloads — extend with optional fields per adapter if needed.
 */
export interface MarketSnapshot {
  readonly instrumentId: InstrumentId;
  readonly observedAtMs: number;
  /** Mid used for rolling signal buffer (typically L1 mid). */
  readonly signalMid: number | null;
  readonly lastTradePrice: number | null;
  readonly book: TopOfBookL1 | null;
  readonly staleness: FeedStaleness;
}
