import { describe, expect, it } from "vitest";
import type { Opportunity } from "./opportunityTracker.js";
import {
  computeStrongSpikeGateFunnel,
  formatGateFunnelSection,
} from "./monitorFunnelDiagnostics.js";
import {
  normalizeOpportunityRejectionReasons,
  pickPrimaryRejectionBlocker,
} from "./rejectionReasons.js";

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
      priorRangeFraction: 0.001,
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
  const {
    entryRejectionReasons: erOver,
    entryRejectionPrimaryBlocker: pbOver,
    entryAllowed: allowedOver,
    status: statusOver,
    opportunityOutcome: outcomeOver,
    qualityProfile: qpOver,
    qualityGateDiagnostics: qgOver,
    ...restOver
  } = over;
  const entryRejectionReasons = erOver ?? ["quality_gate_rejected"];
  const entryAllowed = allowedOver ?? false;
  const status = statusOver ?? "rejected";
  const opportunityOutcome =
    outcomeOver ?? (entryAllowed ? "entered_immediate" : "rejected");
  const qualityProfile = qpOver ?? "weak";
  const qualityGateDiagnostics = qgOver ?? diag(false);
  const entryRejectionPrimaryBlocker =
    pbOver ??
    (entryAllowed
      ? null
      : pickPrimaryRejectionBlocker(
          normalizeOpportunityRejectionReasons({
            rawReasons: entryRejectionReasons,
            movementClassification: "strong_spike",
          })
        ));
  return {
    timestamp: 0,
    btcPrice: 100_000,
    previousPrice: 100_000,
    currentPrice: 100_050,
    spikeDirection: "UP",
    spikePercent: 0.2,
    spikeSource: "tick-1",
    spikeReferencePrice: 100_000,
    priorRangeFraction: 0.0005,
    bestBid: 0.49,
    bestAsk: 0.51,
    midPrice: 0.5,
    spreadBps: 40,
    stableRangeDetected: true,
    stableRangeQuality: "good",
    spikeDetected: true,
    movementClassification: "strong_spike",
    movementThresholdRatio: 2,
    opportunityType: "strong_spike",
    opportunityOutcome,
    tradableSpikeMinPercent: 0.0015,
    qualityProfile,
    qualityGateDiagnostics,
    entryAllowed,
    entryRejectionReasons,
    entryRejectionPrimaryBlocker,
    status,
    ...restOver,
  };
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
      strongBase({
        entryRejectionReasons: ["quality_gate_rejected"],
        qualityGateDiagnostics: diag(false),
      }),
    ];
    const f = computeStrongSpikeGateFunnel({
      opportunities,
      borderlineCandidatesCreated: 2,
      tradesExecuted: 1,
    });
    expect(f.spikesDetected).toBe(5);
    expect(f.passedQuoteGate).toBe(5);
    expect(f.passedUnstableContextGate).toBe(4);
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

  it("uses runtime strategy-approved ticks so opened % is not inflated vs zero JSONL-valid", () => {
    const f = computeStrongSpikeGateFunnel({
      opportunities: [],
      borderlineCandidatesCreated: 0,
      tradesExecuted: 3,
      strategyApprovedEntryTicks: 3,
    });
    expect(f.validOpportunities).toBe(0);
    expect(f.strategyApprovedEntryTicks).toBe(3);
    const block = formatGateFunnelSection(f).join("\n");
    expect(block).toContain("Opened trades (paper sim)");
    expect(block).toMatch(/100\.0% of max\(JSONL-valid, runtime-approved\)/);
  });
});
