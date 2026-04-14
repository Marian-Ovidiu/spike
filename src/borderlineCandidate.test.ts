import { describe, expect, it } from "vitest";
import type { StrategyTickResult } from "./botLoop.js";
import type { EntryEvaluation } from "./entryConditions.js";
import {
  analyzePostBorderlineMovement,
  BorderlineCandidateManager,
  buildPromotedEntryEvaluation,
  createBorderlineCandidate,
  evaluateBorderlineWatchDecision,
} from "./borderlineCandidate.js";

function readyTickWithClassification(
  classification: "no_signal" | "borderline" | "strong_spike",
  ratio = 0.9
): Extract<StrategyTickResult, { kind: "ready" }> {
  const entry: EntryEvaluation = {
    shouldEnter: classification === "strong_spike",
    direction: classification === "strong_spike" ? "DOWN" : null,
    reasons:
      classification === "strong_spike"
        ? []
        : ["spike_not_strong_enough"],
    windowSpike: {
      classification,
      strongestMovePercent: ratio * 0.001,
      strongestMoveAbsolute: 93,
      strongestMoveDirection: "UP",
      thresholdPercent: 0.001,
      thresholdRatio: ratio,
      sourceWindowLabel: "tick-1",
      borderlineMinRatio: 0.85,
      detected: classification === "strong_spike",
      currentPrice: 100_093,
      strongestMove: ratio * 0.001,
      strongestAbsDelta: 93,
      referencePrice: 100_000,
      source: "tick-1",
      direction: "up",
      comparisons: [
        {
          source: "tick-1",
          referencePrice: 100_000,
          relativeMove: ratio * 0.001,
          absoluteDelta: 93,
          exceeds: classification === "strong_spike",
        },
      ],
    },
    stableRangeDetected: true,
    priorRangePercent: 0.05,
    stableRangeQuality: "good",
    rangeDecisionNote: "test",
    movementClassification: classification,
    spikeDetected: classification === "strong_spike",
    movement: {
      strongestMovePercent: ratio * 0.001,
      strongestMoveAbsolute: 93,
      strongestMoveDirection: "UP",
      thresholdPercent: 0.001,
      thresholdRatio: ratio,
      classification,
      sourceWindowLabel: "tick-1",
    },
  };

  return {
    kind: "ready",
    btc: 100_093,
    n: 12,
    cap: 20,
    prev: 100_000,
    last: 100_093,
    prices: [100_000, 100_010, 100_020, 100_093],
    sides: { upSidePrice: 0.2, downSidePrice: 0.2 },
    entry,
  };
}

