import { describe, expect, it } from "vitest";
import { resolvePaperTradeEntryPath } from "./paperEntryPath.js";
import type { StrategyDecision } from "./strategy/strategyDecisionPipeline.js";

function d(
  partial: Pick<StrategyDecision, "action" | "reason">
): Pick<StrategyDecision, "action" | "reason"> {
  return partial;
}

describe("resolvePaperTradeEntryPath", () => {
  it("classifies borderline promote as borderline_promoted", () => {
    expect(
      resolvePaperTradeEntryPath(
        d({ action: "promote_borderline_candidate", reason: "watch_ok" })
      )
    ).toBe("borderline_promoted");
  });

  it("classifies strong-spike watch promote as strong_spike_confirmed", () => {
    expect(
      resolvePaperTradeEntryPath(
        d({
          action: "enter_immediate",
          reason: "strong_spike_confirmed_pause",
        })
      )
    ).toBe("strong_spike_confirmed");
  });

  it("classifies fast-path strong spike as strong_spike_immediate", () => {
    expect(
      resolvePaperTradeEntryPath(
        d({ action: "enter_immediate", reason: "strong_spike_immediate_entry_fast_path" })
      )
    ).toBe("strong_spike_immediate");
  });
});
