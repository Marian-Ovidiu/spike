import type { BotContext } from "../../botLoop.js";
import { BinaryMarketFeed } from "../venue/binaryMarketFeed.js";

export function buildBinaryQuoteMeta(ctx: BotContext): {
  quoteAgeMs: number | null;
  quoteStale: boolean;
  marketId?: string;
  slug?: string;
  question?: string;
  conditionId?: string | null;
} | undefined {
  if (ctx.config.marketMode !== "binary") return undefined;
  const stale = ctx.executionFeed.getQuoteStale();
  if (ctx.executionFeed instanceof BinaryMarketFeed) {
    const q = ctx.executionFeed.getNormalizedBinaryQuote();
    return {
      quoteAgeMs: q?.quoteAgeMs ?? null,
      quoteStale: stale.stale,
      ...(q !== null
        ? {
            marketId: q.marketId,
            slug: q.slug,
            question: q.question,
            conditionId: q.conditionId,
          }
        : {}),
    };
  }
  return {
    quoteAgeMs: null,
    quoteStale: stale.stale,
  };
}
