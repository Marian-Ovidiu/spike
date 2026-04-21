import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { StrongSpikeGateFunnel } from "./monitorFunnelDiagnostics.js";
import type { Opportunity } from "./opportunityTracker.js";
import type { HoldExitAuditSummary } from "./holdExitAudit.js";
import type { SimulationPerformanceStats } from "./simulationEngine.js";
import {
  buildTransparentTradeLog,
  type SimulatedTrade,
} from "./simulationEngine.js";
import { buildBinaryPaperTradeLog } from "./binary/paper/binaryPaperTradeLog.js";
import type { BinaryQuoteSessionSnapshot } from "./binary/monitor/binaryMonitorQuoteStats.js";
import type { BinaryHoldExitAuditSummary } from "./holdExitAudit.js";
import type { MarketFeedDiagnostics, MarketMode } from "./market/types.js";
import type { NormalizedMonitorConfigSummary } from "./config/monitorNormalizedConfigSummary.js";
import type { BinaryRunAnalyticsReport } from "./analyze/binaryRunAnalytics.js";
import { describeActiveConfigGroups } from "./config.js";

const DEFAULT_OUTPUT_DIR = "output/monitor";

export function resolveMonitorOutputDir(): string {
  const raw = process.env.MONITOR_OUTPUT_DIR?.trim();
  return raw && raw.length > 0 ? raw : DEFAULT_OUTPUT_DIR;
}

/** One JSON object per line for opportunities. */
export function opportunityToJsonlRecord(o: Opportunity): Record<string, unknown> {
  return {
    observedAt: new Date(o.timestamp).toISOString(),
    observedAtMs: o.timestamp,
    marketMode: o.marketMode ?? "binary",
    btcPrice: o.btcPrice,
    ...(typeof o.underlyingSignalPrice === "number" &&
    Number.isFinite(o.underlyingSignalPrice)
      ? { underlyingSignalPrice: o.underlyingSignalPrice }
      : {}),
    previousPrice: o.previousPrice,
    currentPrice: o.currentPrice,
    spikeDirection: o.spikeDirection,
    spikePercent: o.spikePercent,
    spikeSource: o.spikeSource,
    spikeReferencePrice: o.spikeReferencePrice,
    priorRangeFraction: o.priorRangeFraction,
    bestBid: o.bestBid,
    bestAsk: o.bestAsk,
    midPrice: o.midPrice,
    spreadBps: o.spreadBps,
    stableRangeDetected: o.stableRangeDetected,
    stableRangeQuality: o.stableRangeQuality,
    spikeDetected: o.spikeDetected,
    movementClassification: o.movementClassification,
    movementThresholdRatio: o.movementThresholdRatio,
    tradableSpikeMinPercent: o.tradableSpikeMinPercent,
    qualityProfile: o.qualityProfile,
    qualityGateDiagnostics: o.qualityGateDiagnostics,
    ...(o.pipelineQualityModifier !== undefined
      ? { pipelineQualityModifier: o.pipelineQualityModifier }
      : {}),
    cooldownOverridden: o.cooldownOverridden ?? false,
    overrideReason: o.overrideReason ?? null,
    opportunityType: o.opportunityType,
    opportunityOutcome: o.opportunityOutcome,
    thresholdRatio: o.thresholdRatio,
    watchTicksConfigured: o.watchTicksConfigured,
    watchTicksObserved: o.watchTicksObserved,
    postMoveClassification: o.postMoveClassification,
    promotionReason: o.promotionReason,
    cancellationReason: o.cancellationReason,
    expirationReason: o.expirationReason,
    borderlineCandidateId: o.borderlineCandidateId,
    entryAllowed: o.entryAllowed,
    entryRejectionReasons: [...o.entryRejectionReasons],
    entryRejectionPrimaryBlocker: o.entryRejectionPrimaryBlocker,
    status: o.status,
    ...(o.yesPrice !== undefined ? { yesPrice: o.yesPrice } : {}),
    ...(o.noPrice !== undefined ? { noPrice: o.noPrice } : {}),
    ...(o.binaryQuoteAgeMs !== undefined ? { binaryQuoteAgeMs: o.binaryQuoteAgeMs } : {}),
    ...(o.binaryQuoteStale !== undefined
      ? { binaryQuoteStale: o.binaryQuoteStale }
      : {}),
    ...(o.binaryMarketId !== undefined ? { binaryMarketId: o.binaryMarketId } : {}),
    ...(o.binarySlug !== undefined ? { binarySlug: o.binarySlug } : {}),
    ...(o.binaryQuestion !== undefined ? { binaryQuestion: o.binaryQuestion } : {}),
    ...(o.binaryConditionId !== undefined
      ? { binaryConditionId: o.binaryConditionId }
      : {}),
    ...(o.entryOutcomeSide !== undefined
      ? { entryOutcomeSide: o.entryOutcomeSide }
      : {}),
    ...(o.estimatedProbabilityUp !== undefined &&
    Number.isFinite(o.estimatedProbabilityUp)
      ? { estimatedProbabilityUp: o.estimatedProbabilityUp }
      : {}),
    ...(o.probabilityTimeHorizonMs !== undefined &&
    Number.isFinite(o.probabilityTimeHorizonMs)
      ? { probabilityTimeHorizonMs: o.probabilityTimeHorizonMs }
      : {}),
    ...(o.invalidMarketPricesAudit !== undefined
      ? { invalidMarketPricesAudit: o.invalidMarketPricesAudit }
      : {}),
    ...(o.marketMode === "binary"
      ? {
          layers: {
            signal: {
              btcMid: o.btcPrice,
              rollingWindowPrevious: o.previousPrice,
              rollingWindowCurrent: o.currentPrice,
            },
            executionVenue: {
              yesPrice: o.yesPrice,
              noPrice: o.noPrice,
              executableMid: o.midPrice,
              bestBid: o.bestBid,
              bestAsk: o.bestAsk,
              spreadBps: o.spreadBps,
              quoteStale: o.binaryQuoteStale,
              quoteAgeMs: o.binaryQuoteAgeMs,
              marketId: o.binaryMarketId,
              slug: o.binarySlug,
              question: o.binaryQuestion,
              conditionId: o.binaryConditionId,
            },
          },
        }
      : {}),
  };
}

