import { readFileSync } from "node:fs";
import { join } from "node:path";

import { computeBinaryEntryEdge, resolveBinaryVenueAsks } from "../binary/entry/edgeEntryDecision.js";
import type { EntryDirection } from "../entryConditions.js";
import type { HoldExitAudit } from "../holdExitAudit.js";
import type { ExecutableTopOfBook, MarketMode } from "../market/types.js";
import type { Opportunity } from "../opportunityTracker.js";
import type { SimulatedTrade } from "../simulationEngine.js";
import type { QualityProfile } from "../preEntryQualityGate.js";

export const BINARY_RUN_ANALYTICS_SCHEMA = "binary_run_analytics_v2" as const;

const PRIMARY_REJECTION_REASONS_TOP = 12;

/** Subreasons for `invalid_market_prices` (binary observability). */
export const INVALID_MARKET_PRICES_SUBREASON_KEYS = [
  "invalid_yes_no_bounds",
  "invalid_executable_price",
  "invalid_crossed_or_inverted_book",
  "invalid_price_not_finite",
  "invalid_market_price_extreme_reprice",
] as const;

export type InvalidMarketPricesSubreasonKey =
  (typeof INVALID_MARKET_PRICES_SUBREASON_KEYS)[number];

function emptyInvalidMarketPricesSubreasonBreakdown(): Record<
  InvalidMarketPricesSubreasonKey | "unknown",
  number
> {
  const base: Record<string, number> = { unknown: 0 };
  for (const k of INVALID_MARKET_PRICES_SUBREASON_KEYS) {
    base[k] = 0;
  }
  return base as Record<InvalidMarketPricesSubreasonKey | "unknown", number>;
}

function countInvalidMarketPricesSubreasons(
  opportunities: readonly {
    marketMode?: string;
    status?: string;
    entryRejectionReasons?: readonly string[];
    invalidMarketPricesAudit?: { subreason?: string };
  }[]
): Record<InvalidMarketPricesSubreasonKey | "unknown", number> {
  const out = emptyInvalidMarketPricesSubreasonBreakdown();
  for (const o of opportunities) {
    if (o.marketMode !== "binary") continue;
    if (o.status !== "rejected") continue;
    const reasons = o.entryRejectionReasons ?? [];
    if (!reasons.includes("invalid_market_prices")) continue;
    const sub = o.invalidMarketPricesAudit?.subreason;
    if (
      sub !== undefined &&
      (INVALID_MARKET_PRICES_SUBREASON_KEYS as readonly string[]).includes(sub)
    ) {
      out[sub as InvalidMarketPricesSubreasonKey] += 1;
    } else {
      out.unknown += 1;
    }
  }
  return out;
}

/** Model edge at entry: P(side) minus venue ask on bought leg (same units as MIN_EDGE_THRESHOLD). */
export type EdgeBucketLabel = "<0.01" | "0.01-0.03" | "0.03-0.05" | ">0.05" | "unknown";

export function edgeBucketForModelEdge(edge: number | null | undefined): EdgeBucketLabel {
  if (edge === null || edge === undefined || !Number.isFinite(edge)) {
    return "unknown";
  }
  if (edge < 0.01) return "<0.01";
  if (edge < 0.03) return "0.01-0.03";
  if (edge <= 0.05) return "0.03-0.05";
  return ">0.05";
}

/** Display order for mispricing tables (matches {@link edgeBucketForModelEdge} buckets). */
export const MISPRICING_BUCKET_DISPLAY_ORDER: readonly EdgeBucketLabel[] = [
  "<0.01",
  "0.01-0.03",
  "0.03-0.05",
  ">0.05",
  "unknown",
];

/** Human-readable range for console / reports (maps internal bucket keys). */
export function mispricingBucketDisplayLabel(bucket: EdgeBucketLabel): string {
  switch (bucket) {
    case "<0.01":
      return "0–0.01";
    case "0.01-0.03":
      return "0.01–0.03";
    case "0.03-0.05":
      return "0.03–0.05";
    case ">0.05":
      return ">0.05";
    default:
      return "unknown (edge)";
  }
}

/** Closed-trade stats by entry {@link SimulatedTrade.entryModelEdge} bucket (mispricing calibration). */
export type MispricingBucketTradeStats = {
  bucket: EdgeBucketLabel;
  trades: number;
  winRatePercent: number;
  pnlTotal: number;
  avgPnlPerTrade: number;
  avgMfe: number | null;
  avgMae: number | null;
};

type MispricingBucketAcc = {
  n: number;
  wins: number;
  pnlSum: number;
  mfeSum: number;
  mfeN: number;
  maeSum: number;
  maeN: number;
};

function emptyMispricingBucketAcc(): MispricingBucketAcc {
  return {
    n: 0,
    wins: 0,
    pnlSum: 0,
    mfeSum: 0,
    mfeN: 0,
    maeSum: 0,
    maeN: 0,
  };
}

function emptyMispricingAcc(): Record<EdgeBucketLabel, MispricingBucketAcc> {
  return {
    "<0.01": emptyMispricingBucketAcc(),
    "0.01-0.03": emptyMispricingBucketAcc(),
    "0.03-0.05": emptyMispricingBucketAcc(),
    ">0.05": emptyMispricingBucketAcc(),
    unknown: emptyMispricingBucketAcc(),
  };
}

