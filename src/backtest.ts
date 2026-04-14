import { readFile } from "node:fs/promises";

import type { AppConfig } from "./config.js";
import { config as defaultConfig } from "./config.js";
import { evaluateEntryConditions } from "./entryConditions.js";
import { BOT_TICK_INTERVAL_MS, MIN_SAMPLES_FOR_STRATEGY } from "./botLoop.js";
import type { StrategyTickResult } from "./botLoop.js";
import { RollingPriceBuffer } from "./rollingPriceBuffer.js";
import { BorderlineCandidateStore } from "./borderlineCandidateStore.js";
import { StrongSpikeCandidateStore } from "./strongSpikeCandidateStore.js";
import {
  type SimulatedTrade,
  SimulationEngine,
} from "./simulationEngine.js";
import { runStrategyDecisionPipeline } from "./strategyDecisionPipeline.js";

export type BacktestOptions = {
  config: AppConfig;
  /** Simulated ms between ticks (aligns simulated exit timeout with live cadence). */
  tickMs?: number;
  /** Epoch ms for first tick (only relative deltas matter for exit timeout). */
  epochStartMs?: number;
  /** Static binary leg quotes on every step (paper book). */
  sides?: { upSidePrice: number; downSidePrice: number };
  /** Include strict-vs-relaxed comparison (default: true). */
  includeStrictComparison?: boolean;
};

export type BacktestCoreSummary = {
  totalTrades: number;
  winRate: number;
  totalProfit: number;
  maxDrawdown: number;
  strongSpikeEntries: number;
  borderlinePromotions: number;
};

export type BacktestResult = {
  winRate: number;
  totalProfit: number;
  maxDrawdown: number;
  totalTrades: number;
  totalEntries: number;
  wins: number;
  losses: number;
  trades: readonly SimulatedTrade[];
  weakSpike: {
    signals: number;
    rejected: number;
    rejectionRate: number;
  };
  strongSpike: {
    signals: number;
    entries: number;
    tradesClosed: number;
    wins: number;
    losses: number;
    winRate: number;
    totalPnL: number;
    averagePnL: number;
  };
  borderline: {
    signals: number;
    candidatesCreated: number;
    promotions: number;
    cancellations: number;
    expirations: number;
    tradesClosed: number;
    wins: number;
    losses: number;
    winRate: number;
    totalPnL: number;
    averagePnL: number;
  };
  combined: {
    tradesClosed: number;
    wins: number;
    losses: number;
    winRate: number;
    totalPnL: number;
    averagePnL: number;
  };
  rejectionReasonBreakdown: Record<string, number>;
  movement: {
    noSignalMoves: number;
    borderlineMoves: number;
    strongSpikeMoves: number;
  };
  blockers: {
    blockedByCooldown: number;
    blockedByActivePosition: number;
    blockedByInvalidQuotes: number;
    blockedByNoisyRange: number;
    blockedByWidePriorRange: number;
    blockedByHardRejectUnstableContext: number;
    rejectedByWeakSpikeQuality: number;
    rejectedByPriorRangeTooWide: number;
    rejectedByHardUnstableContext: number;
    rejectedByStrongSpikeContinuation: number;
    rejectedByBorderlineContinuation: number;
    rejectedByExpensiveOppositeSide: number;
    exceptionalSpikeSignals: number;
    exceptionalSpikeEntries: number;
    cooldownOverridesUsed: number;
    blockedByExpensiveOppositeSide: number;
    blockedByNeutralQuotes: number;
  };
  evaluationNote: string;
  noiseComparison?: {
    refinedEntries: number;
    baselineEntries: number;
    refinedRejectedOpportunities: number;
    baselineRejectedOpportunities: number;
    reducedNoise: boolean;
  };
  comparison?: {
    relaxed: BacktestCoreSummary;
    strict: BacktestCoreSummary;
  };
};

const DEFAULT_SIDES = { upSidePrice: 0.2, downSidePrice: 0.2 };

/**
 * Parse a CSV or one-column text file into BTC prices (oldest → newest).
 * Supports: one number per line, or CSV with a header containing `price`, `close`, or `btc`.
 */
