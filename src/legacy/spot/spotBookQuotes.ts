import type { EntryDirection } from "../../entryConditions.js";
import type { ExecutableBookQuote } from "../../executionSpreadFilter.js";

/** Legacy spot-paper: aggressive buy/sell fill vs book + slippage bps. */
export function legacySpotEntryFillPrice(
  direction: EntryDirection,
  book: ExecutableBookQuote,
  slippageBps: number
): number {
  const slip = slippageBps / 10_000;
  if (direction === "UP") {
    return book.bestAsk * (1 + slip);
  }
  return book.bestBid * (1 - slip);
}

/** Legacy spot-paper: mark for open position (bid for long, ask for short). */
export function legacySpotMarkForPosition(
  direction: EntryDirection,
  book: ExecutableBookQuote
): number {
  return direction === "UP" ? book.bestBid : book.bestAsk;
}
