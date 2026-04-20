import { describe, expect, it } from "vitest";

import {
  buildSessionInterpretationLines,
  isBinaryVenueGenuinelyFlat,
  isBinaryVenueLikelyStale,
  isBinaryVenueRepricingActively,
} from "./binarySessionInterpretation.js";
import type { BinaryQuoteSessionSnapshot } from "../binary/monitor/binaryMonitorQuoteStats.js";

function q(partial: Partial<BinaryQuoteSessionSnapshot>): BinaryQuoteSessionSnapshot {
  return {
    uniqueQuotePairsObserved: 1,
    quoteChangeCount: 0,
    flatQuoteTicks: 0,
    flatQuotePercent: 0,
    ticksWithValidQuote: 0,
    maxBtcSignalTickMovePct: 0,
    maxBtcRollingWindowRangePct: 0,
    maxYesTickMoveAbs: 0,
    maxNoTickMoveAbs: 0,
    ...partial,
  };
}

const baseRuntime = {
  ticksObserved: 120,
  noSignalMoves: 100,
  borderlineMoves: 5,
  strongSpikeMoves: 5,
  validOpportunities: 0,
  rejectedOpportunities: 0,
  rejectedByWeakSpikeQuality: 0,
  blockedByInvalidQuotes: 0,
  blockedByExpensiveOppositeSide: 0,
  blockedByNeutralQuotes: 0,
  rejectedByPriorRangeTooWide: 0,
  rejectedByHardUnstableContext: 0,
  cooldownOverridesUsed: 0,
  exceptionalSpikeEntries: 0,
};

describe("isBinaryVenueGenuinelyFlat / isBinaryVenueRepricingActively", () => {
  it("flags genuinely sticky venue (high flat quote %)", () => {
    const snap = q({
      ticksWithValidQuote: 20,
      flatQuotePercent: 55,
      quoteChangeCount: 9,
      uniqueQuotePairsObserved: 3,
    });
    expect(isBinaryVenueGenuinelyFlat(snap)).toBe(true);
    expect(isBinaryVenueRepricingActively(snap)).toBe(false);
  });

  it("flags active repricing when flat % is low (e.g. synthetic churn)", () => {
    const snap = q({
      ticksWithValidQuote: 200,
      flatQuotePercent: 1.36,
      quoteChangeCount: 197,
      uniqueQuotePairsObserved: 80,
    });
    expect(isBinaryVenueGenuinelyFlat(snap)).toBe(false);
    expect(isBinaryVenueRepricingActively(snap)).toBe(true);
  });
});

describe("isBinaryVenueLikelyStale", () => {
  it("detects few valid quotes vs many monitor ticks", () => {
    expect(
      isBinaryVenueLikelyStale(
        { ...baseRuntime, ticksObserved: 50 },
        q({ ticksWithValidQuote: 2 })
      )
    ).toBe(true);
    expect(
      isBinaryVenueLikelyStale(
        { ...baseRuntime, ticksObserved: 50 },
        q({ ticksWithValidQuote: 20 })
      )
    ).toBe(false);
  });
});

describe("buildSessionInterpretationLines", () => {
  it("binary + active repricing + dominant no-signal: does not claim market too flat", () => {
    const lines = buildSessionInterpretationLines({
      marketMode: "binary",
      runtime: baseRuntime,
      binaryQuote: q({
        ticksWithValidQuote: 200,
        flatQuotePercent: 1.36,
        quoteChangeCount: 197,
        uniqueQuotePairsObserved: 90,
      }),
    });
    expect(lines.some((l) => l === "market too flat")).toBe(false);
    expect(
      lines.some((l) =>
        l.includes("venue repriced often") || l.includes("below spike/borderline")
      )
    ).toBe(true);
  });

  it("binary + genuinely flat venue: emits market too flat", () => {
    const lines = buildSessionInterpretationLines({
      marketMode: "binary",
      runtime: { ...baseRuntime, noSignalMoves: 20, borderlineMoves: 40, strongSpikeMoves: 40 },
      binaryQuote: q({
        ticksWithValidQuote: 25,
        flatQuotePercent: 48,
        quoteChangeCount: 12,
        uniqueQuotePairsObserved: 2,
      }),
    });
    expect(lines).toContain("market too flat");
  });

  it("binary + likely stale venue: warns about feed", () => {
    const lines = buildSessionInterpretationLines({
      marketMode: "binary",
      runtime: { ...baseRuntime, ticksObserved: 40 },
      binaryQuote: q({ ticksWithValidQuote: 2 }),
    });
    expect(lines.some((l) => l.includes("stale venue") || l.includes("feed wiring"))).toBe(
      true
    );
  });

  it("spot mode keeps BTC-centric market too flat when no-signal dominates", () => {
    const lines = buildSessionInterpretationLines({
      marketMode: "spot",
      runtime: baseRuntime,
      binaryQuote: null,
    });
    expect(lines).toContain("market too flat");
  });

  it("binary + dominant no-signal + moderate churn: uses movement line, not market too flat", () => {
    const lines = buildSessionInterpretationLines({
      marketMode: "binary",
      runtime: baseRuntime,
      binaryQuote: q({
        ticksWithValidQuote: 15,
        flatQuotePercent: 30,
        quoteChangeCount: 10,
        uniqueQuotePairsObserved: 8,
      }),
    });
    expect(lines).not.toContain("market too flat");
    expect(lines.some((l) => l.includes("moderate venue churn"))).toBe(true);
  });
});