export function parseHistoricalPriceText(content: string): number[] {
  const lines = content
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));
  if (lines.length === 0) return [];

  const sep = lines[0]!.includes(";") ? ";" : ",";
  const first = lines[0]!;
  const looksLikeHeader =
    /[a-zA-Z]/.test(first) &&
    /price|close|btc|open/i.test(first.toLowerCase());

  let rowStart = 0;
  let priceCol = 0;
  if (looksLikeHeader) {
    rowStart = 1;
    const cols = first.split(sep).map((c) => c.trim().toLowerCase());
    const named = cols.findIndex((c) =>
      /^(price|close|btc)$/.test(c)
    );
    priceCol = named >= 0 ? named : Math.max(0, cols.length - 1);
  }

  const out: number[] = [];
  for (let i = rowStart; i < lines.length; i++) {
    const parts = lines[i]!.split(sep).map((p) => p.trim());
    const raw =
      parts.length === 1 ? parts[0] : (parts[priceCol] ?? parts[parts.length - 1]);
    const n = Number(raw);
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

export async function loadHistoricalPricesFromFile(
  filePath: string
): Promise<number[]> {
  const raw = await readFile(filePath, "utf8");
  return parseHistoricalPriceText(raw);
}

/**
 * Max drawdown on cumulative P/L (peak-to-trough of running equity).
 */
export function maxDrawdownFromTrades(
  trades: readonly SimulatedTrade[]
): number {
  let equity = 0;
  let peak = 0;
  let maxDD = 0;
  for (const t of trades) {
    equity += t.profitLoss;
    peak = Math.max(peak, equity);
    maxDD = Math.max(maxDD, peak - equity);
  }
  return maxDD;
}

/**
 * Replay BTC series through the same buffer → entry → paper simulation path as the live bot.
 */
export function runBacktestReplay(
  btcPrices: readonly number[],
  options: BacktestOptions
): BacktestResult {
  const {
    config,
    tickMs = BOT_TICK_INTERVAL_MS,
    epochStartMs = 0,
    sides = DEFAULT_SIDES,
    includeStrictComparison = true,
  } = options;

  const simulation = new SimulationEngine({
    silent: true,
    initialEquity: config.initialCapital,
  });
  const priceBuffer = new RollingPriceBuffer(config.priceBufferSize);
  const borderlineManager = new BorderlineCandidateStore({
    symbol: "BTCUSD",
    watchTicks: config.borderlineWatchTicks,
  });
  const strongSpikeManager = new StrongSpikeCandidateStore({
    symbol: "BTCUSD",
    watchTicks: config.strongSpikeConfirmationTicks,
  });

  let strongSpikeSignals = 0;
  let strongSpikeEntries = 0;
  let weakSpikeSignals = 0;
  let weakSpikeRejected = 0;
  let borderlineSignals = 0;
  let noSignalMoves = 0;
  let borderlineMoves = 0;
  let strongSpikeMoves = 0;
  let borderlineCandidatesCreated = 0;
  let borderlinePromotions = 0;
  let borderlineCancellations = 0;
  let borderlineExpirations = 0;
  let blockedByCooldown = 0;
  let blockedByActivePosition = 0;
  let blockedByInvalidQuotes = 0;
  let blockedByNoisyRange = 0;
  let blockedByWidePriorRange = 0;
  let blockedByHardRejectUnstableContext = 0;
  let rejectedByWeakSpikeQuality = 0;
  let rejectedByPriorRangeTooWide = 0;
  let rejectedByHardUnstableContext = 0;
  let rejectedByStrongSpikeContinuation = 0;
  let rejectedByBorderlineContinuation = 0;
  let rejectedByExpensiveOppositeSide = 0;
  let exceptionalSpikeSignals = 0;
  let exceptionalSpikeEntries = 0;
  let cooldownOverridesUsed = 0;
  let blockedByExpensiveOppositeSide = 0;
  let blockedByNeutralQuotes = 0;
  const rejectionReasonBreakdown: Record<string, number> = {};

  for (let i = 0; i < btcPrices.length; i++) {
    const btc = btcPrices[i]!;
    const now = epochStartMs + i * tickMs;

    priceBuffer.addPrice(btc);

    if (priceBuffer.getPrices().length < MIN_SAMPLES_FOR_STRATEGY) {
      continue;
    }

    const prev = priceBuffer.getPrevious();
    const last = priceBuffer.getLast();
    if (prev === undefined || last === undefined) continue;

    const prices = priceBuffer.getPrices();
    const entry = evaluateEntryConditions({
      prices,
      rangeThreshold: config.rangeThreshold,
      stableRangeSoftToleranceRatio: config.stableRangeSoftToleranceRatio,
      strongSpikeHardRejectPoorRange: config.strongSpikeHardRejectPoorRange,
      previousPrice: prev,
      currentPrice: last,
      spikeThreshold: config.spikeThreshold,
      spikeMinRangeMultiple: config.spikeMinRangeMultiple,
      borderlineMinRatio: config.borderlineMinRatio,
      entryPrice: config.entryPrice,
      maxOppositeSideEntryPrice: config.maxOppositeSideEntryPrice,
      neutralQuoteBandMin: config.neutralQuoteBandMin,
      neutralQuoteBandMax: config.neutralQuoteBandMax,
      upSidePrice: sides.upSidePrice,
      downSidePrice: sides.downSidePrice,
    });

    if (entry.windowSpike?.classification === "strong_spike") {
      strongSpikeSignals += 1;
      strongSpikeMoves += 1;
      if (entry.movement.strongestMovePercent >= config.exceptionalSpikePercent) {
        exceptionalSpikeSignals += 1;
      }
    } else if (entry.windowSpike?.classification === "borderline") {
      borderlineSignals += 1;
      borderlineMoves += 1;
    } else {
      noSignalMoves += 1;
    }

    const tick: StrategyTickResult = {
      kind: "ready",
      btc,
      n: prices.length,
      cap: config.priceBufferSize,
      prev,
      last,
      prices,
      sides,
      entry,
    };

    const pipeline = runStrategyDecisionPipeline({
      now,
      tick,
      manager: borderlineManager,
      strongSpikeManager,
      simulation,
      config: {
        rangeThreshold: config.rangeThreshold,
        stableRangeSoftToleranceRatio: config.stableRangeSoftToleranceRatio,
        strongSpikeHardRejectPoorRange: config.strongSpikeHardRejectPoorRange,
        spikeThreshold: config.spikeThreshold,
        tradableSpikeMinPercent: config.tradableSpikeMinPercent,
        maxPriorRangeForNormalEntry: config.maxPriorRangeForNormalEntry,
        hardRejectPriorRangePercent: config.hardRejectPriorRangePercent,
        strongSpikeConfirmationTicks: config.strongSpikeConfirmationTicks,
        exceptionalSpikePercent: config.exceptionalSpikePercent,
        exceptionalSpikeOverridesCooldown: config.exceptionalSpikeOverridesCooldown,
        entryPrice: config.entryPrice,
        maxOppositeSideEntryPrice: config.maxOppositeSideEntryPrice,
        neutralQuoteBandMin: config.neutralQuoteBandMin,
        neutralQuoteBandMax: config.neutralQuoteBandMax,
        entryCooldownMs: config.entryCooldownMs,
        borderlineRequirePause: config.borderlineRequirePause,
        borderlineRequireNoContinuation: config.borderlineRequireNoContinuation,
        borderlineContinuationThreshold: config.borderlineContinuationThreshold,
        borderlineReversionThreshold: config.borderlineReversionThreshold,
        borderlinePauseBandPercent: config.borderlinePauseBandPercent,
      },
    });
    const normalizedReasons = pipeline.decision.reasons ?? [];
    for (const reason of normalizedReasons) {
      rejectionReasonBreakdown[reason] = (rejectionReasonBreakdown[reason] ?? 0) + 1;
    }
    if (pipeline.decision.cooldownOverridden === true) {
      cooldownOverridesUsed += 1;
    }
    if (normalizedReasons.includes("entry_cooldown_active")) blockedByCooldown += 1;
    if (normalizedReasons.includes("active_position_open")) blockedByActivePosition += 1;
    if (
      normalizedReasons.includes("invalid_market_prices") ||
      normalizedReasons.includes("missing_quote_data")
    ) {
      blockedByInvalidQuotes += 1;
    }
    if (normalizedReasons.includes("pre_spike_range_too_noisy")) blockedByNoisyRange += 1;
    if (normalizedReasons.includes("prior_range_too_wide_for_mean_reversion")) {
      blockedByWidePriorRange += 1;
      rejectedByPriorRangeTooWide += 1;
    }
    if (normalizedReasons.includes("hard_reject_unstable_pre_spike_context")) {
      blockedByHardRejectUnstableContext += 1;
      rejectedByHardUnstableContext += 1;
    }
    if (normalizedReasons.includes("opposite_side_price_too_high")) {
      blockedByExpensiveOppositeSide += 1;
      rejectedByExpensiveOppositeSide += 1;
    }
    if (normalizedReasons.includes("market_quotes_too_neutral")) {
      blockedByNeutralQuotes += 1;
    }
    if (
      normalizedReasons.includes("quality_gate_rejected") &&
      pipeline.decision.qualityProfile === "weak"
    ) {
      rejectedByWeakSpikeQuality += 1;
    }
    if (
      tick.entry.movementClassification === "strong_spike" &&
      pipeline.decision.qualityProfile === "weak"
    ) {
      weakSpikeSignals += 1;
      if (pipeline.decision.action === "none") weakSpikeRejected += 1;
    }
    if (normalizedReasons.includes("strong_spike_continuation")) {
      rejectedByStrongSpikeContinuation += 1;
    }
    if (normalizedReasons.includes("borderline_cancelled_continuation")) {
      rejectedByBorderlineContinuation += 1;
    }

    for (const ev of pipeline.borderlineLifecycleEvents) {
      if (ev.type === "created") borderlineCandidatesCreated += 1;
      else if (ev.type === "promoted") borderlinePromotions += 1;
      else if (ev.type === "cancelled") borderlineCancellations += 1;
      else if (ev.type === "expired") borderlineExpirations += 1;
    }

    if (pipeline.decision.action === "enter_immediate") {
      strongSpikeEntries += 1;
      if (pipeline.decision.qualityProfile === "exceptional") {
        exceptionalSpikeEntries += 1;
      }
    }

    const entryForSimulation = pipeline.entryForSimulation ?? entry;
    const entryPath =
      pipeline.decision.action === "promote_borderline_candidate"
        ? "borderline_delayed"
        : "strong_spike_immediate";

    simulation.onTick({
      now,
      entry: entryForSimulation,
      entryPath,
      sides,
      config: {
        exitPrice: config.exitPrice,
        stopLoss: config.stopLoss,
        exitTimeoutMs: config.exitTimeoutMs,
        entryCooldownMs: config.entryCooldownMs,
        riskPercentPerTrade: config.riskPercentPerTrade,
      },
    });
  }

  const trades = simulation.getTradeHistory();
  const stats = simulation.getPerformanceStats();
  const strongTrades = trades.filter(
    (t) => t.entryPath === "strong_spike_immediate"
  );
  const borderlineTrades = trades.filter(
    (t) => t.entryPath === "borderline_delayed"
  );
  const strongWins = strongTrades.filter((t) => t.profitLoss > 0).length;
  const strongLosses = strongTrades.filter((t) => t.profitLoss < 0).length;
  const borderlineWins = borderlineTrades.filter((t) => t.profitLoss > 0).length;
  const borderlineLosses = borderlineTrades.filter((t) => t.profitLoss < 0).length;
  const strongPnL = strongTrades.reduce((acc, t) => acc + t.profitLoss, 0);
  const borderlinePnL = borderlineTrades.reduce((acc, t) => acc + t.profitLoss, 0);

  const result: BacktestResult = {
    winRate: stats.winRate,
    totalProfit: stats.totalProfit,
    maxDrawdown: stats.maxEquityDrawdown,
    totalTrades: stats.totalTrades,
    totalEntries: strongSpikeEntries + borderlinePromotions,
    wins: stats.wins,
    losses: stats.losses,
    trades,
    weakSpike: {
      signals: weakSpikeSignals,
      rejected: weakSpikeRejected,
      rejectionRate: weakSpikeSignals > 0 ? (weakSpikeRejected / weakSpikeSignals) * 100 : 0,
    },
    strongSpike: {
      signals: strongSpikeSignals,
      entries: strongSpikeEntries,
      tradesClosed: strongTrades.length,
      wins: strongWins,
      losses: strongLosses,
      winRate:
        strongTrades.length > 0 ? (strongWins / strongTrades.length) * 100 : 0,
      totalPnL: strongPnL,
      averagePnL: strongTrades.length > 0 ? strongPnL / strongTrades.length : 0,
    },
    borderline: {
      signals: borderlineSignals,
      candidatesCreated: borderlineCandidatesCreated,
      promotions: borderlinePromotions,
      cancellations: borderlineCancellations,
      expirations: borderlineExpirations,
      tradesClosed: borderlineTrades.length,
      wins: borderlineWins,
      losses: borderlineLosses,
      winRate:
        borderlineTrades.length > 0
          ? (borderlineWins / borderlineTrades.length) * 100
          : 0,
      totalPnL: borderlinePnL,
      averagePnL:
        borderlineTrades.length > 0 ? borderlinePnL / borderlineTrades.length : 0,
    },
    combined: {
      tradesClosed: stats.totalTrades,
      wins: stats.wins,
      losses: stats.losses,
      winRate: stats.winRate,
      totalPnL: stats.totalProfit,
      averagePnL: stats.averageProfitPerTrade,
    },
    rejectionReasonBreakdown,
    movement: {
      noSignalMoves,
      borderlineMoves,
      strongSpikeMoves,
    },
    blockers: {
      blockedByCooldown,
      blockedByActivePosition,
      blockedByInvalidQuotes,
      blockedByNoisyRange,
      blockedByWidePriorRange,
      blockedByHardRejectUnstableContext,
      rejectedByWeakSpikeQuality,
      rejectedByPriorRangeTooWide,
      rejectedByHardUnstableContext,
      rejectedByStrongSpikeContinuation,
      rejectedByBorderlineContinuation,
      rejectedByExpensiveOppositeSide,
      exceptionalSpikeSignals,
      exceptionalSpikeEntries,
      cooldownOverridesUsed,
      blockedByExpensiveOppositeSide,
      blockedByNeutralQuotes,
    },
    evaluationNote: "refined rules active; run comparison to quantify noise reduction",
  };
  if (includeStrictComparison) {
    const baselineConfig: AppConfig = {
      ...config,
      // Baseline approximation before refined filters became strict.
      tradableSpikeMinPercent: Math.min(config.tradableSpikeMinPercent, 0.001),
      maxPriorRangeForNormalEntry: Math.max(config.maxPriorRangeForNormalEntry, 0.01),
      hardRejectPriorRangePercent: Math.max(config.hardRejectPriorRangePercent, 0.01),
      strongSpikeConfirmationTicks: 0,
      exceptionalSpikeOverridesCooldown: false,
      maxOppositeSideEntryPrice: Math.max(config.maxOppositeSideEntryPrice, 1),
      neutralQuoteBandMin: 1,
      neutralQuoteBandMax: 1,
    };
    const baselineResult = runBacktestReplay(btcPrices, {
      config: baselineConfig,
      tickMs,
      epochStartMs,
      sides,
      includeStrictComparison: false,
    });
    result.comparison = {
      relaxed: {
        totalTrades: result.totalTrades,
        winRate: result.winRate,
        totalProfit: result.totalProfit,
        maxDrawdown: result.maxDrawdown,
        strongSpikeEntries: result.strongSpike.entries,
        borderlinePromotions: result.borderline.promotions,
      },
      strict: {
        totalTrades: baselineResult.totalTrades,
        winRate: baselineResult.winRate,
        totalProfit: baselineResult.totalProfit,
        maxDrawdown: baselineResult.maxDrawdown,
        strongSpikeEntries: baselineResult.strongSpike.entries,
        borderlinePromotions: baselineResult.borderline.promotions,
      },
    };
    const reducedNoise = result.totalEntries < baselineResult.totalEntries;
    result.noiseComparison = {
      refinedEntries: result.totalEntries,
      baselineEntries: baselineResult.totalEntries,
      refinedRejectedOpportunities: result.blockers.rejectedByWeakSpikeQuality,
      baselineRejectedOpportunities: baselineResult.blockers.rejectedByWeakSpikeQuality,
      reducedNoise,
    };
    result.evaluationNote = reducedNoise
      ? "refined rules reduced candidate entries and improved selectivity versus baseline behavior"
      : "refined rules did not yet reduce candidate entries versus baseline; review blocker mix and thresholds";
  }
  return result;
}

export async function runBacktestFromFile(
  filePath: string,
  options?: Omit<BacktestOptions, "config"> & { config?: AppConfig }
): Promise<BacktestResult> {
  const prices = await loadHistoricalPricesFromFile(filePath);
  const replay: BacktestOptions = {
    config: options?.config ?? defaultConfig,
  };
  if (options?.tickMs !== undefined) replay.tickMs = options.tickMs;
  if (options?.epochStartMs !== undefined) replay.epochStartMs = options.epochStartMs;
  if (options?.sides !== undefined) replay.sides = options.sides;
  return runBacktestReplay(prices, replay);
}
