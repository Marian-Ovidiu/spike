import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Opportunity } from "./opportunityTracker.js";
import type {
  SimulationPerformanceStats,
  SimulatedTrade,
} from "./simulationEngine.js";

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
    btcPrice: o.btcPrice,
    previousPrice: o.previousPrice,
    currentPrice: o.currentPrice,
    spikeDirection: o.spikeDirection,
    spikePercent: o.spikePercent,
    spikeSource: o.spikeSource,
    spikeReferencePrice: o.spikeReferencePrice,
    priorRangePercent: o.priorRangePercent,
    upSidePrice: o.upSidePrice,
    downSidePrice: o.downSidePrice,
    stableRangeDetected: o.stableRangeDetected,
    stableRangeQuality: o.stableRangeQuality,
    spikeDetected: o.spikeDetected,
    movementClassification: o.movementClassification,
    movementThresholdRatio: o.movementThresholdRatio,
    tradableSpikeMinPercent: o.tradableSpikeMinPercent,
    qualityProfile: o.qualityProfile,
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
    status: o.status,
  };
}

/** One JSON object per line for closed paper trades. */
export function tradeToJsonlRecord(t: SimulatedTrade): Record<string, unknown> {
  return {
    id: t.id,
    direction: t.direction,
    contracts: t.contracts,
    entryPrice: t.entryPrice,
    exitPrice: t.exitPrice,
    profitLoss: t.profitLoss,
    riskAtEntry: t.riskAtEntry,
    entryPath: t.entryPath,
    exitReason: t.exitReason,
    openedAt: new Date(t.openedAt).toISOString(),
    closedAt: new Date(t.closedAt).toISOString(),
    openedAtMs: t.openedAt,
    closedAtMs: t.closedAt,
    holdDurationMs: t.closedAt - t.openedAt,
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
  perf: SimulationPerformanceStats;
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
    qualityWeak?: number;
    qualityStrong?: number;
    qualityExceptional?: number;
    topRejectionReasons?: Array<{ reason: string; count: number }>;
    interpretation: string[];
  };
}): MonitorSessionSummary {
  const opportunitiesFound =
    input.validOpportunities + input.rejectedOpportunities;
  const runtimeMs = Math.max(0, input.endedAtMs - input.startedAtMs);
  const summary: MonitorSessionSummary = {
    sessionStartedAt: new Date(input.startedAtMs).toISOString(),
    sessionEndedAt: new Date(input.endedAtMs).toISOString(),
    runtimeMs,
    outputDirectory: input.outputDirectory,
    counters: {
      ticksObserved: input.ticksObserved,
      btcFetchFailures: input.btcFetchFailures,
      spikeEventsDetected: input.spikeEventsDetected,
      candidateOpportunities: input.candidateOpportunities,
      validOpportunities: input.validOpportunities,
      rejectedOpportunities: input.rejectedOpportunities,
      opportunitiesFound,
    },
    simulation: {
      tradesSimulated: input.perf.totalTrades,
      wins: input.perf.wins,
      losses: input.perf.losses,
      breakeven: input.perf.breakeven,
      winRatePercent: input.perf.winRate,
      totalProfit: input.perf.totalProfit,
      averageProfitPerTrade: input.perf.averageProfitPerTrade,
      maxEquityDrawdown: input.perf.maxEquityDrawdown,
      currentEquity: input.perf.currentEquity,
      initialEquity: input.perf.initialEquity,
    },
  };
  if (input.extended !== undefined) {
    summary.extended = input.extended;
  }
  return summary;
}

export type MonitorSessionSummary = {
  sessionStartedAt: string;
  sessionEndedAt: string;
  runtimeMs: number;
  outputDirectory: string;
  counters: {
    ticksObserved: number;
    btcFetchFailures: number;
    spikeEventsDetected: number;
    candidateOpportunities: number;
    validOpportunities: number;
    rejectedOpportunities: number;
    opportunitiesFound: number;
  };
  simulation: {
    tradesSimulated: number;
    wins: number;
    losses: number;
    breakeven: number;
    winRatePercent: number;
    totalProfit: number;
    averageProfitPerTrade: number;
    maxEquityDrawdown: number;
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
    qualityWeak?: number;
    qualityStrong?: number;
    qualityExceptional?: number;
    topRejectionReasons?: Array<{ reason: string; count: number }>;
    interpretation: string[];
  };
};

export class MonitorFilePersistence {
  private readonly dir: string;
  private readonly opportunitiesPath: string;
  private readonly tradesPath: string;
  private readonly sessionSummaryPath: string;
  private ready = false;

  constructor(outputDir?: string) {
    this.dir = outputDir ?? resolveMonitorOutputDir();
    this.opportunitiesPath = join(this.dir, "opportunities.jsonl");
    this.tradesPath = join(this.dir, "trades.jsonl");
    this.sessionSummaryPath = join(this.dir, "session-summary.json");
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
}
