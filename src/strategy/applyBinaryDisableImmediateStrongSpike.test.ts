import { describe, expect, it } from "vitest";
import type { StrategyTickResult } from "../botLoop.js";
import type { SimulationEngine } from "../simulationEngine.js";
import {
  applyBinaryDisableImmediateStrongSpike,
  type StrategyDecision,
  type StrategyDecisionPipelineResult,
} from "./strategyDecisionPipeline.js";

const simStub = {
  getOpenPosition: (): null => null,
} as unknown as SimulationEngine;

describe("applyBinaryDisableImmediateStrongSpike", () => {
  const tickStub = {
    kind: "ready",
    entry: {
      movementClassification: "strong_spike",
      reasons: [],
      shouldEnter: true,
      stableRangeDetected: true,
      priorRangeFraction: 0.001,
      stableRangeQuality: "good",
      rangeDecisionNote: "",
      spikeDetected: true,
      windowSpike: undefined,
      movement: {
        strongestMovePercent: 0.005,
        strongestMoveAbsolute: 50,
        strongestMoveDirection: "UP",
        thresholdPercent: 0.003,
        thresholdRatio: 1.5,
        classification: "strong_spike",
        sourceWindowLabel: null,
      },
    },
  } as Extract<StrategyTickResult, { kind: "ready" }>;

  function pipelineWithDecision(decision: StrategyDecision): StrategyDecisionPipelineResult {
    return {
      decision,
      entryForSimulation: undefined,
      borderlineLifecycleEvents: [],
      strongSpikeLifecycleMessages: [],
    };
  }

  it("no-op when flag is false", () => {
    const base: StrategyDecision = {
      action: "enter_immediate",
      direction: "UP",
      stableRangeQuality: "good",
      movementClassification: "strong_spike",
      spikeDetected: true,
      fastPathUsed: true,
      reason: "strong_spike_immediate_entry_fast_path",
    };
    const out = applyBinaryDisableImmediateStrongSpike(pipelineWithDecision(base), {
      tick: tickStub,
      simulation: simStub,
      config: {
        marketMode: "binary",
        binaryDisableImmediateStrongSpike: false,
        tradableSpikeMinPercent: 0.001,
      },
    });
    expect(out.decision.action).toBe("enter_immediate");
  });

  it("blocks enter_immediate that resolves to strong_spike_immediate on binary when flag true", () => {
    const base: StrategyDecision = {
      action: "enter_immediate",
      direction: "UP",
      stableRangeQuality: "good",
      movementClassification: "strong_spike",
      spikeDetected: true,
      fastPathUsed: true,
      reason: "strong_spike_immediate_entry_fast_path",
    };
    const out = applyBinaryDisableImmediateStrongSpike(pipelineWithDecision(base), {
      tick: tickStub,
      simulation: simStub,
      config: {
        marketMode: "binary",
        binaryDisableImmediateStrongSpike: true,
        tradableSpikeMinPercent: 0.001,
      },
    });
    expect(out.decision.action).toBe("none");
    expect(out.decision.reason).toBe("binary_immediate_strong_spike_disabled");
    expect(out.entryForSimulation).toBe(tickStub.entry as never);
  });

  it("does not block strong_spike_confirmed promote", () => {
    const base: StrategyDecision = {
      action: "enter_immediate",
      direction: "UP",
      stableRangeQuality: "good",
      movementClassification: "strong_spike",
      spikeDetected: true,
      fastPathUsed: true,
      reason: "strong_spike_confirmed_pause",
      qualityGatePassed: true,
      qualityGateReasons: [],
      qualityProfile: "strong",
    };
    const out = applyBinaryDisableImmediateStrongSpike(pipelineWithDecision(base), {
      tick: tickStub,
      simulation: simStub,
      config: {
        marketMode: "binary",
        binaryDisableImmediateStrongSpike: true,
        tradableSpikeMinPercent: 0.001,
      },
    });
    expect(out.decision.action).toBe("enter_immediate");
  });

  it("does not touch spot mode", () => {
    const base: StrategyDecision = {
      action: "enter_immediate",
      direction: "UP",
      stableRangeQuality: "good",
      movementClassification: "strong_spike",
      spikeDetected: true,
      fastPathUsed: true,
      reason: "strong_spike_immediate_entry_fast_path",
    };
    const out = applyBinaryDisableImmediateStrongSpike(pipelineWithDecision(base), {
      tick: tickStub,
      simulation: simStub,
      config: {
        marketMode: "spot",
        binaryDisableImmediateStrongSpike: true,
        tradableSpikeMinPercent: 0.001,
      },
    });
    expect(out.decision.action).toBe("enter_immediate");
  });
});
