import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { BinaryRunAnalyticsReport, EdgeBucketLabel, MispricingBucketTradeStats } from "./binaryRunAnalytics.js";
import { BINARY_RUN_ANALYTICS_SCHEMA, MISPRICING_BUCKET_DISPLAY_ORDER } from "./binaryRunAnalytics.js";
import {
  computeBinaryMultiSessionAggregate,
  discoverSessionSummaryPaths,
  discoverTradesJsonlPaths,
} from "./binaryMultiSessionAggregate.js";

function emptyEdgeBucketCounts(): Record<EdgeBucketLabel, number> {
  return {
    "<0.01": 0,
    "0.01-0.03": 0,
    "0.03-0.05": 0,
    ">0.05": 0,
    unknown: 0,
  };
}

function minimalMispricingOneTradeYes(): MispricingBucketTradeStats[] {
  return MISPRICING_BUCKET_DISPLAY_ORDER.map((bucket) =>
    bucket === "0.01-0.03"
      ? {
          bucket,
          trades: 1,
          wins: 1,
          winRatePercent: 100,
          pnlTotal: 0.2,
          avgPnlPerTrade: 0.2,
          avgMfe: null,
          avgMae: null,
        }
      : {
          bucket,
          trades: 0,
          wins: 0,
          winRatePercent: 0,
          pnlTotal: 0,
          avgPnlPerTrade: 0,
          avgMfe: null,
          avgMae: null,
        }
  );
}

function emptyMispricingRows(): MispricingBucketTradeStats[] {
  return MISPRICING_BUCKET_DISPLAY_ORDER.map((bucket) => ({
    bucket,
    trades: 0,
    wins: 0,
    winRatePercent: 0,
    pnlTotal: 0,
    avgPnlPerTrade: 0,
    avgMfe: null,
    avgMae: null,
  }));
}

function minimalBinaryRunAnalytics(
  overrides: Partial<BinaryRunAnalyticsReport> = {}
): BinaryRunAnalyticsReport {
  const rootMispricingDefault = minimalMispricingOneTradeYes();
  const yesEdgeTradeCounts: Record<EdgeBucketLabel, number> = {
    "<0.01": 0,
    "0.01-0.03": 1,
    "0.03-0.05": 0,
    ">0.05": 0,
    unknown: 0,
  };
  const emptyEdge = emptyEdgeBucketCounts();

  const base: BinaryRunAnalyticsReport = {
    schema: BINARY_RUN_ANALYTICS_SCHEMA,
    opportunitiesTotal: 0,
    opportunitiesByType: {},
    opportunitiesByQuality: {},
    openedTrades: 1,
    closedTrades: 1,
    winRate: 100,
    pnlTotal: 0.2,
    avgPnlPerTrade: 0.2,
    timeoutRate: 0,
    edgeBucketBreakdown: {
      "<0.01": 0,
      "0.01-0.03": 1,
      "0.03-0.05": 0,
      ">0.05": 0,
      unknown: 0,
    },
    mispricingBucketTradeStats: rootMispricingDefault,
    qualityBucketBreakdown: { strong: 1 },
    borderlineFunnelBreakdown: {
      borderlineEntered: 0,
      borderlinePromoted: 0,
      borderlineRejectedTimeout: 0,
      borderlineRejectedWeak: 0,
    },
    tradeOutcomeBreakdown: {
      byOutcomeSide: {
        YES: { count: 1, wins: 1, netPnl: 0.2 },
        NO: { count: 0, wins: 0, netPnl: 0 },
        unknown: { count: 0, wins: 0, netPnl: 0 },
      },
      byQuality: {
        strong: { count: 1, wins: 1, netPnl: 0.2 },
      },
      byExit: {
        take_profit: 1,
        stop_loss: 0,
        timeout: 0,
        unknown: 0,
      },
    },
    invalidMarketPricesSubreasonBreakdown: {
      unknown: 0,
      invalid_yes_no_bounds: 0,
      invalid_executable_price: 0,
      invalid_crossed_or_inverted_book: 0,
      invalid_price_not_finite: 0,
      invalid_market_price_extreme_reprice: 0,
    },
    yesNoComparative: {
      YES: {
        opportunitiesSeen: 0,
        opportunitiesRejected: 0,
        validOpportunities: 0,
        primaryRejectionReasons: [],
        tradesClosed: 1,
        winRatePercent: 100,
        pnlTotal: 0.2,
        avgPnlPerTrade: 0.2,
        avgOpportunityModelEdge: null,
        avgTradeEntryModelEdge: null,
        avgOpportunityEntryAsk: null,
        avgTradeEntryPrice: null,
        avgMfe: null,
        avgMae: null,
        avgHoldMs: null,
        mispricingBucketTradeStats: rootMispricingDefault,
        edgeBucketTradeCounts: yesEdgeTradeCounts,
        opportunityEdgeBucketCounts: { ...emptyEdge },
        rejectionReasonCounts: [],
      },
      NO: {
        opportunitiesSeen: 0,
        opportunitiesRejected: 0,
        validOpportunities: 0,
        primaryRejectionReasons: [],
        tradesClosed: 0,
        winRatePercent: 0,
        pnlTotal: 0,
        avgPnlPerTrade: 0,
        avgOpportunityModelEdge: null,
        avgTradeEntryModelEdge: null,
        avgOpportunityEntryAsk: null,
        avgTradeEntryPrice: null,
        avgMfe: null,
        avgMae: null,
        avgHoldMs: null,
        mispricingBucketTradeStats: emptyMispricingRows(),
        edgeBucketTradeCounts: { ...emptyEdge },
        opportunityEdgeBucketCounts: { ...emptyEdge },
        rejectionReasonCounts: [],
      },
      outcomeSideUnknown: {
        opportunitiesSeen: 0,
        opportunitiesRejected: 0,
        validOpportunities: 0,
        primaryRejectionReasons: [],
        tradesClosed: 0,
        winRatePercent: 0,
        pnlTotal: 0,
        avgPnlPerTrade: 0,
        avgOpportunityModelEdge: null,
        avgTradeEntryModelEdge: null,
        avgOpportunityEntryAsk: null,
        avgTradeEntryPrice: null,
        avgMfe: null,
        avgMae: null,
        avgHoldMs: null,
        mispricingBucketTradeStats: emptyMispricingRows(),
        edgeBucketTradeCounts: { ...emptyEdge },
        opportunityEdgeBucketCounts: { ...emptyEdge },
        rejectionReasonCounts: [],
      },
    },
  };
  return { ...base, ...overrides };
}

