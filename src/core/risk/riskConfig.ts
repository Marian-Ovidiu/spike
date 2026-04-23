/**
 * Operational risk knobs (subset of what today lives in `AppConfig` / monitor).
 * No strategy thresholds — wire from env in a future loader.
 */
export type RiskEngineConfig = {
  /** Block new entries when execution quote/stream is stale. */
  blockEntriesOnExecutionFeedStale: boolean;
  /**
   * Optional: block when **signal** feed is stale (off by default; keeps signal vs execution separate).
   */
  blockEntriesOnSignalFeedStale: boolean;
  /**
   * Max bid/ask spread (bps) on execution book (`MAX_ENTRY_SPREAD_BPS`).
   * `0` = disable spread gate.
   */
  maxEntrySpreadBps: number;
  /** Minimum ms since `lastCooldownAnchorMs` before a new entry — `entryCooldownMs`. */
  entryCooldownMs: number;
  /** Default stake/notional (quote) before clamp — mirrors `STAKE_PER_TRADE`. */
  baseStakeQuote: number;
  /** Floor on stake (`MIN_TRADE_SIZE`). */
  minTradeSizeQuote: number;
  /** Hard cap (`MAX_TRADE_SIZE`); `0` = no upper cap (legacy convention). */
  maxTradeSizeQuote: number;
};
