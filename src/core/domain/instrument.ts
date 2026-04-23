import type { VenueSymbol } from "./symbol.js";

/**
 * Broad instrument class for routing feeds, margin rules, and contract math.
 * `spot` included only if the same engine must cohabit with spot hedges — not binary.
 */
export type InstrumentKind =
  | "perpetual_swap"
  | "dated_future"
  | "spot";

/** Opaque id (UUID, exchange id, or composite key) — define policy at persistence layer. */
export type InstrumentId = string;

/**
 * Static contract metadata needed for sizing, rounding, and P/L in quote terms.
 */
export interface Instrument {
  readonly id: InstrumentId;
  readonly venueSymbol: VenueSymbol;
  readonly kind: InstrumentKind;
  /** Base asset symbol, e.g. BTC */
  readonly baseAsset: string;
  /** Quote asset symbol, e.g. USDT */
  readonly quoteAsset: string;
  /** Minimum price increment */
  readonly tickSize: number;
  /** Minimum quantity increment (contracts or base units per venue rules) */
  readonly lotSize: number;
  /** Optional minimum order quantity if the venue enforces one above lot size. */
  readonly minQuantity?: number;
  /** Optional contract multiplier (e.g. USD per index point); 1 if not used */
  readonly contractMultiplier?: number;
}
