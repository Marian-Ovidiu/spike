/**
 * Level-1 executable view used for spread checks and simplistic fill models.
 *
 * Migration: same numeric layout as `ExecutableTopOfBook` in `src/market/types.ts`.
 * Map from `NormalizedSpotBook` via `toExecutableTopOfBook` today, then assign to this shape.
 */
export interface TopOfBookL1 {
  readonly bestBid: number;
  readonly bestAsk: number;
  readonly midPrice: number;
  /** Full bid–ask width as fraction of mid × 10_000 */
  readonly spreadBps: number;
  /** Optional depth at L1 for impact-style slippage models */
  readonly bestBidSize?: number;
  readonly bestAskSize?: number;
}
