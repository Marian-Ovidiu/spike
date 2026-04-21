import { describe, expect, it } from "vitest";

import type { EntryEvaluation } from "../../entryConditions.js";
import {
  BINARY_PRE_ENTRY_AUDIT_TAG,
  buildBinaryPreEntryAuditRecord,
  formatBinaryPreEntryAuditBlock,
} from "./binaryPreEntryAudit.js";

function baseEntry(direction: EntryEvaluation["direction"]): EntryEvaluation {
  return {
    shouldEnter: true,
    direction,
    reasons: [],
    stableRangeDetected: true,
    priorRangeFraction: 0.1,
    stableRangeQuality: "good",
    rangeDecisionNote: "test",
    movementClassification: "strong_spike",
    spikeDetected: true,
    movement: {
      strongestMovePercent: 0.01,
      strongestMoveAbsolute: 0.2,
      strongestMoveDirection: direction === "UP" ? "DOWN" : "UP",
      thresholdPercent: 0.005,
      thresholdRatio: 2,
      classification: "strong_spike",
      sourceWindowLabel: "tick-1",
    },
    windowSpike: undefined,
  };
}

function parseAuditJsonBlock(block: string): Record<string, unknown> {
  const i = block.indexOf("{");
  if (i < 0) throw new Error("no JSON in block");
  return JSON.parse(block.slice(i)) as Record<string, unknown>;
}

describe("binaryPreEntryAudit", () => {
  it("format block starts with tag and round-trips JSON with expected keys", () => {
    const record = buildBinaryPreEntryAuditRecord({
      entry: baseEntry("UP"),
      venueYesMid: 0.5,
      venueNoMid: 0.5,
      resolvedYesAsk: 0.51,
      resolvedNoAsk: 0.52,
      estimatedProbabilityUp: 0.4,
      entryModelEdge: 0.09,
      minEdgeThreshold: 0.03,
      qualityProfile: "strong",
      action: "enter",
      primaryRejectionReason: null,
    });
    const block = formatBinaryPreEntryAuditBlock(record);
    expect(block.startsWith(BINARY_PRE_ENTRY_AUDIT_TAG)).toBe(true);
    const o = parseAuditJsonBlock(block);
    expect(o).toMatchObject({
      spikeDirection: "DOWN",
      movementClassification: "strong_spike",
      strategyDirection: "UP",
      chosenSide: "YES",
      momentumProbabilityUp: 0.4,
      fairProbabilityBuyLeg: 0.6,
      edgeStrategySemantics: "contrarian_mean_reversion",
      venueYesMid: 0.5,
      venueNoMid: 0.5,
      resolvedYesAsk: 0.51,
      resolvedNoAsk: 0.52,
      entryModelEdge: 0.09,
      minEdgeThreshold: 0.03,
      qualityProfile: "strong",
      action: "enter",
      primaryRejectionReason: null,
    });
  });

  it("reject path carries primaryRejectionReason", () => {
    const record = buildBinaryPreEntryAuditRecord({
      entry: baseEntry("DOWN"),
      venueYesMid: 0.55,
      venueNoMid: 0.45,
      resolvedYesAsk: 0.56,
      resolvedNoAsk: 0.46,
      estimatedProbabilityUp: 0.35,
      entryModelEdge: -0.02,
      minEdgeThreshold: 0,
      qualityProfile: undefined,
      action: "reject",
      primaryRejectionReason: "negative_or_zero_model_edge",
    });
    const o = parseAuditJsonBlock(formatBinaryPreEntryAuditBlock(record));
    expect(o.action).toBe("reject");
    expect(o.primaryRejectionReason).toBe("negative_or_zero_model_edge");
    expect(o.chosenSide).toBe("NO");
    expect(o.fairProbabilityBuyLeg).toBeCloseTo(0.35, 8);
    expect(o.edgeStrategySemantics).toBe("contrarian_mean_reversion");
  });
});
