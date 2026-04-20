import type { MarketDataFeed } from "../../market/types.js";
import { BinaryMarketFeed } from "../venue/binaryMarketFeed.js";
import { BinarySyntheticFeed } from "../venue/binarySyntheticFeed.js";

/** One-line description of the binary execution venue for the live monitor banner. */
export function buildBinaryBannerExecutionLine(feed: MarketDataFeed): string {
  if (feed instanceof BinaryMarketFeed) {
    const sel = feed.getGammaSelectorDiagnostics();
    const q = feed.getNormalizedBinaryQuote();
    if (q !== null) {
      const slug = q.slug || q.marketId || "—";
      const qn =
        q.question.length > 100 ? `${q.question.slice(0, 100)}…` : q.question;
      return `${slug}  │  ${qn}`;
    }
    return `gamma  │  ${sel.selectorKind}=${sel.selectorValue} (${sel.sourceEnvKey})  │  quote not loaded yet`;
  }
  if (feed instanceof BinarySyntheticFeed) {
    return `synthetic ${feed.getSymbol()}`;
  }
  return feed.getSymbol();
}
