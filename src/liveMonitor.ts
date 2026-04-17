import {
  BOT_TICK_INTERVAL_MS,
  MIN_SAMPLES_FOR_STRATEGY,
  runStrategyTick,
  type BotContext,
} from "./botLoop.js";
import { config, debugMonitor, logConfig } from "./config.js";
import { aggregateHoldExitAudits } from "./holdExitAudit.js";
import {
  buildMonitorSessionSummary,
  MonitorFilePersistence,
} from "./monitorPersistence.js";
import {
  buildSpikeDecisionTracePayload,
  formatDebugTickExtras,
  logBorderlineLifecycleBlock,
  formatMonitorTickLine,
  logOpportunityBlock,
  logPaperTradeClosedBlock,
  logSpikeDecisionTrace,
  logValidOpportunityBlock,
  printLiveMonitorBanner,
  printPeriodicRuntimeSummary,
  printShutdownReport,
} from "./monitorConsole.js";
import {
  logReportCounterConsistency,
  MonitorRuntimeStats,
} from "./monitorRuntimeStats.js";
import { computeStrongSpikeGateFunnel } from "./monitorFunnelDiagnostics.js";
import { RollingPriceBuffer } from "./rollingPriceBuffer.js";
import type { SimulatedTrade } from "./simulationEngine.js";
import { SimulationEngine } from "./simulationEngine.js";
import { BinanceSpotFeed } from "./adapters/binanceSpotFeed.js";
import { OpportunityTracker } from "./opportunityTracker.js";
import {
  evaluateSession,
  printSessionEvaluationReport,
} from "./sessionEvaluator.js";
import { SpikeDebugTracker } from "./spikeDebugTracker.js";
import {
  BorderlineCandidateStore,
} from "./borderlineCandidateStore.js";
import { StrongSpikeCandidateStore } from "./strongSpikeCandidateStore.js";
import {
  applyFeedStaleEntryBlock,
  entryEvaluationForPipelinePaperExecution,
  formatStrategyDecisionLog,
  runStrategyDecisionPipeline,
} from "./strategyDecisionPipeline.js";

const runtimeStats = new MonitorRuntimeStats({
  exceptionalSpikePercent: config.exceptionalSpikePercent,
});
const persistence = new MonitorFilePersistence();
const binanceFeed = new BinanceSpotFeed();
const spikeDebug = new SpikeDebugTracker();
const borderlineManager = new BorderlineCandidateStore({
  symbol: binanceFeed.getSymbol(),
  watchTicks: config.borderlineWatchTicks,
});
const strongSpikeManager = new StrongSpikeCandidateStore({
  symbol: binanceFeed.getSymbol(),
  watchTicks: config.strongSpikeConfirmationTicks,
});

let monitorStartedAtMs = 0;
let tickTimer: ReturnType<typeof setInterval> | undefined;
let statsTimer: ReturnType<typeof setInterval> | undefined;
let shutdownInProgress = false;

function buildInterpretationLines(): string[] {
  const lines: string[] = [];
  if (
    runtimeStats.noSignalMoves >
    runtimeStats.borderlineMoves + runtimeStats.strongSpikeMoves
  ) {
    lines.push("market too flat");
  }
  const blockedByBook =
    runtimeStats.blockedByInvalidQuotes +
    runtimeStats.blockedByExpensiveOppositeSide +
    runtimeStats.blockedByNeutralQuotes;
  if (runtimeStats.rejectedByWeakSpikeQuality > runtimeStats.validOpportunities) {
    lines.push("too many weak spikes rejected");
  }
  const trendNoiseFiltered =
    runtimeStats.rejectedByPriorRangeTooWide + runtimeStats.rejectedByHardUnstableContext;
  if (trendNoiseFiltered >= runtimeStats.validOpportunities) {
    lines.push("trend/noise filter removed most signals");
  }
  if (blockedByBook > 0 && blockedByBook >= runtimeStats.validOpportunities) {
    lines.push("wide spread or invalid book blocked most entries");
  }
  if (runtimeStats.cooldownOverridesUsed > 0 && runtimeStats.exceptionalSpikeEntries > 0) {
    lines.push("exceptional spikes bypassed cooldown successfully");
  }
  if (
    runtimeStats.validOpportunities > 0 &&
    runtimeStats.validOpportunities < runtimeStats.rejectedOpportunities
  ) {
    lines.push("strategy now focuses on high-quality setups");
  }
  if (lines.length === 0) {
    lines.push("session mixed: monitor movement mix and blocker counters");
  }
  return lines;
}