/** One JSON object per line for closed paper trades (core fields match {@link buildTransparentTradeLog}). */
export function tradeToJsonlRecord(t: SimulatedTrade): Record<string, unknown> {
  const closedAtIso = new Date(t.closedAt).toISOString();
  const openedAtIso = new Date(t.openedAt).toISOString();
  const timeEnvelope = {
    openedAt: openedAtIso,
    closedAt: closedAtIso,
    openedAtMs: t.openedAt,
    closedAtMs: t.closedAt,
    holdDurationMs: t.closedAt - t.openedAt,
  };
  if (t.executionModel === "binary") {
    return {
      marketMode: "binary" as const,
      ...timeEnvelope,
      ...buildBinaryPaperTradeLog(t),
      ...(t.holdExitAudit !== undefined ? { holdExitAudit: t.holdExitAudit } : {}),
    };
  }
  return {
    marketMode: "spot" as const,
    ...buildTransparentTradeLog(t),
    ...(t.holdExitAudit !== undefined ? { holdExitAudit: t.holdExitAudit } : {}),
    ...timeEnvelope,
  };
}

export function buildMonitorSessionSummary(input: {
  outputDirectory: string;
  startedAtMs: number;
  endedAtMs: number;
  ticksObserved: number;
  btcFetchFailures: number;
  spikeEventsDetected: number;
  candidateOpportunities: number;
  validOpportunities: number;
  rejectedOpportunities: number;
  /** Positions opened by paper sim (funnel level 4). */
  tradesExecuted: number;
  perf: SimulationPerformanceStats;
  /** Live monitor: which execution universe was selected. */
  marketMode?: MarketMode;
  /** Override default {@link describeActiveConfigGroups} text for the artifact. */
  configGroupSummary?: string;
  /** Live monitor: mode routing, venue, effective exits, stale guards (observability). */
  normalizedConfig?: NormalizedMonitorConfigSummary;
  extended?: {
    strongSpikeSignals: number;
    strongSpikeEntries: number;
    noSignalMoves: number;
    borderlineMoves: number;
    strongSpikeMoves: number;
    borderlineSignals: number;
    borderlineCandidatesCreated: number;
    borderlinePromotions: number;
    borderlineCancellations: number;
    borderlineExpirations: number;
    borderlineEntered: number;
    borderlinePromoted: number;
    borderlineRejectedTimeout: number;
    borderlineRejectedWeak: number;
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
    borderlineTradesClosed: number;
    borderlineWins: number;
    borderlineLosses: number;
    borderlinePnL: number;
    averageBorderlinePnL: number;
    strongSpikeTradesClosed: number;
    strongSpikeWins: number;
    strongSpikeLosses: number;
    strongSpikePnL: number;
    averageStrongSpikePnL: number;
    strongSpikeWinRate: number;
    delayedBorderlineWinRate: number;
    borderlineNetImpact: "positive" | "negative" | "flat";
    verdict: "helpful" | "neutral" | "harmful";
    rejectedByPipelineQualityDowngradeLegacy?: number;
    pipelineQualityDowngradeBreakdown?: Record<string, number>;
    qualityWeak?: number;
    qualityStrong?: number;
    qualityExceptional?: number;
    topRejectionReasons?: Array<{ reason: string; count: number }>;
    interpretation: string[];
    gateFunnel?: StrongSpikeGateFunnel;
    /** True when TEST_MODE=1 — session is diagnostic, not production baseline. */
    testMode?: boolean;
    /** Fixed label for UIs/logs when testMode is true. */
    testModeLabel?: "TEST MODE ACTIVE";
    /** Aggregated EXIT_PRICE / STOP_LOSS realism vs observed marks (closed trades). */
    exitThresholdAudit?: HoldExitAuditSummary | null;
    /** Spot WS health or binary snapshot (live monitor shutdown). */
    marketFeedDiagnostics?: MarketFeedDiagnostics;
    /** Binary mode: BTC spot signal feed shutdown snapshot. */
    signalFeedDiagnostics?: MarketFeedDiagnostics;
    /** Binary-only: quote pair churn over the session. */
    binaryQuoteSession?: BinaryQuoteSessionSnapshot;
    /** Binary-only: mean TP/SL gap diagnostics on outcome leg (closed trades subset). */
    binaryOutcomeExitAudit?: BinaryHoldExitAuditSummary;
  };
  /** Binary mode: aggregated funnel + trade attribution (also reproducible via `npm run analyze-run`). */
  binaryRunAnalytics?: BinaryRunAnalyticsReport | null;
}): MonitorSessionSummary {
  const opportunitiesFound =
    input.validOpportunities + input.rejectedOpportunities;
  const runtimeMs = Math.max(0, input.endedAtMs - input.startedAtMs);
  const summary: MonitorSessionSummary = {
    sessionStartedAt: new Date(input.startedAtMs).toISOString(),
    sessionEndedAt: new Date(input.endedAtMs).toISOString(),
    runtimeMs,
    ...(input.marketMode !== undefined
      ? {
          marketMode: input.marketMode,
          configGroupSummary:
            input.configGroupSummary ?? describeActiveConfigGroups(input.marketMode),
        }
      : {}),
    ...(input.normalizedConfig !== undefined
      ? { normalizedConfig: input.normalizedConfig }
      : {}),
    outputDirectory: input.outputDirectory,
    counters: {
      ticksObserved: input.ticksObserved,
      btcFetchFailures: input.btcFetchFailures,
      spikeEventsDetected: input.spikeEventsDetected,
      candidateOpportunities: input.candidateOpportunities,
      validOpportunities: input.validOpportunities,
      rejectedOpportunities: input.rejectedOpportunities,
      tradesExecuted: input.tradesExecuted,
      opportunitiesFound,
    },
    simulation: {
      totalTrades: input.perf.totalTrades,
      wins: input.perf.wins,
      losses: input.perf.losses,
      breakeven: input.perf.breakeven,
      winRatePercent: input.perf.winRate,
      totalPnl: input.perf.totalProfit,
      avgPnl: input.perf.averageProfitPerTrade,
      maxDrawdown: input.perf.maxEquityDrawdown,
      currentEquity: input.perf.currentEquity,
      initialEquity: input.perf.initialEquity,
    },
  };
  if (input.extended !== undefined) {
    summary.extended = input.extended;
  }
  if (input.binaryRunAnalytics !== undefined && input.binaryRunAnalytics !== null) {
    summary.binaryRunAnalytics = input.binaryRunAnalytics;
  }
  return summary;
}

