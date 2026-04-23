import type { InstrumentId } from "../domain/instrument.js";
import type { VenueId } from "../domain/symbol.js";

/** Stable id for Binance **spot** symbols until a persisted instrument registry exists. */
export function binanceSpotInstrumentId(symbolCode: string): InstrumentId {
  const u = symbolCode.trim().toUpperCase();
  return `binance:spot:${u}`;
}

/** Reserved pattern for a future USD-M perpetual adapter (not implemented yet). */
export function binanceUsdmPerpInstrumentId(symbolCode: string): InstrumentId {
  const u = symbolCode.trim().toUpperCase();
  return `binance:usdm_perp:${u}`;
}

export function parseVenueFromInstrumentId(id: InstrumentId): VenueId | null {
  const parts = id.split(":");
  return parts.length >= 1 ? parts[0]! : null;
}
