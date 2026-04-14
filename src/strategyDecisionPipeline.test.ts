import { describe, expect, it } from "vitest";
import { SimulationEngine } from "./simulationEngine.js";
import { BorderlineCandidateManager } from "./borderlineCandidate.js";
import { StrongSpikeCandidateStore } from "./strongSpikeCandidateStore.js";
import type { StrategyTickResult } from "./botLoop.js";
import type { EntryEvaluation } from "./entryConditions.js";
import { runStrategyDecisionPipeline } from "./strategyDecisionPipeline.js";

function readyTick(
  entry: EntryEvaluation
): Extract<StrategyTickResult, { kind: "ready" }> {
  const normalizedEntry: EntryEvaluation = {
    stableRangeDetected: true,
    priorRangePercent: 0.0005,
    stableRangeQuality: "good",
    rangeDecisionNote: "test",
    movementClassification: "no_signal",
    spikeDetected: false,
    movement: {
      strongestMovePercent: 0,
      strongestMoveAbsolute: 0,
      strongestMoveDirection: null,
      thresholdPercent: 0.001,
      thresholdRatio: 0,
      classification: "no_signal",
      sourceWindowLabel: null,
    },
    ...entry,
  };
  return {
    kind: "ready",
    btc: 100_000,
    n: 12,
    cap: 20,
    prev: 100_000,
    last: 100_050,
    prices: [99_980, 99_990, 100_000, 100_050],
    sides: { upSidePrice: 0.2, downSidePrice: 0.2 },
    entry: normalizedEntry,
  };
}

const pipelineConfig = {
  rangeThreshold: 0.02,
  stableRangeSoftToleranceRatio: 1.5,
  strongSpikeHardRejectPoorRange: false,
  spikeThreshold: 0.001,
  tradableSpikeMinPercent: 0.0015,
  maxPriorRangeForNormalEntry: 0.0015,
  hardRejectPriorRangePercent: 0.002,
  strongSpikeConfirmationTicks: 1,
  exceptionalSpikePercent: 0.0025,
  exceptionalSpikeOverridesCooldown: true,
  entryPrice: 0.25,
  maxOppositeSideEntryPrice: 0.35,
  neutralQuoteBandMin: 0.45,
  neutralQuoteBandMax: 0.55,
  entryCooldownMs: 0,
  borderlineRequirePause: true,
  borderlineRequireNoContinuation: true,
  borderlineContinuationThreshold: 0.25,
  borderlineReversionThreshold: 0.2,
  borderlinePauseBandPercent: 0.00015,
} as const;