function accumulateMispricingTrade(
  acc: Record<EdgeBucketLabel, MispricingBucketAcc>,
  bucket: EdgeBucketLabel,
  pnl: number,
  holdAudit: HoldExitAudit | undefined
): void {
  const b = acc[bucket];
  b.n += 1;
  b.pnlSum += pnl;
  if (pnl > 0) b.wins += 1;
  const mm = mfeMaeFromHoldAudit(holdAudit);
  if (mm !== null) {
    b.mfeSum += mm.mfe;
    b.mfeN += 1;
    b.maeSum += mm.mae;
    b.maeN += 1;
  }
}

function finalizeMispricingBucketTradeStats(
  acc: Record<EdgeBucketLabel, MispricingBucketAcc>
): MispricingBucketTradeStats[] {
  const out: MispricingBucketTradeStats[] = [];
  for (const bucket of MISPRICING_BUCKET_DISPLAY_ORDER) {
    const x = acc[bucket];
    const n = x.n;
    const wr = n > 0 ? (x.wins / n) * 100 : 0;
    const avgPnl = n > 0 ? x.pnlSum / n : 0;
    out.push({
      bucket,
      trades: n,
      winRatePercent: wr,
      pnlTotal: x.pnlSum,
      avgPnlPerTrade: avgPnl,
      avgMfe: x.mfeN > 0 ? x.mfeSum / x.mfeN : null,
      avgMae: x.maeN > 0 ? x.maeSum / x.maeN : null,
    });
  }
  return out;
}

function inc<K extends string>(m: Record<K, number>, k: K): void {
  m[k] = (m[k] ?? 0) + 1;
}

export type BorderlineFunnelBreakdown = {
  borderlineEntered: number;
  borderlinePromoted: number;
  borderlineRejectedTimeout: number;
  borderlineRejectedWeak: number;
};

export type TradeOutcomeBreakdown = {
  byOutcomeSide: {
    YES: { count: number; wins: number; netPnl: number };
    NO: { count: number; wins: number; netPnl: number };
    unknown: { count: number; wins: number; netPnl: number };
  };
  byQuality: Record<string, { count: number; wins: number; netPnl: number }>;
  byExit: {
    take_profit: number;
    stop_loss: number;
    timeout: number;
    unknown: number;
  };
};

/** Per bought-outcome leg: full-funnel observability (binary sessions). */
export type BinaryYesNoSideMetrics = {
  opportunitiesSeen: number;
  opportunitiesRejected: number;
  validOpportunities: number;
  /** Primary blockers on rejected rows (`entryRejectionPrimaryBlocker`), sorted by count desc. */
  primaryRejectionReasons: Array<{ reason: string; count: number }>;
  /**
   * Closed paper trades on this leg (`sideBought` / JSONL `outcomeTokenBought`).
   * In the current engine each open is closed in-session, so this matches per-leg “opens”.
   */
  tradesClosed: number;
  winRatePercent: number;
  pnlTotal: number;
  avgPnlPerTrade: number;
  /**
   * Mean model edge at opportunity observation (same geometry as simulator:
   * {@link computeBinaryEntryEdge} + {@link resolveBinaryVenueAsks}).
   */
  avgOpportunityModelEdge: number | null;
  /** Mean `entryModelEdge` on closed trades for this leg. */
  avgTradeEntryModelEdge: number | null;
  /** Mean executable ask on the bought leg at opportunity tick. */
  avgOpportunityEntryAsk: number | null;
  /** Mean entry fill / outcome price on closed trades. */
  avgTradeEntryPrice: number | null;
  avgMfe: number | null;
  avgMae: number | null;
  avgHoldMs: number | null;
};

export type BinaryYesNoComparativeReport = {
  YES: BinaryYesNoSideMetrics;
  NO: BinaryYesNoSideMetrics;
  /** Rows missing YES/NO attribution (e.g. legacy JSONL or unset contrarian). */
  outcomeSideUnknown: BinaryYesNoSideMetrics;
};

type YesNoOppLike = {
  marketMode?: string;
  status?: string;
  entryOutcomeSide?: "YES" | "NO" | null;
  entryRejectionPrimaryBlocker?: string | null;
  estimatedProbabilityUp?: number;
  yesPrice?: number;
  noPrice?: number;
  bestBid?: number;
  bestAsk?: number;
  midPrice?: number;
  spreadBps?: number;
};

type YesNoTradeLike = {
  executionModel?: string;
  marketMode?: string;
  sideBought?: "YES" | "NO";
  outcomeTokenBought?: string | null;
  profitLoss?: number;
  netPnlUsdt?: number;
  entryModelEdge?: number | null;
  entryPrice?: number;
  entryOutcomePrice?: number;
  holdExitAudit?: HoldExitAudit;
  openedAt?: number;
  closedAt?: number;
  openedAtMs?: number;
  closedAtMs?: number;
  holdDurationMs?: number;
};

type YesNoAcc = {
  opportunitiesSeen: number;
  opportunitiesRejected: number;
  validOpportunities: number;
  primaryReasons: Map<string, number>;
  oppEdgeSum: number;
  oppEdgeN: number;
  oppAskSum: number;
  oppAskN: number;
  tradesClosed: number;
  wins: number;
  pnlSum: number;
  tradeEdgeSum: number;
  tradeEdgeN: number;
  tradeEntryPxSum: number;
  tradeEntryPxN: number;
  mfeSum: number;
  mfeN: number;
  maeSum: number;
  maeN: number;
  holdMsSum: number;
  holdMsN: number;
};

