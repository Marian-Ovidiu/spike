import { describe, expect, it } from "vitest";
import { normalizeDecisionRejectionReasons } from "./rejectionReasons.js";
import type { StrategyDecision } from "./strategyDecisionPipeline.js";

function baseDecision(
  partial: Partial<StrategyDecision>
): StrategyDecision {
  return {
    action: "none",
    direction: null,
    stableRangeQuality: "good",
    movementClassification: "no_signal",
    spikeDetected: false,
    fastPathUsed: false,
    reason: "no_actionable_signal",
    ...partial,
  };
}

describe("normalizeDecisionRejectionReasons", () => {
  it("maps strong spike cooldown blocker", () => {
    const reasons = normalizeDecisionRejectionReasons({
      decision: baseDecision({
        movementClassification: "strong_spike",
        spikeDetected: true,
        criticalBlockerUsed: "active_position_or_cooldown",
      }),
      entry: { movementClassification: "strong_spike", reasons: [] },
      hasOpenPosition: false,
    });
    expect(reasons).toEqual(["entry_cooldown_active"]);
  });

  it("maps borderline create as watch pending", () => {
    const reasons = normalizeDecisionRejectionReasons({
      decision: baseDecision({
        action: "create_borderline_candidate",
        movementClassification: "borderline",
      }),
      entry: { movementClassification: "borderline", reasons: [] },
    });
    expect(reasons).toEqual(["borderline_watch_pending"]);
  });

  it("maps no_signal to below borderline reason", () => {
    const reasons = normalizeDecisionRejectionReasons({
      decision: baseDecision({
        movementClassification: "no_signal",
      }),
      entry: {
        movementClassification: "no_signal",
        reasons: ["spike_not_strong_enough"],
      },
    });
    expect(reasons).toEqual(["no_signal_below_borderline"]);
  });

  it("maps strict prior-range rejection reason", () => {
    const reasons = normalizeDecisionRejectionReasons({
      decision: baseDecision({
        movementClassification: "strong_spike",
        reason: "prior_range_too_wide_for_mean_reversion",
      }),
      entry: {
        movementClassification: "strong_spike",
        reasons: ["prior_range_too_wide_for_mean_reversion"],
      },
    });
    expect(reasons).toContain("prior_range_too_wide_for_mean_reversion");
  });

  it("maps hard reject unstable pre-spike reason", () => {
    const reasons = normalizeDecisionRejectionReasons({
      decision: baseDecision({
        movementClassification: "strong_spike",
        reason: "hard_reject_unstable_pre_spike_context",
      }),
      entry: {
        movementClassification: "strong_spike",
        reasons: ["hard_reject_unstable_pre_spike_context"],
      },
    });
    expect(reasons).toContain("hard_reject_unstable_pre_spike_context");
  });

  it("maps neutral market quote rejection reason", () => {
    const reasons = normalizeDecisionRejectionReasons({
      decision: baseDecision({
        movementClassification: "strong_spike",
        reason: "market_quotes_too_neutral",
      }),
      entry: {
        movementClassification: "strong_spike",
        reasons: ["market_quotes_too_neutral"],
      },
    });
    expect(reasons).toContain("market_quotes_too_neutral");
  });

  it("maps strong spike continuation reason", () => {
    const reasons = normalizeDecisionRejectionReasons({
      decision: baseDecision({
        movementClassification: "strong_spike",
        reason: "strong_spike_confirmation_continuation",
      }),
      entry: {
        movementClassification: "strong_spike",
        reasons: ["strong_spike_confirmation_continuation"],
      },
    });
    expect(reasons).toContain("strong_spike_continuation");
  });
});

