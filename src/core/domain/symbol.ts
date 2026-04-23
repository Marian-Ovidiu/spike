/**
 * Exchange-facing identity for a tradable instrument.
 * `code` is venue-native (e.g. `BTCUSDT`, `BTC-PERP`).
 */
export type VenueId = string;

/** Human- or API-level symbol string; not parsed here. */
export type SymbolCode = string;

export interface VenueSymbol {
  readonly venue: VenueId;
  readonly code: SymbolCode;
}
