import type { InstrumentId } from "./instrument.js";
import type { PositionSide } from "./sides.js";

/**
 * Open derivatives position (single instrument, single direction).
 * Quantity is signed-by-side convention: always positive here; use `side` for exposure.
 */
export interface Position {
  readonly instrumentId: InstrumentId;
  readonly side: PositionSide;
  /** Base quantity (contracts or coins per venue semantics) */
  readonly quantity: number;
  /** Volume-weighted average entry in quote per base */
  readonly avgEntryPrice: number;
  readonly openedAtMs: number;
  /** Optional unrealized metrics for MTM-style logs */
  readonly unrealizedPnlQuote?: number;
}
