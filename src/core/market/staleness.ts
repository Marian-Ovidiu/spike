/**
 * Feed freshness for gating entries (symmetric with legacy `QuoteStaleResult`, standalone name).
 */
export type FeedStaleness = {
  readonly stale: boolean;
  readonly reason: string | null;
};