function emptyYesNoAcc(): YesNoAcc {
  return {
    opportunitiesSeen: 0,
    opportunitiesRejected: 0,
    validOpportunities: 0,
    primaryReasons: new Map(),
    oppEdgeSum: 0,
    oppEdgeN: 0,
    oppAskSum: 0,
    oppAskN: 0,
    tradesClosed: 0,
    wins: 0,
    pnlSum: 0,
    tradeEdgeSum: 0,
    tradeEdgeN: 0,
    tradeEntryPxSum: 0,
    tradeEntryPxN: 0,
    mfeSum: 0,
    mfeN: 0,
    maeSum: 0,
    maeN: 0,
    holdMsSum: 0,
    holdMsN: 0,
  };
}

function directionFromOutcomeSide(side: "YES" | "NO"): EntryDirection {
  return side === "YES" ? "UP" : "DOWN";
}

function executableBookFromOppLike(o: YesNoOppLike): ExecutableTopOfBook | null {
  const { bestBid, bestAsk, midPrice, spreadBps } = o;
  if (
    bestBid === undefined ||
    bestAsk === undefined ||
    midPrice === undefined ||
    spreadBps === undefined
  ) {
    return null;
  }
  if (
    !Number.isFinite(bestBid) ||
    !Number.isFinite(bestAsk) ||
    !Number.isFinite(midPrice) ||
    !Number.isFinite(spreadBps)
  ) {
    return null;
  }
  return { bestBid, bestAsk, midPrice, spreadBps };
}

function tryOpportunityModelEdgeAndAsk(o: YesNoOppLike): {
  edge: number;
  askOnLeg: number;
} | null {
  if (o.marketMode !== "binary") return null;
  if (o.entryOutcomeSide !== "YES" && o.entryOutcomeSide !== "NO") return null;
  if (o.estimatedProbabilityUp === undefined || !Number.isFinite(o.estimatedProbabilityUp)) {
    return null;
  }
  if (o.yesPrice === undefined || o.noPrice === undefined) return null;
  if (!Number.isFinite(o.yesPrice) || !Number.isFinite(o.noPrice)) return null;
  const book = executableBookFromOppLike(o);
  if (book === null) return null;
  const asks = resolveBinaryVenueAsks({
    executionBook: book,
    yesMid: o.yesPrice,
    noMid: o.noPrice,
  });
  const edge = computeBinaryEntryEdge({
    estimatedProbabilityUp: o.estimatedProbabilityUp,
    direction: directionFromOutcomeSide(o.entryOutcomeSide),
    yesAsk: asks.yesAsk,
    noAsk: asks.noAsk,
  });
  if (!Number.isFinite(edge)) return null;
  const askOnLeg = o.entryOutcomeSide === "YES" ? asks.yesAsk : asks.noAsk;
  if (!Number.isFinite(askOnLeg)) return null;
  return { edge, askOnLeg };
}

function outcomeSideBucketFromOpportunity(o: YesNoOppLike): "YES" | "NO" | "unknown" {
  if (o.marketMode !== "binary") return "unknown";
  if (o.entryOutcomeSide === "YES" || o.entryOutcomeSide === "NO") {
    return o.entryOutcomeSide;
  }
  return "unknown";
}

function bumpPrimaryReason(acc: YesNoAcc, reason: string | null | undefined): void {
  if (reason === null || reason === undefined || reason.length === 0) return;
  acc.primaryReasons.set(reason, (acc.primaryReasons.get(reason) ?? 0) + 1);
}

function accumulateOpportunityForYesNo(
  o: YesNoOppLike,
  byYes: YesNoAcc,
  byNo: YesNoAcc,
  byUnk: YesNoAcc
): void {
  if (o.marketMode !== "binary") return;
  const bucket = outcomeSideBucketFromOpportunity(o);
  const acc = bucket === "YES" ? byYes : bucket === "NO" ? byNo : byUnk;
  acc.opportunitiesSeen += 1;
  if (o.status === "rejected") {
    acc.opportunitiesRejected += 1;
    bumpPrimaryReason(acc, o.entryRejectionPrimaryBlocker ?? null);
  } else if (o.status === "valid") {
    acc.validOpportunities += 1;
  }
  const econ = tryOpportunityModelEdgeAndAsk(o);
  if (econ !== null) {
    acc.oppEdgeSum += econ.edge;
    acc.oppEdgeN += 1;
    acc.oppAskSum += econ.askOnLeg;
    acc.oppAskN += 1;
  }
}

function mfeMaeFromHoldAudit(a: HoldExitAudit | undefined): { mfe: number; mae: number } | null {
  if (a === undefined) return null;
  if (a.binaryPriceSide !== undefined) {
    const mfe = a.binaryPriceSide.maxFavorableExcursionPoints;
    const mae = a.binaryPriceSide.maxAdverseExcursionPoints;
    if (Number.isFinite(mfe) && Number.isFinite(mae)) return { mfe, mae };
  }
  if (Number.isFinite(a.maxFavorableExcursion) && Number.isFinite(a.maxAdverseExcursion)) {
    return { mfe: a.maxFavorableExcursion, mae: a.maxAdverseExcursion };
  }
  return null;
}

function isBinaryTradeLike(t: YesNoTradeLike): boolean {
  return t.executionModel === "binary" || t.marketMode === "binary";
}