function formatTopRejectionReasons(): string {
  const top = runtimeStats.getTopRejectionReasons(5);
  if (top.length === 0) return "none";
  return top.map((r) => `${r.reason}:${r.count}`).join(" | ");
}

function borderlineImpactVerdict(): "helpful" | "neutral" | "harmful" {
  if (runtimeStats.borderlineTradesClosed <= 0) return "neutral";
  const avgDelta =
    runtimeStats.borderlineAveragePnL - runtimeStats.strongSpikeAveragePnL;
  if (avgDelta > 0) return "helpful";
  if (avgDelta < 0) return "harmful";
  return "neutral";
}

function borderlineNetImpact(): "positive" | "negative" | "flat" {
  if (runtimeStats.borderlinePnL > 0) return "positive";
  if (runtimeStats.borderlinePnL < 0) return "negative";
  return "flat";
}

function gracefulShutdown(): void {
  if (shutdownInProgress) return;
  shutdownInProgress = true;
  if (statsTimer !== undefined) clearInterval(statsTimer);
  if (tickTimer !== undefined) clearInterval(tickTimer);

  const gateFunnel = computeStrongSpikeGateFunnel({
    opportunities: ctx.opportunityTracker.getOpportunities(),
    borderlineCandidatesCreated: runtimeStats.borderlineCandidatesCreated,
    tradesExecuted: runtimeStats.tradesExecuted,
    strategyApprovedEntryTicks: runtimeStats.validOpportunities,
  });
  const exitThresholdAudit = aggregateHoldExitAudits(simulation.getTradeHistory());
  printShutdownReport(
    monitorStartedAtMs,
    {
      ticksObserved: runtimeStats.ticksObserved,
      spikeEventsDetected: runtimeStats.spikeEventsDetected,
      candidateOpportunities: runtimeStats.candidateOpportunities,
      validOpportunities: runtimeStats.validOpportunities,
      rejectedOpportunities: runtimeStats.rejectedOpportunities,
      tradesExecuted: runtimeStats.tradesExecuted,
    },
    simulation.getPerformanceStats(),
    {
      strongSpikeWinRate: runtimeStats.strongSpikeWinRate,
      delayedBorderlineWinRate: runtimeStats.borderlineWinRate,
      averageStrongSpikePnL: runtimeStats.strongSpikeAveragePnL,
      averageBorderlinePnL: runtimeStats.borderlineAveragePnL,
      borderlinePnL: runtimeStats.borderlinePnL,
      borderlineNetImpact: borderlineNetImpact(),
      borderlinePromotions: runtimeStats.borderlinePromotions,
      borderlineSignals: runtimeStats.borderlineSignals,
      qualityWeak: runtimeStats.qualityWeak,
      qualityStrong: runtimeStats.qualityStrong,
      qualityExceptional: runtimeStats.qualityExceptional,
      topRejectionReasons: runtimeStats.getTopRejectionReasons(5),
      verdict: borderlineImpactVerdict(),
      gateFunnel,
      testMode: config.testMode,
      exitThresholdAudit,
      binanceFeedDiagnostics: {
        symbol: binanceFeed.getSymbol(),
        health: binanceFeed.getHealth(),
        lastMessageAgeMs: binanceFeed.getLastMessageAgeMs(),
      },
    }
  );
  for (const line of buildInterpretationLines()) {
    console.log(`[interpretation] ${line}`);
  }

  if (spikeDebug.getReadyTickCount() > 0) {
    console.log(spikeDebug.formatSummary());
  }

  printSessionEvaluationReport(
    evaluateSession({
      opportunities: ctx.opportunityTracker.getOpportunities(),
      trades: simulation.getTradeHistory(),
    }),
    { testMode: config.testMode }
  );

  const endedAt = Date.now();
  logReportCounterConsistency(runtimeStats);
  try {
    persistence.writeSessionSummary(
      buildMonitorSessionSummary({
        outputDirectory: persistence.getOutputDir(),
        startedAtMs: monitorStartedAtMs,
        endedAtMs: endedAt,
        ticksObserved: runtimeStats.ticksObserved,
        btcFetchFailures: runtimeStats.btcFetchFailures,
        spikeEventsDetected: runtimeStats.spikeEventsDetected,
        candidateOpportunities: runtimeStats.candidateOpportunities,
        validOpportunities: runtimeStats.validOpportunities,
        rejectedOpportunities: runtimeStats.rejectedOpportunities,
        tradesExecuted: runtimeStats.tradesExecuted,
        perf: simulation.getPerformanceStats(),
        extended: {
          strongSpikeSignals: runtimeStats.strongSpikeSignals,
          strongSpikeEntries: runtimeStats.strongSpikeEntries,
          noSignalMoves: runtimeStats.noSignalMoves,
          borderlineMoves: runtimeStats.borderlineMoves,
          strongSpikeMoves: runtimeStats.strongSpikeMoves,
          borderlineSignals: runtimeStats.borderlineSignals,
          borderlineCandidatesCreated: runtimeStats.borderlineCandidatesCreated,
          borderlinePromotions: runtimeStats.borderlinePromotions,
          borderlineCancellations: runtimeStats.borderlineCancellations,
          borderlineExpirations: runtimeStats.borderlineExpirations,
          blockedByCooldown: runtimeStats.blockedByCooldown,
          blockedByActivePosition: runtimeStats.blockedByActivePosition,
          blockedByInvalidQuotes: runtimeStats.blockedByInvalidQuotes,
          blockedByNoisyRange: runtimeStats.blockedByNoisyRange,
          blockedByWidePriorRange: runtimeStats.blockedByWidePriorRange,
          blockedByHardRejectUnstableContext:
            runtimeStats.blockedByHardRejectUnstableContext,
          rejectedByWeakSpikeQuality: runtimeStats.rejectedByWeakSpikeQuality,
          rejectedByPriorRangeTooWide: runtimeStats.rejectedByPriorRangeTooWide,
          rejectedByHardUnstableContext: runtimeStats.rejectedByHardUnstableContext,
          rejectedByStrongSpikeContinuation:
            runtimeStats.rejectedByStrongSpikeContinuation,
          rejectedByBorderlineContinuation:
            runtimeStats.rejectedByBorderlineContinuation,
          rejectedByExpensiveOppositeSide: runtimeStats.rejectedByExpensiveOppositeSide,
          exceptionalSpikeSignals: runtimeStats.exceptionalSpikeSignals,
          exceptionalSpikeEntries: runtimeStats.exceptionalSpikeEntries,
          cooldownOverridesUsed: runtimeStats.cooldownOverridesUsed,
          blockedByExpensiveOppositeSide: runtimeStats.blockedByExpensiveOppositeSide,
          blockedByNeutralQuotes: runtimeStats.blockedByNeutralQuotes,
          borderlineTradesClosed: runtimeStats.borderlineTradesClosed,
          borderlineWins: runtimeStats.borderlineWins,
          borderlineLosses: runtimeStats.borderlineLosses,
          borderlinePnL: runtimeStats.borderlinePnL,
          averageBorderlinePnL: runtimeStats.borderlineAveragePnL,
          strongSpikeTradesClosed: runtimeStats.strongSpikeTradesClosed,
          strongSpikeWins: runtimeStats.strongSpikeWins,
          strongSpikeLosses: runtimeStats.strongSpikeLosses,
          strongSpikePnL: runtimeStats.strongSpikePnL,
          averageStrongSpikePnL: runtimeStats.strongSpikeAveragePnL,
          strongSpikeWinRate: runtimeStats.strongSpikeWinRate,
          delayedBorderlineWinRate: runtimeStats.borderlineWinRate,
          borderlineNetImpact: borderlineNetImpact(),
          verdict: borderlineImpactVerdict(),
          qualityWeak: runtimeStats.qualityWeak,
          qualityStrong: runtimeStats.qualityStrong,
          qualityExceptional: runtimeStats.qualityExceptional,
          topRejectionReasons: runtimeStats.getTopRejectionReasons(5),
          interpretation: buildInterpretationLines(),
          gateFunnel,
          testMode: config.testMode,
          exitThresholdAudit,
          ...(config.testMode
            ? { testModeLabel: "TEST MODE ACTIVE" as const }
            : {}),
          binanceFeedDiagnostics: {
            symbol: binanceFeed.getSymbol(),
            health: binanceFeed.getHealth(),
            lastMessageAgeMs: binanceFeed.getLastMessageAgeMs(),
          },
        },
      })
    );
  } catch (err) {
    console.error("[monitor] Failed to write session-summary.json:", err);
  }
  process.exit(0);
}

