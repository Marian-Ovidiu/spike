import { describe, expect, it } from "vitest";
import {
  normalizeDecisionRejectionReasons,
  normalizeOpportunityRejectionReasons,
  pickPrimaryRejectionBlocker,
} from "./rejectionReasons.js";
import type { StrategyDecision } from "./strategy/strategyDecisionPipeline.js";

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

describe("normalizeOpportunityRejectionReasons", () => {
  it("maps binary model edge rejection codes", () => {
    expect(
      normalizeOpportunityRejectionReasons({
        rawReasons: ["negative_or_zero_model_edge"],
        movementClassification: "strong_spike",
      })
    ).toEqual(["negative_or_zero_model_edge"]);
    expect(
      normalizeOpportunityRejectionReasons({
        rawReasons: ["binary_model_edge_below_min_threshold"],
        movementClassification: "strong_spike",
      })
    ).toEqual(["model_edge_below_min_threshold"]);
  });

  it("maps pipeline watch / quality strings to explicit pipeline_* codes", () => {
    expect(
      normalizeOpportunityRejectionReasons({
        rawReasons: ["quality_gate_requires_delayed_confirmation"],
        movementClassification: "strong_spike",
      })
    ).toEqual(["pipeline_delayed_confirmation_failed"]);
    expect(
      normalizeOpportunityRejectionReasons({
        rawReasons: [
          "borderline_mode_off_strong_spike_requires_strong_or_exceptional_quality",
        ],
        movementClassification: "strong_spike",
      })
    ).toEqual(["pipeline_profile_weak"]);
    expect(
      normalizeOpportunityRejectionReasons({
        rawReasons: ["strong_spike_confirmation_noisy_unclear"],
        movementClassification: "strong_spike",
      })
    ).toEqual(["pipeline_confirmation_noise"]);
    expect(
      normalizeOpportunityRejectionReasons({
        rawReasons: ["strong_spike_confirmation_tick_pending_review"],
        movementClassification: "strong_spike",
      })
    ).toEqual(["pipeline_confirmation_noise"]);
    expect(
      normalizeOpportunityRejectionReasons({
        rawReasons: ["strong_spike_waiting_confirmation_tick"],
        movementClassification: "strong_spike",
      })
    ).toEqual(["pipeline_watch_path_blocked"]);
  });

  it("keeps legacy pipeline_quality_downgrade token when already normalized", () => {
    expect(
      normalizeOpportunityRejectionReasons({
        rawReasons: ["pipeline_quality_downgrade"],
        movementClassification: "strong_spike",
      })
    ).toEqual(["pipeline_quality_downgrade"]);
  });

  it("maps strong_spike_confirmation_invalid_market_prices to coupled pipeline code", () => {
    expect(
      normalizeOpportunityRejectionReasons({
        rawReasons: ["strong_spike_confirmation_invalid_market_prices"],
        movementClassification: "strong_spike",
      })
    ).toEqual(["pipeline_invalid_market_coupled_downgrade"]);
  });

  it("keeps strong_spike continuation distinct from other strong_spike_confirmation_* codes", () => {
    expect(
      normalizeOpportunityRejectionReasons({
        rawReasons: ["strong_spike_confirmation_continuation"],
        movementClassification: "strong_spike",
      })
    ).toEqual(["strong_spike_continuation"]);
  });
});

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

  it("maps quote_feed_stale critical blocker", () => {
    const reasons = normalizeDecisionRejectionReasons({
      decision: baseDecision({
        movementClassification: "strong_spike",
        spikeDetected: true,
        criticalBlockerUsed: "quote_feed_stale",
        reason: "quote_feed_stale",
      }),
      entry: { movementClassification: "strong_spike", reasons: [] },
    });
    expect(reasons).toContain("quote_feed_stale");
  });

  it("drops redundant quality_gate_rejected when a more specific normalized reason is present", () => {
    const reasons = normalizeDecisionRejectionReasons({
      decision: baseDecision({
        movementClassification: "strong_spike",
        criticalBlockerUsed: "quality_gate_rejected",
        reason: "hard_reject_unstable_pre_spike_context",
      }),
      entry: {
        movementClassification: "strong_spike",
        reasons: ["hard_reject_unstable_pre_spike_context"],
      },
    });
    expect(reasons).toContain("hard_reject_unstable_pre_spike_context");
    expect(reasons).not.toContain("quality_gate_rejected");
  });

  it("drops redundant quality_gate when opposite-side price is the downstream blocker", () => {
    const reasons = normalizeDecisionRejectionReasons({
      decision: baseDecision({
        movementClassification: "strong_spike",
        criticalBlockerUsed: "quality_gate_rejected",
        reason: "opposite_side_price_too_high",
      }),
      entry: {
        movementClassification: "strong_spike",
        reasons: ["opposite_side_price_too_high"],
      },
    });
    expect(reasons).toEqual(["opposite_side_price_too_high"]);
  });

  it("adds pipeline_invalid_market_coupled_downgrade when invalid prices meet confirmation modifier", () => {
    const reasons = normalizeDecisionRejectionReasons({
      decision: baseDecision({
        movementClassification: "strong_spike",
        spikeDetected: true,
        criticalBlockerUsed: "invalid_market_prices",
        reason: "invalid_market_prices",
        pipelineQualityModifier: {
          effectiveQualityProfile: "weak",
          reason: "strong_spike_confirmation_invalid_market_prices",
          preModifierGateProfile: "strong",
        },
      }),
      entry: { movementClassification: "strong_spike", reasons: [] },
    });
    expect(reasons).toContain("invalid_market_prices");
    expect(reasons).toContain("pipeline_invalid_market_coupled_downgrade");
  });
});

describe("pickPrimaryRejectionBlocker", () => {
  it("prefers invalid_market_prices over pipeline detail when both are present", () => {
    expect(
      pickPrimaryRejectionBlocker([
        "pipeline_watch_path_blocked",
        "invalid_market_prices",
        "pipeline_confirmation_noise",
      ])
    ).toBe("invalid_market_prices");
  });

  it("orders pipeline sub-causes: coupled invalid market before profile weak", () => {
    expect(
      pickPrimaryRejectionBlocker([
        "pipeline_profile_weak",
        "pipeline_invalid_market_coupled_downgrade",
      ])
    ).toBe("pipeline_invalid_market_coupled_downgrade");
  });
});
