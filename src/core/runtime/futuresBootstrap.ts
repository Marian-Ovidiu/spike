/**
 * Wiring for the futures-oriented monitor: shared app config + core modules only.
 */
import "dotenv/config";

import type { EvaluateSignalConditionsInput } from "../signal/signalEvaluate.js";
import type { FuturesPaperEngineConfig } from "../execution/futuresPaperTypes.js";
import { FuturesPaperEngine } from "../execution/FuturesPaperEngine.js";
import { RiskEngine } from "../risk/RiskEngine.js";
import type { RiskEngineConfig } from "../risk/riskConfig.js";
import { RollingPriceBuffer } from "../signal/rollingPriceBuffer.js";
import type { FuturesMarketFeed } from "../market/futuresFeed.js";
import { createDefaultFuturesMarketFeed } from "../market/futuresFeed.js";
import { config } from "../../config.js";

/** Matches legacy `MIN_SAMPLES_FOR_STRATEGY` — spike math needs sufficient window. */
export const FUTURES_MIN_SAMPLES_FOR_SIGNAL = 11;

function envBool(key: string, fallback: boolean): boolean {
  const v = process.env[key]?.trim().toLowerCase();
  if (!v) return fallback;
  if (v === "1" || v === "true" || v === "yes") return true;
  if (v === "0" || v === "false" || v === "no") return false;
  return fallback;
}

