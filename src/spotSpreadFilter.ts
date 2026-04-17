import type { EntryDirection } from "./entryConditions.js";

export type SpotMicrostructure = {
  bestBid: number;
  bestAsk: number;
  midPrice: number;
  spreadBps: number;
};

/** Symmetric book around mid (backtest / replay when only mid is known). */
export function syntheticSpotBookFromMid(
  mid: number,
  spreadBps: number
): SpotMicrostructure {
  const half = (spreadBps / 10_000 / 2) * mid;
  const bestBid = mid - half;
  const bestAsk = mid + half;
  return {
    bestBid,
    bestAsk,
    midPrice: mid,
    spreadBps,
  };
}

export type SpotSpreadBlocker = "spread_too_wide";

/**
 * Reject entries when the bid/ask spread is wider than allowed (illiquid / noisy book).
 */
export function evaluateSpotSpreadFilter(input: {
  spreadBps: number;
  maxEntrySpreadBps: number;
}): SpotSpreadBlocker | null {
  if (!Number.isFinite(input.spreadBps) || !Number.isFinite(input.maxEntrySpreadBps)) {
    return "spread_too_wide";
  }
  if (input.spreadBps > input.maxEntrySpreadBps) {
    return "spread_too_wide";
  }
  return null;
}

/** Top-of-book sanity + spread cap for strategy pipeline (replaces binary quote filters). */
export function evaluateSpotBookPipeline(
  book: SpotMicrostructure,
  maxEntrySpreadBps: number
): "invalid_book" | "spread_too_wide" | null {
  if (
    !Number.isFinite(book.bestBid) ||
    !Number.isFinite(book.bestAsk) ||
    book.bestAsk < book.bestBid
  ) {
    return "invalid_book";
  }
  return evaluateSpotSpreadFilter({
    spreadBps: book.spreadBps,
    maxEntrySpreadBps,
  });
}

/** Legacy mapping: direction is still UP=long / DOWN=short for pipeline compatibility. */
export function spotEntryFillPrice(
  direction: EntryDirection,
  book: SpotMicrostructure,
  slippageBps: number
): number {
  const slip = slippageBps / 10_000;
  if (direction === "UP") {
    return book.bestAsk * (1 + slip);
  }
  return book.bestBid * (1 - slip);
}

/** Mark price for open position (bid for long, ask for short). */
export function spotMarkForPosition(
  direction: EntryDirection,
  book: SpotMicrostructure
): number {
  return direction === "UP" ? book.bestBid : book.bestAsk;
}