function onPaperTradeClosed(trade: SimulatedTrade): void {
  runtimeStats.observeClosedTrade(trade);
  try {
    persistence.appendTradeLine(trade);
  } catch (err) {
    console.error("[monitor] Failed to append trades.jsonl:", err);
  }

  logPaperTradeClosedBlock(trade);

  const closedCount = simulation.getTradeHistory().length;
  if (closedCount > 0 && closedCount % 10 === 0) {
    printPeriodicRuntimeSummary(
      `Runtime stats (${closedCount} closed trades)`,
      {
        ticksObserved: runtimeStats.ticksObserved,
        btcFetchFailures: runtimeStats.btcFetchFailures,
        spikeEventsDetected: runtimeStats.spikeEventsDetected,
        candidateOpportunities: runtimeStats.candidateOpportunities,
        validOpportunities: runtimeStats.validOpportunities,
        rejectedOpportunities: runtimeStats.rejectedOpportunities,
        tradesExecuted: runtimeStats.tradesExecuted,
        strongSpikeSignals: runtimeStats.strongSpikeSignals,
        strongSpikeEntries: runtimeStats.strongSpikeEntries,
        noSignalMoves: runtimeStats.noSignalMoves,
        borderlineMoves: runtimeStats.borderlineMoves,
        strongSpikeMoves: runtimeStats.strongSpikeMoves,
        borderlineSignals: runtimeStats.borderlineSignals,
        borderlineCandidatesCreated: runtimeStats.borderlineCandidatesCreated,
        borderlinePromotions: runtimeStats.borderlinePromotions,
        borderlineCancellations: runtimeStats.borderlineCancellations,
        borderlineExpirations: runtimeStats.borderlineExpirations,
        blockedByCooldown: runtimeStats.blockedByCooldown,
        blockedByActivePosition: runtimeStats.blockedByActivePosition,
        blockedByInvalidQuotes: runtimeStats.blockedByInvalidQuotes,
        blockedByNoisyRange: runtimeStats.blockedByNoisyRange,
        blockedByWidePriorRange: runtimeStats.blockedByWidePriorRange,
        blockedByHardRejectUnstableContext:
          runtimeStats.blockedByHardRejectUnstableContext,
        rejectedByWeakSpikeQuality: runtimeStats.rejectedByWeakSpikeQuality,
        rejectedByPriorRangeTooWide: runtimeStats.rejectedByPriorRangeTooWide,
        rejectedByHardUnstableContext: runtimeStats.rejectedByHardUnstableContext,
        rejectedByStrongSpikeContinuation:
          runtimeStats.rejectedByStrongSpikeContinuation,
        rejectedByBorderlineContinuation:
          runtimeStats.rejectedByBorderlineContinuation,
        rejectedByExpensiveOppositeSide: runtimeStats.rejectedByExpensiveOppositeSide,
        exceptionalSpikeSignals: runtimeStats.exceptionalSpikeSignals,
        exceptionalSpikeEntries: runtimeStats.exceptionalSpikeEntries,
        cooldownOverridesUsed: runtimeStats.cooldownOverridesUsed,
        blockedByExpensiveOppositeSide: runtimeStats.blockedByExpensiveOppositeSide,
        blockedByNeutralQuotes: runtimeStats.blockedByNeutralQuotes,
        borderlineTradesClosed: runtimeStats.borderlineTradesClosed,
        borderlineWinRate: runtimeStats.borderlineWinRate,
        borderlinePnL: runtimeStats.borderlinePnL,
      },
      simulation,
      config.testMode
    );
  }
}

