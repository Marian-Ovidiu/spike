import { describe, expect, it } from "vitest";
import { buildTradeEntryOpenReason } from "./tradeEntryOpenDiagnosis.js";
import type { StrategyDecision } from "./strategy/strategyDecisionPipeline.js";

function d(overrides: Partial<StrategyDecision>): StrategyDecision {
  return {
    action: "none",
    direction: null,
    stableRangeQuality: "good",
    movementClassification: "no_signal",
    spikeDetected: false,
    fastPathUsed: false,
    reason: "",
    ...overrides,
  } as StrategyDecision;
}

describe("buildTradeEntryOpenReason", () => {
  it("tags strong_spike_confirmed path and watch", () => {
    const r = buildTradeEntryOpenReason(
      d({
        action: "enter_immediate",
        reason: "strong_spike_confirmed_ok",
        qualityProfile: "strong",
      }),
      "strong_spike_confirmed"
    );
    expect(r.entryPath).toBe("strong_spike_confirmed");
    expect(r.routeKind).toBe("strong_spike_confirmation");
    expect(r.passedWatchOrCandidate).toBe(true);
    expect(r.tags).toContain("strong_spike_confirmation_watch");
    expect(r.tags).toContain("entry_path_strong_spike_confirmed");
  });

  it("distinguishes immediate path and fast_path_entry", () => {
    const r = buildTradeEntryOpenReason(
      d({
        action: "enter_immediate",
        reason: "strong_spike_immediate_entry_fast_path",
        qualityProfile: "exceptional",
        fastPathUsed: true,
        cooldownOverridden: true,
        overrideReason: "exceptional_spike_cooldown_override",
      }),
      "strong_spike_immediate"
    );
    expect(r.routeKind).toBe("strong_spike_immediate");
    expect(r.passedWatchOrCandidate).toBe(false);
    expect(r.exceptionalQuality).toBe(true);
    expect(r.tags).toContain("fast_path_entry");
    expect(r.tags).toContain("exceptional_spike_cooldown_override");
    expect(r.tags).toContain("pipeline_fast_path_tick");
  });

  it("borderline promote from entryPath", () => {
    const r = buildTradeEntryOpenReason(
      d({ action: "promote_borderline_candidate", reason: "promote_borderline_candidate" }),
      "borderline_promoted"
    );
    expect(r.routeKind).toBe("borderline_promote");
    expect(r.passedWatchOrCandidate).toBe(true);
    expect(r.tags).toContain("promote_borderline");
    expect(r.tags).toContain("entry_path_borderline_watch");
  });
});
