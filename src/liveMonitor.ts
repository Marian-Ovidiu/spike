import "./config/loadEnv.js";

/**
 * Legacy **binary-first** live monitor (`SimulationEngine`, YES/NO execution, JSONL `output/monitor/`).
 * For the **futures core** stack use `src/core/runtime/runFuturesMonitor.ts` → `npm run monitor:futures`.
 */
import { BOT_TICK_INTERVAL_MS, MIN_SAMPLES_FOR_STRATEGY, type BotContext } from "./botLoop.js";
import {
  config,
  configMeta,
  debugMonitor,
  describeActiveConfigGroups,
  logConfig,
} from "./config.js";
import { assertBinaryOnlyRuntime } from "./binaryOnlyRuntime.js";
import { assertLegacySpotMarketModeAcknowledged } from "./legacy/spot/assertLegacySpotMarketMode.js";
import { aggregateHoldExitAudits } from "./holdExitAudit.js";
import {
  buildNormalizedMonitorConfigSummary,
  formatSignalDetectionBannerLines,
} from "./config/monitorNormalizedConfigSummary.js";
import {
  buildMonitorSessionSummary,
  MonitorFilePersistence,
} from "./monitorPersistence.js";
import { computeBinaryRunAnalytics } from "./analyze/binaryRunAnalytics.js";
import { BinaryMarketFeed } from "./binary/venue/binaryMarketFeed.js";
import { BinarySyntheticFeed } from "./binary/venue/binarySyntheticFeed.js";
import { formatGammaBootstrapStepsForLog } from "./binary/venue/gammaMarketResolve.js";
import {
  formatBinaryExecutionVenueBannerLine,
  resolveBinaryMarketSelectorFromEnv,
} from "./binary/venue/binaryMarketSelector.js";
import { buildBinaryBannerExecutionLine } from "./binary/monitor/binaryMonitorBanner.js";
import { BinaryQuoteSessionStats } from "./binary/monitor/binaryMonitorQuoteStats.js";
import {
  logPaperTradeClosedBlock,
  printLiveMonitorBanner,
  printPeriodicRuntimeSummary,
  printShutdownReport,
} from "./monitorConsole.js";
import { buildSessionInterpretationLines } from "./monitor/binarySessionInterpretation.js";
import {
  flushPendingProbabilityCalibration,
  runLiveMonitorTick,
  type LiveMonitorTickDeps,
} from "./monitor/runLiveMonitorTick.js";
import { SignalMidRingBuffer } from "./binary/signal/signalMidRingBuffer.js";
import {
  resolveOpportunityCalibration,
  resolveTradeCalibration,
} from "./binary/signal/probabilityCalibrationResolve.js";
import {
  logReportCounterConsistency,
  MonitorRuntimeStats,
} from "./monitorRuntimeStats.js";
import { computeStrongSpikeGateFunnel } from "./monitorFunnelDiagnostics.js";
import { RollingPriceBuffer } from "./rollingPriceBuffer.js";
import type { SimulatedTrade } from "./simulationEngine.js";
import { SimulationEngine } from "./simulationEngine.js";
import {
  ensureAutoDiscoveredBinaryMarketSlug,
  getLastAutoDiscoveredBtc5mMarket,
  wasBinaryMarketAutoDiscovered,
} from "./binary/venue/discoverBtc5mUpDownMarket.js";
import { createSignalAndExecutionFeeds } from "./market/marketFeedFactory.js";
import {
  buildMarketFeedShutdownDiagnostics,
  liveMonitorDualFeedBannerDetail,
} from "./market/marketDiagnostics.js";
import { OpportunityTracker } from "./opportunityTracker.js";
import {
  evaluateSession,
  printSessionEvaluationReport,
} from "./sessionEvaluator.js";
import { SpikeDebugTracker } from "./spikeDebugTracker.js";
import { BorderlineCandidateStore } from "./borderlineCandidateStore.js";
import { StrongSpikeCandidateStore } from "./strongSpikeCandidateStore.js";

const runtimeStats = new MonitorRuntimeStats({
  exceptionalSpikePercent: config.exceptionalSpikePercent,
});
const binaryQuoteSessionStats = new BinaryQuoteSessionStats();
const binaryCompareDiag =
  process.env.BINARY_COMPARE_DIAG?.trim().toLowerCase() === "1" ||
  process.env.BINARY_COMPARE_DIAG?.trim().toLowerCase() === "true";

