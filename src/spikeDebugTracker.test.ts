import { describe, it, expect } from "vitest";
import {
  SpikeDebugTracker,
  type SpikeDebugSnapshot,
} from "./spikeDebugTracker.js";
import type { StrategyTickResult } from "./botLoop.js";
import type { EntryEvaluation } from "./entryConditions.js";

function makeReadyTick(
  prev: number,
  last: number,
  overrides?: Partial<EntryEvaluation>
): StrategyTickResult {
  return {
    kind: "ready",
    btc: last,
    n: 10,
    cap: 20,
    prev,
    last,
    prices: [prev, last],
    sides: { upSidePrice: 0.55, downSidePrice: 0.45 },
    entry: {
      shouldEnter: false,
      direction: null,
      reasons: ["market_not_stable"],
      windowSpike: undefined,
      ...overrides,
    },
  };
}

function makeReadyTickWithHistory(
  history: number[],
  overrides?: Partial<EntryEvaluation>
): StrategyTickResult {
  const last = history[history.length - 1]!;
  const prev = history.length >= 2 ? history[history.length - 2]! : last;
  return {
    kind: "ready",
    btc: last,
    n: history.length,
    cap: 20,
    prev,
    last,
    prices: history,
    sides: { upSidePrice: 0.55, downSidePrice: 0.45 },
    entry: {
      shouldEnter: false,
      direction: null,
      reasons: ["market_not_stable"],
      windowSpike: undefined,
      ...overrides,
    },
  };
}