async function runMonitorTick(ctx: BotContext): Promise<void> {
  const tick = await runStrategyTick(ctx);
  const sim = ctx.simulation;
  const now = Date.now();

  runtimeStats.observeTick(tick);

  console.log(formatMonitorTickLine(tick, sim, MIN_SAMPLES_FOR_STRATEGY));

  const spikeSnap = spikeDebug.observeTick(
    tick,
    ctx.config.spikeThreshold,
    ctx.config.borderlineMinRatio,
  );
  if (debugMonitor) {
    if (spikeSnap !== null) {
      console.log(SpikeDebugTracker.formatTickDebugLine(spikeSnap));
    }
    if (tick.kind === "ready") {
      console.log(
        formatDebugTickExtras(
          tick.prices,
          ctx.config.rangeThreshold,
          ctx.config.spikeThreshold,
          ctx.config.tradableSpikeMinPercent,
          ctx.config.maxPriorRangeForNormalEntry,
          ctx.config.hardRejectPriorRangePercent,
          ctx.config.maxEntrySpreadBps,
          tick.entry.windowSpike
            ? {
                classification: tick.entry.windowSpike.classification,
                thresholdRatio: tick.entry.windowSpike.thresholdRatio,
                sourceWindowLabel: tick.entry.windowSpike.sourceWindowLabel,
              }
            : undefined,
        ),
      );
    }
  }
  if (spikeDebug.shouldPrintSummary()) {
    console.log(spikeDebug.formatSummary());
  }

  if (tick.kind !== "ready") {
    const pipeline = runStrategyDecisionPipeline({
      now,
      tick,
      manager: borderlineManager,
      strongSpikeManager,
      simulation: sim,
      config: {
        rangeThreshold: ctx.config.rangeThreshold,
        stableRangeSoftToleranceRatio: ctx.config.stableRangeSoftToleranceRatio,
        strongSpikeHardRejectPoorRange: ctx.config.strongSpikeHardRejectPoorRange,
        spikeThreshold: ctx.config.spikeThreshold,
        tradableSpikeMinPercent: ctx.config.tradableSpikeMinPercent,
        maxPriorRangeForNormalEntry: ctx.config.maxPriorRangeForNormalEntry,
        hardRejectPriorRangePercent: ctx.config.hardRejectPriorRangePercent,
        strongSpikeConfirmationTicks: ctx.config.strongSpikeConfirmationTicks,
        exceptionalSpikePercent: ctx.config.exceptionalSpikePercent,
        exceptionalSpikeOverridesCooldown: ctx.config.exceptionalSpikeOverridesCooldown,
        maxEntrySpreadBps: ctx.config.maxEntrySpreadBps,
        entryCooldownMs: ctx.config.entryCooldownMs,
        borderlineRequirePause: ctx.config.borderlineRequirePause,
        borderlineRequireNoContinuation: ctx.config.borderlineRequireNoContinuation,
        borderlineContinuationThreshold:
          ctx.config.borderlineContinuationThreshold,
        borderlineReversionThreshold: ctx.config.borderlineReversionThreshold,
        borderlinePauseBandPercent: ctx.config.borderlinePauseBandPercent,
        allowWeakQualityEntries: ctx.config.allowWeakQualityEntries,
        allowWeakQualityOnlyForStrongSpikes:
          ctx.config.allowWeakQualityOnlyForStrongSpikes,
        allowAcceptableQualityStrongSpikes:
          ctx.config.allowAcceptableQualityStrongSpikes,
        unstableContextMode: ctx.config.unstableContextMode,
      },
    });
    for (const msg of pipeline.strongSpikeLifecycleMessages ?? []) {
      console.log(msg);
    }
    for (const ev of pipeline.borderlineLifecycleEvents) {
      logBorderlineLifecycleBlock(ev);
    }
    if (pipeline.decision.action !== "none") {
      console.log(formatStrategyDecisionLog(pipeline.decision));
    }
    return;
  }

  persistence.ensureReady();

  const feedStale =
    tick.market.feedPossiblyStale ||
    ctx.marketFeed.getLastMessageAgeMs() > ctx.config.feedStaleMaxAgeMs;

  let pipeline = runStrategyDecisionPipeline({
    now,
    tick,
    manager: borderlineManager,
    strongSpikeManager,
    simulation: sim,
    config: {
      rangeThreshold: ctx.config.rangeThreshold,
      stableRangeSoftToleranceRatio: ctx.config.stableRangeSoftToleranceRatio,
      strongSpikeHardRejectPoorRange: ctx.config.strongSpikeHardRejectPoorRange,
      spikeThreshold: ctx.config.spikeThreshold,
      tradableSpikeMinPercent: ctx.config.tradableSpikeMinPercent,
      maxPriorRangeForNormalEntry: ctx.config.maxPriorRangeForNormalEntry,
      hardRejectPriorRangePercent: ctx.config.hardRejectPriorRangePercent,
      strongSpikeConfirmationTicks: ctx.config.strongSpikeConfirmationTicks,
      exceptionalSpikePercent: ctx.config.exceptionalSpikePercent,
      exceptionalSpikeOverridesCooldown: ctx.config.exceptionalSpikeOverridesCooldown,
      maxEntrySpreadBps: ctx.config.maxEntrySpreadBps,
      entryCooldownMs: ctx.config.entryCooldownMs,
      borderlineRequirePause: ctx.config.borderlineRequirePause,
      borderlineRequireNoContinuation: ctx.config.borderlineRequireNoContinuation,
      borderlineContinuationThreshold: ctx.config.borderlineContinuationThreshold,
      borderlineReversionThreshold: ctx.config.borderlineReversionThreshold,
      borderlinePauseBandPercent: ctx.config.borderlinePauseBandPercent,
      allowWeakQualityEntries: ctx.config.allowWeakQualityEntries,
      allowWeakQualityOnlyForStrongSpikes:
        ctx.config.allowWeakQualityOnlyForStrongSpikes,
      allowAcceptableQualityStrongSpikes:
        ctx.config.allowAcceptableQualityStrongSpikes,
      unstableContextMode: ctx.config.unstableContextMode,
    },
  });
  pipeline = applyFeedStaleEntryBlock(pipeline, {
    tick,
    simulation: sim,
    config: ctx.config,
    feedStale,
  });
  for (const ev of pipeline.borderlineLifecycleEvents) {
    logBorderlineLifecycleBlock(ev);
    runtimeStats.observeBorderlineLifecycleEventType(ev.type);
    const tracked = ctx.opportunityTracker.recordBorderlineLifecycleEvent({
      timestamp: now,
      event: ev,
      tradableSpikeMinPercent: ctx.config.tradableSpikeMinPercent,
      maxPriorRangeForNormalEntry: ctx.config.maxPriorRangeForNormalEntry,
    });
    try {
      persistence.appendOpportunityLine(tracked);
    } catch (err) {
      console.error(
        "[monitor] Failed to append opportunities.jsonl (borderline lifecycle):",
        err
      );
    }
  }
  for (const msg of pipeline.strongSpikeLifecycleMessages ?? []) {
    if (
      msg.includes("promoted") ||
      msg.includes("cancelled") ||
      msg.includes("classification=") ||
      msg.includes("exceptional spike override activated") ||
      msg.includes("[quality-gate]") ||
      msg.includes("[unstable-context]")
    ) {
      console.log(msg);
    }
  }
  if (pipeline.decision.action !== "none") {
    console.log(formatStrategyDecisionLog(pipeline.decision));
  } else if (debugMonitor) {
    console.log(formatStrategyDecisionLog(pipeline.decision));
  }

  const entryForSimulation = pipeline.entryForSimulation ?? tick.entry;
  const paperEntry = entryEvaluationForPipelinePaperExecution(
    pipeline.decision,
    entryForSimulation
  );
  if (debugMonitor && tick.entry.spikeDetected) {
    logSpikeDecisionTrace(
      buildSpikeDecisionTracePayload({
        entry: entryForSimulation,
        decision: pipeline.decision,
      })
    );
  }
  const entryPath =
    pipeline.decision.action === "promote_borderline_candidate"
      ? "borderline_delayed"
      : "strong_spike_immediate";
  const hadOpenPosition = sim.getOpenPosition() !== null;
  const action = pipeline.decision.action;
  const enteringImmediate = action === "enter_immediate";
  const promoting = action === "promote_borderline_candidate";
  sim.onTick({
    now,
    entry: paperEntry,
    entryPath,
    ...(pipeline.decision.qualityProfile !== undefined
      ? { entryQualityProfile: pipeline.decision.qualityProfile }
      : {}),
    sides: tick.sides,
    symbol: ctx.tradeSymbol,
    config: {
      takeProfitBps: ctx.config.takeProfitBps,
      stopLossBps: ctx.config.stopLossBps,
      paperSlippageBps: ctx.config.paperSlippageBps,
      paperFeeRoundTripBps: ctx.config.paperFeeRoundTripBps,
      exitTimeoutMs: ctx.config.exitTimeoutMs,
      entryCooldownMs: ctx.config.entryCooldownMs,
      stakePerTrade: ctx.config.stakePerTrade,
      allowWeakQualityEntries: ctx.config.allowWeakQualityEntries,
      weakQualitySizeMultiplier: ctx.config.weakQualitySizeMultiplier,
      strongQualitySizeMultiplier: ctx.config.strongQualitySizeMultiplier,
      exceptionalQualitySizeMultiplier:
        ctx.config.exceptionalQualitySizeMultiplier,
    },
  });

  const cls = tick.entry.movementClassification;
  const spikeRawEvent =
    tick.entry.spikeDetected === true || enteringImmediate || promoting;
  const candidatePass =
    spikeRawEvent &&
    (cls === "strong_spike" ||
      cls === "borderline" ||
      enteringImmediate ||
      promoting);
  const validEntryApproved = enteringImmediate || promoting;
  const positionOpenedThisTick =
    !hadOpenPosition && sim.getOpenPosition() !== null;
  runtimeStats.observeReadyTickFunnel({
    spikeRawEvent,
    candidatePass,
    validEntryApproved,
    positionOpenedThisTick,
  });

  const recorded = ctx.opportunityTracker.recordFromReadyTick({
    timestamp: now,
    btcPrice: tick.btc,
    prices: tick.prices,
    previousPrice: tick.prev,
    currentPrice: tick.last,
    sides: tick.sides,
    entry: entryForSimulation,
    tradableSpikeMinPercent: ctx.config.tradableSpikeMinPercent,
    maxPriorRangeForNormalEntry: ctx.config.maxPriorRangeForNormalEntry,
    exceptionalSpikeMinPercent: ctx.config.exceptionalSpikePercent,
    allowWeakQualityEntries: ctx.config.allowWeakQualityEntries,
    allowWeakQualityOnlyForStrongSpikes:
      ctx.config.allowWeakQualityOnlyForStrongSpikes,
    allowAcceptableQualityStrongSpikes:
      ctx.config.allowAcceptableQualityStrongSpikes,
    decision: pipeline.decision,
  });
  if (recorded !== null) {
    if (recorded.status === "valid") {
      logValidOpportunityBlock(recorded);
    } else if (debugMonitor) {
      logOpportunityBlock(recorded);
    }
  }

  runtimeStats.observeOpportunityRecord(recorded);

  if (recorded !== null) {
    try {
      persistence.appendOpportunityLine(recorded);
    } catch (err) {
      console.error("[monitor] Failed to append opportunities.jsonl:", err);
    }
  }
}

