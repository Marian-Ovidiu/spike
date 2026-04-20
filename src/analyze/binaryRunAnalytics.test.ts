import { describe, expect, it } from "vitest";

import {
  computeBinaryRunAnalyticsFromJsonlRows,
  edgeBucketForModelEdge,
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
  });
});