function tradePnlUsdt(t: YesNoTradeLike): number {
  if (t.profitLoss !== undefined && Number.isFinite(t.profitLoss)) return t.profitLoss;
  const n = Number(t.netPnlUsdt);
  return Number.isFinite(n) ? n : 0;
}

function tradeOutcomeSide(t: YesNoTradeLike): "YES" | "NO" | "unknown" {
  const raw = t.sideBought ?? t.outcomeTokenBought ?? null;
  if (raw === "YES" || raw === "NO") return raw;
  return "unknown";
}

function tradeHoldMs(t: YesNoTradeLike): number | null {
  if (t.holdDurationMs !== undefined && Number.isFinite(t.holdDurationMs)) {
    return t.holdDurationMs;
  }
  const o0 = t.openedAt ?? t.openedAtMs;
  const c0 = t.closedAt ?? t.closedAtMs;
  if (
    o0 !== undefined &&
    c0 !== undefined &&
    Number.isFinite(o0) &&
    Number.isFinite(c0)
  ) {
    return c0 - o0;
  }
  return null;
}

function tradeEntryPrice(t: YesNoTradeLike): number | null {
  const px =
    t.entryPrice !== undefined && Number.isFinite(t.entryPrice)
      ? t.entryPrice
      : t.entryOutcomePrice;
  if (px !== undefined && Number.isFinite(px)) return px;
  return null;
}

function accumulateTradeForYesNo(
  t: YesNoTradeLike,
  byYes: YesNoAcc,
  byNo: YesNoAcc,
  byUnk: YesNoAcc
): void {
  if (!isBinaryTradeLike(t)) return;
  const side = tradeOutcomeSide(t);
  const acc = side === "YES" ? byYes : side === "NO" ? byNo : byUnk;
  const pnl = tradePnlUsdt(t);
  acc.tradesClosed += 1;
  acc.pnlSum += pnl;
  if (pnl > 0) acc.wins += 1;

  if (t.entryModelEdge !== undefined && t.entryModelEdge !== null && Number.isFinite(t.entryModelEdge)) {
    acc.tradeEdgeSum += t.entryModelEdge;
    acc.tradeEdgeN += 1;
  }
  const entryPx = tradeEntryPrice(t);
  if (entryPx !== null) {
    acc.tradeEntryPxSum += entryPx;
    acc.tradeEntryPxN += 1;
  }
  const mm = mfeMaeFromHoldAudit(t.holdExitAudit);
  if (mm !== null) {
    acc.mfeSum += mm.mfe;
    acc.mfeN += 1;
    acc.maeSum += mm.mae;
    acc.maeN += 1;
  }
  const hold = tradeHoldMs(t);
  if (hold !== null && Number.isFinite(hold) && hold >= 0) {
    acc.holdMsSum += hold;
    acc.holdMsN += 1;
  }
}

function finalizeYesNoAcc(acc: YesNoAcc): BinaryYesNoSideMetrics {
  const primaryRejectionReasons = [...acc.primaryReasons.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, PRIMARY_REJECTION_REASONS_TOP)
    .map(([reason, count]) => ({ reason, count }));

  const nTr = acc.tradesClosed;
  const winRatePercent = nTr > 0 ? (acc.wins / nTr) * 100 : 0;
  const avgPnlPerTrade = nTr > 0 ? acc.pnlSum / nTr : 0;

  return {
    opportunitiesSeen: acc.opportunitiesSeen,
    opportunitiesRejected: acc.opportunitiesRejected,
    validOpportunities: acc.validOpportunities,
    primaryRejectionReasons,
    tradesClosed: nTr,
    winRatePercent,
    pnlTotal: acc.pnlSum,
    avgPnlPerTrade,
    avgOpportunityModelEdge:
      acc.oppEdgeN > 0 ? acc.oppEdgeSum / acc.oppEdgeN : null,
    avgTradeEntryModelEdge:
      acc.tradeEdgeN > 0 ? acc.tradeEdgeSum / acc.tradeEdgeN : null,
    avgOpportunityEntryAsk: acc.oppAskN > 0 ? acc.oppAskSum / acc.oppAskN : null,
    avgTradeEntryPrice:
      acc.tradeEntryPxN > 0 ? acc.tradeEntryPxSum / acc.tradeEntryPxN : null,
    avgMfe: acc.mfeN > 0 ? acc.mfeSum / acc.mfeN : null,
    avgMae: acc.maeN > 0 ? acc.maeSum / acc.maeN : null,
    avgHoldMs: acc.holdMsN > 0 ? acc.holdMsSum / acc.holdMsN : null,
  };
}

export function computeBinaryYesNoComparative(input: {
  opportunities: readonly YesNoOppLike[];
  trades: readonly YesNoTradeLike[];
}): BinaryYesNoComparativeReport {
  const y = emptyYesNoAcc();
  const n = emptyYesNoAcc();
  const u = emptyYesNoAcc();
  for (const o of input.opportunities) {
    accumulateOpportunityForYesNo(o, y, n, u);
  }
  for (const t of input.trades) {
    accumulateTradeForYesNo(t, y, n, u);
  }
  return {
    YES: finalizeYesNoAcc(y),
    NO: finalizeYesNoAcc(n),
    outcomeSideUnknown: finalizeYesNoAcc(u),
  };
}

