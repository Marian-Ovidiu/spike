import type { EntryDirection } from "./entryConditions.js";
import type { ExecutableTopOfBook } from "./market/types.js";

/** Executable top-of-book (any venue: Binance book, binary synthetic, replay mid). */
export type ExecutableBookQuote = ExecutableTopOfBook;

/** Symmetric book around mid (backtest / replay when only mid is known). */
export function syntheticExecutableBookFromMid(
  mid: number,
  spreadBps: number
): ExecutableBookQuote {
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

export type ExecutionSpreadBlocker = "spread_too_wide";

/**
 * Reject entries when the bid/ask spread is wider than allowed (illiquid / noisy book).
 */
export function evaluateExecutionSpreadFilter(input: {
  spreadBps: number;
  maxEntrySpreadBps: number;
}): ExecutionSpreadBlocker | null {
  if (!Number.isFinite(input.spreadBps) || !Number.isFinite(input.maxEntrySpreadBps)) {
    return "spread_too_wide";
  }
  if (input.spreadBps > input.maxEntrySpreadBps) {
    return "spread_too_wide";
  }
  return null;
}

/** Top-of-book sanity + spread cap for strategy pipeline. */
export function evaluateExecutionBookPipeline(
  book: ExecutableBookQuote,
  maxEntrySpreadBps: number
): "invalid_book" | "spread_too_wide" | null {
  if (
    !Number.isFinite(book.bestBid) ||
    !Number.isFinite(book.bestAsk) ||
    book.bestAsk < book.bestBid
  ) {
    return "invalid_book";
  }
  return evaluateExecutionSpreadFilter({
    spreadBps: book.spreadBps,
    maxEntrySpreadBps,
  });
}
