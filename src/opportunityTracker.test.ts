import { describe, expect, it } from "vitest";

import { config as defaultConfig } from "./config.js";
import {
  evaluateEntryConditions,
} from "./entryConditions.js";
import {
  buildOpportunityFromReadyTick,
  OpportunityTracker,
} from "./opportunityTracker.js";
import { runStrategyDecisionPipeline } from "./strategyDecisionPipeline.js";
import { BorderlineCandidateManager } from "./borderlineCandidate.js";
import { SimulationEngine } from "./simulationEngine.js";

const cfg = defaultConfig;

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
    const entry = evaluateEntryConditions({
      prices,
      rangeThreshold: cfg.rangeThreshold,
      stableRangeSoftToleranceRatio: cfg.stableRangeSoftToleranceRatio,
      strongSpikeHardRejectPoorRange: cfg.strongSpikeHardRejectPoorRange,
      previousPrice: prev,
      currentPrice: last,
      spikeThreshold: cfg.spikeThreshold,
      spikeMinRangeMultiple: cfg.spikeMinRangeMultiple,
      borderlineMinRatio: cfg.borderlineMinRatio,
      entryPrice: cfg.entryPrice,
      maxOppositeSideEntryPrice: cfg.maxOppositeSideEntryPrice,
      neutralQuoteBandMin: cfg.neutralQuoteBandMin,
      neutralQuoteBandMax: cfg.neutralQuoteBandMax,
      upSidePrice: 0.15,
      downSidePrice: 0.15,
    });
    const o = buildOpportunityFromReadyTick({
      timestamp: 0,
      btcPrice: last,
      prices,
      previousPrice: prev,
      currentPrice: last,
      sides: { upSidePrice: 0.15, downSidePrice: 0.15 },
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
    const entry = evaluateEntryConditions({
      prices,
      rangeThreshold: cfg.rangeThreshold,
      stableRangeSoftToleranceRatio: cfg.stableRangeSoftToleranceRatio,
      strongSpikeHardRejectPoorRange: cfg.strongSpikeHardRejectPoorRange,
      previousPrice: prev,
      currentPrice: last,
      spikeThreshold: cfg.spikeThreshold,
      spikeMinRangeMultiple: cfg.spikeMinRangeMultiple,
      borderlineMinRatio: cfg.borderlineMinRatio,
      entryPrice: cfg.entryPrice,
      maxOppositeSideEntryPrice: cfg.maxOppositeSideEntryPrice,
      neutralQuoteBandMin: cfg.neutralQuoteBandMin,
      neutralQuoteBandMax: cfg.neutralQuoteBandMax,
      upSidePrice: 0.15,
      downSidePrice: 0.15,
    });
    const o = buildOpportunityFromReadyTick({
      timestamp: 1,
      btcPrice: last,
      prices,
      previousPrice: prev,
      currentPrice: last,
      sides: { upSidePrice: 0.15, downSidePrice: 0.15 },
      entry,
      tradableSpikeMinPercent: cfg.tradableSpikeMinPercent,
      maxPriorRangeForNormalEntry: cfg.maxPriorRangeForNormalEntry,
    });
    expect(o).not.toBeNull();
    expect(o!.status).toBe("valid");
    expect(o!.stableRangeQuality).toBe("poor");
    expect(o!.entryRejectionReasons).toEqual([]);
    expect(o!.entryAllowed).toBe(true);
  });

  it("records valid opportunity when gates pass and opposite leg is cheap", () => {
    const prev = 100_000;
    const last = 100_700;
    const prices = makeStableThenSpikePrices(prev, 10, last);
    const entry = evaluateEntryConditions({
      prices,
      rangeThreshold: cfg.rangeThreshold,
      stableRangeSoftToleranceRatio: cfg.stableRangeSoftToleranceRatio,
      strongSpikeHardRejectPoorRange: cfg.strongSpikeHardRejectPoorRange,
      previousPrice: prev,
      currentPrice: last,
      spikeThreshold: cfg.spikeThreshold,
      spikeMinRangeMultiple: cfg.spikeMinRangeMultiple,
      borderlineMinRatio: cfg.borderlineMinRatio,
      entryPrice: cfg.entryPrice,
      maxOppositeSideEntryPrice: cfg.maxOppositeSideEntryPrice,
      neutralQuoteBandMin: cfg.neutralQuoteBandMin,
      neutralQuoteBandMax: cfg.neutralQuoteBandMax,
      upSidePrice: 0.5,
      downSidePrice: 0.18,
    });
    const o = buildOpportunityFromReadyTick({
      timestamp: 2,
      btcPrice: last,
      prices,
      previousPrice: prev,
      currentPrice: last,
      sides: { upSidePrice: 0.5, downSidePrice: 0.18 },
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
});

describe("OpportunityTracker", () => {
  it("stores opportunities and reports counts", () => {
    const tracker = new OpportunityTracker({ maxStored: 100 });
    const prev = 100_000;
    const last = 100_700;
    const prices = makeStableThenSpikePrices(prev, 10, last);
    const entry = evaluateEntryConditions({
      prices,
      rangeThreshold: cfg.rangeThreshold,
      stableRangeSoftToleranceRatio: cfg.stableRangeSoftToleranceRatio,
      strongSpikeHardRejectPoorRange: cfg.strongSpikeHardRejectPoorRange,
      previousPrice: prev,
      currentPrice: last,
      spikeThreshold: cfg.spikeThreshold,
      spikeMinRangeMultiple: cfg.spikeMinRangeMultiple,
      borderlineMinRatio: cfg.borderlineMinRatio,
      entryPrice: cfg.entryPrice,
      maxOppositeSideEntryPrice: cfg.maxOppositeSideEntryPrice,
      neutralQuoteBandMin: cfg.neutralQuoteBandMin,
      neutralQuoteBandMax: cfg.neutralQuoteBandMax,
      upSidePrice: 0.5,
      downSidePrice: 0.18,
    });
    const o = tracker.recordFromReadyTick({
      timestamp: 0,
      btcPrice: last,
      prices,
      previousPrice: prev,
      currentPrice: last,
      sides: { upSidePrice: 0.5, downSidePrice: 0.18 },
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
    const entry = evaluateEntryConditions({
      prices,
      rangeThreshold: cfg.rangeThreshold,
      stableRangeSoftToleranceRatio: cfg.stableRangeSoftToleranceRatio,
      strongSpikeHardRejectPoorRange: cfg.strongSpikeHardRejectPoorRange,
      previousPrice: prev,
      currentPrice: last,
      spikeThreshold: cfg.spikeThreshold,
      spikeMinRangeMultiple: cfg.spikeMinRangeMultiple,
      borderlineMinRatio: cfg.borderlineMinRatio,
      entryPrice: cfg.entryPrice,
      maxOppositeSideEntryPrice: cfg.maxOppositeSideEntryPrice,
      neutralQuoteBandMin: cfg.neutralQuoteBandMin,
      neutralQuoteBandMax: cfg.neutralQuoteBandMax,
      upSidePrice: 0.5,
      downSidePrice: 0.18,
    });
    sim.onTick({
      now: 1,
      entry,
      entryPath: "strong_spike_immediate",
      sides: { upSidePrice: 0.5, downSidePrice: 0.18 },
      config: {
        exitPrice: cfg.exitPrice,
        stopLoss: cfg.stopLoss,
        exitTimeoutMs: cfg.exitTimeoutMs,
        entryCooldownMs: 120_000,
        riskPercentPerTrade: cfg.riskPercentPerTrade,
      },
    });
    const pipeline = runStrategyDecisionPipeline({
      now: 1_000,
      tick: {
        kind: "ready",
        btc: last,
        n: prices.length,
        cap: cfg.priceBufferSize,
        prev,
        last,
        prices,
        sides: { upSidePrice: 0.5, downSidePrice: 0.18 },
        entry,
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
        exceptionalSpikeOverridesCooldown: cfg.exceptionalSpikeOverridesCooldown,
        entryPrice: cfg.entryPrice,
      maxOppositeSideEntryPrice: cfg.maxOppositeSideEntryPrice,
      neutralQuoteBandMin: cfg.neutralQuoteBandMin,
      neutralQuoteBandMax: cfg.neutralQuoteBandMax,
        entryCooldownMs: cfg.entryCooldownMs,
        borderlineRequirePause: cfg.borderlineRequirePause,
        borderlineRequireNoContinuation: cfg.borderlineRequireNoContinuation,
        borderlineContinuationThreshold: cfg.borderlineContinuationThreshold,
        borderlineReversionThreshold: cfg.borderlineReversionThreshold,
        borderlinePauseBandPercent: cfg.borderlinePauseBandPercent,
      },
    });
    const o = tracker.recordFromReadyTick({
      timestamp: 0,
      btcPrice: last,
      prices,
      previousPrice: prev,
      currentPrice: last,
      sides: { upSidePrice: 0.5, downSidePrice: 0.18 },
      entry,
      tradableSpikeMinPercent: cfg.tradableSpikeMinPercent,
      maxPriorRangeForNormalEntry: cfg.maxPriorRangeForNormalEntry,
      decision: pipeline.decision,
    });
    expect(o?.status).toBe("rejected");
    expect(o?.entryRejectionReasons).toContain("active_position_open");
  });
});
