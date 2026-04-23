import type { InstrumentId } from "../domain/instrument.js";
import type { TopOfBookL1 } from "../domain/book.js";
import type { MarketTick } from "../domain/marketTick.js";
import type { FeedStaleness } from "./staleness.js";
import type { MarketSnapshot } from "./snapshot.js";

/**
 * L1 book access for spread checks and aggressive fill models.
 */
export interface TopOfBookProvider {
  getTopOfBookL1(): TopOfBookL1 | null;
}

/**
 * Price feed driving the signal path (rolling buffer, spike math).
 * Intentionally **no** binary/outcome methods — pure scalar series + transport health.
 *
 * Future: Binance USD-M futures mid/index can implement the same port with a different
 * underlying client while keeping `instrumentId` pointed at a perpetual contract.
 */
export interface MarketDataFeed {
  readonly instrumentId: InstrumentId;

  /** Best available mid for signal sampling (null until first valid book/bootstrap). */
  getSignalMid(): number | null;

  getLastMessageAgeMs(nowMs?: number): number;

  getStaleness(nowMs?: number): FeedStaleness;

  bootstrapRest(): Promise<boolean>;

  start(): void;

  stop(): void;

  /**
   * Canonical snapshot for one strategy tick; default implementation may compose book + staleness.
   */
  getMarketSnapshot(nowMs?: number): MarketSnapshot | null;

  /** Optional: structured tick for futures adapters that separate mark vs last. */
  getMarketTick?(nowMs?: number): MarketTick | null;
}

/**
 * Executable venue for paper/live execution (L1 view). On spot, often the **same** connection
 * as {@link MarketDataFeed}; on futures, may be a separate stream or merged book.
 */
export interface ExecutionVenueFeed extends TopOfBookProvider {
  readonly instrumentId: InstrumentId;

  getStaleness(nowMs?: number): FeedStaleness;

  bootstrapRest(): Promise<boolean>;

  start(): void;

  stop(): void;
}

/**
 * Combined spot-style feed where signal and execution share one Binance spot socket.
 * Futures refactor may split into two concrete classes behind a factory.
 */
export type SpotDualFeed = MarketDataFeed & ExecutionVenueFeed;