function envNumber(key: string, fallback: number): number {
  const raw = process.env[key]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export type FuturesMonitorRuntime = {
  feed: FuturesMarketFeed;
  risk: RiskEngine;
  paper: FuturesPaperEngine;
  priceBuffer: RollingPriceBuffer;
  feedStaleMaxAgeMs: number;
  tickIntervalMs: number;
  minSamples: number;
  signalInputBase: Omit<EvaluateSignalConditionsInput, "prices">;
  /** When true, risk treats execution feed age vs `feedStaleMaxAgeMs`. */
  blockEntriesOnExecutionFeedStale: boolean;
  entryConfirmationTicks: number;
  entryRequireReversal: boolean;
  balanceTrackingEnabled: boolean;
  balanceStartingBalance: number;
  balanceReserveBalance: number;
  balanceFixedStakeUntilBalance: number;
  balanceMinBalanceToContinue: number;
};

function buildPaperConfig(): FuturesPaperEngineConfig {
  return {
    takeProfitBps: envNumber("FUTURES_TP_BPS", config.takeProfitBps),
    stopLossBps: envNumber("FUTURES_SL_BPS", config.stopLossBps),
    exitTimeoutMs: envNumber("FUTURES_EXIT_TIMEOUT_MS", config.exitTimeoutMs),
    feeRoundTripBps: envNumber(
      "FUTURES_FEE_ROUND_TRIP_BPS",
      config.paperFeeRoundTripBps
    ),
    slippageBps: envNumber(
      "FUTURES_SLIPPAGE_BPS",
      config.binaryPaperSlippageBps
    ),
    exitGracePeriodMs: envNumber("FUTURES_EXIT_GRACE_MS", 5_000),
    forcedExitPenaltyBps: envNumber("FUTURES_FORCED_EXIT_PENALTY_BPS", 25),
    initialMarginRate: envNumber("FUTURES_INITIAL_MARGIN_RATE", 0.05),
    maintenanceMarginRate: envNumber("FUTURES_MAINTENANCE_MARGIN_RATE", 0.0375),
    marginWarningRatio: envNumber("FUTURES_MARGIN_WARNING_RATIO", 1.25),
    liquidationRiskRatio: envNumber("FUTURES_LIQUIDATION_RISK_RATIO", 1.05),
    liquidationPenaltyBps: envNumber("FUTURES_LIQUIDATION_PENALTY_BPS", 50),
    profitLockEnabled: envBool("FUTURES_PROFIT_LOCK_ENABLED", false),
    profitLockThresholdQuote: envNumber(
      "FUTURES_PROFIT_LOCK_THRESHOLD_QUOTE",
      1
    ),
    trailingProfitEnabled: envBool("FUTURES_TRAILING_PROFIT_ENABLED", false),
    trailingProfitDropQuote: envNumber(
      "FUTURES_TRAILING_PROFIT_DROP_QUOTE",
      0
    ),
  };
}

function buildRiskConfig(): RiskEngineConfig {
  const blockStale = envBool(
    "FUTURES_BLOCK_ON_STALE_FEED",
    config.blockEntriesOnStaleFeed
  );

  const blockSignalStale = envBool("FUTURES_BLOCK_ON_SIGNAL_STALE", false);

  return {
    blockEntriesOnExecutionFeedStale: blockStale,
    blockEntriesOnSignalFeedStale: blockSignalStale,
    maxEntrySpreadBps: envNumber(
      "FUTURES_MAX_ENTRY_SPREAD_BPS",
      config.maxEntrySpreadBps
    ),
    entryCooldownMs: envNumber(
      "FUTURES_ENTRY_COOLDOWN_MS",
      config.entryCooldownMs
    ),
    baseStakeQuote: envNumber("FUTURES_STAKE_QUOTE", config.stakePerTrade),
    minTradeSizeQuote: envNumber(
      "FUTURES_MIN_TRADE_QUOTE",
      config.minTradeSize
    ),
    maxTradeSizeQuote: envNumber(
      "FUTURES_MAX_TRADE_QUOTE",
      config.maxTradeSize
    ),
  };
}

export function createFuturesMonitorRuntime(): FuturesMonitorRuntime {
  const futuresContractSymbol =
    process.env.FUTURES_CONTRACT_SYMBOL?.trim() ||
    process.env.FUTURES_DEFAULT_SYMBOL?.trim() ||
    "BTCUSDT";
  const feed = createDefaultFuturesMarketFeed({
    symbol: futuresContractSymbol,
    initialSignalMid: envNumber("FUTURES_PAPER_MID", 95_000),
    initialSpreadBps: envNumber("FUTURES_PAPER_SPREAD_BPS", 2),
    syntheticUpdateMs: envNumber("FUTURES_FEED_SYNTHETIC_UPDATE_MS", 2_000),
    oscillationBps: envNumber("FUTURES_FEED_OSCILLATION_BPS", 18),
    markBasisBps: envNumber("FUTURES_FEED_MARK_BASIS_BPS", 0.8),
    indexBasisBps: envNumber("FUTURES_FEED_INDEX_BASIS_BPS", -0.2),
    fundingBiasBps: envNumber("FUTURES_FEED_FUNDING_BIAS_BPS", 0.05),
    spotProxyFallback: envBool("FUTURES_USE_SPOT_PROXY_FALLBACK", false),
  });

  const feedStaleMaxAgeMs = envNumber(
    "FUTURES_FEED_STALE_MAX_MS",
    config.feedStaleMaxAgeMs
  );

  const tickIntervalMs = envNumber(
    "FUTURES_TICK_INTERVAL_MS",
    5_000
  );

  const riskCfg = buildRiskConfig();

  const signalInputBase: Omit<EvaluateSignalConditionsInput, "prices"> = {
    rangeThreshold: config.rangeThreshold,
    stableRangeSoftToleranceRatio: config.stableRangeSoftToleranceRatio,
    strongSpikeHardRejectPoorRange: config.strongSpikeHardRejectPoorRange,
    spikeThreshold: config.spikeThreshold,
    spikeMinRangeMultiple: config.spikeMinRangeMultiple,
    borderlineMinRatio: config.borderlineMinRatio,
    tradableSpikeMinPercent: config.tradableSpikeMinPercent,
  };

  return {
    feed,
    risk: new RiskEngine(riskCfg),
    paper: new FuturesPaperEngine(buildPaperConfig()),
    priceBuffer: new RollingPriceBuffer(config.priceBufferSize),
    feedStaleMaxAgeMs,
    tickIntervalMs,
    minSamples: FUTURES_MIN_SAMPLES_FOR_SIGNAL,
    signalInputBase,
    blockEntriesOnExecutionFeedStale:
      riskCfg.blockEntriesOnExecutionFeedStale,
    entryConfirmationTicks: envNumber("FUTURES_ENTRY_CONFIRMATION_TICKS", 2),
    entryRequireReversal: envBool("FUTURES_ENTRY_REQUIRE_REVERSAL", false),
    balanceTrackingEnabled: envBool(
      "FUTURES_BALANCE_TRACKING_ENABLED",
      false
    ),
    balanceStartingBalance: envNumber("FUTURES_STARTING_BALANCE", 110),
    balanceReserveBalance: envNumber("FUTURES_RESERVE_BALANCE", 10),
    balanceFixedStakeUntilBalance: envNumber(
      "FUTURES_FIXED_STAKE_UNTIL_BALANCE",
      120
    ),
    balanceMinBalanceToContinue: envNumber(
      "FUTURES_MIN_BALANCE_TO_CONTINUE",
      100
    ),
  };
}