function startLiveMonitor(ctx: BotContext): void {
  monitorStartedAtMs = Date.now();
  persistence.ensureReady();
  logConfig();
  printLiveMonitorBanner({
    dataSourceDetail: `Binance Spot ${binanceFeed.getSymbol()} (bookTicker + aggTrade WS, REST bootstrap)`,
    tickIntervalSec: BOT_TICK_INTERVAL_MS / 1000,
    bufferSlots: config.priceBufferSize,
    minSamples: MIN_SAMPLES_FOR_STRATEGY,
    spikeThreshold: config.spikeThreshold,
    tradableSpikeMinPercent: config.tradableSpikeMinPercent,
    maxPriorRangeForNormalEntry: config.maxPriorRangeForNormalEntry,
    hardRejectPriorRangePercent: config.hardRejectPriorRangePercent,
    strongSpikeConfirmationTicks: config.strongSpikeConfirmationTicks,
    exceptionalSpikePercent: config.exceptionalSpikePercent,
    exceptionalSpikeOverridesCooldown: config.exceptionalSpikeOverridesCooldown,
    maxEntrySpreadBps: config.maxEntrySpreadBps,
    persistPath: `${persistence.getOutputDir()} (JSONL + session-summary on exit)`,
    debugMode: debugMonitor,
    testMode: config.testMode,
  });

  statsTimer = setInterval(() => {
    printPeriodicRuntimeSummary(
      "Runtime stats (5 min)",
      {
        ticksObserved: runtimeStats.ticksObserved,
        btcFetchFailures: runtimeStats.btcFetchFailures,
        spikeEventsDetected: runtimeStats.spikeEventsDetected,
        candidateOpportunities: runtimeStats.candidateOpportunities,
        validOpportunities: runtimeStats.validOpportunities,
        rejectedOpportunities: runtimeStats.rejectedOpportunities,
        tradesExecuted: runtimeStats.tradesExecuted,
        strongSpikeSignals: runtimeStats.strongSpikeSignals,
        strongSpikeEntries: runtimeStats.strongSpikeEntries,
        noSignalMoves: runtimeStats.noSignalMoves,
        borderlineMoves: runtimeStats.borderlineMoves,
        strongSpikeMoves: runtimeStats.strongSpikeMoves,
        borderlineSignals: runtimeStats.borderlineSignals,
        borderlineCandidatesCreated: runtimeStats.borderlineCandidatesCreated,
        borderlinePromotions: runtimeStats.borderlinePromotions,
        borderlineCancellations: runtimeStats.borderlineCancellations,
        borderlineExpirations: runtimeStats.borderlineExpirations,
        blockedByCooldown: runtimeStats.blockedByCooldown,
        blockedByActivePosition: runtimeStats.blockedByActivePosition,
        blockedByInvalidQuotes: runtimeStats.blockedByInvalidQuotes,
        blockedByNoisyRange: runtimeStats.blockedByNoisyRange,
        blockedByWidePriorRange: runtimeStats.blockedByWidePriorRange,
        blockedByHardRejectUnstableContext:
          runtimeStats.blockedByHardRejectUnstableContext,
        rejectedByWeakSpikeQuality: runtimeStats.rejectedByWeakSpikeQuality,
        rejectedByPriorRangeTooWide: runtimeStats.rejectedByPriorRangeTooWide,
        rejectedByHardUnstableContext: runtimeStats.rejectedByHardUnstableContext,
        rejectedByStrongSpikeContinuation:
          runtimeStats.rejectedByStrongSpikeContinuation,
        rejectedByBorderlineContinuation:
          runtimeStats.rejectedByBorderlineContinuation,
        rejectedByExpensiveOppositeSide: runtimeStats.rejectedByExpensiveOppositeSide,
        exceptionalSpikeSignals: runtimeStats.exceptionalSpikeSignals,
        exceptionalSpikeEntries: runtimeStats.exceptionalSpikeEntries,
        cooldownOverridesUsed: runtimeStats.cooldownOverridesUsed,
        blockedByExpensiveOppositeSide: runtimeStats.blockedByExpensiveOppositeSide,
        blockedByNeutralQuotes: runtimeStats.blockedByNeutralQuotes,
        borderlineTradesClosed: runtimeStats.borderlineTradesClosed,
        borderlineWinRate: runtimeStats.borderlineWinRate,
        borderlinePnL: runtimeStats.borderlinePnL,
      },
      ctx.simulation,
      config.testMode
    );
    console.log(
      `${config.testMode ? "[TEST MODE] " : ""}[quality] weak=${runtimeStats.qualityWeak} strong=${runtimeStats.qualityStrong} exceptional=${runtimeStats.qualityExceptional} | top-rejections ${formatTopRejectionReasons()}`
    );
  }, 5 * 60 * 1000);
  void runMonitorTick(ctx);
  tickTimer = setInterval(() => {
    void runMonitorTick(ctx);
  }, BOT_TICK_INTERVAL_MS);
  process.once("SIGINT", gracefulShutdown);
  process.once("SIGTERM", gracefulShutdown);
}

const simulation = new SimulationEngine({
  silent: true,
  initialEquity: config.initialCapital,
  onTradeClosed: onPaperTradeClosed,
  paperPositionMtmDiagnostics: config.paperPositionMtmDebug,
});

const ctx: BotContext = {
  priceBuffer: new RollingPriceBuffer(config.priceBufferSize),
  simulation,
  opportunityTracker: new OpportunityTracker(),
  config,
  marketFeed: binanceFeed,
  tradeSymbol: binanceFeed.getSymbol(),
};

void binanceFeed.bootstrapRest().then((ok) => {
  if (!ok) {
    console.warn("[monitor] REST bookTicker bootstrap failed — waiting for WebSocket");
  }
  binanceFeed.start();
  startLiveMonitor(ctx);
});
