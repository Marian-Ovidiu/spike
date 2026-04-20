import {
  BOT_TICK_INTERVAL_MS,
  MIN_SAMPLES_FOR_STRATEGY,
  runStrategyTick,
  type BotContext,
} from "../botLoop.js";
import { config, debugMonitor } from "../config.js";
import { logMonitorDebug } from "./monitorDebugLog.js";
import { BinaryMarketFeed } from "../binary/venue/binaryMarketFeed.js";
import { BinaryQuoteSessionStats } from "../binary/monitor/binaryMonitorQuoteStats.js";
import type { MonitorTickFormatContext } from "../binary/monitor/binaryMonitorTickTypes.js";
import { formatPolymarketBinaryQuoteMonitorLine } from "../binary/monitor/formatPolymarketQuoteLine.js";
import { buildBinaryQuoteMeta } from "../binary/monitor/binaryQuoteMeta.js";
import {
  buildSpikeDecisionTracePayload,
  formatDebugTickExtras,
  formatMonitorTickLine,
  formatMonitorTickLineVerboseEnglish,
  logBorderlineLifecycleBlock,
  type MonitorLiveLinePipelineContext,
  logOpportunityBlock,
  logSpikeDecisionTrace,
  logValidOpportunityBlock,
} from "../monitorConsole.js";
import type { MonitorFilePersistence } from "../monitorPersistence.js";
import type { MonitorRuntimeStats } from "../monitorRuntimeStats.js";
import { SpikeDebugTracker } from "../spikeDebugTracker.js";
import type { BorderlineCandidateStore } from "../borderlineCandidateStore.js";
import type { StrongSpikeCandidateStore } from "../strongSpikeCandidateStore.js";
import {
  applyFeedStaleEntryBlock,
  entryEvaluationForPipelinePaperExecution,
  formatStrategyDecisionLog,
  isPersistedBorderlineLifecycleEvent,
  runStrategyDecisionPipeline,
} from "../strategy/strategyDecisionPipeline.js";
import {
  formatBinaryProbabilityDebugLine,
  getBinaryProbabilityDiagnostics,
  pricesToProbabilityTicks,
} from "../binary/signal/binaryProbabilityEngine.js";
import { SignalMidRingBuffer } from "../binary/signal/signalMidRingBuffer.js";
import { resolveTradeCalibration } from "../binary/signal/probabilityCalibrationResolve.js";
import type { SimulationEngine } from "../simulationEngine.js";

export type LiveMonitorTickDeps = {
  runtimeStats: MonitorRuntimeStats;
  binaryQuoteSessionStats: BinaryQuoteSessionStats;
  borderlineManager: BorderlineCandidateStore;
  strongSpikeManager: StrongSpikeCandidateStore;
  persistence: MonitorFilePersistence;
  spikeDebug: SpikeDebugTracker;
  binaryCompareDiag: boolean;
  /** Binary monitor: BTC signal path for probability calibration vs horizon. */
  probabilityCalibration?: {
    signalMidRing: SignalMidRingBuffer;
    horizonMs: number;
    pendingTradeIds: number[];
    getSimulation: () => SimulationEngine;
  };
};

export function flushPendingProbabilityCalibration(
  deps: LiveMonitorTickDeps,
  nowMs: number
): void {
  const cal = deps.probabilityCalibration;
  if (!cal) return;
  const sim = cal.getSimulation();
  const next: number[] = [];
  for (const id of cal.pendingTradeIds) {
    const trade = sim.getTradeHistory().find((t) => t.id === id);
    if (!trade) continue;
    const r = resolveTradeCalibration(
      trade,
      cal.horizonMs,
      cal.signalMidRing,
      nowMs
    );
    if (r.kind === "event") {
      try {
        deps.persistence.appendProbabilityCalibrationLine(r.event);
      } catch (err) {
        console.error(
          "[monitor] Failed to append probability-calibration-events.jsonl:",
          err
        );
      }
    } else if (r.kind === "deferred") {
      next.push(id);
    }
  }
  cal.pendingTradeIds.length = 0;
  cal.pendingTradeIds.push(...next);
}

