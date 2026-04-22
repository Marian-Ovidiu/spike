import { describe, expect, it } from "vitest";

import { config as defaultConfig } from "./config.js";
import { evaluateEntryConditions } from "./entryConditions.js";
import {
  buildOpportunityFromReadyTick,
  OpportunityTracker,
} from "./opportunityTracker.js";
import { runStrategyDecisionPipeline } from "./strategy/strategyDecisionPipeline.js";
import { BorderlineCandidateManager } from "./borderlineCandidate.js";
import { SimulationEngine } from "./simulationEngine.js";
import { syntheticExecutableBookFromMid } from "./executionSpreadFilter.js";

const cfg = defaultConfig;

function bookAtMid(mid: number) {
  return syntheticExecutableBookFromMid(mid, 5);
}

function entryAtMid(
  prices: number[],
  prev: number,
  last: number,
  midForBook = last
) {
  const b = bookAtMid(midForBook);
  return evaluateEntryConditions({
    prices,
    rangeThreshold: cfg.rangeThreshold,
    stableRangeSoftToleranceRatio: cfg.stableRangeSoftToleranceRatio,
    strongSpikeHardRejectPoorRange: cfg.strongSpikeHardRejectPoorRange,
    previousPrice: prev,
    currentPrice: last,
    spikeThreshold: cfg.spikeThreshold,
    spikeMinRangeMultiple: cfg.spikeMinRangeMultiple,
    borderlineMinRatio: cfg.borderlineMinRatio,
    tradableSpikeMinPercent: cfg.tradableSpikeMinPercent,
    maxEntrySpreadBps: cfg.maxEntrySpreadBps,
    bestBid: b.bestBid,
    bestAsk: b.bestAsk,
    midPrice: b.midPrice,
    spreadBps: b.spreadBps,
  });
}

function makeStableThenSpikePrices(
  flat: number,
  nFlat: number,
  spikeTo: number
): number[] {
  const out: number[] = [];
  for (let i = 0; i < nFlat; i++) out.push(flat);
  out.push(spikeTo);
  return out;
}

describe("buildOpportunityFromReadyTick", () => {
  it("returns null when raw spike threshold is not exceeded", () => {
    const prices = makeStableThenSpikePrices(100_000, 10, 100_010);
    const prev = 100_000;
    const last = 100_010;
    const entry = entryAtMid(prices, prev, last);
    const executionBook = bookAtMid(last);
    const o = buildOpportunityFromReadyTick({
      timestamp: 0,
      btcPrice: last,
      prices,
      previousPrice: prev,
      currentPrice: last,
      executionBook,
      entry,
      tradableSpikeMinPercent: cfg.tradableSpikeMinPercent,
      maxPriorRangeForNormalEntry: cfg.maxPriorRangeForNormalEntry,
    });
    expect(o).toBeNull();
  });

  it("records valid strong opportunity even when strict range is weak", () => {
    const prices: number[] = [];
    for (let i = 0; i < 10; i++) prices.push(100_000 + i * 500);
    prices.push(106_000);
    const prev = prices[prices.length - 2]!;
    const last = prices[prices.length - 1]!;
    const entry = entryAtMid(prices, prev, last);
    const executionBook = bookAtMid(last);
    const o = buildOpportunityFromReadyTick({
      timestamp: 1,
      btcPrice: last,
      prices,
      previousPrice: prev,
      currentPrice: last,
      executionBook,
      entry,
      tradableSpikeMinPercent: cfg.tradableSpikeMinPercent,
      maxPriorRangeForNormalEntry: cfg.maxPriorRangeForNormalEntry,
    });
    expect(o).not.toBeNull();
    expect(o!.status).toBe("valid");
    // Range quality depends on shared thresholds from loaded config; weak-but-valid cases land on poor or acceptable.
    expect(["poor", "acceptable"] as const).toContain(o!.stableRangeQuality);
    expect(o!.entryRejectionReasons).toEqual([]);
    expect(o!.entryAllowed).toBe(true);
  });

  it("records valid opportunity when gates pass", () => {
    const prev = 100_000;
    const last = 100_700;
    const prices = makeStableThenSpikePrices(prev, 10, last);
    const entry = entryAtMid(prices, prev, last);
    const executionBook = bookAtMid(last);
    const o = buildOpportunityFromReadyTick({
      timestamp: 2,
      btcPrice: last,
      prices,
      previousPrice: prev,
      currentPrice: last,
      executionBook,
      entry,
      tradableSpikeMinPercent: cfg.tradableSpikeMinPercent,
      maxPriorRangeForNormalEntry: cfg.maxPriorRangeForNormalEntry,
    });
    expect(o).not.toBeNull();
    expect(o!.status).toBe("valid");
    expect(o!.opportunityType).toBe("strong_spike");
    expect(o!.opportunityOutcome).toBe("entered_immediate");
    expect(o!.tradableSpikeMinPercent).toBe(cfg.tradableSpikeMinPercent);
    expect(o!.entryAllowed).toBe(true);
    expect(o!.entryRejectionReasons).toEqual([]);
    expect(o!.spikeDirection).toBe("UP");
  });

  it("allows valid opportunity when pipeline only defers confirmation tick", () => {
    const prev = 100_000;
    const last = 100_700;
    const prices = makeStableThenSpikePrices(prev, 10, last);
    const entry = entryAtMid(prices, prev, last);
    const executionBook = bookAtMid(last);
    const o = buildOpportunityFromReadyTick({
      timestamp: 3,
      btcPrice: last,
      prices,
      previousPrice: prev,
      currentPrice: last,
      executionBook,
      entry,
      tradableSpikeMinPercent: cfg.tradableSpikeMinPercent,
      maxPriorRangeForNormalEntry: cfg.maxPriorRangeForNormalEntry,
      decision: {
        action: "none",
        reason: "strong_spike_waiting_confirmation_tick",
      },
    });
    expect(o).not.toBeNull();
    expect(o!.entryAllowed).toBe(true);
    expect(o!.pipelineWatchPathDeferredNonBlocking).toBe(true);
    expect(o!.status).toBe("valid");
    expect(o!.entryRejectionReasons).toEqual([]);
  });
});

