import { describe, expect, it, vi } from "vitest";

import { printPeriodicRuntimeSummary, printShutdownReport } from "./monitorConsole.js";
import {
  logReportCounterConsistency,
  MonitorRuntimeStats,
} from "./monitorRuntimeStats.js";
import { SimulationEngine } from "./simulationEngine.js";

describe("MonitorRuntimeStats", () => {
  it("aggregates tick and opportunity counters", () => {
    const s = new MonitorRuntimeStats({ exceptionalSpikePercent: 0.0025 });
    s.observeTick({ kind: "no_btc" });
    s.observeTick({
      kind: "warming",
      btc: 1,
      n: 1,
      cap: 20,
    });
    expect(s.ticksObserved).toBe(2);
    expect(s.btcFetchFailures).toBe(1);

    s.observeTick({
      kind: "ready",
      btc: 1,
      n: 11,
      cap: 20,
      prev: 1,
      last: 1,
      prices: [],
      sides: { upSidePrice: 0.5, downSidePrice: 0.5 },
      entry: {
        shouldEnter: false,
        direction: "UP",
        reasons: ["opposite_side_price_too_high"],
        stableRangeDetected: true,
        priorRangePercent: 0.1,
        stableRangeQuality: "good",
        rangeDecisionNote: "test",
        movementClassification: "strong_spike",
        spikeDetected: true,
        movement: {
          strongestMovePercent: 0.0015,
          strongestMoveAbsolute: 1,
          strongestMoveDirection: "UP",
          thresholdPercent: 0.001,
          thresholdRatio: 1.5,
          classification: "strong_spike",
          sourceWindowLabel: "tick-1",
        },
        windowSpike: {
          classification: "strong_spike",
          strongestMovePercent: 0.0015,
          strongestMoveAbsolute: 1,
          strongestMoveDirection: "UP",
          thresholdPercent: 0.001,
          thresholdRatio: 1.5,
          sourceWindowLabel: "tick-1",
          borderlineMinRatio: 0.85,
          detected: true,
          currentPrice: 100,
          strongestMove: 0.0015,
          strongestAbsDelta: 1,
          referencePrice: 99,
          source: "tick-1",
          direction: "up",
          comparisons: [],
        },
      },
    });
    expect(s.strongSpikeSignals).toBe(1);
    expect(s.strongSpikeCount).toBe(1);

    s.observeTick({
      kind: "ready",
      btc: 1,
      n: 11,
      cap: 20,
      prev: 1,
      last: 1,
      prices: [],
      sides: { upSidePrice: 0.5, downSidePrice: 0.5 },
      entry: {
        shouldEnter: false,
        direction: null,
        reasons: ["spike_not_strong_enough"],
        stableRangeDetected: true,
        priorRangePercent: 0.1,
        stableRangeQuality: "good",
        rangeDecisionNote: "test",
        movementClassification: "borderline",
        spikeDetected: false,
        movement: {
          strongestMovePercent: 0.0009,
          strongestMoveAbsolute: 1,
          strongestMoveDirection: "UP",
          thresholdPercent: 0.001,
          thresholdRatio: 0.9,
          classification: "borderline",
          sourceWindowLabel: "tick-1",
        },
        windowSpike: undefined,
      },
    });
    s.observeTick({
      kind: "ready",
      btc: 1,
      n: 11,
      cap: 20,
      prev: 1,
      last: 1,
      prices: [],
      sides: { upSidePrice: 0.5, downSidePrice: 0.5 },
      entry: {
        shouldEnter: false,
        direction: null,
        reasons: ["spike_not_strong_enough"],
        stableRangeDetected: true,
        priorRangePercent: 0.1,
        stableRangeQuality: "good",
        rangeDecisionNote: "test",
        movementClassification: "no_signal",
        spikeDetected: false,
        movement: {
          strongestMovePercent: 0.0001,
          strongestMoveAbsolute: 1,
          strongestMoveDirection: "UP",
          thresholdPercent: 0.001,
          thresholdRatio: 0.1,
          classification: "no_signal",
          sourceWindowLabel: "tick-1",
        },
        windowSpike: undefined,
      },
    });
    expect(s.borderlineCount).toBe(1);
    expect(s.noSignalCount).toBe(1);

    s.observeReadyTickFunnel({
      spikeRawEvent: true,
      candidatePass: true,
      validEntryApproved: true,
      positionOpenedThisTick: false,
    });
    s.observeOpportunityRecord({
      timestamp: 0,
      btcPrice: 1,
      previousPrice: 1,
      currentPrice: 1.1,
      spikeDirection: "UP",
      spikePercent: 1,
      spikeSource: "tick-1",
      spikeReferencePrice: 1,
      priorRangePercent: 0.1,
      upSidePrice: 0.5,
      downSidePrice: 0.5,
      stableRangeDetected: true,
      stableRangeQuality: "good",
      spikeDetected: true,
      movementClassification: "strong_spike",
      movement: {
        strongestMovePercent: 0.01,
        strongestMoveAbsolute: 0.1,
        strongestMoveDirection: "UP",
        thresholdPercent: 0.005,
        thresholdRatio: 2,
        classification: "strong_spike",
        sourceWindowLabel: "tick-1",
      },
      movementThresholdRatio: 1.2,
      tradableSpikeMinPercent: 0.0015,
      qualityProfile: "strong",
      cooldownOverridden: true,
      overrideReason: "exceptional_spike_cooldown_override",
      opportunityType: "strong_spike",
      opportunityOutcome: "entered_immediate",
      entryAllowed: true,
      entryRejectionReasons: [],
      status: "valid",
    });
    expect(s.spikeEventsDetected).toBe(1);
    expect(s.validOpportunities).toBe(1);
    expect(s.rejectedOpportunities).toBe(0);
    expect(s.cooldownOverridesUsed).toBe(1);
    expect(s.exceptionalSpikeEntries).toBe(0);
    expect(s.candidateOpportunities).toBe(1);
    expect(s.tradesExecuted).toBe(0);

    s.observeBorderlineLifecycleEventType("created");
    s.observeBorderlineLifecycleEventType("promoted");
    expect(s.borderlineCandidatesCreated).toBe(1);
    expect(s.borderlinePromotions).toBe(1);

    s.observeClosedTrade({ entryPath: "borderline_delayed", profitLoss: 0.2 });
    s.observeClosedTrade({ entryPath: "strong_spike_immediate", profitLoss: -0.1 });
    expect(s.borderlineTradesClosed).toBe(1);
    expect(s.borderlineWins).toBe(1);
    expect(s.borderlineAveragePnL).toBeCloseTo(0.2, 6);
    expect(s.strongSpikeTradesClosed).toBe(1);
    expect(s.strongSpikeLosses).toBe(1);
    expect(s.strongSpikeAveragePnL).toBeCloseTo(-0.1, 6);

    s.observeReadyTickFunnel({
      spikeRawEvent: true,
      candidatePass: true,
      validEntryApproved: false,
      positionOpenedThisTick: false,
    });
    s.observeOpportunityRecord({
      timestamp: 0,
      btcPrice: 1,
      previousPrice: 1,
      currentPrice: 1.1,
      spikeDirection: "UP",
      spikePercent: 1,
      spikeSource: "tick-1",
      spikeReferencePrice: 1,
      priorRangePercent: 0.2,
      upSidePrice: 0.5,
      downSidePrice: 0.5,
      stableRangeDetected: true,
      stableRangeQuality: "good",
      spikeDetected: true,
      movementClassification: "strong_spike",
      movement: {
        strongestMovePercent: 0.01,
        strongestMoveAbsolute: 0.1,
        strongestMoveDirection: "UP",
        thresholdPercent: 0.005,
        thresholdRatio: 2,
        classification: "strong_spike",
        sourceWindowLabel: "tick-1",
      },
      movementThresholdRatio: 2,
      tradableSpikeMinPercent: 0.0015,
      qualityProfile: "weak",
      cooldownOverridden: false,
      overrideReason: null,
      opportunityType: "strong_spike",
      opportunityOutcome: "rejected",
      entryAllowed: false,
      entryRejectionReasons: [
        "prior_range_too_wide_for_mean_reversion",
        "quality_gate_rejected",
      ],
      status: "rejected",
    });
    expect(s.blockedByWidePriorRange).toBe(1);
    expect(s.rejectedByPriorRangeTooWide).toBe(1);
    expect(s.rejectedByWeakSpikeQuality).toBe(1);

    s.observeReadyTickFunnel({
      spikeRawEvent: true,
      candidatePass: true,
      validEntryApproved: false,
      positionOpenedThisTick: false,
    });
    s.observeOpportunityRecord({
      timestamp: 0,
      btcPrice: 1,
      previousPrice: 1,
      currentPrice: 1.1,
      spikeDirection: "UP",
      spikePercent: 1,
      spikeSource: "tick-1",
      spikeReferencePrice: 1,
      priorRangePercent: 0.21,
      upSidePrice: 0.5,
      downSidePrice: 0.5,
      stableRangeDetected: false,
      stableRangeQuality: "poor",
      spikeDetected: true,
      movementClassification: "strong_spike",
      movement: {
        strongestMovePercent: 0.01,
        strongestMoveAbsolute: 0.1,
        strongestMoveDirection: "UP",
        thresholdPercent: 0.005,
        thresholdRatio: 2,
        classification: "strong_spike",
        sourceWindowLabel: "tick-1",
      },
      movementThresholdRatio: 2,
      tradableSpikeMinPercent: 0.0015,
      qualityProfile: "weak",
      cooldownOverridden: false,
      overrideReason: null,
      opportunityType: "strong_spike",
      opportunityOutcome: "rejected",
      entryAllowed: false,
      entryRejectionReasons: ["hard_reject_unstable_pre_spike_context"],
      status: "rejected",
    });
    expect(s.blockedByHardRejectUnstableContext).toBe(1);
    expect(s.rejectedByHardUnstableContext).toBe(1);

    s.observeReadyTickFunnel({
      spikeRawEvent: true,
      candidatePass: true,
      validEntryApproved: false,
      positionOpenedThisTick: false,
    });
    s.observeOpportunityRecord({
      timestamp: 0,
      btcPrice: 1,
      previousPrice: 1,
      currentPrice: 1.1,
      spikeDirection: "UP",
      spikePercent: 1,
      spikeSource: "tick-1",
      spikeReferencePrice: 1,
      priorRangePercent: 0.21,
      upSidePrice: 0.5,
      downSidePrice: 0.5,
      stableRangeDetected: false,
      stableRangeQuality: "poor",
      spikeDetected: true,
      movementClassification: "strong_spike",
      movement: {
        strongestMovePercent: 0.01,
        strongestMoveAbsolute: 0.1,
        strongestMoveDirection: "UP",
        thresholdPercent: 0.005,
        thresholdRatio: 2,
        classification: "strong_spike",
        sourceWindowLabel: "tick-1",
      },
      movementThresholdRatio: 2,
      tradableSpikeMinPercent: 0.0015,
      qualityProfile: "weak",
      cooldownOverridden: false,
      overrideReason: null,
      opportunityType: "strong_spike",
      opportunityOutcome: "rejected",
      entryAllowed: false,
      entryRejectionReasons: [
        "strong_spike_continuation",
        "borderline_cancelled_continuation",
        "opposite_side_price_too_high",
      ],
      status: "rejected",
    });
    expect(s.rejectedByStrongSpikeContinuation).toBe(1);
    expect(s.rejectedByBorderlineContinuation).toBe(1);
    expect(s.rejectedByExpensiveOppositeSide).toBe(1);

    expect(s.spikeEventsDetected).toBe(4);
    expect(s.candidateOpportunities).toBe(4);
    expect(s.validOpportunities).toBe(1);
    expect(s.rejectedOpportunities).toBe(3);
    logReportCounterConsistency(s);
  });

  it("logReportCounterConsistency logs when trades exceed valid", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    logReportCounterConsistency({
      tradesExecuted: 2,
      validOpportunities: 1,
      candidateOpportunities: 3,
      spikeEventsDetected: 5,
    });
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
});

describe("monitorConsole periodic / shutdown", () => {
  it("printPeriodicRuntimeSummary logs", () => {
    const s = new MonitorRuntimeStats({ exceptionalSpikePercent: 0.0025 });
    const sim = new SimulationEngine({ silent: true, initialEquity: 1000 });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    printPeriodicRuntimeSummary(
      "test",
      {
        ticksObserved: s.ticksObserved,
        btcFetchFailures: s.btcFetchFailures,
        spikeEventsDetected: s.spikeEventsDetected,
        candidateOpportunities: s.candidateOpportunities,
        validOpportunities: s.validOpportunities,
        rejectedOpportunities: s.rejectedOpportunities,
        tradesExecuted: s.tradesExecuted,
      },
      sim
    );
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });

  it("printShutdownReport logs final report", () => {
    const sim = new SimulationEngine({ silent: true, initialEquity: 1000 });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const t0 = Date.now() - 5000;
    printShutdownReport(
      t0,
      {
        ticksObserved: 3,
        spikeEventsDetected: 2,
        candidateOpportunities: 2,
        validOpportunities: 1,
        rejectedOpportunities: 0,
        tradesExecuted: 1,
      },
      sim.getPerformanceStats()
    );
    const combined = log.mock.calls.map((c) => String(c[0])).join("\n");
    expect(combined).toContain("final report");
    log.mockRestore();
  });
});
