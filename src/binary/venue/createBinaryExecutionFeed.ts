import type { MarketDataFeed } from "../../market/types.js";
import { BinaryMarketFeed, type BinaryMarketFeedOptions } from "./binaryMarketFeed.js";
import {
  formatBinaryExecutionVenueBannerLine,
  isGammaExecutionConfigured,
  isPolymarketGammaConfigured,
  resolveBinaryMarketSelectorFromEnv,
} from "./binaryMarketSelector.js";
import { BinarySyntheticFeed } from "./binarySyntheticFeed.js";

export {
  formatBinaryExecutionVenueBannerLine,
  isGammaExecutionConfigured,
  isPolymarketGammaConfigured,
  resolveBinaryMarketSelectorFromEnv,
};

/**
 * Binary **execution** venue factory.
 *
 * **Default (core lab path):** no Gamma selector in env → {@link BinarySyntheticFeed}
 * (synthetic YES/NO; no Polymarket network).
 *
 * **Optional integration:** when {@link resolveBinaryMarketSelectorFromEnv} returns
 * `executionMode === "gamma"`, returns {@link BinaryMarketFeed} (Polymarket Gamma + CLOB).
 */
export function createBinaryExecutionFeed(): MarketDataFeed {
  const sel = resolveBinaryMarketSelectorFromEnv();
  if (sel.executionMode === "synthetic") {
    return new BinarySyntheticFeed();
  }
  const opts: BinaryMarketFeedOptions = {
    selectorSourceEnvKey: sel.sourceEnvKey,
  };
  if (sel.selectorKind === "market_id") {
    opts.marketId = sel.selectorValue;
  } else if (sel.selectorKind === "slug") {
    opts.slug = sel.selectorValue;
  } else {
    opts.conditionId = sel.selectorValue;
  }
  return new BinaryMarketFeed(opts);
}
