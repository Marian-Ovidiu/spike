import type { BinaryQuoteStaleResult } from "../venue/binaryMarketFeed.js";
import type { NormalizedBinaryQuote } from "../../market/binaryQuoteTypes.js";

function fmtTime(): string {
  return new Date().toLocaleTimeString("en-GB", { hour12: false });
}

/**
 * Polymarket Gamma YES/NO diagnostic line — printed only when `DEBUG_MONITOR=1`
 * from the live monitor tick loop; not part of the default Italian live line.
 */
export function formatPolymarketBinaryQuoteMonitorLine(input: {
  quote: NormalizedBinaryQuote | null;
  stale: BinaryQuoteStaleResult;
  lastError: string | null;
}): string {
  const t = fmtTime();
  const st = input.stale.stale
    ? `STALE${input.stale.reason ? ` (${input.stale.reason})` : ""}`
    : "fresh";
  if (input.quote === null) {
    return `[gamma] ${t}  │  no quote  │  err=${input.lastError ?? "—"}  │  ${st}`;
  }
  const q = input.quote;
  const vol =
    q.volume !== null && Number.isFinite(q.volume) ? q.volume.toFixed(0) : "—";
  const qAge = q.quoteAgeMs !== null ? `${Math.round(q.quoteAgeMs)}ms` : "n/a";
  return `[gamma] ${t}  │  ${q.slug || q.marketId}  │  YES ${q.yesPrice.toFixed(4)} NO ${q.noPrice.toFixed(4)}  │  vol ${vol}  │  venueAge ${qAge}  │  ${st}`;
}