const persistence = new MonitorFilePersistence();

const signalMidRing = new SignalMidRingBuffer(
  config.probabilityTimeHorizonMs + 180_000
);
const pendingCalibrationTradeIds: number[] = [];

assertLegacySpotMarketModeAcknowledged(config.marketMode);
assertBinaryOnlyRuntime(config.marketMode);
await ensureAutoDiscoveredBinaryMarketSlug(config.marketMode);

const { signalFeed, executionFeed } = createSignalAndExecutionFeeds(
  config.marketMode,
  {
    paper: false,
    binarySignalSource: config.binarySignalSource,
    binarySignalSymbol: config.binarySignalSymbol,
  }
);
const sameMarketFeedInstance = signalFeed === executionFeed;
const spikeDebug = new SpikeDebugTracker();
const borderlineManager = new BorderlineCandidateStore({
  symbol: executionFeed.getSymbol(),
  watchTicks: config.borderlineWatchTicks,
  maxLifetimeMs: config.borderlineMaxLifetimeMs,
  enableBorderlineMode: config.enableBorderlineMode,
  borderlineEntryMinThresholdRatio: config.borderlineEntryMinThresholdRatio,
  borderlineEntryRequiresStableRange: config.borderlineEntryRequiresStableRange,
});
const strongSpikeManager = new StrongSpikeCandidateStore({
  symbol: executionFeed.getSymbol(),
  watchTicks: config.strongSpikeConfirmationTicks,
});

const liveMonitorTickDeps: LiveMonitorTickDeps = {
  runtimeStats,
  binaryQuoteSessionStats,
  borderlineManager,
  strongSpikeManager,
  persistence,
  spikeDebug,
  binaryCompareDiag,
  ...(config.marketMode === "binary"
    ? {
        probabilityCalibration: {
          signalMidRing,
          horizonMs: config.probabilityTimeHorizonMs,
          pendingTradeIds: pendingCalibrationTradeIds,
          getSimulation: () => simulation,
        },
      }
    : {}),
};

let monitorStartedAtMs = 0;
let tickTimer: ReturnType<typeof setInterval> | undefined;
let statsTimer: ReturnType<typeof setInterval> | undefined;
let shutdownInProgress = false;

