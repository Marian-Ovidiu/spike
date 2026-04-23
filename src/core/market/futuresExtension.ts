/**
 * Reserved extension points for a future Binance USD-M (or CM) futures adapter.
 *
 * The futures runtime now depends on `core/market/futuresFeed.ts` for its boundary.
 * This file only keeps adapter naming reserved for an exchange-specific implementation.
 */

import type { FuturesMarketFeed } from "./futuresFeed.js";

/** Discriminant for factories when multiple venue adapters coexist. */
export type CoreVenueAdapterKind = "binance_spot" | "binance_usdm_perp_pending";

/** Alias reserved until a real USD-M implementation lands. */
export type FuturesDualFeedPlaceholder = FuturesMarketFeed;