export async function runLiveMonitorTick(
  ctx: BotContext,
  deps: LiveMonitorTickDeps
): Promise<void> {
  const {
    runtimeStats,
    binaryQuoteSessionStats,
    borderlineManager,
    strongSpikeManager,
    persistence,
    spikeDebug,
    binaryCompareDiag,
  } = deps;

  const tick = await runStrategyTick(ctx);
  const sim = ctx.simulation;
  const now = Date.now();

  runtimeStats.observeTick(tick);

  if (
    deps.probabilityCalibration &&
    ctx.config.marketMode === "binary" &&
    tick.kind === "ready" &&
    Number.isFinite(tick.underlyingSignalPrice)
  ) {
    deps.probabilityCalibration.signalMidRing.record(
      now,
      tick.underlyingSignalPrice
    );
  }

  if (debugMonitor) {
    const buf = ctx.priceBuffer.getPrices();
    if (buf.length >= 2) {
      const probTicks = pricesToProbabilityTicks(buf, now, BOT_TICK_INTERVAL_MS);
      const probDiag = getBinaryProbabilityDiagnostics({
        ticks: probTicks,
        windowSize: ctx.config.probabilityWindowSize,
        timeHorizonMs: ctx.config.probabilityTimeHorizonMs,
        sigmoidK: ctx.config.probabilitySigmoidK,
      });
      logMonitorDebug(
        formatBinaryProbabilityDebugLine(probDiag, ctx.config.probabilityTimeHorizonMs)
      );
    }
  }

  let tickFmt: MonitorTickFormatContext | undefined;
  if (ctx.config.marketMode === "binary") {
    if (tick.kind === "ready") {
      binaryQuoteSessionStats.observe(tick.binaryOutcomes, {
        signalMid: tick.underlyingSignalPrice,
        prices: tick.prices,
      });
    } else if (tick.kind === "warming" || tick.kind === "no_book") {
      binaryQuoteSessionStats.observe(null, { signalMid: tick.btc });
    }
  }
  if (ctx.config.marketMode === "binary" && tick.kind === "ready") {
    const st = ctx.executionFeed.getQuoteStale();
    const gq =
      ctx.executionFeed instanceof BinaryMarketFeed
        ? ctx.executionFeed.getNormalizedBinaryQuote()
        : null;
    tickFmt = {
      marketMode: "binary",
      underlyingSignalPrice: tick.underlyingSignalPrice,
      ...(tick.signalFeedPossiblyStale !== undefined
        ? { signalFeedPossiblyStale: tick.signalFeedPossiblyStale }
        : {}),
      binaryOutcomes: tick.binaryOutcomes,
      quoteStale: st.stale,
      quoteStaleReason: st.reason,
      quoteAgeMs: gq?.quoteAgeMs ?? null,
    };
  }
  if (
    debugMonitor &&
    binaryCompareDiag &&
    ctx.config.marketMode === "binary" &&
    tick.kind === "ready"
  ) {
    const d = binaryQuoteSessionStats.peekLastComparativeTick();
    const spikePct = tick.entry.movement.strongestMovePercent * 100;
    const leg = Math.max(d.yesAbsDelta, d.noAbsDelta);
    logMonitorDebug(
      `[sig×bin] BTCΔtick=${d.btcTickMovePct.toFixed(4)}% | YESΔ=${d.yesAbsDelta.toFixed(5)} NOΔ=${d.noAbsDelta.toFixed(5)} | spike=${spikePct.toFixed(4)}% vs maxLegΔ=${leg.toFixed(5)}`
    );
  }

  const syntheticVenuePriceLogEnv = (): boolean => {
    const raw = process.env.SYNTHETIC_VENUE_PRICE_LOG?.trim().toLowerCase();
    return raw === "1" || raw === "true" || raw === "yes";
  };
  if (
    tick.kind === "ready" &&
    tick.syntheticVenuePricing !== undefined &&
    (debugMonitor || syntheticVenuePriceLogEnv())
  ) {
    const v = tick.syntheticVenuePricing;
    const line =
      `[synthetic-venue] prob_up=${v.strategyProbabilityUp.toFixed(4)} fair=${v.fairValueYes.toFixed(4)} ` +
      `synth_mid=${v.syntheticYesMid.toFixed(4)} yes_ask=${v.syntheticYesAsk.toFixed(4)} no_ask=${v.syntheticNoAsk.toFixed(4)} ` +
      `edge_vs_yes_ask=${v.edgeVsYesAsk.toFixed(4)} edge_vs_no_ask=${v.edgeVsNoAsk.toFixed(4)} ` +
      `raw_venue=${v.rawVenueYesMid.toFixed(4)} lag_fair=${v.laggedFairValueYes.toFixed(4)}`;
    if (debugMonitor) logMonitorDebug(line);
    else console.log(line);
  }

  if (debugMonitor && ctx.executionFeed instanceof BinaryMarketFeed) {
    logMonitorDebug(
      formatPolymarketBinaryQuoteMonitorLine({
        quote: ctx.executionFeed.getNormalizedBinaryQuote(),
        stale: ctx.executionFeed.getQuoteStale(),
        lastError: ctx.executionFeed.getLastError(),
      })
    );
  }

  if (debugMonitor) {
    const spikeSnap = spikeDebug.observeTick(
      tick,
      ctx.config.spikeThreshold,
      ctx.config.borderlineMinRatio
    );
    if (spikeSnap !== null) {
      logMonitorDebug(SpikeDebugTracker.formatTickDebugLine(spikeSnap));
    }
    if (tick.kind === "ready") {
      logMonitorDebug(
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
            : undefined
        )
      );
    }
    if (spikeDebug.shouldPrintSummary()) {
      logMonitorDebug(spikeDebug.formatSummary());
    }
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
        borderlineMaxLifetimeMs: ctx.config.borderlineMaxLifetimeMs,
        borderlineFastPromoteDeltaBps: ctx.config.borderlineFastPromoteDeltaBps,
        borderlineFastPromoteProbDelta: ctx.config.borderlineFastPromoteProbDelta,
        borderlineFastRejectSameDirectionBps:
          ctx.config.borderlineFastRejectSameDirectionBps,
        enableBorderlineMode: ctx.config.enableBorderlineMode,
        allowWeakQualityEntries: ctx.config.allowWeakQualityEntries,
        allowWeakQualityOnlyForStrongSpikes:
          ctx.config.allowWeakQualityOnlyForStrongSpikes,
        allowAcceptableQualityStrongSpikes:
          ctx.config.allowAcceptableQualityStrongSpikes,
        unstableContextMode: ctx.config.unstableContextMode,
        marketMode: ctx.config.marketMode,
        binaryMaxOppositeSideEntryPrice: ctx.config.binaryMaxOppositeSideEntryPrice,
        binaryMaxEntrySidePrice: ctx.config.binaryMaxEntrySidePrice,
        binaryNeutralQuoteBandMin: ctx.config.binaryNeutralQuoteBandMin,
        binaryNeutralQuoteBandMax: ctx.config.binaryNeutralQuoteBandMax,
      },
    });
    if (debugMonitor) {
      for (const msg of pipeline.strongSpikeLifecycleMessages ?? []) {
        logMonitorDebug(msg);
      }
      for (const ev of pipeline.borderlineLifecycleEvents) {
        logBorderlineLifecycleBlock(ev);
      }
      if (pipeline.decision.action !== "none") {
        logMonitorDebug(formatStrategyDecisionLog(pipeline.decision));
      }
    }
    console.log(
      formatMonitorTickLine(
        tick,
        sim,
        MIN_SAMPLES_FOR_STRATEGY,
        tickFmt,
        config.marketMode
      )
    );
    if (debugMonitor) {
      logMonitorDebug(
        formatMonitorTickLineVerboseEnglish(
          tick,
          sim,
          MIN_SAMPLES_FOR_STRATEGY,
          tickFmt,
          config.marketMode
        )
      );
    }
    flushPendingProbabilityCalibration(deps, now);
    return;
  }

  persistence.ensureReady();

  const feedStale =
    ctx.config.marketMode === "binary"
      ? ctx.executionFeed.getQuoteStale().stale
      : tick.market.feedPossiblyStale ||
        ctx.executionFeed.getLastMessageAgeMs() > ctx.config.feedStaleMaxAgeMs;

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
      borderlineMaxLifetimeMs: ctx.config.borderlineMaxLifetimeMs,
      borderlineFastPromoteDeltaBps: ctx.config.borderlineFastPromoteDeltaBps,
      borderlineFastPromoteProbDelta: ctx.config.borderlineFastPromoteProbDelta,
      borderlineFastRejectSameDirectionBps:
        ctx.config.borderlineFastRejectSameDirectionBps,
      enableBorderlineMode: ctx.config.enableBorderlineMode,
      allowWeakQualityEntries: ctx.config.allowWeakQualityEntries,
      allowWeakQualityOnlyForStrongSpikes:
        ctx.config.allowWeakQualityOnlyForStrongSpikes,
      allowAcceptableQualityStrongSpikes:
        ctx.config.allowAcceptableQualityStrongSpikes,
      unstableContextMode: ctx.config.unstableContextMode,
      marketMode: ctx.config.marketMode,
      binaryMaxOppositeSideEntryPrice: ctx.config.binaryMaxOppositeSideEntryPrice,
      binaryMaxEntrySidePrice: ctx.config.binaryMaxEntrySidePrice,
      binaryNeutralQuoteBandMin: ctx.config.binaryNeutralQuoteBandMin,
      binaryNeutralQuoteBandMax: ctx.config.binaryNeutralQuoteBandMax,
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
    runtimeStats.observeBorderlineLifecycleRenderEvent(ev);
    if (!isPersistedBorderlineLifecycleEvent(ev)) {
      continue;
    }
    const binaryMeta = buildBinaryQuoteMeta(ctx);
    const tracked = ctx.opportunityTracker.recordBorderlineLifecycleEvent({
      timestamp: now,
      event: ev,
      tradableSpikeMinPercent: ctx.config.tradableSpikeMinPercent,
      maxPriorRangeForNormalEntry: ctx.config.maxPriorRangeForNormalEntry,
      ...(ctx.config.marketMode === "binary"
        ? {
            marketMode: "binary" as const,
            binaryOutcomes: tick.binaryOutcomes,
            ...(binaryMeta !== undefined ? { binaryQuoteMeta: binaryMeta } : {}),
            ...(tick.estimatedProbabilityUp !== undefined &&
            Number.isFinite(tick.estimatedProbabilityUp)
              ? { estimatedProbabilityUp: tick.estimatedProbabilityUp }
              : {}),
            probabilityTimeHorizonMs: ctx.config.probabilityTimeHorizonMs,
          }
        : {}),
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
  if (debugMonitor) {
    for (const msg of pipeline.strongSpikeLifecycleMessages ?? []) {
      logMonitorDebug(msg);
    }
    logMonitorDebug(formatStrategyDecisionLog(pipeline.decision));
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
    marketMode: ctx.config.marketMode,
    binaryOutcomes: tick.binaryOutcomes,
    underlyingSignalPrice: tick.underlyingSignalPrice,
    ...(ctx.config.marketMode === "binary" &&
    tick.estimatedProbabilityUp !== undefined
      ? { estimatedProbabilityUp: tick.estimatedProbabilityUp }
      : {}),
    ...(pipeline.decision.qualityProfile !== undefined
      ? { entryQualityProfile: pipeline.decision.qualityProfile }
      : {}),
    executionBook: tick.executionBook,
    symbol: ctx.tradeSymbol,
    config: {
      takeProfitBps: ctx.config.takeProfitBps,
      stopLossBps: ctx.config.stopLossBps,
      binaryPaperSlippageBps: ctx.config.binaryPaperSlippageBps,
      paperFeeRoundTripBps: ctx.config.paperFeeRoundTripBps,
      exitTimeoutMs: ctx.config.exitTimeoutMs,
      binaryTakeProfitPriceDelta: ctx.config.binaryTakeProfitPriceDelta,
      binaryStopLossPriceDelta: ctx.config.binaryStopLossPriceDelta,
      binaryExitTimeoutMs: ctx.config.binaryExitTimeoutMs,
      binaryMaxEntryPrice: ctx.config.binaryMaxEntryPrice,
      entryCooldownMs: ctx.config.entryCooldownMs,
      stakePerTrade: ctx.config.stakePerTrade,
      allowWeakQualityEntries: ctx.config.allowWeakQualityEntries,
      weakQualitySizeMultiplier: ctx.config.weakQualitySizeMultiplier,
      strongQualitySizeMultiplier: ctx.config.strongQualitySizeMultiplier,
      exceptionalQualitySizeMultiplier:
        ctx.config.exceptionalQualitySizeMultiplier,
      minEdgeThreshold: ctx.config.minEdgeThreshold,
      riskPercentPerTrade: ctx.config.riskPercentPerTrade,
      maxTradeSize: ctx.config.maxTradeSize,
      minTradeSize: ctx.config.minTradeSize,
      probabilityTimeHorizonMs: ctx.config.probabilityTimeHorizonMs,
    },
  });

  const cls = tick.entry.movementClassification;
  const spikeRawEvent =
    tick.entry.spikeDetected === true || enteringImmediate || promoting;
  const candidatePass =
    spikeRawEvent &&
    (cls === "strong_spike" ||
      (cls === "borderline" && ctx.config.enableBorderlineMode) ||
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

  const binaryMetaForOpp = buildBinaryQuoteMeta(ctx);
  const recorded = ctx.opportunityTracker.recordFromReadyTick({
    timestamp: now,
    btcPrice: tick.underlyingSignalPrice,
    underlyingSignalPrice: tick.underlyingSignalPrice,
    prices: tick.prices,
    previousPrice: tick.prev,
    currentPrice: tick.last,
    executionBook: tick.executionBook,
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
    ...(ctx.config.marketMode === "binary"
      ? {
          marketMode: "binary" as const,
          binaryOutcomes: tick.binaryOutcomes,
          ...(binaryMetaForOpp !== undefined
            ? { binaryQuoteMeta: binaryMetaForOpp }
            : {}),
          ...(tick.estimatedProbabilityUp !== undefined &&
          Number.isFinite(tick.estimatedProbabilityUp)
            ? { estimatedProbabilityUp: tick.estimatedProbabilityUp }
            : {}),
          probabilityTimeHorizonMs: ctx.config.probabilityTimeHorizonMs,
        }
      : {}),
  });
  if (recorded !== null) {
    if (recorded.status === "valid") {
      logValidOpportunityBlock(recorded);
    } else {
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

  const pipelineCtx: MonitorLiveLinePipelineContext = {
    decision: pipeline.decision,
    pipelineEntry: paperEntry,
    hasOpenPosition: hadOpenPosition,
  };
  console.log(
    formatMonitorTickLine(
      tick,
      sim,
      MIN_SAMPLES_FOR_STRATEGY,
      tickFmt,
      config.marketMode,
      pipelineCtx
    )
  );

  flushPendingProbabilityCalibration(deps, now);
}