function buildInterpretationLines(): string[] {
  return buildSessionInterpretationLines({
    marketMode: config.marketMode,
    runtime: {
      ticksObserved: runtimeStats.ticksObserved,
      noSignalMoves: runtimeStats.noSignalMoves,
      borderlineMoves: runtimeStats.borderlineMoves,
      strongSpikeMoves: runtimeStats.strongSpikeMoves,
      validOpportunities: runtimeStats.validOpportunities,
      rejectedOpportunities: runtimeStats.rejectedOpportunities,
      rejectedByWeakSpikeQuality: runtimeStats.rejectedByWeakSpikeQuality,
      blockedByInvalidQuotes: runtimeStats.blockedByInvalidQuotes,
      blockedByExpensiveOppositeSide: runtimeStats.blockedByExpensiveOppositeSide,
      blockedByNeutralQuotes: runtimeStats.blockedByNeutralQuotes,
      rejectedByPriorRangeTooWide: runtimeStats.rejectedByPriorRangeTooWide,
      rejectedByHardUnstableContext: runtimeStats.rejectedByHardUnstableContext,
      cooldownOverridesUsed: runtimeStats.cooldownOverridesUsed,
      exceptionalSpikeEntries: runtimeStats.exceptionalSpikeEntries,
    },
    binaryQuote:
      config.marketMode === "binary" ? binaryQuoteSessionStats.snapshot() : null,
  });
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
  try {
    signalFeed.stop();
  } catch {
    /* ignore */
  }
  if (!sameMarketFeedInstance) {
    try {
      executionFeed.stop();
    } catch {
      /* ignore */
    }
  }

  const gateFunnel = computeStrongSpikeGateFunnel({
    opportunities: ctx.opportunityTracker.getOpportunities(),
    borderlineCandidatesCreated: runtimeStats.borderlineCandidatesCreated,
    tradesExecuted: runtimeStats.tradesExecuted,
    strategyApprovedEntryTicks: runtimeStats.validOpportunities,
  });
  const exitThresholdAudit = aggregateHoldExitAudits(simulation.getTradeHistory());
  const binaryRunAnalytics =
    config.marketMode === "binary"
      ? computeBinaryRunAnalytics({
          marketMode: config.marketMode,
          opportunities: ctx.opportunityTracker.getOpportunities(),
          trades: simulation.getTradeHistory(),
          openedTradesOverride: runtimeStats.tradesExecuted,
          borderlineFunnel: {
            borderlineEntered: runtimeStats.borderlineEntered,
            borderlinePromoted: runtimeStats.borderlinePromoted,
            borderlineRejectedTimeout: runtimeStats.borderlineRejectedTimeout,
            borderlineRejectedWeak: runtimeStats.borderlineRejectedWeak,
          },
        })
      : null;
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
      strongSpikeImmediateTradesClosed:
        runtimeStats.strongSpikeImmediateTradesClosed,
      strongSpikeImmediateWinRate: runtimeStats.strongSpikeImmediateWinRate,
      averageStrongSpikeImmediatePnL:
        runtimeStats.strongSpikeImmediateAveragePnL,
      strongSpikeConfirmedTradesClosed:
        runtimeStats.strongSpikeConfirmedTradesClosed,
      strongSpikeConfirmedWinRate: runtimeStats.strongSpikeConfirmedWinRate,
      averageStrongSpikeConfirmedPnL:
        runtimeStats.strongSpikeConfirmedAveragePnL,
      testMode: config.testMode,
      marketMode: config.marketMode,
      configGroupSummary: describeActiveConfigGroups(config.marketMode),
      exitThresholdAudit,
      marketFeedDiagnostics: buildMarketFeedShutdownDiagnostics(
        config.marketMode,
        executionFeed
      ),
      ...(config.marketMode === "binary"
        ? {
            signalFeedDiagnostics: buildMarketFeedShutdownDiagnostics(
              "spot",
              signalFeed
            ),
            binaryQuoteSession: binaryQuoteSessionStats.snapshot(),
            ...(binaryRunAnalytics !== null
              ? {
                  binaryYesNoComparative: binaryRunAnalytics.yesNoComparative,
                  binaryRunAnalytics,
                }
              : {}),
          }
        : {}),
    }
  );
  for (const line of buildInterpretationLines()) {
    console.log(`[interpretation] ${line}`);
  }

  if (debugMonitor && spikeDebug.getReadyTickCount() > 0) {
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
        marketMode: config.marketMode,
        configGroupSummary: describeActiveConfigGroups(config.marketMode),
        normalizedConfig: buildNormalizedMonitorConfigSummary(config, configMeta),
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
          borderlineEntered: runtimeStats.borderlineEntered,
          borderlinePromoted: runtimeStats.borderlinePromoted,
          borderlineRejectedTimeout: runtimeStats.borderlineRejectedTimeout,
          borderlineRejectedWeak: runtimeStats.borderlineRejectedWeak,
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
          strongSpikeImmediateTradesClosed:
            runtimeStats.strongSpikeImmediateTradesClosed,
          strongSpikeImmediateWinRate: runtimeStats.strongSpikeImmediateWinRate,
          averageStrongSpikeImmediatePnL:
            runtimeStats.strongSpikeImmediateAveragePnL,
          strongSpikeConfirmedTradesClosed:
            runtimeStats.strongSpikeConfirmedTradesClosed,
          strongSpikeConfirmedWinRate: runtimeStats.strongSpikeConfirmedWinRate,
          averageStrongSpikeConfirmedPnL:
            runtimeStats.strongSpikeConfirmedAveragePnL,
          delayedBorderlineWinRate: runtimeStats.borderlineWinRate,
          borderlineNetImpact: borderlineNetImpact(),
          verdict: borderlineImpactVerdict(),
          qualityWeak: runtimeStats.qualityWeak,
          qualityStrong: runtimeStats.qualityStrong,
          qualityExceptional: runtimeStats.qualityExceptional,
          topRejectionReasons: runtimeStats.getTopRejectionReasons(5),
          rejectedByPipelineQualityDowngradeLegacy:
            runtimeStats.rejectedByPipelineQualityDowngradeLegacy,
          pipelineQualityDowngradeBreakdown:
            runtimeStats.getPipelineQualityDowngradeBreakdown(),
          interpretation: buildInterpretationLines(),
          gateFunnel,
          testMode: config.testMode,
          exitThresholdAudit,
          ...(config.testMode
            ? { testModeLabel: "TEST MODE ACTIVE" as const }
            : {}),
          marketFeedDiagnostics: buildMarketFeedShutdownDiagnostics(
            config.marketMode,
            executionFeed
          ),
          ...(config.marketMode === "binary"
            ? {
                signalFeedDiagnostics: buildMarketFeedShutdownDiagnostics(
                  "spot",
                  signalFeed
                ),
                binaryQuoteSession: binaryQuoteSessionStats.snapshot(),
              }
            : {}),
        },
        ...(binaryRunAnalytics !== null ? { binaryRunAnalytics } : {}),
      })
    );
    if (config.marketMode === "binary" && executionFeed instanceof BinarySyntheticFeed) {
      const synDiag = executionFeed.getSyntheticPricingDiagnosticsSummary();
      if (synDiag !== null) {
        persistence.writeSyntheticPricingDiagnostics(synDiag);
      }
    }
  } catch (err) {
    console.error("[monitor] Failed to write session-summary.json:", err);
  }
  flushPendingProbabilityCalibration(liveMonitorTickDeps, Date.now());
  if (config.marketMode === "binary") {
    const ended = Date.now();
    for (const o of ctx.opportunityTracker.getOpportunities()) {
      if (o.marketMode !== "binary") continue;
      if (
        o.estimatedProbabilityUp === undefined ||
        !Number.isFinite(o.estimatedProbabilityUp)
      ) {
        continue;
      }
      if (
        o.opportunityOutcome === "entered_immediate" ||
        o.opportunityOutcome === "promoted_after_watch"
      ) {
        continue;
      }
      const horizon = o.probabilityTimeHorizonMs ?? config.probabilityTimeHorizonMs;
      const refMid = o.underlyingSignalPrice ?? o.btcPrice;
      if (!Number.isFinite(refMid)) continue;
      const ev = resolveOpportunityCalibration({
        opportunityTimestampMs: o.timestamp,
        predictedProbabilityUp: o.estimatedProbabilityUp,
        probabilityTimeHorizonMs: horizon,
        referenceSignalMid: refMid,
        ring: signalMidRing,
        sessionEndMs: ended,
      });
      if (ev) {
        try {
          persistence.appendProbabilityCalibrationLine(ev);
        } catch (err) {
          console.error(
            "[monitor] Failed to append probability-calibration-events.jsonl (opportunity):",
            err
          );
        }
      }
    }
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

  if (trade.executionModel === "binary") {
    const r = resolveTradeCalibration(
      trade,
      config.probabilityTimeHorizonMs,
      signalMidRing,
      Date.now()
    );
    if (r.kind === "event") {
      try {
        persistence.appendProbabilityCalibrationLine(r.event);
      } catch (err) {
        console.error(
          "[monitor] Failed to append probability-calibration-events.jsonl (trade):",
          err
        );
      }
    } else if (r.kind === "deferred") {
      pendingCalibrationTradeIds.push(trade.id);
    }
  }

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
      config.testMode,
      config.marketMode
    );
  }
}