export type BinaryRunAnalyticsReport = {
  schema: typeof BINARY_RUN_ANALYTICS_SCHEMA;
  opportunitiesTotal: number;
  opportunitiesByType: Record<string, number>;
  opportunitiesByQuality: Record<string, number>;
  openedTrades: number;
  closedTrades: number;
  winRate: number;
  pnlTotal: number;
  avgPnlPerTrade: number;
  timeoutRate: number;
  edgeBucketBreakdown: Record<EdgeBucketLabel, number>;
  /**
   * Per trade: entry {@link SimulatedTrade.entryModelEdge} (mispricing) vs outcome.
   * MFE/MAE from {@link HoldExitAudit} when present (binary price points or long convention).
   */
  mispricingBucketTradeStats: MispricingBucketTradeStats[];
  qualityBucketBreakdown: Record<string, number>;
  borderlineFunnelBreakdown: BorderlineFunnelBreakdown;
  tradeOutcomeBreakdown: TradeOutcomeBreakdown;
  /**
   * Binary-only: rejected opportunities whose normalized reasons include
   * `invalid_market_prices`, split by {@link InvalidMarketPricesSubreasonKey}.
   */
  invalidMarketPricesSubreasonBreakdown: Record<
    InvalidMarketPricesSubreasonKey | "unknown",
    number
  >;
  /** YES vs NO: funnel (opportunities) + closed paper trade stats side-by-side. */
  yesNoComparative: BinaryYesNoComparativeReport;
};

function emptyTradeOutcomeBreakdown(): TradeOutcomeBreakdown {
  const z = () => ({ count: 0, wins: 0, netPnl: 0 });
  return {
    byOutcomeSide: { YES: z(), NO: z(), unknown: z() },
    byQuality: {},
    byExit: { take_profit: 0, stop_loss: 0, timeout: 0, unknown: 0 },
  };
}

function bumpSide(
  b: TradeOutcomeBreakdown["byOutcomeSide"],
  side: "YES" | "NO" | "unknown",
  won: boolean,
  pnl: number
): void {
  const t = b[side];
  t.count += 1;
  t.netPnl += pnl;
  if (won) t.wins += 1;
}

function bumpQuality(
  by: Record<string, { count: number; wins: number; netPnl: number }>,
  q: string,
  won: boolean,
  pnl: number
): void {
  if (by[q] === undefined) {
    by[q] = { count: 0, wins: 0, netPnl: 0 };
  }
  const t = by[q]!;
  t.count += 1;
  t.netPnl += pnl;
  if (won) t.wins += 1;
}

function exitKind(
  r: "profit" | "stop" | "timeout" | string | undefined
): keyof TradeOutcomeBreakdown["byExit"] {
  if (r === "profit") return "take_profit";
  if (r === "stop") return "stop_loss";
  if (r === "timeout") return "timeout";
  return "unknown";
}

export type BinaryRunAnalyticsSessionSlice = {
  borderlineEntered: number;
  borderlinePromoted: number;
  borderlineRejectedTimeout: number;
  borderlineRejectedWeak: number;
};

export function computeBinaryRunAnalytics(input: {
  marketMode: MarketMode;
  opportunities: readonly Opportunity[];
  trades: readonly SimulatedTrade[];
  borderlineFunnel?: BinaryRunAnalyticsSessionSlice | null;
  /** When set (e.g. funnel counter), can exceed closed trades if exits are missing from JSONL. */
  openedTradesOverride?: number;
}): BinaryRunAnalyticsReport | null {
  if (input.marketMode !== "binary") return null;

  const opps = input.opportunities;
  const opportunitiesTotal = opps.length;
  const opportunitiesByType: Record<string, number> = {};
  const opportunitiesByQuality: Record<string, number> = {};
  for (const o of opps) {
    inc(opportunitiesByType as Record<string, number>, String(o.opportunityType));
    inc(opportunitiesByQuality as Record<string, number>, String(o.qualityProfile ?? "unknown"));
  }

  const binaryTrades = input.trades.filter((t) => t.executionModel === "binary");
  const closedTrades = binaryTrades.length;
  const openedTrades =
    input.openedTradesOverride !== undefined
      ? Math.max(closedTrades, input.openedTradesOverride)
      : closedTrades;

  let wins = 0;
  let pnlTotal = 0;
  let timeouts = 0;
  const edgeBucketBreakdown: Record<EdgeBucketLabel, number> = {
    "<0.01": 0,
    "0.01-0.03": 0,
    "0.03-0.05": 0,
    ">0.05": 0,
    unknown: 0,
  };
  const qualityBucketBreakdown: Record<string, number> = {};
  const tradeOutcome = emptyTradeOutcomeBreakdown();
  const mispricingAcc = emptyMispricingAcc();

  for (const t of binaryTrades) {
    const pnl = t.profitLoss;
    pnlTotal += pnl;
    const won = pnl > 0;
    if (won) wins += 1;
    if (t.exitReason === "timeout") timeouts += 1;

    const bucket = edgeBucketForModelEdge(t.entryModelEdge);
    edgeBucketBreakdown[bucket] += 1;
    accumulateMispricingTrade(mispricingAcc, bucket, pnl, t.holdExitAudit);

    const q = (t.entryQualityProfile ?? "unknown") as string;
    inc(qualityBucketBreakdown as Record<string, number>, q);

    const side = t.sideBought === "YES" || t.sideBought === "NO" ? t.sideBought : "unknown";
    bumpSide(tradeOutcome.byOutcomeSide, side, won, pnl);
    bumpQuality(tradeOutcome.byQuality, q, won, pnl);

    const ek = exitKind(t.exitReason);
    tradeOutcome.byExit[ek] += 1;
  }

  const winRate = closedTrades > 0 ? (wins / closedTrades) * 100 : 0;
  const avgPnlPerTrade = closedTrades > 0 ? pnlTotal / closedTrades : 0;
  const timeoutRate = closedTrades > 0 ? (timeouts / closedTrades) * 100 : 0;

  const borderlineFunnelBreakdown: BorderlineFunnelBreakdown = input.borderlineFunnel ?? {
    borderlineEntered: 0,
    borderlinePromoted: 0,
    borderlineRejectedTimeout: 0,
    borderlineRejectedWeak: 0,
  };

  const invalidMarketPricesSubreasonBreakdown =
    countInvalidMarketPricesSubreasons(opps);

  const yesNoComparative = computeBinaryYesNoComparative({
    opportunities: opps,
    trades: binaryTrades,
  });

  return {
    schema: BINARY_RUN_ANALYTICS_SCHEMA,
    opportunitiesTotal,
    opportunitiesByType,
    opportunitiesByQuality,
    openedTrades,
    closedTrades,
    winRate,
    pnlTotal,
    avgPnlPerTrade,
    timeoutRate,
    edgeBucketBreakdown,
    mispricingBucketTradeStats: finalizeMispricingBucketTradeStats(mispricingAcc),
    qualityBucketBreakdown,
    borderlineFunnelBreakdown,
    tradeOutcomeBreakdown: tradeOutcome,
    invalidMarketPricesSubreasonBreakdown,
    yesNoComparative,
  };
}