describe("OpportunityTracker", () => {
  it("stores opportunities and reports counts", () => {
    const tracker = new OpportunityTracker({ maxStored: 100 });
    const prev = 100_000;
    const last = 100_700;
    const prices = makeStableThenSpikePrices(prev, 10, last);
    const entry = entryAtMid(prices, prev, last);
    const executionBook = bookAtMid(last);
    const o = tracker.recordFromReadyTick({
      timestamp: 0,
      btcPrice: last,
      prices,
      previousPrice: prev,
      currentPrice: last,
      executionBook,
      entry,
      tradableSpikeMinPercent: cfg.tradableSpikeMinPercent,
      maxPriorRangeForNormalEntry: cfg.maxPriorRangeForNormalEntry,
    });
    expect(o?.status).toBe("valid");
    expect(o?.opportunityType).toBe("strong_spike");
    expect(o?.opportunityOutcome).toBe("entered_immediate");
    expect(tracker.getOpportunities()).toHaveLength(1);
    expect(tracker.counts).toEqual({
      rawSpikeEvents: 1,
      valid: 1,
      rejected: 0,
    });
  });

  it("stores normalized rejection reason from final pipeline decision", () => {
    const tracker = new OpportunityTracker({ maxStored: 100 });
    const sim = new SimulationEngine({ silent: true, initialEquity: 10_000 });
    const manager = new BorderlineCandidateManager({ symbol: "BTCUSD", watchTicks: 2 });
    const prev = 100_000;
    const last = 100_700;
    const prices = makeStableThenSpikePrices(prev, 10, last);
    const entry = entryAtMid(prices, prev, last);
    const executionBook = bookAtMid(last);
    sim.onTick({
      marketMode: "spot",
      binaryOutcomes: null,
      now: 1,
      entry,
      entryPath: "strong_spike_immediate",
      executionBook,
      symbol: "BTCUSDT",
      config: {
        takeProfitBps: cfg.takeProfitBps,
        stopLossBps: cfg.stopLossBps,
        binaryPaperSlippageBps: cfg.binaryPaperSlippageBps,
        paperFeeRoundTripBps: cfg.paperFeeRoundTripBps,
        exitTimeoutMs: cfg.exitTimeoutMs,
        binaryTakeProfitPriceDelta: cfg.binaryTakeProfitPriceDelta,
        binaryStopLossPriceDelta: cfg.binaryStopLossPriceDelta,
        binaryExitTimeoutMs: cfg.binaryExitTimeoutMs,
        binaryMaxEntryPrice: cfg.binaryMaxEntryPrice,
        binaryEnableSideSpecificGating: cfg.binaryEnableSideSpecificGating,
        binaryYesMinMispricingThreshold: cfg.binaryYesMinMispricingThreshold,
        binaryNoMinMispricingThreshold: cfg.binaryNoMinMispricingThreshold,
        binaryYesMaxEntryPrice: cfg.binaryYesMaxEntryPrice,
        binaryNoMaxEntryPrice: cfg.binaryNoMaxEntryPrice,
        binaryYesMidExtremeFilterEnabled:
          cfg.binaryYesMidExtremeFilterEnabled,
        binaryYesMidBandMin: cfg.binaryYesMidBandMin,
        binaryYesMidBandMax: cfg.binaryYesMidBandMax,
        binaryHardMaxSpreadBps: cfg.binaryHardMaxSpreadBps,
        entryCooldownMs: 120_000,
        stakePerTrade: cfg.stakePerTrade,
        allowWeakQualityEntries: cfg.allowWeakQualityEntries,
        weakQualitySizeMultiplier: cfg.weakQualitySizeMultiplier,
        strongQualitySizeMultiplier: cfg.strongQualitySizeMultiplier,
        exceptionalQualitySizeMultiplier:
          cfg.exceptionalQualitySizeMultiplier,
        minEdgeThreshold: cfg.minEdgeThreshold,
        riskPercentPerTrade: cfg.riskPercentPerTrade,
        maxTradeSize: cfg.maxTradeSize,
        minTradeSize: cfg.minTradeSize,
        probabilityTimeHorizonMs: cfg.probabilityTimeHorizonMs,
      },
    });
    const pipeline = runStrategyDecisionPipeline({
      now: 1_000,
      tick: {
        kind: "ready",
        btc: last,
        underlyingSignalPrice: last,
        n: prices.length,
        cap: cfg.priceBufferSize,
        prev,
        last,
        prices,
        executionBook,
        entry,
        market: { book: executionBook, feedPossiblyStale: false },
        binaryOutcomes: null,
      },
      manager,
      simulation: sim,
      config: {
        rangeThreshold: cfg.rangeThreshold,
        stableRangeSoftToleranceRatio: cfg.stableRangeSoftToleranceRatio,
        strongSpikeHardRejectPoorRange: cfg.strongSpikeHardRejectPoorRange,
        spikeThreshold: cfg.spikeThreshold,
        tradableSpikeMinPercent: cfg.tradableSpikeMinPercent,
        maxPriorRangeForNormalEntry: cfg.maxPriorRangeForNormalEntry,
        hardRejectPriorRangePercent: cfg.hardRejectPriorRangePercent,
        strongSpikeConfirmationTicks: cfg.strongSpikeConfirmationTicks,
        exceptionalSpikePercent: cfg.exceptionalSpikePercent,
        strongSpikeEarlyEntryExceptionalFraction:
          cfg.strongSpikeEarlyEntryExceptionalFraction,
        exceptionalSpikeOverridesCooldown: cfg.exceptionalSpikeOverridesCooldown,
        maxEntrySpreadBps: cfg.maxEntrySpreadBps,
        entryCooldownMs: cfg.entryCooldownMs,
        borderlineRequirePause: cfg.borderlineRequirePause,
        borderlineRequireNoContinuation: cfg.borderlineRequireNoContinuation,
        borderlineContinuationThreshold: cfg.borderlineContinuationThreshold,
        borderlineReversionThreshold: cfg.borderlineReversionThreshold,
        borderlinePauseBandPercent: cfg.borderlinePauseBandPercent,
        borderlineMaxLifetimeMs: cfg.borderlineMaxLifetimeMs,
        borderlineFastPromoteDeltaBps: cfg.borderlineFastPromoteDeltaBps,
        borderlineFastPromoteProbDelta: cfg.borderlineFastPromoteProbDelta,
        borderlineFastRejectSameDirectionBps: cfg.borderlineFastRejectSameDirectionBps,
        enableBorderlineMode: cfg.enableBorderlineMode,
        allowWeakQualityEntries: cfg.allowWeakQualityEntries,
        allowWeakQualityOnlyForStrongSpikes:
          cfg.allowWeakQualityOnlyForStrongSpikes,
        allowAcceptableQualityStrongSpikes:
          cfg.allowAcceptableQualityStrongSpikes,
        unstableContextMode: cfg.unstableContextMode,
        marketMode: "spot",
        binaryMaxOppositeSideEntryPrice: cfg.binaryMaxOppositeSideEntryPrice,
        binaryMaxEntrySidePrice: cfg.binaryMaxEntrySidePrice,
        binaryNeutralQuoteBandMin: cfg.binaryNeutralQuoteBandMin,
        binaryNeutralQuoteBandMax: cfg.binaryNeutralQuoteBandMax,
      },
    });
    const o = tracker.recordFromReadyTick({
      timestamp: 0,
      btcPrice: last,
      prices,
      previousPrice: prev,
      currentPrice: last,
      executionBook,
      entry,
      tradableSpikeMinPercent: cfg.tradableSpikeMinPercent,
      maxPriorRangeForNormalEntry: cfg.maxPriorRangeForNormalEntry,
      decision: pipeline.decision,
    });
    expect(o?.status).toBe("rejected");
    expect(o?.entryRejectionReasons).toContain("active_position_open");
  });
});