export type MonitorSessionSummary = {
  sessionStartedAt: string;
  sessionEndedAt: string;
  runtimeMs: number;
  outputDirectory: string;
  /** Present when `MARKET_MODE=binary` and shutdown analytics were computed. */
  binaryRunAnalytics?: BinaryRunAnalyticsReport;
  /** Live monitor shutdown only — aligns session artifact with MARKET_MODE. */
  marketMode?: MarketMode;
  /** Which config sections were active vs ignored for this run. */
  configGroupSummary?: string;
  /** Effective routing / exits / staleness as interpreted at shutdown (live monitor). */
  normalizedConfig?: NormalizedMonitorConfigSummary;
  counters: {
    ticksObserved: number;
    btcFetchFailures: number;
    spikeEventsDetected: number;
    candidateOpportunities: number;
    validOpportunities: number;
    rejectedOpportunities: number;
    tradesExecuted: number;
    opportunitiesFound: number;
  };
  simulation: {
    totalTrades: number;
    wins: number;
    losses: number;
    breakeven: number;
    winRatePercent: number;
    /** Sum of closed-trade `profitLoss` (matches trades JSONL). */
    totalPnl: number;
    avgPnl: number;
    maxDrawdown: number;
    currentEquity: number;
    initialEquity: number;
  };
  extended?: {
    strongSpikeSignals: number;
    strongSpikeEntries: number;
    noSignalMoves: number;
    borderlineMoves: number;
    strongSpikeMoves: number;
    borderlineSignals: number;
    borderlineCandidatesCreated: number;
    borderlinePromotions: number;
    borderlineCancellations: number;
    borderlineExpirations: number;
    borderlineEntered: number;
    borderlinePromoted: number;
    borderlineRejectedTimeout: number;
    borderlineRejectedWeak: number;
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
    borderlineTradesClosed: number;
    borderlineWins: number;
    borderlineLosses: number;
    borderlinePnL: number;
    averageBorderlinePnL: number;
    strongSpikeTradesClosed: number;
    strongSpikeWins: number;
    strongSpikeLosses: number;
    strongSpikePnL: number;
    averageStrongSpikePnL: number;
    strongSpikeWinRate: number;
    delayedBorderlineWinRate: number;
    borderlineNetImpact: "positive" | "negative" | "flat";
    verdict: "helpful" | "neutral" | "harmful";
    rejectedByPipelineQualityDowngradeLegacy?: number;
    pipelineQualityDowngradeBreakdown?: Record<string, number>;
    qualityWeak?: number;
    qualityStrong?: number;
    qualityExceptional?: number;
    topRejectionReasons?: Array<{ reason: string; count: number }>;
    interpretation: string[];
    gateFunnel?: StrongSpikeGateFunnel;
    testMode?: boolean;
    testModeLabel?: "TEST MODE ACTIVE";
    exitThresholdAudit?: HoldExitAuditSummary | null;
    marketFeedDiagnostics?: MarketFeedDiagnostics;
    signalFeedDiagnostics?: MarketFeedDiagnostics;
    binaryQuoteSession?: BinaryQuoteSessionSnapshot;
    binaryOutcomeExitAudit?: BinaryHoldExitAuditSummary;
  };
};