/** Loose JSONL row shape after `JSON.parse` (file replay / older rows). */
export type OpportunityJsonlRow = {
  opportunityType?: string;
  qualityProfile?: string;
  status?: string;
  marketMode?: string;
  entryRejectionReasons?: readonly string[];
  invalidMarketPricesAudit?: { subreason?: string };
  entryOutcomeSide?: "YES" | "NO" | null;
  entryRejectionPrimaryBlocker?: string | null;
  estimatedProbabilityUp?: number;
  yesPrice?: number;
  noPrice?: number;
  bestBid?: number;
  bestAsk?: number;
  midPrice?: number;
  spreadBps?: number;
};

export type BinaryTradeJsonlRow = {
  marketMode?: string;
  netPnlUsdt?: number;
  exitReason?: string;
  outcomeTokenBought?: string | null;
  entryQualityProfile?: QualityProfile | string;
  entryModelEdge?: number | null;
  entryOutcomePrice?: number;
  openedAtMs?: number;
  closedAtMs?: number;
  holdDurationMs?: number;
  holdExitAudit?: HoldExitAudit;
};

export function computeBinaryRunAnalyticsFromJsonlRows(input: {
  opportunityRows: readonly OpportunityJsonlRow[];
  tradeRows: readonly BinaryTradeJsonlRow[];
  borderlineFunnel?: BinaryRunAnalyticsSessionSlice | null;
  openedTradesOverride?: number;
}): BinaryRunAnalyticsReport {
  const opportunitiesTotal = input.opportunityRows.length;
  const opportunitiesByType: Record<string, number> = {};
  const opportunitiesByQuality: Record<string, number> = {};
  for (const o of input.opportunityRows) {
    inc(opportunitiesByType as Record<string, number>, String(o.opportunityType ?? "unknown"));
    inc(
      opportunitiesByQuality as Record<string, number>,
      String(o.qualityProfile ?? "unknown")
    );
  }

  const binaryTrades = input.tradeRows.filter((t) => t.marketMode === "binary");
  const closedTrades = binaryTrades.length;
  const openedTrades =
    input.openedTradesOverride !== undefined
      ? Math.max(closedTrades, input.openedTradesOverride)
      : closedTrades;

  let wins = 0;
  let pnlTotal = 0;
  let timeouts = 0;
  const edgeBucketBreakdown: Record<EdgeBucketLabel, number> = {
    "<0.01": 0,
    "0.01-0.03": 0,
    "0.03-0.05": 0,
    ">0.05": 0,
    unknown: 0,
  };
  const qualityBucketBreakdown: Record<string, number> = {};
  const tradeOutcome = emptyTradeOutcomeBreakdown();
  const mispricingAcc = emptyMispricingAcc();

  for (const t of binaryTrades) {
    const pnl = Number(t.netPnlUsdt);
    const pnlSafe = Number.isFinite(pnl) ? pnl : 0;
    pnlTotal += pnlSafe;
    const won = pnlSafe > 0;
    if (won) wins += 1;
    if (t.exitReason === "timeout") timeouts += 1;

    const bucket = edgeBucketForModelEdge(
      t.entryModelEdge === null ? undefined : t.entryModelEdge
    );
    edgeBucketBreakdown[bucket] += 1;
    accumulateMispricingTrade(mispricingAcc, bucket, pnlSafe, t.holdExitAudit);

    const q = String(t.entryQualityProfile ?? "unknown");
    inc(qualityBucketBreakdown as Record<string, number>, q);

    const rawSide = t.outcomeTokenBought;
    const side =
      rawSide === "YES" || rawSide === "NO"
        ? rawSide
        : ("unknown" as const);
    bumpSide(tradeOutcome.byOutcomeSide, side, won, pnlSafe);
    bumpQuality(tradeOutcome.byQuality, q, won, pnlSafe);

    const ek = exitKind(t.exitReason);
    tradeOutcome.byExit[ek] += 1;
  }

  const winRate = closedTrades > 0 ? (wins / closedTrades) * 100 : 0;
  const avgPnlPerTrade = closedTrades > 0 ? pnlTotal / closedTrades : 0;
  const timeoutRate = closedTrades > 0 ? (timeouts / closedTrades) * 100 : 0;

  const invalidMarketPricesSubreasonBreakdown =
    countInvalidMarketPricesSubreasons(input.opportunityRows);

  const yesNoComparative = computeBinaryYesNoComparative({
    opportunities: input.opportunityRows,
    trades: binaryTrades,
  });

  return {
    schema: BINARY_RUN_ANALYTICS_SCHEMA,
    opportunitiesTotal,
    opportunitiesByType,
    opportunitiesByQuality,
    openedTrades,
    closedTrades,
    winRate,
    pnlTotal,
    avgPnlPerTrade,
    timeoutRate,
    edgeBucketBreakdown,
    mispricingBucketTradeStats: finalizeMispricingBucketTradeStats(mispricingAcc),
    qualityBucketBreakdown,
    borderlineFunnelBreakdown: input.borderlineFunnel ?? {
      borderlineEntered: 0,
      borderlinePromoted: 0,
      borderlineRejectedTimeout: 0,
      borderlineRejectedWeak: 0,
    },
    tradeOutcomeBreakdown: tradeOutcome,
    invalidMarketPricesSubreasonBreakdown,
    yesNoComparative,
  };
}

