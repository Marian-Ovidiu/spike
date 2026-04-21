import { describe, expect, it } from "vitest";

import {
  computeBinaryEntryEdge,
  fairBuyLegProbabilityFromMomentumUp,
  modelProbabilityOnBoughtLeg,
} from "./edgeEntryDecision.js";

describe("fairBuyLegProbabilityFromMomentumUp", () => {
  it("contrarian: high momentum p_up does not imply high fair P(YES) — fade uses complement on YES", () => {
    const pUp = 0.85;
    expect(fairBuyLegProbabilityFromMomentumUp(pUp, "YES", "contrarian_mean_reversion")).toBeCloseTo(
      0.15,
      8
    );
  });

  it("contrarian: same momentum p_up is the fair P(NO) when buying NO (not 1−p_up as naive YES-token confusion)", () => {
    const pUp = 0.85;
    const fairNo = fairBuyLegProbabilityFromMomentumUp(pUp, "NO", "contrarian_mean_reversion");
    expect(fairNo).toBeCloseTo(0.85, 8);
    expect(fairNo).not.toBeCloseTo(1 - pUp, 8);
  });

  it("momentum continuation: fair P matches trend model on each leg", () => {
    expect(fairBuyLegProbabilityFromMomentumUp(0.7, "YES", "momentum_continuation")).toBeCloseTo(
      0.7,
      8
    );
    expect(fairBuyLegProbabilityFromMomentumUp(0.7, "NO", "momentum_continuation")).toBeCloseTo(
      0.3,
      8
    );
  });
});

describe("edge coherence: strategy buy side vs computeBinaryEntryEdge", () => {
  it("contrarian DOWN→buy NO: edge = fair(NO) − noAsk uses p_up not (1−p_up) for fair", () => {
    const yesAsk = 0.52;
    const noAsk = 0.46;
    const pUp = 0.72;
    const edge = computeBinaryEntryEdge({
      estimatedProbabilityUp: pUp,
      direction: "DOWN",
      yesAsk,
      noAsk,
    });
    const fairNo = fairBuyLegProbabilityFromMomentumUp(pUp, "NO", "contrarian_mean_reversion");
    expect(fairNo).toBeCloseTo(pUp, 8);
    expect(edge).toBeCloseTo(fairNo - noAsk, 8);
    expect(modelProbabilityOnBoughtLeg(pUp, "NO", "mean_reversion")).toBeCloseTo(fairNo, 8);
  });

  it("contrarian UP→buy YES: edge uses (1−p_up) − yesAsk", () => {
    const pUp = 0.35;
    const yesAsk = 0.51;
    const noAsk = 0.49;
    const edge = computeBinaryEntryEdge({
      estimatedProbabilityUp: pUp,
      direction: "UP",
      yesAsk,
      noAsk,
    });
    const fairYes = fairBuyLegProbabilityFromMomentumUp(pUp, "YES", "contrarian_mean_reversion");
    expect(fairYes).toBeCloseTo(1 - pUp, 8);
    expect(edge).toBeCloseTo(fairYes - yesAsk, 8);
  });
});
