import { describe, expect, it } from "vitest";

import type { HoldExitAudit } from "../holdExitAudit.js";

import {
  computeBinaryRunAnalyticsFromJsonlRows,
  edgeBucketForModelEdge,
  formatBinaryYesNoComparativeConsole,
} from "./binaryRunAnalytics.js";

describe("binaryRunAnalytics", () => {
  it("edgeBucketForModelEdge uses fixed buckets", () => {
    expect(edgeBucketForModelEdge(0)).toBe("<0.01");
    expect(edgeBucketForModelEdge(0.009)).toBe("<0.01");
    expect(edgeBucketForModelEdge(0.01)).toBe("0.01-0.03");
    expect(edgeBucketForModelEdge(0.029)).toBe("0.01-0.03");
    expect(edgeBucketForModelEdge(0.03)).toBe("0.03-0.05");
    expect(edgeBucketForModelEdge(0.049)).toBe("0.03-0.05");
    expect(edgeBucketForModelEdge(0.05)).toBe("0.03-0.05");
    expect(edgeBucketForModelEdge(Number.NaN)).toBe("unknown");
  });

  it("aggregates opportunities and binary trades from JSONL-shaped rows", () => {
    const report = computeBinaryRunAnalyticsFromJsonlRows({
      opportunityRows: [
        { opportunityType: "strong_spike", qualityProfile: "strong", status: "rejected" },
        { opportunityType: "borderline", qualityProfile: "weak", status: "rejected" },
      ],
      tradeRows: [
        {
          marketMode: "binary",
          netPnlUsdt: 0.5,
          exitReason: "profit",
          outcomeTokenBought: "YES",
          entryQualityProfile: "strong",
          entryModelEdge: 0.02,
        },
        {
          marketMode: "binary",
          netPnlUsdt: -0.2,
          exitReason: "timeout",
          outcomeTokenBought: "NO",
          entryQualityProfile: "exceptional",
          entryModelEdge: 0.06,
        },
      ],
      borderlineFunnel: {
        borderlineEntered: 2,
        borderlinePromoted: 1,
        borderlineRejectedTimeout: 1,
        borderlineRejectedWeak: 3,
      },
      openedTradesOverride: 5,
    });
    expect(report.schema).toBe("binary_run_analytics_v3");
    expect(report.opportunitiesTotal).toBe(2);
    expect(report.opportunitiesByType.strong_spike).toBe(1);
    expect(report.opportunitiesByType.borderline).toBe(1);
    expect(report.closedTrades).toBe(2);
    expect(report.openedTrades).toBe(5);
    expect(report.winRate).toBe(50);
    expect(report.pnlTotal).toBeCloseTo(0.3, 6);
    expect(report.timeoutRate).toBe(50);
    expect(report.edgeBucketBreakdown["0.01-0.03"]).toBe(1);
    expect(report.edgeBucketBreakdown[">0.05"]).toBe(1);
    expect(report.tradeOutcomeBreakdown.byExit.take_profit).toBe(1);
    expect(report.tradeOutcomeBreakdown.byExit.timeout).toBe(1);
    expect(report.tradeOutcomeBreakdown.byOutcomeSide.YES.count).toBe(1);
    expect(report.tradeOutcomeBreakdown.byOutcomeSide.NO.count).toBe(1);
    expect(report.borderlineFunnelBreakdown.borderlineEntered).toBe(2);
    expect(report.invalidMarketPricesSubreasonBreakdown.unknown).toBe(0);
    expect(report.invalidMarketPricesSubreasonBreakdown.invalid_price_not_finite).toBe(
      0
    );
    expect(report.mispricingBucketTradeStats).toHaveLength(5);
    const mp01 = report.mispricingBucketTradeStats.find((r) => r.bucket === "0.01-0.03");
    expect(mp01?.trades).toBe(1);
    expect(mp01?.pnlTotal).toBeCloseTo(0.5, 6);
    expect(mp01?.winRatePercent).toBe(100);
    const mpHigh = report.mispricingBucketTradeStats.find((r) => r.bucket === ">0.05");
    expect(mpHigh?.trades).toBe(1);
    expect(mpHigh?.pnlTotal).toBeCloseTo(-0.2, 6);
    expect(mpHigh?.winRatePercent).toBe(0);
  });

  it("mispricing buckets aggregate avg MFE MAE from holdExitAudit when present", () => {
    const audit = {
      maxFavorableExcursion: 0.03,
      maxAdverseExcursion: 0.02,
    } as HoldExitAudit;
    const report = computeBinaryRunAnalyticsFromJsonlRows({
      opportunityRows: [],
      tradeRows: [
        {
          marketMode: "binary",
          netPnlUsdt: 1,
          exitReason: "profit",
          outcomeTokenBought: "YES",
          entryModelEdge: 0.015,
          holdExitAudit: audit,
        },
      ],
    });
    const row = report.mispricingBucketTradeStats.find((r) => r.bucket === "0.01-0.03");
    expect(row?.trades).toBe(1);
    expect(row?.avgMfe).toBeCloseTo(0.03, 6);
    expect(row?.avgMae).toBeCloseTo(0.02, 6);
  });

  it("counts invalid_market_prices subreasons on binary rejected opportunities", () => {
    const report = computeBinaryRunAnalyticsFromJsonlRows({
      opportunityRows: [
        {
          marketMode: "binary",
          status: "rejected",
          entryRejectionReasons: ["invalid_market_prices"],
          invalidMarketPricesAudit: {
            subreason: "invalid_crossed_or_inverted_book",
          },
        },
        {
          marketMode: "binary",
          status: "rejected",
          entryRejectionReasons: ["invalid_market_prices"],
        },
        { marketMode: "binary", status: "valid", entryRejectionReasons: [] },
      ],
      tradeRows: [],
    });
    expect(
      report.invalidMarketPricesSubreasonBreakdown.invalid_crossed_or_inverted_book
    ).toBe(1);
    expect(report.invalidMarketPricesSubreasonBreakdown.unknown).toBe(1);
  });

  it("aggregates YES vs NO funnel and trade metrics (comparative)", () => {
    const report = computeBinaryRunAnalyticsFromJsonlRows({
      opportunityRows: [
        {
          marketMode: "binary",
          status: "rejected",
          entryOutcomeSide: "YES",
          entryRejectionPrimaryBlocker: "invalid_market_prices",
          estimatedProbabilityUp: 0.55,
          yesPrice: 0.5,
          noPrice: 0.5,
          bestBid: 0.49,
          bestAsk: 0.51,
          midPrice: 0.5,
          spreadBps: 400,
        },
        {
          marketMode: "binary",
          status: "valid",
          entryOutcomeSide: "YES",
          estimatedProbabilityUp: 0.6,
          yesPrice: 0.52,
          noPrice: 0.48,
          bestBid: 0.51,
          bestAsk: 0.53,
          midPrice: 0.52,
          spreadBps: 400,
        },
        {
          marketMode: "binary",
          status: "rejected",
          entryOutcomeSide: "NO",
          entryRejectionPrimaryBlocker: "quality_gate_rejected",
          estimatedProbabilityUp: 0.4,
          yesPrice: 0.55,
          noPrice: 0.45,
          bestBid: 0.44,
          bestAsk: 0.46,
          midPrice: 0.45,
          spreadBps: 400,
        },
      ],
      tradeRows: [
        {
          marketMode: "binary",
          netPnlUsdt: 0.1,
          exitReason: "profit",
          outcomeTokenBought: "YES",
          entryModelEdge: 0.04,
          entryOutcomePrice: 0.52,
          holdDurationMs: 5000,
        },
        {
          marketMode: "binary",
          netPnlUsdt: -0.05,
          exitReason: "stop",
          outcomeTokenBought: "NO",
          entryModelEdge: 0.03,
          entryOutcomePrice: 0.46,
          holdDurationMs: 2000,
        },
      ],
    });

    const yn = report.yesNoComparative;
    expect(yn.YES.opportunitiesSeen).toBe(2);
    expect(yn.YES.opportunitiesRejected).toBe(1);
    expect(yn.YES.validOpportunities).toBe(1);
    expect(yn.YES.tradesClosed).toBe(1);
    expect(yn.YES.pnlTotal).toBeCloseTo(0.1, 6);
    expect(yn.YES.primaryRejectionReasons[0]?.reason).toBe("invalid_market_prices");

    expect(yn.NO.opportunitiesSeen).toBe(1);
    expect(yn.NO.opportunitiesRejected).toBe(1);
    expect(yn.NO.tradesClosed).toBe(1);
    expect(yn.NO.winRatePercent).toBe(0);

    expect(yn.outcomeSideUnknown.opportunitiesSeen).toBe(0);

    const block = formatBinaryYesNoComparativeConsole(yn);
    expect(block).toContain("YES (bought leg)");
    expect(block).toContain("NO (bought leg)");
  });
});