describe("borderlineCandidate", () => {
  it("creates candidate from borderline tick payload", () => {
    const t = readyTickWithClassification("borderline", 0.93);
    const c = createBorderlineCandidate({
      now: 1_000,
      tickNumber: 5,
      symbol: "BTCUSD",
      tick: t,
      stableRangeDetected: true,
      watchTicks: 2,
    });
    expect(c.status).toBe("watching");
    expect(c.symbol).toBe("BTCUSD");
    expect(c.moveDirection).toBe("UP");
    expect(c.thresholdRatio).toBeCloseTo(0.93, 2);
    expect(c.watchTicksRemaining).toBe(2);
  });

  it("creates one active candidate for borderline", () => {
    const m = new BorderlineCandidateManager({ symbol: "BTCUSD", watchTicks: 2 });
    const events = m.onTick(1_000, readyTickWithClassification("borderline", 0.9));
    expect(events.some((e) => e.type === "created")).toBe(true);
    expect(m.getActive()).not.toBeNull();
  });

  it("expires candidate after watch ticks elapse", () => {
    const m = new BorderlineCandidateManager({ symbol: "BTCUSD", watchTicks: 1 });
    m.onTick(1_000, readyTickWithClassification("borderline", 0.9));
    const events = m.onTick(2_000, readyTickWithClassification("no_signal", 0.2));
    expect(events.some((e) => e.type === "expired")).toBe(true);
    expect(m.getActive()).toBeNull();
    expect(m.getHistory().at(-1)?.status).toBe("expired");
  });

  it("cancels active borderline when strong spike arrives", () => {
    const m = new BorderlineCandidateManager({ symbol: "BTCUSD", watchTicks: 2 });
    m.onTick(1_000, readyTickWithClassification("borderline", 0.9));
    const events = m.onTick(2_000, readyTickWithClassification("strong_spike", 1.05));
    expect(events.some((e) => e.type === "cancelled")).toBe(true);
    expect(m.getActive()).toBeNull();
    expect(m.getHistory().at(-1)?.cancellationReason).toBe(
      "strong_spike_same_direction"
    );
  });

  it("keeps only one active candidate per symbol (replace policy)", () => {
    const m = new BorderlineCandidateManager({ symbol: "BTCUSD", watchTicks: 2 });
    m.onTick(1_000, readyTickWithClassification("borderline", 0.88));
    const first = m.getActive();
    m.onTick(2_000, readyTickWithClassification("borderline", 0.92));
    const second = m.getActive();
    expect(first?.id).not.toBe(second?.id);
    expect(m.getHistory().at(-1)?.cancellationReason).toBe(
      "replaced_by_new_borderline"
    );
  });

  it("watch decision promotes when paused/reverting and opposite side affordable", () => {
    const m = new BorderlineCandidateManager({ symbol: "BTCUSD", watchTicks: 2 });
    m.onTick(1_000, readyTickWithClassification("borderline", 0.93));
    const active = {
      ...m.getActive()!,
      watchedPrices: [100_060, 100_050],
    };
    const tick = readyTickWithClassification("no_signal", 0.6);
    const decision = evaluateBorderlineWatchDecision({
      candidate: active,
      tick,
      config: {
        rangeThreshold: 0.02,
        stableRangeSoftToleranceRatio: 1.5,
        spikeThreshold: 0.001,
        entryPrice: 0.25,
        borderlineRequirePause: true,
        borderlineRequireNoContinuation: true,
        borderlineContinuationThreshold: 0.25,
        borderlineReversionThreshold: 0.2,
        borderlinePauseBandPercent: 0.00015,
      },
      cooldownBlocked: false,
    });
    expect(decision.action).toBe("promote");
  });

  it("watch decision promotes on clear pause after borderline move", () => {
    const m = new BorderlineCandidateManager({ symbol: "BTCUSD", watchTicks: 2 });
    m.onTick(1_000, readyTickWithClassification("borderline", 0.93));
    const active = {
      ...m.getActive()!,
      watchedPrices: [100_094, 100_095],
      moveAbsolute: 93,
      btcPriceAtDetection: 100_093,
    };
    const tick = readyTickWithClassification("no_signal", 0.2);
    const decision = evaluateBorderlineWatchDecision({
      candidate: active,
      tick,
      config: {
        rangeThreshold: 0.02,
        stableRangeSoftToleranceRatio: 1.5,
        spikeThreshold: 0.001,
        entryPrice: 0.25,
        borderlineRequirePause: true,
        borderlineRequireNoContinuation: true,
        borderlineContinuationThreshold: 0.25,
        borderlineReversionThreshold: 0.2,
        borderlinePauseBandPercent: 0.0002,
      },
      cooldownBlocked: false,
    });
    expect(decision.action).toBe("promote");
  });

  it("watch decision promotes on meaningful reversion", () => {
    const m = new BorderlineCandidateManager({ symbol: "BTCUSD", watchTicks: 2 });
    m.onTick(1_000, readyTickWithClassification("borderline", 0.93));
    const active = {
      ...m.getActive()!,
      watchedPrices: [100_070, 100_060],
      moveAbsolute: 93,
      btcPriceAtDetection: 100_093,
    };
    const tick = readyTickWithClassification("no_signal", 0.3);
    const decision = evaluateBorderlineWatchDecision({
      candidate: active,
      tick,
      config: {
        rangeThreshold: 0.02,
        stableRangeSoftToleranceRatio: 1.5,
        spikeThreshold: 0.001,
        entryPrice: 0.25,
        borderlineRequirePause: true,
        borderlineRequireNoContinuation: true,
        borderlineContinuationThreshold: 0.25,
        borderlineReversionThreshold: 0.2,
        borderlinePauseBandPercent: 0.00015,
      },
      cooldownBlocked: false,
    });
    expect(decision.action).toBe("promote");
  });

  it("watch decision cancels on strong same-direction continuation", () => {
    const m = new BorderlineCandidateManager({ symbol: "BTCUSD", watchTicks: 2 });
    m.onTick(1_000, readyTickWithClassification("borderline", 0.93));
    const active = m.getActive()!;
    const tick = readyTickWithClassification("strong_spike", 1.05);
    const decision = evaluateBorderlineWatchDecision({
      candidate: active,
      tick,
      config: {
        rangeThreshold: 0.02,
        stableRangeSoftToleranceRatio: 1.5,
        spikeThreshold: 0.001,
        entryPrice: 0.25,
        borderlineRequirePause: true,
        borderlineRequireNoContinuation: true,
        borderlineContinuationThreshold: 0.25,
        borderlineReversionThreshold: 0.2,
        borderlinePauseBandPercent: 0.00015,
      },
      cooldownBlocked: false,
    });
    expect(decision.action).toBe("cancel");
    expect(decision.reason).toContain("strong_spike_same_direction");
  });

  it("watch decision cancels on continuation classification", () => {
    const m = new BorderlineCandidateManager({ symbol: "BTCUSD", watchTicks: 2 });
    m.onTick(1_000, readyTickWithClassification("borderline", 0.93));
    const active = {
      ...m.getActive()!,
      watchedPrices: [100_120, 100_130],
      moveAbsolute: 93,
      btcPriceAtDetection: 100_093,
    };
    const tick = readyTickWithClassification("no_signal", 0.5);
    const decision = evaluateBorderlineWatchDecision({
      candidate: active,
      tick,
      config: {
        rangeThreshold: 0.02,
        stableRangeSoftToleranceRatio: 1.5,
        spikeThreshold: 0.001,
        entryPrice: 0.25,
        borderlineRequirePause: true,
        borderlineRequireNoContinuation: true,
        borderlineContinuationThreshold: 0.25,
        borderlineReversionThreshold: 0.2,
        borderlinePauseBandPercent: 0.00015,
      },
      cooldownBlocked: false,
    });
    expect(decision.action).toBe("cancel");
    expect(decision.reason).toBe("continuation_same_direction");
  });

  it("watch decision expires when watch ended without pause/reversion", () => {
    const m = new BorderlineCandidateManager({ symbol: "BTCUSD", watchTicks: 1 });
    m.onTick(1_000, readyTickWithClassification("borderline", 0.9));
    const active = {
      ...m.getActive()!,
      watchTicksRemaining: 0,
      watchedPrices: [100_110],
      moveAbsolute: 90,
      btcPriceAtDetection: 100_090,
    };
    const tick = readyTickWithClassification("no_signal", 0.2);
    const decision = evaluateBorderlineWatchDecision({
      candidate: active,
      tick,
      config: {
        rangeThreshold: 0.02,
        stableRangeSoftToleranceRatio: 1.5,
        spikeThreshold: 0.001,
        entryPrice: 0.25,
        borderlineRequirePause: true,
        borderlineRequireNoContinuation: false,
        borderlineContinuationThreshold: 0.95,
        borderlineReversionThreshold: 0.95,
        borderlinePauseBandPercent: 0.00001,
      },
      cooldownBlocked: false,
    });
    expect(decision.action).toBe("expire");
    expect(decision.reason).toBe("no_pause_or_reversion");
  });

  it("watch decision cancels when cooldown blocks new entries", () => {
    const m = new BorderlineCandidateManager({ symbol: "BTCUSD", watchTicks: 2 });
    m.onTick(1_000, readyTickWithClassification("borderline", 0.93));
    const active = m.getActive()!;
    const tick = readyTickWithClassification("no_signal", 0.4);
    const decision = evaluateBorderlineWatchDecision({
      candidate: active,
      tick,
      config: {
        rangeThreshold: 0.02,
        stableRangeSoftToleranceRatio: 1.5,
        spikeThreshold: 0.001,
        entryPrice: 0.25,
        borderlineRequirePause: true,
        borderlineRequireNoContinuation: true,
        borderlineContinuationThreshold: 0.25,
        borderlineReversionThreshold: 0.2,
        borderlinePauseBandPercent: 0.00015,
      },
      cooldownBlocked: true,
    });
    expect(decision.action).toBe("cancel");
    expect(decision.reason).toBe("cooldown_blocked");
  });

  it("buildPromotedEntryEvaluation forces contrarian simulated entry", () => {
    const t = readyTickWithClassification("borderline", 0.9);
    const c = createBorderlineCandidate({
      now: 1_000,
      tickNumber: 1,
      symbol: "BTCUSD",
      tick: t,
      stableRangeDetected: true,
      watchTicks: 2,
    });
    const promoted = buildPromotedEntryEvaluation(c, t.entry);
    expect(promoted.shouldEnter).toBe(true);
    expect(promoted.direction).toBe("DOWN");
    expect(promoted.reasons).toEqual([]);
  });

  it("classifies continuation explicitly", () => {
    const t = readyTickWithClassification("borderline", 0.9);
    const c = createBorderlineCandidate({
      now: 1_000,
      tickNumber: 1,
      symbol: "BTCUSD",
      tick: t,
      stableRangeDetected: true,
      watchTicks: 2,
    });
    const analysis = analyzePostBorderlineMovement(
      c,
      [100_120, 100_130],
      {
        continuationThreshold: 0.25,
        reversionThreshold: 0.2,
        pauseBandPercent: 0.00015,
      }
    );
    expect(analysis.postMoveClassification).toBe("continuation");
  });

  it("classifies reversion explicitly", () => {
    const t = readyTickWithClassification("borderline", 0.9);
    const c = createBorderlineCandidate({
      now: 1_000,
      tickNumber: 1,
      symbol: "BTCUSD",
      tick: t,
      stableRangeDetected: true,
      watchTicks: 2,
    });
    const analysis = analyzePostBorderlineMovement(
      c,
      [100_060, 100_040],
      {
        continuationThreshold: 0.25,
        reversionThreshold: 0.2,
        pauseBandPercent: 0.00015,
      }
    );
    expect(analysis.postMoveClassification).toBe("reversion");
  });

  it("classifies pause explicitly", () => {
    const t = readyTickWithClassification("borderline", 0.9);
    const c = createBorderlineCandidate({
      now: 1_000,
      tickNumber: 1,
      symbol: "BTCUSD",
      tick: t,
      stableRangeDetected: true,
      watchTicks: 2,
    });
    const analysis = analyzePostBorderlineMovement(
      c,
      [100_095, 100_094],
      {
        continuationThreshold: 0.25,
        reversionThreshold: 0.2,
        pauseBandPercent: 0.0002,
      }
    );
    expect(analysis.postMoveClassification).toBe("pause");
  });

  it("classifies noisy_unclear explicitly", () => {
    const t = readyTickWithClassification("borderline", 0.9);
    const c = createBorderlineCandidate({
      now: 1_000,
      tickNumber: 1,
      symbol: "BTCUSD",
      tick: t,
      stableRangeDetected: true,
      watchTicks: 2,
    });
    const analysis = analyzePostBorderlineMovement(
      c,
      [100_100, 100_085],
      {
        continuationThreshold: 0.6,
        reversionThreshold: 0.6,
        pauseBandPercent: 0.00005,
      }
    );
    expect(analysis.postMoveClassification).toBe("noisy_unclear");
  });
});