export function readJsonlObjects(path: string): unknown[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const out: unknown[] = [];
  for (const line of lines) {
    try {
      out.push(JSON.parse(line) as unknown);
    } catch {
      /* skip bad line */
    }
  }
  return out;
}

export function loadSessionSummary(path: string): Record<string, unknown> | null {
  try {
    const raw = readFileSync(path, "utf8");
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function tradesExecutedFromSessionSummary(
  summary: Record<string, unknown> | null
): number | null {
  if (summary === null) return null;
  const c = summary.counters as Record<string, unknown> | undefined;
  if (!c) return null;
  const n = c.tradesExecuted;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

export function borderlineFunnelFromSessionSummary(
  summary: Record<string, unknown> | null
): BinaryRunAnalyticsSessionSlice | null {
  if (summary === null) return null;
  const ext = summary.extended as Record<string, unknown> | undefined;
  if (!ext) return null;
  const n = (k: string): number => {
    const v = ext[k];
    return typeof v === "number" && Number.isFinite(v) ? v : 0;
  };
  return {
    borderlineEntered: n("borderlineEntered"),
    borderlinePromoted: n("borderlinePromoted"),
    borderlineRejectedTimeout: n("borderlineRejectedTimeout"),
    borderlineRejectedWeak: n("borderlineRejectedWeak"),
  };
}

export function analyzeRunDirectory(dir: string): BinaryRunAnalyticsReport {
  const opPath = join(dir, "opportunities.jsonl");
  const trPath = join(dir, "trades.jsonl");
  const sessionPath = join(dir, "session-summary.json");

  const opportunityRows = readJsonlObjects(opPath) as OpportunityJsonlRow[];
  const tradeRows = readJsonlObjects(trPath) as BinaryTradeJsonlRow[];
  const session = loadSessionSummary(sessionPath);
  const funnel = borderlineFunnelFromSessionSummary(session);
  const openedOverride = tradesExecutedFromSessionSummary(session);

  return computeBinaryRunAnalyticsFromJsonlRows({
    opportunityRows,
    tradeRows,
    borderlineFunnel: funnel,
    ...(openedOverride !== null ? { openedTradesOverride: openedOverride } : {}),
  });
}

function fmtNumOrDash(n: number | null, digits: number): string {
  if (n === null || !Number.isFinite(n)) return "—";
  return n.toFixed(digits);
}

/** Mispricing buckets × closed-trade performance (shutdown + `npm run analyze-run`). */
export function formatMispricingBucketAnalysisConsole(
  rows: readonly MispricingBucketTradeStats[]
): string {
  const lines: string[] = [
    "──────── Binary — mispricing (entry model edge) vs outcomes ──",
    "  Entry edge = stored mispricing at open (fair − ask on bought leg). Compare buckets for real edge.",
    "",
    `${"Edge (mispricing)".padEnd(18)} ${"n".padStart(4)} ${"win%".padStart(
      7
    )} ${"ΣPnL".padStart(10)} ${"avgPnL".padStart(10)} ${"avgMFE".padStart(
      10
    )} ${"avgMAE".padStart(10)}`,
  ];
  for (const r of rows) {
    const lab = mispricingBucketDisplayLabel(r.bucket).padEnd(18);
    const n = String(r.trades).padStart(4);
    const wr =
      r.trades > 0 ? `${r.winRatePercent.toFixed(1)}%`.padStart(7) : "      —".padStart(7);
    const sumPnl =
      r.trades > 0 ? r.pnlTotal.toFixed(4).padStart(10) : "       —".padStart(10);
    const avgPnl =
      r.trades > 0 ? r.avgPnlPerTrade.toFixed(4).padStart(10) : "       —".padStart(10);
    const mfe = fmtNumOrDash(r.avgMfe, 6).padStart(10);
    const mae = fmtNumOrDash(r.avgMae, 6).padStart(10);
    lines.push(`${lab} ${n} ${wr} ${sumPnl} ${avgPnl} ${mfe} ${mae}`);
  }
  lines.push("──────────────────────────────────────────────────────────────");
  return lines.join("\n");
}

/** Multi-line block for shutdown console + analyze-run text output. */
export function formatBinaryYesNoComparativeConsole(
  y: BinaryYesNoComparativeReport
): string {
  const lines: string[] = [
    "──────── Binary — YES vs NO (funnel + closed trades) ────────",
  ];
  const blocks: Array<{ title: string; b: BinaryYesNoSideMetrics }> = [
    { title: "YES (bought leg)", b: y.YES },
    { title: "NO (bought leg)", b: y.NO },
    { title: "Side unknown (missing entryOutcomeSide / token)", b: y.outcomeSideUnknown },
  ];
  for (const { title, b } of blocks) {
    lines.push(`${title}:`);
    lines.push(
      `  opportunities: seen=${b.opportunitiesSeen} rejected=${b.opportunitiesRejected} valid=${b.validOpportunities}`
    );
    lines.push(
      `  trades closed: ${b.tradesClosed}  winRate=${b.winRatePercent.toFixed(1)}%  pnl=${b.pnlTotal.toFixed(4)} USDT  avgPnl/trade=${b.avgPnlPerTrade.toFixed(4)}`
    );
    lines.push(
      `  avg opp model edge: ${fmtNumOrDash(b.avgOpportunityModelEdge, 4)}  avg trade entry edge: ${fmtNumOrDash(b.avgTradeEntryModelEdge, 4)}`
    );
    lines.push(
      `  avg opp entry ask (leg): ${fmtNumOrDash(b.avgOpportunityEntryAsk, 4)}  avg trade entry price: ${fmtNumOrDash(b.avgTradeEntryPrice, 4)}`
    );
    lines.push(
      `  avg MFE: ${fmtNumOrDash(b.avgMfe, 6)}  avg MAE: ${fmtNumOrDash(b.avgMae, 6)}  avg hold: ${fmtNumOrDash(b.avgHoldMs, 0)} ms`
    );
    if (b.primaryRejectionReasons.length > 0) {
      lines.push(
        `  primary rejection blockers: ${b.primaryRejectionReasons.map((p) => `${p.reason}×${p.count}`).join(" | ")}`
      );
    } else if (b.opportunitiesRejected > 0) {
      lines.push(`  primary rejection blockers: (none recorded — add entryRejectionPrimaryBlocker to JSONL)`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

export function formatBinaryRunAnalyticsConsole(
  dir: string,
  report: BinaryRunAnalyticsReport
): string {
  const lines: string[] = [
    "",
    `=== Binary run analytics ===`,
    `Directory: ${dir}`,
    `Schema: ${report.schema}`,
    "",
    `Opportunities (total): ${report.opportunitiesTotal}`,
    `  By type: ${JSON.stringify(report.opportunitiesByType)}`,
    `  By quality: ${JSON.stringify(report.opportunitiesByQuality)}`,
    "",
    `Trades opened (binary): ${report.openedTrades}`,
    `Trades closed (binary): ${report.closedTrades}`,
    `Win rate %: ${report.winRate.toFixed(2)}`,
    `PnL total (USDT): ${report.pnlTotal.toFixed(4)}`,
    `Avg PnL / trade (USDT): ${report.avgPnlPerTrade.toFixed(4)}`,
    `Timeout rate %: ${report.timeoutRate.toFixed(2)}`,
    "",
    `Edge buckets (entry model edge): ${JSON.stringify(report.edgeBucketBreakdown)}`,
    "",
    formatMispricingBucketAnalysisConsole(report.mispricingBucketTradeStats),
    "",
    `Quality buckets (closed trades): ${JSON.stringify(report.qualityBucketBreakdown)}`,
    "",
    `Borderline funnel: ${JSON.stringify(report.borderlineFunnelBreakdown)}`,
    "",
    `Trade outcomes by side (YES/NO):`,
    ...(["YES", "NO", "unknown"] as const).map((s) => {
      const b = report.tradeOutcomeBreakdown.byOutcomeSide[s];
      const wr = b.count > 0 ? ((b.wins / b.count) * 100).toFixed(1) : "0.0";
      return `  ${s}: n=${b.count} win%=${wr} netPnl=${b.netPnl.toFixed(4)}`;
    }),
    "",
    `Trade outcomes by quality (closed):`,
    ...Object.entries(report.tradeOutcomeBreakdown.byQuality)
      .sort((a, b) => b[1].count - a[1].count)
      .map(([q, b]) => {
        const wr = b.count > 0 ? ((b.wins / b.count) * 100).toFixed(1) : "0.0";
        return `  ${q}: n=${b.count} win%=${wr} netPnl=${b.netPnl.toFixed(4)}`;
      }),
    "",
    `Trade outcomes by exit:`,
    `  TP: ${report.tradeOutcomeBreakdown.byExit.take_profit}`,
    `  SL: ${report.tradeOutcomeBreakdown.byExit.stop_loss}`,
    `  Timeout: ${report.tradeOutcomeBreakdown.byExit.timeout}`,
    `  Unknown: ${report.tradeOutcomeBreakdown.byExit.unknown}`,
    "",
    `Invalid market prices (binary rejected opps) by subreason:`,
    `  ${JSON.stringify(report.invalidMarketPricesSubreasonBreakdown)}`,
    "",
    formatBinaryYesNoComparativeConsole(report.yesNoComparative),
  ];
  return lines.join("\n");
}
