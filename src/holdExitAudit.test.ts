import { describe, expect, it } from "vitest";
import {
  aggregateHoldExitAudits,
  buildHoldExitAudit,
  EXIT_AUDIT_NEAR_STOP_PRICE,
  EXIT_AUDIT_NEAR_TARGET_PRICE,
} from "./holdExitAudit.js";

describe("buildHoldExitAudit", () => {
  it("flags timeout-only when mark never approached target or stop bands", () => {
    const a = buildHoldExitAudit({
      entryPrice: 0.4895,
      exitMark: 0.4895,
      holdMarkMin: 0.4895,
      holdMarkMax: 0.4895,
      configExitPrice: 0.52,
      configStopLoss: 0.085,
      exitReason: "timeout",
    });
    expect(a.minGapToProfitTarget).toBeCloseTo(0.52 - 0.4895, 10);
    expect(a.minBufferAboveStop).toBeCloseTo(0.4895 - 0.085, 10);
    expect(a.targetWithinNearPriceBand).toBe(false);
    expect(a.stopWithinNearPriceBand).toBe(false);
    expect(a.timeoutLikelyOnlyViableExit).toBe(true);
    expect(a.maxFavorableExcursion).toBe(0);
    expect(a.maxAdverseExcursion).toBe(0);
  });

  it("detects near-target when high mark gets within EXIT_AUDIT_NEAR_TARGET_PRICE of TP", () => {
    const a = buildHoldExitAudit({
      entryPrice: 0.48,
      exitMark: 0.5,
      holdMarkMin: 0.47,
      holdMarkMax: 0.505,
      configExitPrice: 0.52,
      configStopLoss: 0.05,
      exitReason: "timeout",
    });
    expect(a.minGapToProfitTarget).toBeCloseTo(0.015, 10);
    expect(a.targetWithinNearPriceBand).toBe(true);
    expect(a.timeoutLikelyOnlyViableExit).toBe(false);
  });

  it("profit exit still records excursions; target band may be true if mark touched TP", () => {
    const a = buildHoldExitAudit({
      entryPrice: 0.4,
      exitMark: 0.55,
      holdMarkMin: 0.39,
      holdMarkMax: 0.55,
      configExitPrice: 0.52,
      configStopLoss: 0.05,
      exitReason: "profit",
    });
    expect(a.minGapToProfitTarget).toBeLessThanOrEqual(0);
    expect(a.targetWithinNearPriceBand).toBe(true);
    expect(a.timeoutLikelyOnlyViableExit).toBe(false);
  });

  it("binary mode attaches binaryPriceSide with price-point gaps and deltas", () => {
    const a = buildHoldExitAudit({
      mode: "binary",
      entryPrice: 0.49,
      exitMark: 0.52,
      holdMarkMin: 0.48,
      holdMarkMax: 0.53,
      takeProfitPriceDelta: 0.05,
      stopLossPriceDelta: 0.05,
      exitReason: "profit",
    });
    expect(a.binaryPriceSide).toBeDefined();
    expect(a.binaryPriceSide!.profitTargetPrice).toBeCloseTo(0.54, 8);
    expect(a.binaryPriceSide!.stopLossThresholdPrice).toBeCloseTo(0.44, 8);
    expect(a.binaryPriceSide!.maxFavorableExcursionPoints).toBeCloseTo(
      0.53 - 0.49,
      8
    );
    expect(a.binaryPriceSide!.maxAdverseExcursionPoints).toBeCloseTo(
      0.49 - 0.48,
      8
    );
    expect(a.configExitPrice).toBeCloseTo(0.54, 8);
    expect(a.configStopLoss).toBeCloseTo(0.44, 8);
  });
});

describe("aggregateHoldExitAudits", () => {
  it("returns null when no audits attached", () => {
    expect(aggregateHoldExitAudits([{ exitReason: "timeout" }])).toBeNull();
  });

  it("aggregates timeout-only rate", () => {
    const t1 = buildHoldExitAudit({
      entryPrice: 0.49,
      exitMark: 0.49,
      holdMarkMin: 0.49,
      holdMarkMax: 0.49,
      configExitPrice: 0.52,
      configStopLoss: 0.08,
      exitReason: "timeout",
    });
    const t2 = buildHoldExitAudit({
      entryPrice: 0.48,
      exitMark: 0.52,
      holdMarkMin: 0.47,
      holdMarkMax: 0.53,
      configExitPrice: 0.52,
      configStopLoss: 0.08,
      exitReason: "profit",
    });
    const s = aggregateHoldExitAudits([
      { holdExitAudit: t1, exitReason: "timeout" },
      { holdExitAudit: t2, exitReason: "profit" },
    ]);
    expect(s).not.toBeNull();
    expect(s!.tradesAudited).toBe(2);
    expect(s!.closedByTimeout).toBe(1);
    expect(s!.timeoutsLikelyOnlyViableExit).toBe(1);
    expect(s!.pctTimeoutsOnlyViableExit).toBe(100);
    expect(s!.nearTargetPriceThreshold).toBe(EXIT_AUDIT_NEAR_TARGET_PRICE);
    expect(s!.nearStopPriceThreshold).toBe(EXIT_AUDIT_NEAR_STOP_PRICE);
  });

  it("adds binaryOutcomeExitAudit when binaryPriceSide audits exist", () => {
    const b = buildHoldExitAudit({
      mode: "binary",
      entryPrice: 0.49,
      exitMark: 0.52,
      holdMarkMin: 0.48,
      holdMarkMax: 0.53,
      takeProfitPriceDelta: 0.05,
      stopLossPriceDelta: 0.05,
      exitReason: "profit",
    });
    const s = aggregateHoldExitAudits([
      { holdExitAudit: b, exitReason: "profit" },
    ]);
    expect(s?.binaryOutcomeExitAudit).toBeDefined();
    expect(s!.binaryOutcomeExitAudit!.tradesAudited).toBe(1);
    expect(s!.binaryOutcomeExitAudit!.avgConfiguredTakeProfitDelta).toBeCloseTo(0.05, 8);
  });
});