function startLiveMonitor(ctx: BotContext): void {
  monitorStartedAtMs = Date.now();
  binaryQuoteSessionStats.reset();
  persistence.ensureReady();
  logConfig();
  printLiveMonitorBanner({
    ...(config.marketMode === "binary"
      ? {
          binaryBannerLayers: {
            signalSource: config.binarySignalSource,
            signalSymbol: config.binarySignalSymbol,
            executionSlugLine: buildBinaryBannerExecutionLine(executionFeed),
          },
          binaryVenueLine: formatBinaryExecutionVenueBannerLine(
            resolveBinaryMarketSelectorFromEnv()
          ),
          ...(wasBinaryMarketAutoDiscovered() && getLastAutoDiscoveredBtc5mMarket() !== null
            ? {
                binaryAutoDiscoveryBanner: getLastAutoDiscoveredBtc5mMarket()!,
              }
            : {}),
        }
      : {}),
    dataSourceDetail: liveMonitorDualFeedBannerDetail(
      config.marketMode,
      signalFeed,
      executionFeed,
      config.marketMode === "binary"
        ? {
            source: config.binarySignalSource,
            symbol: config.binarySignalSymbol,
          }
        : undefined
    ),
    marketMode: config.marketMode,
    ...(config.marketMode === "binary"
      ? {
          binaryPaperExits: {
            takeProfitPriceDelta: config.binaryTakeProfitPriceDelta,
            stopLossPriceDelta: config.binaryStopLossPriceDelta,
            exitTimeoutMs: config.binaryExitTimeoutMs,
            maxOppositeSideEntryPrice: config.binaryMaxOppositeSideEntryPrice,
          },
        }
      : {}),
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
    signalDetectionBannerLines: formatSignalDetectionBannerLines(config, configMeta),
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
      config.testMode,
      ctx.config.marketMode
    );
    console.log(
      `${config.testMode ? "[TEST MODE] " : ""}[quality] weak=${runtimeStats.qualityWeak} strong=${runtimeStats.qualityStrong} exceptional=${runtimeStats.qualityExceptional} | top-rejections ${formatTopRejectionReasons()}`
    );
  }, 5 * 60 * 1000);
  void runLiveMonitorTick(ctx, liveMonitorTickDeps);
  tickTimer = setInterval(() => {
    void runLiveMonitorTick(ctx, liveMonitorTickDeps);
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
  signalFeed,
  executionFeed,
  tradeSymbol: executionFeed.getSymbol(),
};

function startAfterBootstrap(signalOk: boolean, execOk: boolean): void {
  if (!signalOk && config.marketMode === "spot") {
    console.warn("[monitor] REST bookTicker bootstrap failed — waiting for WebSocket");
  }
  if (!signalOk && config.marketMode === "binary") {
    console.warn(
      "[monitor] BTC signal feed REST bootstrap failed — check Binance connectivity / symbol"
    );
  }
  if (
    !sameMarketFeedInstance &&
    !execOk &&
    config.marketMode === "binary" &&
    executionFeed instanceof BinaryMarketFeed
  ) {
    const sel = resolveBinaryMarketSelectorFromEnv();
    console.error(
      "[monitor] FATAL: Gamma bootstrap did not produce a usable YES/NO execution quote/book (see [gamma-bootstrap] lines above)."
    );
    console.error(
      `  selector: ${sel.selectorKind}  value: ${sel.selectorValue}  env: ${sel.sourceEnvKey}`
    );
    const lr = executionFeed.getLastGammaResolve();
    if (lr !== null) {
      console.error(
        "  Gamma HTTP trace:\n" + formatGammaBootstrapStepsForLog(lr.steps).replace(/^/gm, "  ")
      );
      console.error(`  resolution: ${JSON.stringify(lr.resolution)}`);
      if (lr.parseFailure) console.error(`  parseFailure: ${lr.parseFailure}`);
    }
    const bookWhy = executionFeed.describeExecutableBookInvalidReason();
    if (bookWhy) console.error(`  executable_book: ${bookWhy}`);
    console.error(
      "  Common fix: Polymarket **event** URL slugs must resolve via /events/slug (bot does this automatically). If you still see empty markets, use BINARY_MARKET_SLUG of the **child** market or BINARY_MARKET_ID. For condition hex use BINARY_CONDITION_ID (CLOB bridge)."
    );
    process.exit(1);
  }
  signalFeed.start();
  if (!sameMarketFeedInstance) executionFeed.start();
  startLiveMonitor(ctx);
}

if (sameMarketFeedInstance) {
  void signalFeed.bootstrapRest().then((signalOk) => {
    startAfterBootstrap(signalOk, signalOk);
  });
} else {
  void Promise.all([signalFeed.bootstrapRest(), executionFeed.bootstrapRest()]).then(
    ([signalOk, execOk]) => {
      startAfterBootstrap(signalOk, execOk);
    }
  );
}
