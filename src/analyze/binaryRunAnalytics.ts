import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { Opportunity } from "../opportunityTracker.js";
import type { SimulatedTrade } from "../simulationEngine.js";
import type { MarketMode } from "../market/types.js";
import type { QualityProfile } from "../preEntryQualityGate.js";

export const BINARY_RUN_ANALYTICS_SCHEMA = "binary_run_analytics_v1" as const;

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
  qualityBucketBreakdown: Record<string, number>;
  borderlineFunnelBreakdown: BorderlineFunnelBreakdown;
  tradeOutcomeBreakdown: TradeOutcomeBreakdown;
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

  for (const t of binaryTrades) {
    const pnl = t.profitLoss;
    pnlTotal += pnl;
    const won = pnl > 0;
    if (won) wins += 1;
    if (t.exitReason === "timeout") timeouts += 1;

    const bucket = edgeBucketForModelEdge(t.entryModelEdge);
    edgeBucketBreakdown[bucket] += 1;

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
    qualityBucketBreakdown,
    borderlineFunnelBreakdown,
    tradeOutcomeBreakdown: tradeOutcome,
  };
}

/** Loose JSONL row shape after `JSON.parse` (file replay / older rows). */
export type OpportunityJsonlRow = {
  opportunityType?: string;
  qualityProfile?: string;
  status?: string;
  marketMode?: string;
};

export type BinaryTradeJsonlRow = {
  marketMode?: string;
  netPnlUsdt?: number;
  exitReason?: string;
  outcomeTokenBought?: string | null;
  entryQualityProfile?: QualityProfile | string;
  entryModelEdge?: number | null;
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
    qualityBucketBreakdown,
    borderlineFunnelBreakdown: input.borderlineFunnel ?? {
      borderlineEntered: 0,
      borderlinePromoted: 0,
      borderlineRejectedTimeout: 0,
      borderlineRejectedWeak: 0,
    },
    tradeOutcomeBreakdown: tradeOutcome,
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
  ];
  return lines.join("\n");
}
