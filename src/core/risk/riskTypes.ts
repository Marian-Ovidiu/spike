/**
 * Outcome of an **operational** risk check (feeds, spread, cooldown, capacity).
 * Intentionally no signal / strategy fields — keep those upstream.
 */
export type RiskGateResult = {
  allowed: boolean;
  /** Stable machine-oriented codes (e.g. `spread_too_wide`). */
  rejectionReasons: string[];
  /**
   * Quote-currency size after min/max clamp (same units as stake/notional config).
   * `0` when blocked by a hard gate or when sizing collapses below minimum.
   */
  suggestedSizeQuote: number;
};

/** Codes returned in {@link RiskGateResult.rejectionReasons}. */
export const RISK_REJECTION_CODES = {
  EXECUTION_FEED_STALE: "execution_feed_stale",
  SIGNAL_FEED_STALE: "signal_feed_stale",
  SPREAD_TOO_WIDE: "spread_too_wide",
  COOLDOWN_ACTIVE: "cooldown_active",
  POSITION_ALREADY_OPEN: "position_already_open",
  BELOW_MIN_TRADE_SIZE: "below_min_trade_size",
  ABOVE_MAX_TRADE_SIZE: "above_max_trade_size",
  INVALID_BOOK: "invalid_book",
} as const;

export type RiskEvaluationInput = {
  nowMs: number;
  /**
   * Start of cooldown window — typically last **exit** timestamp (aligned with legacy
   * `entryCooldownMs` between round-trips).
   */
  lastCooldownAnchorMs: number | null;
  /** Single-position engines: block new entry when true. */
  hasOpenPosition: boolean;
  /**
   * Execution venue path only (spread, staleness). Do not pass signal-path diagnostics here;
   * use {@link RiskEvaluationInput.signal} only when config enables that gate.
   */
  execution: {
    /** True when execution feed is considered too old for new risk. */
    feedStale: boolean;
    spreadBps: number;
    /** Set false when bid/ask/mid invalid or crossed. */
    bookValid?: boolean;
  };
  /**
   * Optional separate staleness for **signal** feed — gated only if
   * `config.blockEntriesOnSignalFeedStale` is true (default false to avoid mixing concerns).
   */
  signal?: {
    feedStale: boolean;
  };
  /** If set, sizes this request; otherwise engine uses `config.baseStakeQuote`. */
  proposedSizeQuote?: number;
};

export type { RiskEngineConfig } from "./riskConfig.js";