describe("SpikeDebugTracker", () => {
  it("returns null for non-ready ticks", () => {
    const tracker = new SpikeDebugTracker();
    expect(tracker.observeTick({ kind: "no_btc" }, 0.005)).toBeNull();
    expect(
      tracker.observeTick({ kind: "warming", btc: 100_000, n: 2, cap: 20 }, 0.005)
    ).toBeNull();
    expect(tracker.getReadyTickCount()).toBe(0);
  });

  it("computes per-tick diagnostics correctly", () => {
    const tracker = new SpikeDebugTracker();
    const tick = makeReadyTick(100_000, 100_600);
    const snap = tracker.observeTick(tick, 0.005)!;

    expect(snap.currentPrice).toBe(100_600);
    expect(snap.referencePrice).toBe(100_000);
    expect(snap.absoluteDelta).toBe(600);
    expect(snap.percentDelta).toBeCloseTo(0.6, 4);
    expect(snap.configuredSpikeThreshold).toBe(0.005);
    expect(snap.spikeDetected).toBe(true);
    expect(snap.source).toBe("tick-1");
    expect(snap.direction).toBe("up");
    expect(snap.classification).toBe("strong_spike");
    expect(snap.thresholdRatio).toBeGreaterThan(1);
    expect(snap.comparisons).toHaveLength(1);
  });

  it("detects spike=false when move is below threshold", () => {
    const tracker = new SpikeDebugTracker();
    const tick = makeReadyTick(100_000, 100_100);
    const snap = tracker.observeTick(tick, 0.005)!;

    expect(snap.absoluteDelta).toBe(100);
    expect(snap.percentDelta).toBeCloseTo(0.1, 4);
    expect(snap.spikeDetected).toBe(false);
    expect(snap.classification).toBe("no_signal");
  });

  it("tracks session maxima across multiple ticks", () => {
    const tracker = new SpikeDebugTracker();
    tracker.observeTick(makeReadyTick(100_000, 100_200), 0.005);
    tracker.observeTick(makeReadyTick(100_200, 100_900), 0.005);
    tracker.observeTick(makeReadyTick(100_900, 100_950), 0.005);

    const max = tracker.getSessionMaxima();
    expect(max.maxAbsoluteDelta).toBe(700);
    expect(max.maxAbsoluteDeltaTick).toBe(2);
    expect(max.maxPercentDelta).toBeCloseTo((700 / 100_200) * 100, 4);
    expect(max.maxPercentDeltaTick).toBe(2);
  });

  it("shouldPrintSummary fires every N ticks", () => {
    const tracker = new SpikeDebugTracker(3);
    tracker.observeTick(makeReadyTick(100, 101), 0.005);
    expect(tracker.shouldPrintSummary()).toBe(false);
    tracker.observeTick(makeReadyTick(101, 102), 0.005);
    expect(tracker.shouldPrintSummary()).toBe(false);
    tracker.observeTick(makeReadyTick(102, 103), 0.005);
    expect(tracker.shouldPrintSummary()).toBe(true);
    tracker.observeTick(makeReadyTick(103, 104), 0.005);
    expect(tracker.shouldPrintSummary()).toBe(false);
  });

  it("formatTickDebugLine produces a readable string with window comparisons", () => {
    const snap: SpikeDebugSnapshot = {
      currentPrice: 100_600,
      referencePrice: 100_000,
      source: "tick-1",
      classification: "strong_spike",
      thresholdRatio: 1.2,
      absoluteDelta: 600,
      percentDelta: 0.6,
      configuredSpikeThreshold: 0.005,
      spikeDetected: true,
      direction: "up",
      comparisons: [
        { source: "tick-1", referencePrice: 100_000, relativeMove: 0.006, absoluteDelta: 600, exceeds: true },
      ],
    };
    const line = SpikeDebugTracker.formatTickDebugLine(snap);
    expect(line).toContain("spike? YES");
    expect(line).toContain("(tick-1)");
    expect(line).toContain("$600.00");
    expect(line).toContain("0.6000%");
    expect(line).toContain("thresh 0.5000%");
    expect(line).toContain("move/thresh");
    expect(line).toContain("t1:");
  });

  it("formatTickDebugLine shows 'no' for non-spike", () => {
    const snap: SpikeDebugSnapshot = {
      currentPrice: 100_100,
      referencePrice: 100_000,
      source: "tick-1",
      classification: "no_signal",
      thresholdRatio: 0.2,
      absoluteDelta: 100,
      percentDelta: 0.1,
      configuredSpikeThreshold: 0.005,
      spikeDetected: false,
      direction: "up",
      comparisons: [
        { source: "tick-1", referencePrice: 100_000, relativeMove: 0.001, absoluteDelta: 100, exceeds: false },
      ],
    };
    const line = SpikeDebugTracker.formatTickDebugLine(snap);
    expect(line).toContain("spike? no");
  });

  it("formatSummary contains diagnosis and maxima", () => {
    const tracker = new SpikeDebugTracker();
    tracker.observeTick(makeReadyTick(100_000, 100_200), 0.005);
    tracker.observeTick(makeReadyTick(100_200, 100_800), 0.005);

    const summary = tracker.formatSummary();
    expect(summary).toContain("Spike debug");
    expect(summary).toContain("2 ready ticks");
    expect(summary).toContain("threshold");
    expect(summary).toContain("max |Δ|");
    expect(summary).toContain("max |Δ%|");
    expect(summary).toContain("headroom");
    expect(summary).toContain("diagnosis");
  });

  it("formatSummary diagnosis says 'flat' for tiny moves", () => {
    const tracker = new SpikeDebugTracker();
    tracker.observeTick(makeReadyTick(100_000, 100_010), 0.005);

    const summary = tracker.formatSummary();
    expect(summary).toContain("prices are flat or threshold is too high");
  });

  it("formatSummary diagnosis says 'borderline' for close moves", () => {
    const tracker = new SpikeDebugTracker();
    tracker.observeTick(makeReadyTick(100_000, 100_350), 0.005);

    const summary = tracker.formatSummary();
    expect(summary).toContain("borderline");
  });

  it("window spike detects move that tick-to-tick misses", () => {
    const tracker = new SpikeDebugTracker();
    const tick = makeReadyTickWithHistory(
      [100_000, 100_100, 100_200, 100_600],
      {},
    );
    const snap = tracker.observeTick(tick, 0.005)!;

    expect(snap.spikeDetected).toBe(true);
    expect(snap.source).toBe("tick-3");
    expect(snap.referencePrice).toBe(100_000);
    expect(snap.classification).toBe("strong_spike");
    expect(snap.absoluteDelta).toBe(600);
    expect(snap.percentDelta).toBeCloseTo(0.6, 3);
    expect(snap.comparisons.length).toBeGreaterThanOrEqual(3);
  });

  it("shows all window comparisons in debug line", () => {
    const tracker = new SpikeDebugTracker();
    const tick = makeReadyTickWithHistory(
      [100_000, 100_100, 100_200, 100_600],
      {},
    );
    const snap = tracker.observeTick(tick, 0.005)!;
    const line = SpikeDebugTracker.formatTickDebugLine(snap);
    expect(line).toContain("t1:");
    expect(line).toContain("t2:");
    expect(line).toContain("t3:");
  });

  it("marks near-threshold movement as borderline", () => {
    const tracker = new SpikeDebugTracker();
    const tick = makeReadyTick(100_000, 100_093);
    const snap = tracker.observeTick(tick, 0.001, 0.85)!;
    expect(snap.classification).toBe("borderline");
    expect(snap.thresholdRatio).toBeCloseTo(0.93, 2);
    const line = SpikeDebugTracker.formatTickDebugLine(snap);
    expect(line).toContain("cls borderline");
  });
});