export class MonitorFilePersistence {
  private readonly dir: string;
  private readonly opportunitiesPath: string;
  private readonly tradesPath: string;
  private readonly sessionSummaryPath: string;
  private readonly syntheticPricingDiagnosticsPath: string;
  private readonly probabilityCalibrationPath: string;
  private ready = false;

  constructor(outputDir?: string) {
    this.dir = outputDir ?? resolveMonitorOutputDir();
    this.opportunitiesPath = join(this.dir, "opportunities.jsonl");
    this.tradesPath = join(this.dir, "trades.jsonl");
    this.sessionSummaryPath = join(this.dir, "session-summary.json");
    this.syntheticPricingDiagnosticsPath = join(
      this.dir,
      "synthetic-pricing-diagnostics.json"
    );
    this.probabilityCalibrationPath = join(
      this.dir,
      "probability-calibration-events.jsonl"
    );
  }

  getOutputDir(): string {
    return this.dir;
  }

  /** Create output directory if missing. Safe to call multiple times. */
  ensureReady(): void {
    if (this.ready) return;
    mkdirSync(this.dir, { recursive: true });
    this.ready = true;
  }

  appendOpportunityLine(opportunity: Opportunity): void {
    this.ensureReady();
    const line = `${JSON.stringify(opportunityToJsonlRecord(opportunity))}\n`;
    appendFileSync(this.opportunitiesPath, line, "utf8");
  }

  appendTradeLine(trade: SimulatedTrade): void {
    this.ensureReady();
    const line = `${JSON.stringify(tradeToJsonlRecord(trade))}\n`;
    appendFileSync(this.tradesPath, line, "utf8");
  }

  writeSessionSummary(summary: MonitorSessionSummary): void {
    this.ensureReady();
    writeFileSync(
      this.sessionSummaryPath,
      `${JSON.stringify(summary, null, 2)}\n`,
      "utf8"
    );
  }

  /** Binary synthetic venue: aggregated mid/spread behaviour (see README). */
  writeSyntheticPricingDiagnostics(payload: unknown): void {
    this.ensureReady();
    writeFileSync(
      this.syntheticPricingDiagnosticsPath,
      `${JSON.stringify(payload, null, 2)}\n`,
      "utf8"
    );
  }

  /** Binary: one resolved calibration row (predicted P(up) vs realized BTC over horizon). */
  appendProbabilityCalibrationLine(payload: unknown): void {
    this.ensureReady();
    appendFileSync(
      this.probabilityCalibrationPath,
      `${JSON.stringify(payload)}\n`,
      "utf8"
    );
  }
}
