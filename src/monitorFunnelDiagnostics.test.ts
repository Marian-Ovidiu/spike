import { describe, expect, it } from "vitest";
import type { Opportunity } from "./opportunityTracker.js";
import { computeStrongSpikeGateFunnel } from "./monitorFunnelDiagnostics.js";

function diag(passed: boolean) {
  return {
    classification: "rule_based" as const,
    effectiveThresholds: {
      tradableSpikeMinPercent: 0.0015,
      exceptionalSpikeMinPercent: 0.0025,
      maxPriorRangeForNormalEntry: 0.0015,
    },
    inputs: {
      movementClassification: "strong_spike" as const,
      strongestMovePercent: 0.002,
      spikePercent: 0.2,
      thresholdRatio: 2,
      priorRangePercent: 0.001,
      stableRangeDetected: true,
      stableRangeQuality: "good" as const,
      entryReasonCodes: [],
    },
    profileAfterSpikeSizeTier: "strong" as const,
    ruleChecks: [],
    downgradeChain: [],
    finalProfile: "strong" as const,
    qualityGatePassed: passed,
    weakPrimaryReasons: [] as string[],
  };
}

function strongBase(over: Partial<Opportunity>): Opportunity {
  const o: Opportunity = {
    timestamp: 0,
    btcPrice: 100_000,
    previousPrice: 100_000,
    currentPrice: 100_050,
    spikeDirection: "UP",
    spikePercent: 0.2,
    spikeSource: "tick-1",
    spikeReferencePrice: 100_000,
    priorRangePercent: 0.0005,
    upSidePrice: 0.35,
    downSidePrice: 0.65,
    stableRangeDetected: true,
    stableRangeQuality: "good",
    spikeDetected: true,
    movementClassification: "strong_spike",
    movementThresholdRatio: 2,
    opportunityType: "strong_spike",
    opportunityOutcome: "rejected",
    tradableSpikeMinPercent: 0.0015,
    qualityProfile: "weak",
    qualityGateDiagnostics: diag(false),
    entryAllowed: false,
    entryRejectionReasons: ["quality_gate_rejected"],
    status: "rejected",
    ...over,
  };
  return o;
}

describe("computeStrongSpikeGateFunnel", () => {
  it("counts nested survival and dominant blocker", () => {
    const opportunities: Opportunity[] = [
      strongBase({
        status: "valid",
        entryAllowed: true,
        entryRejectionReasons: [],
        opportunityOutcome: "entered_immediate",
        qualityGateDiagnostics: diag(true),
        qualityProfile: "strong",
      }),
      strongBase({
        entryRejectionReasons: ["hard_reject_unstable_pre_spike_context"],
        qualityGateDiagnostics: diag(false),
      }),
      strongBase({
        entryRejectionReasons: ["quality_gate_rejected"],
        qualityGateDiagnostics: diag(false),
      }),
      strongBase({
        entryRejectionReasons: [
          "quality_gate_rejected",
          "prior_range_too_wide_for_mean_reversion",
        ],
        qualityGateDiagnostics: diag(false),
      }),
    ];
    const f = computeStrongSpikeGateFunnel({
      opportunities,
      borderlineCandidatesCreated: 2,
      tradesExecuted: 1,
    });
    expect(f.spikesDetected).toBe(4);
    expect(f.passedQuoteGate).toBe(4);
    expect(f.passedUnstableContextGate).toBe(3);
    expect(f.validOpportunities).toBe(1);
    expect(f.rejectedWithMultipleNormalizedReasons).toBe(1);
    expect(f.dominantPrimaryBlocker?.reason).toBe("quality_gate_rejected");
    expect(f.topReasonCombinations.some((c) => c.combo.includes("quality_gate"))).toBe(
      true
    );
    expect(f.borderlineCandidatesCreated).toBe(2);
  });

  it("ignores borderline-only rows", () => {
    const borderline: Opportunity = {
      ...strongBase({}),
      opportunityType: "borderline",
      movementClassification: "borderline",
    };
    const f = computeStrongSpikeGateFunnel({
      opportunities: [borderline],
      borderlineCandidatesCreated: 0,
      tradesExecuted: 0,
    });
    expect(f.spikesDetected).toBe(0);
  });
});