describe("binaryMultiSessionAggregate", () => {
  it("discovers root summary and sessions/*.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "sess-"));
    writeFileSync(join(dir, "session-summary.json"), "{}", "utf8");
    const sub = join(dir, "sessions");
    mkdirSync(sub);
    writeFileSync(join(sub, "a.json"), "{}", "utf8");
    const paths = discoverSessionSummaryPaths(dir);
    expect(paths.length).toBe(2);
    expect(paths.some((p) => p.endsWith("session-summary.json"))).toBe(true);
    expect(paths.some((p) => p.endsWith(join("sessions", "a.json")))).toBe(true);
  });

  it("merges two binary session summaries", () => {
    const dir = mkdtempSync(join(tmpdir(), "sess2-"));
    const braA = minimalBinaryRunAnalytics({
      closedTrades: 1,
      edgeBucketBreakdown: {
        "<0.01": 0,
        "0.01-0.03": 1,
        "0.03-0.05": 0,
        ">0.05": 0,
        unknown: 0,
      },
      mispricingBucketTradeStats: [
        {
          bucket: "<0.01",
          trades: 0,
          wins: 0,
          winRatePercent: 0,
          pnlTotal: 0,
          avgPnlPerTrade: 0,
          avgMfe: null,
          avgMae: null,
        },
        {
          bucket: "0.01-0.03",
          trades: 1,
          wins: 1,
          winRatePercent: 100,
          pnlTotal: 1,
          avgPnlPerTrade: 1,
          avgMfe: null,
          avgMae: null,
        },
        {
          bucket: "0.03-0.05",
          trades: 0,
          wins: 0,
          winRatePercent: 0,
          pnlTotal: 0,
          avgPnlPerTrade: 0,
          avgMfe: null,
          avgMae: null,
        },
        {
          bucket: ">0.05",
          trades: 0,
          wins: 0,
          winRatePercent: 0,
          pnlTotal: 0,
          avgPnlPerTrade: 0,
          avgMfe: null,
          avgMae: null,
        },
        {
          bucket: "unknown",
          trades: 0,
          wins: 0,
          winRatePercent: 0,
          pnlTotal: 0,
          avgPnlPerTrade: 0,
          avgMfe: null,
          avgMae: null,
        },
      ],
    });
    writeFileSync(
      join(dir, "session-summary.json"),
      JSON.stringify({
        marketMode: "binary",
        sessionStartedAt: "2026-01-01T00:00:00.000Z",
        simulation: {
          totalTrades: 1,
          wins: 1,
          losses: 0,
          totalPnl: 1,
          winRatePercent: 100,
          maxDrawdown: 1,
        },
        binaryRunAnalytics: braA,
      }),
      "utf8"
    );
    const sub = join(dir, "sessions");
    mkdirSync(sub);
    const braB = minimalBinaryRunAnalytics({
      closedTrades: 1,
      pnlTotal: -2,
      avgPnlPerTrade: -2,
      winRate: 0,
      edgeBucketBreakdown: {
        "<0.01": 0,
        "0.01-0.03": 1,
        "0.03-0.05": 0,
        ">0.05": 0,
        unknown: 0,
      },
      mispricingBucketTradeStats: [
        {
          bucket: "<0.01",
          trades: 0,
          wins: 0,
          winRatePercent: 0,
          pnlTotal: 0,
          avgPnlPerTrade: 0,
          avgMfe: null,
          avgMae: null,
        },
        {
          bucket: "0.01-0.03",
          trades: 1,
          wins: 0,
          winRatePercent: 0,
          pnlTotal: -2,
          avgPnlPerTrade: -2,
          avgMfe: null,
          avgMae: null,
        },
        {
          bucket: "0.03-0.05",
          trades: 0,
          wins: 0,
          winRatePercent: 0,
          pnlTotal: 0,
          avgPnlPerTrade: 0,
          avgMfe: null,
          avgMae: null,
        },
        {
          bucket: ">0.05",
          trades: 0,
          wins: 0,
          winRatePercent: 0,
          pnlTotal: 0,
          avgPnlPerTrade: 0,
          avgMfe: null,
          avgMae: null,
        },
        {
          bucket: "unknown",
          trades: 0,
          wins: 0,
          winRatePercent: 0,
          pnlTotal: 0,
          avgPnlPerTrade: 0,
          avgMfe: null,
          avgMae: null,
        },
      ],
      tradeOutcomeBreakdown: {
        byOutcomeSide: {
          YES: { count: 1, wins: 0, netPnl: -2 },
          NO: { count: 0, wins: 0, netPnl: 0 },
          unknown: { count: 0, wins: 0, netPnl: 0 },
        },
        byQuality: {
          strong: { count: 1, wins: 0, netPnl: -2 },
        },
        byExit: {
          take_profit: 0,
          stop_loss: 1,
          timeout: 0,
          unknown: 0,
        },
      },
    });
    writeFileSync(
      join(sub, "older.json"),
      JSON.stringify({
        marketMode: "binary",
        sessionStartedAt: "2026-01-02T00:00:00.000Z",
        simulation: {
          totalTrades: 1,
          wins: 0,
          losses: 1,
          totalPnl: -2,
          winRatePercent: 0,
          maxDrawdown: 12,
        },
        binaryRunAnalytics: braB,
      }),
      "utf8"
    );

    writeFileSync(
      join(dir, "trades.jsonl"),
      '{"marketMode":"binary","netPnlUsdt":1}\n{"marketMode":"binary","netPnlUsdt":-2}\n',
      "utf8"
    );

    const r = computeBinaryMultiSessionAggregate(dir);
    expect(r).not.toBeNull();
    expect(r!.totals.sessionsAnalyzed).toBe(2);
    expect(r!.totals.totalTrades).toBe(2);
    expect(r!.totals.overallPnlUsdt).toBeCloseTo(-1, 6);
    expect(r!.totals.maxSessionDrawdown).toBe(12);
    expect(r!.totals.profitableSessions).toBe(1);
    expect(r!.totals.losingSessions).toBe(1);
    expect(r!.stability.stddevPnlPerTrade).not.toBeNull();
    expect(r!.breakdowns.edgeBucketTradeCounts["0.01-0.03"]).toBe(2);
    expect(r!.breakdowns.qualityByBucket.strong?.trades).toBe(2);

    const mp = r!.breakdowns.mispricingByBucket.find((x) => x.bucket === "0.01-0.03");
    expect(mp?.trades).toBe(2);
    expect(mp?.wins).toBe(1);
    expect(mp?.pnlTotal).toBeCloseTo(-1, 6);
  });

  it("finds trades.jsonl under sessions/<dir>/ when present", () => {
    const dir = mkdtempSync(join(tmpdir(), "sess3-"));
    writeFileSync(join(dir, "session-summary.json"), "{}", "utf8");
    const nested = join(dir, "sessions", "run1");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, "trades.jsonl"), "\n", "utf8");
    const t = discoverTradesJsonlPaths(dir);
    expect(t.some((p) => p.endsWith(join("sessions", "run1", "trades.jsonl")))).toBe(true);
  });
});
