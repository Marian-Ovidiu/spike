import type { InstrumentId } from "./instrument.js";
import type { OrderSide } from "./sides.js";

/**
 * Single execution print against an order (partial fills aggregate into multiple fills).
 */
export interface Fill {
  readonly fillId: string;
  readonly instrumentId: InstrumentId;
  readonly side: OrderSide;
  readonly price: number;
  readonly quantity: number;
  /** Fee charged in quote currency (positive number = cost) */
  readonly feeQuote: number;
  readonly executedAtMs: number;
  readonly liquidity?: "maker" | "taker";
}