describe("strategyDecisionPipeline", () => {
  it("creates strong candidate and waits one confirmation tick", () => {
    const sim = new SimulationEngine({ silent: true, initialEquity: 10_000 });
    const manager = new BorderlineCandidateManager({
      symbol: "BTCUSD",
      watchTicks: 2,
    });
    const strongSpikeManager = new StrongSpikeCandidateStore({
      symbol: "BTCUSD",
      watchTicks: 1,
    });
    const entry: EntryEvaluation = {
      shouldEnter: true,
      direction: "DOWN",
      reasons: [],
      movementClassification: "strong_spike",
      spikeDetected: true,
      stableRangeDetected: true,
      priorRangePercent: 0.0004,
      stableRangeQuality: "good",
      rangeDecisionNote: "test",
      movement: {
        strongestMovePercent: 0.0016,
        strongestMoveAbsolute: 160,
        strongestMoveDirection: "UP",
        thresholdPercent: 0.001,
        thresholdRatio: 1.6,
        classification: "strong_spike",
        sourceWindowLabel: "tick-1",
      },
      windowSpike: {
        classification: "strong_spike",
        strongestMovePercent: 0.0016,
        strongestMoveAbsolute: 160,
        strongestMoveDirection: "UP",
        thresholdPercent: 0.001,
        thresholdRatio: 1.6,
        sourceWindowLabel: "tick-1",
        borderlineMinRatio: 0.85,
        detected: true,
        currentPrice: 100_160,
        strongestMove: 0.0016,
        strongestAbsDelta: 160,
        referencePrice: 100_000,
        source: "tick-1",
        direction: "up",
        comparisons: [],
      },
    };
    const result = runStrategyDecisionPipeline({
      now: 1_000,
      tick: readyTick(entry),
      manager,
      strongSpikeManager,
      simulation: sim,
      config: pipelineConfig,
    });
    expect(result.decision.action).toBe("none");
    expect(result.decision.reason).toBe("strong_spike_waiting_confirmation_tick");
    expect(result.decision.qualityGatePassed).toBe(false);
    expect(result.decision.qualityProfile).toBe("strong");
    expect((result.strongSpikeLifecycleMessages ?? []).join(" ")).toContain("detected");
  });

  it("blocks strong spike when quality gate profile is only acceptable", () => {
    const sim = new SimulationEngine({ silent: true, initialEquity: 10_000 });
    const manager = new BorderlineCandidateManager({
      symbol: "BTCUSD",
      watchTicks: 2,
    });
    const entry: EntryEvaluation = {
      shouldEnter: true,
      direction: "DOWN",
      reasons: [],
      movementClassification: "strong_spike",
      spikeDetected: true,
      stableRangeDetected: true,
      priorRangePercent: 0.0004,
      stableRangeQuality: "good",
      rangeDecisionNote: "test",
      movement: {
        strongestMovePercent: 0.00105,
        strongestMoveAbsolute: 105,
        strongestMoveDirection: "UP",
        thresholdPercent: 0.001,
        thresholdRatio: 1.05,
        classification: "strong_spike",
        sourceWindowLabel: "tick-1",
      },
      windowSpike: {
        classification: "strong_spike",
        strongestMovePercent: 0.00105,
        strongestMoveAbsolute: 105,
        strongestMoveDirection: "UP",
        thresholdPercent: 0.001,
        thresholdRatio: 1.05,
        sourceWindowLabel: "tick-1",
        borderlineMinRatio: 0.85,
        detected: true,
        currentPrice: 100_105,
        strongestMove: 0.00105,
        strongestAbsDelta: 105,
        referencePrice: 100_000,
        source: "tick-1",
        direction: "up",
        comparisons: [],
      },
    };
    const result = runStrategyDecisionPipeline({
      now: 1_000,
      tick: readyTick(entry),
      manager,
      simulation: sim,
      config: pipelineConfig,
    });
    expect(result.decision.action).toBe("none");
    expect(result.decision.criticalBlockerUsed).toBe("quality_gate_rejected");
    expect(result.decision.reason).toBe("quality_gate_rejected");
    expect(result.decision.qualityGatePassed).toBe(false);
    expect(result.decision.qualityProfile).toBe("weak");
    expect(result.decision.reasons).toContain("quality_gate_rejected");
  });

  it("does not allow immediate entry for 0.10%-0.1499% move band", () => {
    const sim = new SimulationEngine({ silent: true, initialEquity: 10_000 });
    const manager = new BorderlineCandidateManager({
      symbol: "BTCUSD",
      watchTicks: 2,
    });
    const entry: EntryEvaluation = {
      shouldEnter: true,
      direction: "DOWN",
      reasons: [],
      movementClassification: "strong_spike",
      spikeDetected: true,
      stableRangeDetected: true,
      priorRangePercent: 0.0004,
      stableRangeQuality: "good",
      rangeDecisionNote: "test",
      movement: {
        strongestMovePercent: 0.001499,
        strongestMoveAbsolute: 149.9,
        strongestMoveDirection: "UP",
        thresholdPercent: 0.001,
        thresholdRatio: 1.499,
        classification: "strong_spike",
        sourceWindowLabel: "tick-1",
      },
      windowSpike: {
        classification: "strong_spike",
        strongestMovePercent: 0.001499,
        strongestMoveAbsolute: 149.9,
        strongestMoveDirection: "UP",
        thresholdPercent: 0.001,
        thresholdRatio: 1.499,
        sourceWindowLabel: "tick-1",
        borderlineMinRatio: 0.85,
        detected: true,
        currentPrice: 100_149.9,
        strongestMove: 0.001499,
        strongestAbsDelta: 149.9,
        referencePrice: 100_000,
        source: "tick-1",
        direction: "up",
        comparisons: [],
      },
    };
    const result = runStrategyDecisionPipeline({
      now: 1_000,
      tick: readyTick(entry),
      manager,
      simulation: sim,
      config: pipelineConfig,
    });
    expect(result.decision.action).toBe("none");
    expect(result.decision.qualityGatePassed).toBe(false);
    expect(result.decision.qualityProfile).toBe("weak");
  });

  it("promotes strong spike after 1 tick when pause/reversion is confirmed", () => {
    const sim = new SimulationEngine({ silent: true, initialEquity: 10_000 });
    const manager = new BorderlineCandidateManager({
      symbol: "BTCUSD",
      watchTicks: 2,
    });
    const strongSpikeManager = new StrongSpikeCandidateStore({
      symbol: "BTCUSD",
      watchTicks: 1,
    });
    const entry: EntryEvaluation = {
      shouldEnter: true,
      direction: "DOWN",
      reasons: [],
      movementClassification: "strong_spike",
      spikeDetected: true,
      stableRangeDetected: true,
      priorRangePercent: 0.0004,
      stableRangeQuality: "good",
      rangeDecisionNote: "test",
      movement: {
        strongestMovePercent: 0.0015,
        strongestMoveAbsolute: 150,
        strongestMoveDirection: "UP",
        thresholdPercent: 0.001,
        thresholdRatio: 1.5,
        classification: "strong_spike",
        sourceWindowLabel: "tick-1",
      },
      windowSpike: {
        classification: "strong_spike",
        strongestMovePercent: 0.0015,
        strongestMoveAbsolute: 150,
        strongestMoveDirection: "UP",
        thresholdPercent: 0.001,
        thresholdRatio: 1.5,
        sourceWindowLabel: "tick-1",
        borderlineMinRatio: 0.85,
        detected: true,
        currentPrice: 100_150,
        strongestMove: 0.0015,
        strongestAbsDelta: 150,
        referencePrice: 100_000,
        source: "tick-1",
        direction: "up",
        comparisons: [],
      },
    };
    const first = runStrategyDecisionPipeline({
      now: 1_000,
      tick: readyTick(entry),
      manager,
      strongSpikeManager,
      simulation: sim,
      config: pipelineConfig,
    });
    expect(first.decision.action).toBe("none");
    expect(first.decision.reason).toBe("strong_spike_waiting_confirmation_tick");

    const confirmTick = readyTick({
      ...entry,
      shouldEnter: false,
      direction: null,
      movementClassification: "no_signal",
      spikeDetected: false,
      reasons: ["spike_not_strong_enough"],
      movement: {
        ...entry.movement,
        strongestMovePercent: 0.0002,
        thresholdRatio: 0.2,
        classification: "no_signal",
      },
      windowSpike: {
        ...entry.windowSpike!,
        classification: "no_signal",
        strongestMovePercent: 0.0002,
        thresholdRatio: 0.2,
        detected: false,
      },
    });
    const result = runStrategyDecisionPipeline({
      now: 2_000,
      tick: confirmTick,
      manager,
      strongSpikeManager,
      simulation: sim,
      config: pipelineConfig,
    });
    expect(result.decision.action).toBe("enter_immediate");
    expect(result.decision.reason).toContain("strong_spike_confirmed");
    expect(result.decision.direction).toBe("DOWN");
  });

  it("rejects strong spike when priorRangePercent is wider than strict max", () => {
    const sim = new SimulationEngine({ silent: true, initialEquity: 10_000 });
    const manager = new BorderlineCandidateManager({
      symbol: "BTCUSD",
      watchTicks: 2,
    });
    const entry: EntryEvaluation = {
      shouldEnter: true,
      direction: "DOWN",
      reasons: [],
      movementClassification: "strong_spike",
      spikeDetected: true,
      stableRangeDetected: true,
      priorRangePercent: 0.0016,
      stableRangeQuality: "good",
      rangeDecisionNote: "test",
      movement: {
        strongestMovePercent: 0.002,
        strongestMoveAbsolute: 200,
        strongestMoveDirection: "UP",
        thresholdPercent: 0.001,
        thresholdRatio: 2,
        classification: "strong_spike",
        sourceWindowLabel: "tick-1",
      },
      windowSpike: {
        classification: "strong_spike",
        strongestMovePercent: 0.002,
        strongestMoveAbsolute: 200,
        strongestMoveDirection: "UP",
        thresholdPercent: 0.001,
        thresholdRatio: 2,
        sourceWindowLabel: "tick-1",
        borderlineMinRatio: 0.85,
        detected: true,
        currentPrice: 100_200,
        strongestMove: 0.002,
        strongestAbsDelta: 200,
        referencePrice: 100_000,
        source: "tick-1",
        direction: "up",
        comparisons: [],
      },
    };
    const result = runStrategyDecisionPipeline({
      now: 1_000,
      tick: readyTick(entry),
      manager,
      simulation: sim,
      config: pipelineConfig,
    });
    expect(result.decision.action).toBe("none");
    expect(result.decision.qualityGatePassed).toBe(false);
    expect(result.decision.reasons).toContain(
      "prior_range_too_wide_for_mean_reversion"
    );
  });

  it("applies hard reject when stable range is false and prior range is above 0.20%", () => {
    const sim = new SimulationEngine({ silent: true, initialEquity: 10_000 });
    const manager = new BorderlineCandidateManager({ symbol: "BTCUSD", watchTicks: 2 });
    const entry: EntryEvaluation = {
      shouldEnter: true,
      direction: "DOWN",
      reasons: [],
      movementClassification: "strong_spike",
      spikeDetected: true,
      stableRangeDetected: false,
      priorRangePercent: 0.0021,
      stableRangeQuality: "poor",
      rangeDecisionNote: "test",
      movement: {
        strongestMovePercent: 0.0023,
        strongestMoveAbsolute: 230,
        strongestMoveDirection: "UP",
        thresholdPercent: 0.001,
        thresholdRatio: 2.3,
        classification: "strong_spike",
        sourceWindowLabel: "tick-1",
      },
      windowSpike: {
        classification: "strong_spike",
        strongestMovePercent: 0.0023,
        strongestMoveAbsolute: 230,
        strongestMoveDirection: "UP",
        thresholdPercent: 0.001,
        thresholdRatio: 2.3,
        sourceWindowLabel: "tick-1",
        borderlineMinRatio: 0.85,
        detected: true,
        currentPrice: 100_230,
        strongestMove: 0.0023,
        strongestAbsDelta: 230,
        referencePrice: 100_000,
        source: "tick-1",
        direction: "up",
        comparisons: [],
      },
    };
    const result = runStrategyDecisionPipeline({
      now: 1_000,
      tick: readyTick(entry),
      manager,
      simulation: sim,
      config: pipelineConfig,
    });
    expect(result.decision.action).toBe("none");
    expect(result.decision.hardRejectApplied).toBe(true);
    expect(result.decision.hardRejectReason).toBe(
      "hard_reject_unstable_pre_spike_context"
    );
    expect(result.decision.reasons).toContain("hard_reject_unstable_pre_spike_context");
  });

  it("does not hard reject only because prior range is above 0.20% when stable range is true", () => {
    const sim = new SimulationEngine({ silent: true, initialEquity: 10_000 });
    const manager = new BorderlineCandidateManager({ symbol: "BTCUSD", watchTicks: 2 });
    const entry: EntryEvaluation = {
      shouldEnter: true,
      direction: "DOWN",
      reasons: [],
      movementClassification: "strong_spike",
      spikeDetected: true,
      stableRangeDetected: true,
      priorRangePercent: 0.0021,
      stableRangeQuality: "good",
      rangeDecisionNote: "test",
      movement: {
        strongestMovePercent: 0.0023,
        strongestMoveAbsolute: 230,
        strongestMoveDirection: "UP",
        thresholdPercent: 0.001,
        thresholdRatio: 2.3,
        classification: "strong_spike",
        sourceWindowLabel: "tick-1",
      },
      windowSpike: {
        classification: "strong_spike",
        strongestMovePercent: 0.0023,
        strongestMoveAbsolute: 230,
        strongestMoveDirection: "UP",
        thresholdPercent: 0.001,
        thresholdRatio: 2.3,
        sourceWindowLabel: "tick-1",
        borderlineMinRatio: 0.85,
        detected: true,
        currentPrice: 100_230,
        strongestMove: 0.0023,
        strongestAbsDelta: 230,
        referencePrice: 100_000,
        source: "tick-1",
        direction: "up",
        comparisons: [],
      },
    };
    const result = runStrategyDecisionPipeline({
      now: 1_000,
      tick: readyTick(entry),
      manager,
      simulation: sim,
      config: pipelineConfig,
    });
    expect(result.decision.hardRejectApplied).toBe(false);
    expect(result.decision.reasons).not.toContain("hard_reject_unstable_pre_spike_context");
  });

  it("does not hard reject when unstable but prior range is below 0.20%", () => {
    const sim = new SimulationEngine({ silent: true, initialEquity: 10_000 });
    const manager = new BorderlineCandidateManager({ symbol: "BTCUSD", watchTicks: 2 });
    const entry: EntryEvaluation = {
      shouldEnter: true,
      direction: "DOWN",
      reasons: [],
      movementClassification: "strong_spike",
      spikeDetected: true,
      stableRangeDetected: false,
      priorRangePercent: 0.0018,
      stableRangeQuality: "poor",
      rangeDecisionNote: "test",
      movement: {
        strongestMovePercent: 0.0023,
        strongestMoveAbsolute: 230,
        strongestMoveDirection: "UP",
        thresholdPercent: 0.001,
        thresholdRatio: 2.3,
        classification: "strong_spike",
        sourceWindowLabel: "tick-1",
      },
      windowSpike: {
        classification: "strong_spike",
        strongestMovePercent: 0.0023,
        strongestMoveAbsolute: 230,
        strongestMoveDirection: "UP",
        thresholdPercent: 0.001,
        thresholdRatio: 2.3,
        sourceWindowLabel: "tick-1",
        borderlineMinRatio: 0.85,
        detected: true,
        currentPrice: 100_230,
        strongestMove: 0.0023,
        strongestAbsDelta: 230,
        referencePrice: 100_000,
        source: "tick-1",
        direction: "up",
        comparisons: [],
      },
    };
    const result = runStrategyDecisionPipeline({
      now: 1_000,
      tick: readyTick(entry),
      manager,
      simulation: sim,
      config: pipelineConfig,
    });
    expect(result.decision.hardRejectApplied).toBe(false);
    expect(result.decision.reasons).not.toContain("hard_reject_unstable_pre_spike_context");
  });

  it("emits create_borderline_candidate for borderline move", () => {
    const sim = new SimulationEngine({ silent: true, initialEquity: 10_000 });
    const manager = new BorderlineCandidateManager({
      symbol: "BTCUSD",
      watchTicks: 2,
    });
    const entry: EntryEvaluation = {
      shouldEnter: false,
      direction: null,
      reasons: ["spike_not_strong_enough"],
      movementClassification: "borderline",
      spikeDetected: false,
      stableRangeDetected: true,
      priorRangePercent: 0.0008,
      stableRangeQuality: "good",
      rangeDecisionNote: "test",
      movement: {
        strongestMovePercent: 0.00093,
        strongestMoveAbsolute: 93,
        strongestMoveDirection: "UP",
        thresholdPercent: 0.001,
        thresholdRatio: 0.93,
        classification: "borderline",
        sourceWindowLabel: "tick-1",
      },
      windowSpike: {
        classification: "borderline",
        strongestMovePercent: 0.00093,
        strongestMoveAbsolute: 93,
        strongestMoveDirection: "UP",
        thresholdPercent: 0.001,
        thresholdRatio: 0.93,
        sourceWindowLabel: "tick-1",
        borderlineMinRatio: 0.85,
        detected: false,
        currentPrice: 100_093,
        strongestMove: 0.00093,
        strongestAbsDelta: 93,
        referencePrice: 100_000,
        source: "tick-1",
        direction: "up",
        comparisons: [],
      },
    };
    const result = runStrategyDecisionPipeline({
      now: 1_000,
      tick: readyTick(entry),
      manager,
      simulation: sim,
      config: pipelineConfig,
    });
    expect(result.decision.action).toBe("create_borderline_candidate");
    expect(result.decision.borderlineCandidateId).toBeDefined();
    expect(result.decision.reasons).toEqual(["borderline_watch_pending"]);
    expect(
      result.borderlineLifecycleEvents.some((e) => e.type === "created")
    ).toBe(true);
  });

  it("emits cancel for non-ready tick with active candidate", () => {
    const sim = new SimulationEngine({ silent: true, initialEquity: 10_000 });
    const manager = new BorderlineCandidateManager({
      symbol: "BTCUSD",
      watchTicks: 2,
    });
    const borderlineEntry: EntryEvaluation = {
      shouldEnter: false,
      direction: null,
      reasons: ["spike_not_strong_enough"],
      movementClassification: "borderline",
      spikeDetected: false,
      stableRangeDetected: true,
      priorRangePercent: 0.0008,
      stableRangeQuality: "good",
      rangeDecisionNote: "test",
      movement: {
        strongestMovePercent: 0.0009,
        strongestMoveAbsolute: 90,
        strongestMoveDirection: "UP",
        thresholdPercent: 0.001,
        thresholdRatio: 0.9,
        classification: "borderline",
        sourceWindowLabel: "tick-1",
      },
      windowSpike: {
        classification: "borderline",
        strongestMovePercent: 0.0009,
        strongestMoveAbsolute: 90,
        strongestMoveDirection: "UP",
        thresholdPercent: 0.001,
        thresholdRatio: 0.9,
        sourceWindowLabel: "tick-1",
        borderlineMinRatio: 0.85,
        detected: false,
        currentPrice: 100_090,
        strongestMove: 0.0009,
        strongestAbsDelta: 90,
        referencePrice: 100_000,
        source: "tick-1",
        direction: "up",
        comparisons: [],
      },
    };
    runStrategyDecisionPipeline({
      now: 1_000,
      tick: readyTick(borderlineEntry),
      manager,
      simulation: sim,
      config: pipelineConfig,
    });

    const result = runStrategyDecisionPipeline({
      now: 2_000,
      tick: { kind: "no_btc" },
      manager,
      simulation: sim,
      config: pipelineConfig,
    });
    expect(result.decision.action).toBe("cancel_borderline_candidate");
  });

  it("creates borderline candidate and does not emit immediate entry", () => {
    const sim = new SimulationEngine({ silent: true, initialEquity: 10_000 });
    const manager = new BorderlineCandidateManager({
      symbol: "BTCUSD",
      watchTicks: 2,
    });
    const entry: EntryEvaluation = {
      shouldEnter: false,
      direction: null,
      reasons: ["spike_not_strong_enough"],
      movementClassification: "borderline",
      spikeDetected: false,
      stableRangeDetected: true,
      priorRangePercent: 0.0008,
      stableRangeQuality: "good",
      rangeDecisionNote: "test",
      movement: {
        strongestMovePercent: 0.0009,
        strongestMoveAbsolute: 90,
        strongestMoveDirection: "UP",
        thresholdPercent: 0.001,
        thresholdRatio: 0.9,
        classification: "borderline",
        sourceWindowLabel: "tick-1",
      },
      windowSpike: {
        classification: "borderline",
        strongestMovePercent: 0.0009,
        strongestMoveAbsolute: 90,
        strongestMoveDirection: "UP",
        thresholdPercent: 0.001,
        thresholdRatio: 0.9,
        sourceWindowLabel: "tick-1",
        borderlineMinRatio: 0.85,
        detected: false,
        currentPrice: 100_090,
        strongestMove: 0.0009,
        strongestAbsDelta: 90,
        referencePrice: 100_000,
        source: "tick-1",
        direction: "up",
        comparisons: [],
      },
    };
    const result = runStrategyDecisionPipeline({
      now: 1_000,
      tick: readyTick(entry),
      manager,
      simulation: sim,
      config: pipelineConfig,
    });
    expect(result.decision.action).toBe("create_borderline_candidate");
    expect(result.entryForSimulation?.shouldEnter).toBe(false);
  });

  it("never emits immediate entry for borderline even if shouldEnter is true", () => {
    const sim = new SimulationEngine({ silent: true, initialEquity: 10_000 });
    const manager = new BorderlineCandidateManager({
      symbol: "BTCUSD",
      watchTicks: 2,
    });
    const entry: EntryEvaluation = {
      shouldEnter: true,
      direction: "DOWN",
      reasons: [],
      movementClassification: "borderline",
      spikeDetected: false,
      stableRangeDetected: true,
      priorRangePercent: 0.0008,
      stableRangeQuality: "good",
      rangeDecisionNote: "test",
      movement: {
        strongestMovePercent: 0.00093,
        strongestMoveAbsolute: 93,
        strongestMoveDirection: "UP",
        thresholdPercent: 0.001,
        thresholdRatio: 0.93,
        classification: "borderline",
        sourceWindowLabel: "tick-1",
      },
      windowSpike: {
        classification: "borderline",
        strongestMovePercent: 0.00093,
        strongestMoveAbsolute: 93,
        strongestMoveDirection: "UP",
        thresholdPercent: 0.001,
        thresholdRatio: 0.93,
        sourceWindowLabel: "tick-1",
        borderlineMinRatio: 0.85,
        detected: false,
        currentPrice: 100_093,
        strongestMove: 0.00093,
        strongestAbsDelta: 93,
        referencePrice: 100_000,
        source: "tick-1",
        direction: "up",
        comparisons: [],
      },
    };
    const result = runStrategyDecisionPipeline({
      now: 1_000,
      tick: readyTick(entry),
      manager,
      simulation: sim,
      config: pipelineConfig,
    });
    expect(result.decision.action).not.toBe("enter_immediate");
    expect(result.decision.action).toBe("create_borderline_candidate");
  });

  it("cancels borderline candidate on same-direction continuation", () => {
    const sim = new SimulationEngine({ silent: true, initialEquity: 10_000 });
    const manager = new BorderlineCandidateManager({
      symbol: "BTCUSD",
      watchTicks: 2,
    });
    const borderline: EntryEvaluation = {
      shouldEnter: false,
      direction: null,
      reasons: ["spike_not_strong_enough"],
      movementClassification: "borderline",
      spikeDetected: false,
      stableRangeDetected: true,
      priorRangePercent: 0.0008,
      stableRangeQuality: "good",
      rangeDecisionNote: "test",
      movement: {
        strongestMovePercent: 0.0009,
        strongestMoveAbsolute: 90,
        strongestMoveDirection: "UP",
        thresholdPercent: 0.001,
        thresholdRatio: 0.9,
        classification: "borderline",
        sourceWindowLabel: "tick-1",
      },
      windowSpike: {
        classification: "borderline",
        strongestMovePercent: 0.0009,
        strongestMoveAbsolute: 90,
        strongestMoveDirection: "UP",
        thresholdPercent: 0.001,
        thresholdRatio: 0.9,
        sourceWindowLabel: "tick-1",
        borderlineMinRatio: 0.85,
        detected: false,
        currentPrice: 100_090,
        strongestMove: 0.0009,
        strongestAbsDelta: 90,
        referencePrice: 100_000,
        source: "tick-1",
        direction: "up",
        comparisons: [],
      },
    };
    runStrategyDecisionPipeline({
      now: 1_000,
      tick: readyTick(borderline),
      manager,
      simulation: sim,
      config: pipelineConfig,
    });
    const continuationTick = readyTick({
      ...borderline,
      windowSpike: {
        ...borderline.windowSpike!,
        classification: "strong_spike",
        strongestMovePercent: 0.0014,
        thresholdRatio: 1.4,
        detected: true,
      },
    });
    continuationTick.btc = 100_140;
    continuationTick.prev = 100_090;
    continuationTick.last = 100_140;
    continuationTick.prices = [100_000, 100_090, 100_120, 100_140];
    const result = runStrategyDecisionPipeline({
      now: 2_000,
      tick: continuationTick,
      manager,
      simulation: sim,
      config: pipelineConfig,
    });
    expect(result.decision.action).toBe("cancel_borderline_candidate");
  });

  it("prioritizes strong spike while borderline candidate is active", () => {
    const sim = new SimulationEngine({ silent: true, initialEquity: 10_000 });
    const manager = new BorderlineCandidateManager({
      symbol: "BTCUSD",
      watchTicks: 2,
    });
    const strongSpikeManager = new StrongSpikeCandidateStore({
      symbol: "BTCUSD",
      watchTicks: 1,
    });
    const borderline: EntryEvaluation = {
      shouldEnter: false,
      direction: null,
      reasons: ["spike_not_strong_enough"],
      movementClassification: "borderline",
      spikeDetected: false,
      stableRangeDetected: true,
      priorRangePercent: 0.0008,
      stableRangeQuality: "good",
      rangeDecisionNote: "test",
      movement: {
        strongestMovePercent: 0.0009,
        strongestMoveAbsolute: 90,
        strongestMoveDirection: "UP",
        thresholdPercent: 0.001,
        thresholdRatio: 0.9,
        classification: "borderline",
        sourceWindowLabel: "tick-1",
      },
      windowSpike: {
        classification: "borderline",
        strongestMovePercent: 0.0009,
        strongestMoveAbsolute: 90,
        strongestMoveDirection: "UP",
        thresholdPercent: 0.001,
        thresholdRatio: 0.9,
        sourceWindowLabel: "tick-1",
        borderlineMinRatio: 0.85,
        detected: false,
        currentPrice: 100_090,
        strongestMove: 0.0009,
        strongestAbsDelta: 90,
        referencePrice: 100_000,
        source: "tick-1",
        direction: "up",
        comparisons: [],
      },
    };
    runStrategyDecisionPipeline({
      now: 1_000,
      tick: readyTick(borderline),
      manager,
      strongSpikeManager,
      simulation: sim,
      config: pipelineConfig,
    });
    const strong: EntryEvaluation = {
      shouldEnter: true,
      direction: "DOWN",
      reasons: [],
      movementClassification: "strong_spike",
      spikeDetected: true,
      stableRangeDetected: true,
      priorRangePercent: 0.0009,
      stableRangeQuality: "good",
      rangeDecisionNote: "test",
      movement: {
        strongestMovePercent: 0.0023,
        strongestMoveAbsolute: 230,
        strongestMoveDirection: "UP",
        thresholdPercent: 0.001,
        thresholdRatio: 2.3,
        classification: "strong_spike",
        sourceWindowLabel: "tick-1",
      },
      windowSpike: {
        classification: "strong_spike",
        strongestMovePercent: 0.0023,
        strongestMoveAbsolute: 230,
        strongestMoveDirection: "UP",
        thresholdPercent: 0.001,
        thresholdRatio: 2.3,
        sourceWindowLabel: "tick-1",
        borderlineMinRatio: 0.85,
        detected: true,
        currentPrice: 100_230,
        strongestMove: 0.0023,
        strongestAbsDelta: 230,
        referencePrice: 100_000,
        source: "tick-1",
        direction: "up",
        comparisons: [],
      },
    };
    const result = runStrategyDecisionPipeline({
      now: 2_000,
      tick: readyTick(strong),
      manager,
      strongSpikeManager,
      simulation: sim,
      config: pipelineConfig,
    });
    expect(
      result.borderlineLifecycleEvents.some((e) => e.type === "cancelled")
    ).toBe(true);
    expect(result.decision.action).toBe("none");
    expect(result.decision.reason).toBe("strong_spike_waiting_confirmation_tick");
  });

  it("strong spike can be blocked by cooldown as critical blocker", () => {
    const sim = new SimulationEngine({ silent: true, initialEquity: 10_000 });
    const manager = new BorderlineCandidateManager({
      symbol: "BTCUSD",
      watchTicks: 2,
    });
    const strongSpikeManager = new StrongSpikeCandidateStore({
      symbol: "BTCUSD",
      watchTicks: 1,
    });
    const strong: EntryEvaluation = {
      shouldEnter: true,
      direction: "DOWN",
      reasons: [],
      movementClassification: "strong_spike",
      spikeDetected: true,
      stableRangeDetected: true,
      priorRangePercent: 0.001,
      stableRangeQuality: "good",
      rangeDecisionNote: "test",
      movement: {
        strongestMovePercent: 0.0017,
        strongestMoveAbsolute: 170,
        strongestMoveDirection: "UP",
        thresholdPercent: 0.001,
        thresholdRatio: 1.7,
        classification: "strong_spike",
        sourceWindowLabel: "tick-1",
      },
      windowSpike: {
        classification: "strong_spike",
        strongestMovePercent: 0.0017,
        strongestMoveAbsolute: 170,
        strongestMoveDirection: "UP",
        thresholdPercent: 0.001,
        thresholdRatio: 1.7,
        sourceWindowLabel: "tick-1",
        borderlineMinRatio: 0.85,
        detected: true,
        currentPrice: 100_170,
        strongestMove: 0.0017,
        strongestAbsDelta: 170,
        referencePrice: 100_000,
        source: "tick-1",
        direction: "up",
        comparisons: [],
      },
    };
    // open position to trigger critical blocker
    sim.onTick({
      now: 100,
      entry: strong,
      entryPath: "strong_spike_immediate",
      sides: { upSidePrice: 0.2, downSidePrice: 0.2 },
      config: {
        exitPrice: 0.5,
        stopLoss: 0.1,
        exitTimeoutMs: 60_000,
        entryCooldownMs: 120_000,
        riskPercentPerTrade: 1,
      },
    });

    const first = runStrategyDecisionPipeline({
      now: 1_000,
      tick: readyTick(strong),
      manager,
      strongSpikeManager,
      simulation: sim,
      config: pipelineConfig,
    });
    expect(first.decision.reason).toBe("strong_spike_waiting_confirmation_tick");
    const confirmTick = readyTick({
      ...strong,
      shouldEnter: false,
      direction: null,
      movementClassification: "no_signal",
      spikeDetected: false,
      reasons: ["spike_not_strong_enough"],
      movement: {
        ...strong.movement,
        strongestMovePercent: 0.0002,
        thresholdRatio: 0.2,
        classification: "no_signal",
      },
      windowSpike: {
        ...strong.windowSpike!,
        classification: "no_signal",
        strongestMovePercent: 0.0002,
        thresholdRatio: 0.2,
        detected: false,
      },
    });
    const result = runStrategyDecisionPipeline({
      now: 2_000,
      tick: confirmTick,
      manager,
      strongSpikeManager,
      simulation: sim,
      config: pipelineConfig,
    });
    expect(result.decision.action).toBe("none");
    expect(result.decision.fastPathUsed).toBe(true);
    expect(result.decision.criticalBlockerUsed).toBe("active_position_or_cooldown");
    expect(result.decision.reasons).toContain("active_position_open");
  });

  it("strong spike can be blocked by invalid quote data as critical blocker", () => {
    const sim = new SimulationEngine({ silent: true, initialEquity: 10_000 });
    const manager = new BorderlineCandidateManager({
      symbol: "BTCUSD",
      watchTicks: 2,
    });
    const strongSpikeManager = new StrongSpikeCandidateStore({
      symbol: "BTCUSD",
      watchTicks: 1,
    });
    const strong: EntryEvaluation = {
      shouldEnter: true,
      direction: "DOWN",
      reasons: [],
      movementClassification: "strong_spike",
      spikeDetected: true,
      stableRangeDetected: true,
      priorRangePercent: 0.001,
      stableRangeQuality: "good",
      rangeDecisionNote: "test",
      movement: {
        strongestMovePercent: 0.0017,
        strongestMoveAbsolute: 170,
        strongestMoveDirection: "UP",
        thresholdPercent: 0.001,
        thresholdRatio: 1.7,
        classification: "strong_spike",
        sourceWindowLabel: "tick-1",
      },
      windowSpike: {
        classification: "strong_spike",
        strongestMovePercent: 0.0017,
        strongestMoveAbsolute: 170,
        strongestMoveDirection: "UP",
        thresholdPercent: 0.001,
        thresholdRatio: 1.7,
        sourceWindowLabel: "tick-1",
        borderlineMinRatio: 0.85,
        detected: true,
        currentPrice: 100_170,
        strongestMove: 0.0017,
        strongestAbsDelta: 170,
        referencePrice: 100_000,
        source: "tick-1",
        direction: "up",
        comparisons: [],
      },
    };
    const first = runStrategyDecisionPipeline({
      now: 1_000,
      tick: readyTick(strong),
      manager,
      strongSpikeManager,
      simulation: sim,
      config: pipelineConfig,
    });
    expect(first.decision.reason).toBe("strong_spike_waiting_confirmation_tick");
    const t = readyTick({
      ...strong,
      shouldEnter: false,
      direction: null,
      movementClassification: "no_signal",
      spikeDetected: false,
      reasons: ["spike_not_strong_enough"],
      movement: {
        ...strong.movement,
        strongestMovePercent: 0.0002,
        thresholdRatio: 0.2,
        classification: "no_signal",
      },
      windowSpike: {
        ...strong.windowSpike!,
        classification: "no_signal",
        strongestMovePercent: 0.0002,
        thresholdRatio: 0.2,
        detected: false,
      },
    });
    t.sides.upSidePrice = Number.NaN;
    const result = runStrategyDecisionPipeline({
      now: 2_000,
      tick: t,
      manager,
      strongSpikeManager,
      simulation: sim,
      config: pipelineConfig,
    });
    expect(result.decision.action).toBe("none");
    expect(result.decision.fastPathUsed).toBe(true);
    expect(result.decision.criticalBlockerUsed).toBe("invalid_market_prices");
    expect(result.decision.reasons).toContain("invalid_market_prices");
  });

  it("allows cooldown override for exceptional spike above 0.25% with no open position", () => {
    const sim = {
      canOpenNewPosition: () => false,
      getOpenPosition: () => null,
    } as unknown as SimulationEngine;
    const manager = new BorderlineCandidateManager({ symbol: "BTCUSD", watchTicks: 2 });
    const strongSpikeManager = new StrongSpikeCandidateStore({
      symbol: "BTCUSD",
      watchTicks: 1,
    });
    const strong: EntryEvaluation = {
      shouldEnter: true,
      direction: "DOWN",
      reasons: [],
      movementClassification: "strong_spike",
      spikeDetected: true,
      stableRangeDetected: true,
      priorRangePercent: 0.0005,
      stableRangeQuality: "good",
      rangeDecisionNote: "test",
      movement: {
        strongestMovePercent: 0.0026,
        strongestMoveAbsolute: 260,
        strongestMoveDirection: "UP",
        thresholdPercent: 0.001,
        thresholdRatio: 2.6,
        classification: "strong_spike",
        sourceWindowLabel: "tick-1",
      },
      windowSpike: {
        classification: "strong_spike",
        strongestMovePercent: 0.0026,
        strongestMoveAbsolute: 260,
        strongestMoveDirection: "UP",
        thresholdPercent: 0.001,
        thresholdRatio: 2.6,
        sourceWindowLabel: "tick-1",
        borderlineMinRatio: 0.85,
        detected: true,
        currentPrice: 100_260,
        strongestMove: 0.0026,
        strongestAbsDelta: 260,
        referencePrice: 100_000,
        source: "tick-1",
        direction: "up",
        comparisons: [],
      },
    };
    const result = runStrategyDecisionPipeline({
      now: 1_000,
      tick: readyTick(strong),
      manager,
      strongSpikeManager,
      simulation: sim,
      config: pipelineConfig,
    });
    expect(result.decision.action).toBe("enter_immediate");
    expect(result.decision.cooldownOverridden).toBe(true);
    expect(result.decision.overrideReason).toBe("exceptional_spike_cooldown_override");
  });

  it("does not override cooldown when exceptional spike has open position", () => {
    const sim = {
      canOpenNewPosition: () => false,
      getOpenPosition: () => ({ direction: "DOWN", entryPrice: 0.2, contracts: 1 }),
    } as unknown as SimulationEngine;
    const manager = new BorderlineCandidateManager({ symbol: "BTCUSD", watchTicks: 2 });
    const strongSpikeManager = new StrongSpikeCandidateStore({
      symbol: "BTCUSD",
      watchTicks: 1,
    });
    const strong: EntryEvaluation = {
      shouldEnter: true,
      direction: "DOWN",
      reasons: [],
      movementClassification: "strong_spike",
      spikeDetected: true,
      stableRangeDetected: true,
      priorRangePercent: 0.0005,
      stableRangeQuality: "good",
      rangeDecisionNote: "test",
      movement: {
        strongestMovePercent: 0.0026,
        strongestMoveAbsolute: 260,
        strongestMoveDirection: "UP",
        thresholdPercent: 0.001,
        thresholdRatio: 2.6,
        classification: "strong_spike",
        sourceWindowLabel: "tick-1",
      },
      windowSpike: {
        classification: "strong_spike",
        strongestMovePercent: 0.0026,
        strongestMoveAbsolute: 260,
        strongestMoveDirection: "UP",
        thresholdPercent: 0.001,
        thresholdRatio: 2.6,
        sourceWindowLabel: "tick-1",
        borderlineMinRatio: 0.85,
        detected: true,
        currentPrice: 100_260,
        strongestMove: 0.0026,
        strongestAbsDelta: 260,
        referencePrice: 100_000,
        source: "tick-1",
        direction: "up",
        comparisons: [],
      },
    };
    const result = runStrategyDecisionPipeline({
      now: 1_000,
      tick: readyTick(strong),
      manager,
      strongSpikeManager,
      simulation: sim,
      config: pipelineConfig,
    });
    expect(result.decision.action).toBe("none");
    expect(result.decision.cooldownOverridden).toBe(false);
    expect(result.decision.reasons).toContain("active_position_open");
  });

  it("does not override cooldown for 0.24% spike", () => {
    const sim = {
      canOpenNewPosition: () => false,
      getOpenPosition: () => null,
    } as unknown as SimulationEngine;
    const manager = new BorderlineCandidateManager({ symbol: "BTCUSD", watchTicks: 2 });
    const strongSpikeManager = new StrongSpikeCandidateStore({
      symbol: "BTCUSD",
      watchTicks: 1,
    });
    const strong: EntryEvaluation = {
      shouldEnter: true,
      direction: "DOWN",
      reasons: [],
      movementClassification: "strong_spike",
      spikeDetected: true,
      stableRangeDetected: true,
      priorRangePercent: 0.0005,
      stableRangeQuality: "good",
      rangeDecisionNote: "test",
      movement: {
        strongestMovePercent: 0.0024,
        strongestMoveAbsolute: 240,
        strongestMoveDirection: "UP",
        thresholdPercent: 0.001,
        thresholdRatio: 2.4,
        classification: "strong_spike",
        sourceWindowLabel: "tick-1",
      },
      windowSpike: {
        classification: "strong_spike",
        strongestMovePercent: 0.0024,
        strongestMoveAbsolute: 240,
        strongestMoveDirection: "UP",
        thresholdPercent: 0.001,
        thresholdRatio: 2.4,
        sourceWindowLabel: "tick-1",
        borderlineMinRatio: 0.85,
        detected: true,
        currentPrice: 100_240,
        strongestMove: 0.0024,
        strongestAbsDelta: 240,
        referencePrice: 100_000,
        source: "tick-1",
        direction: "up",
        comparisons: [],
      },
    };
    const first = runStrategyDecisionPipeline({
      now: 1_000,
      tick: readyTick(strong),
      manager,
      strongSpikeManager,
      simulation: sim,
      config: pipelineConfig,
    });
    expect(first.decision.reason).toBe("strong_spike_waiting_confirmation_tick");
    const confirmTick = readyTick({
      ...strong,
      shouldEnter: false,
      direction: null,
      movementClassification: "no_signal",
      spikeDetected: false,
      reasons: ["spike_not_strong_enough"],
      movement: {
        ...strong.movement,
        strongestMovePercent: 0.0002,
        thresholdRatio: 0.2,
        classification: "no_signal",
      },
      windowSpike: {
        ...strong.windowSpike!,
        classification: "no_signal",
        strongestMovePercent: 0.0002,
        thresholdRatio: 0.2,
        detected: false,
      },
    });
    const result = runStrategyDecisionPipeline({
      now: 2_000,
      tick: confirmTick,
      manager,
      strongSpikeManager,
      simulation: sim,
      config: pipelineConfig,
    });
    expect(result.decision.action).toBe("none");
    expect(result.decision.cooldownOverridden).toBe(false);
  });

  it("maps no_signal to no_signal_below_borderline rejection reason", () => {
    const sim = new SimulationEngine({ silent: true, initialEquity: 10_000 });
    const manager = new BorderlineCandidateManager({
      symbol: "BTCUSD",
      watchTicks: 2,
    });
    const noSignal: EntryEvaluation = {
      shouldEnter: false,
      direction: null,
      reasons: ["spike_not_strong_enough"],
      movementClassification: "no_signal",
      spikeDetected: false,
      stableRangeDetected: true,
      priorRangePercent: 0.001,
      stableRangeQuality: "good",
      rangeDecisionNote: "test",
      movement: {
        strongestMovePercent: 0.0002,
        strongestMoveAbsolute: 20,
        strongestMoveDirection: "UP",
        thresholdPercent: 0.001,
        thresholdRatio: 0.2,
        classification: "no_signal",
        sourceWindowLabel: "tick-1",
      },
      windowSpike: {
        classification: "no_signal",
        strongestMovePercent: 0.0002,
        strongestMoveAbsolute: 20,
        strongestMoveDirection: "UP",
        thresholdPercent: 0.001,
        thresholdRatio: 0.2,
        sourceWindowLabel: "tick-1",
        borderlineMinRatio: 0.85,
        detected: false,
        currentPrice: 100_020,
        strongestMove: 0.0002,
        strongestAbsDelta: 20,
        referencePrice: 100_000,
        source: "tick-1",
        direction: "up",
        comparisons: [],
      },
    };
    const result = runStrategyDecisionPipeline({
      now: 1_000,
      tick: readyTick(noSignal),
      manager,
      simulation: sim,
      config: pipelineConfig,
    });
    expect(result.decision.action).toBe("none");
    expect(result.decision.reasons).toContain("no_signal_below_borderline");
  });

  it("rejects exceptional immediate path when opposite side is too high", () => {
    const sim = new SimulationEngine({ silent: true, initialEquity: 10_000 });
    const manager = new BorderlineCandidateManager({ symbol: "BTCUSD", watchTicks: 2 });
    const strong: EntryEvaluation = {
      shouldEnter: false,
      direction: "DOWN",
      reasons: ["opposite_side_price_too_high"],
      movementClassification: "strong_spike",
      spikeDetected: true,
      stableRangeDetected: true,
      priorRangePercent: 0.0005,
      stableRangeQuality: "good",
      rangeDecisionNote: "test",
      movement: {
        strongestMovePercent: 0.0026,
        strongestMoveAbsolute: 260,
        strongestMoveDirection: "UP",
        thresholdPercent: 0.001,
        thresholdRatio: 2.6,
        classification: "strong_spike",
        sourceWindowLabel: "tick-1",
      },
      windowSpike: {
        classification: "strong_spike",
        strongestMovePercent: 0.0026,
        strongestMoveAbsolute: 260,
        strongestMoveDirection: "UP",
        thresholdPercent: 0.001,
        thresholdRatio: 2.6,
        sourceWindowLabel: "tick-1",
        borderlineMinRatio: 0.85,
        detected: true,
        currentPrice: 100_260,
        strongestMove: 0.0026,
        strongestAbsDelta: 260,
        referencePrice: 100_000,
        source: "tick-1",
        direction: "up",
        comparisons: [],
      },
    };
    const t = readyTick(strong);
    t.sides.downSidePrice = 0.5125;
    const result = runStrategyDecisionPipeline({
      now: 1_000,
      tick: t,
      manager,
      simulation: sim,
      config: pipelineConfig,
    });
    expect(result.decision.action).toBe("none");
    expect(result.decision.reason).toBe("opposite_side_price_too_high");
  });

  it("rejects exceptional immediate path when quotes are too neutral", () => {
    const sim = new SimulationEngine({ silent: true, initialEquity: 10_000 });
    const manager = new BorderlineCandidateManager({ symbol: "BTCUSD", watchTicks: 2 });
    const strong: EntryEvaluation = {
      shouldEnter: false,
      direction: "DOWN",
      reasons: ["market_quotes_too_neutral"],
      movementClassification: "strong_spike",
      spikeDetected: true,
      stableRangeDetected: true,
      priorRangePercent: 0.0005,
      stableRangeQuality: "good",
      rangeDecisionNote: "test",
      movement: {
        strongestMovePercent: 0.0026,
        strongestMoveAbsolute: 260,
        strongestMoveDirection: "UP",
        thresholdPercent: 0.001,
        thresholdRatio: 2.6,
        classification: "strong_spike",
        sourceWindowLabel: "tick-1",
      },
      windowSpike: {
        classification: "strong_spike",
        strongestMovePercent: 0.0026,
        strongestMoveAbsolute: 260,
        strongestMoveDirection: "UP",
        thresholdPercent: 0.001,
        thresholdRatio: 2.6,
        sourceWindowLabel: "tick-1",
        borderlineMinRatio: 0.85,
        detected: true,
        currentPrice: 100_260,
        strongestMove: 0.0026,
        strongestAbsDelta: 260,
        referencePrice: 100_000,
        source: "tick-1",
        direction: "up",
        comparisons: [],
      },
    };
    const t = readyTick(strong);
    t.sides.upSidePrice = 0.49;
    t.sides.downSidePrice = 0.51;
    const result = runStrategyDecisionPipeline({
      now: 1_000,
      tick: t,
      manager,
      simulation: sim,
      config: pipelineConfig,
    });
    expect(result.decision.action).toBe("none");
    expect(result.decision.reason).toBe("market_quotes_too_neutral");
  });
});

