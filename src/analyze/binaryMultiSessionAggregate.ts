import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";

import type {
  BinaryRunAnalyticsReport,
  EdgeBucketLabel,
  MispricingBucketTradeStats,
} from "./binaryRunAnalytics.js";
import {
  MISPRICING_BUCKET_DISPLAY_ORDER,
  mispricingBucketDisplayLabel,
} from "./binaryRunAnalytics.js";

export const BINARY_MULTI_SESSION_SCHEMA =
  "binary_multi_session_aggregate_v1" as const;

function sampleStddev(values: readonly number[]): number | null {
  const n = values.length;
  if (n <= 1) return n === 0 ? null : 0;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const v =
    values.reduce((s, x) => s + (x - mean) * (x - mean), 0) / (n - 1);
  return Math.sqrt(Math.max(0, v));
}

/** Discovered `session-summary.json` plus any `sessions/*.json` under `rootDir`. */
export function discoverSessionSummaryPaths(rootDir: string): string[] {
  const root = resolve(rootDir);
  const out: string[] = [];
  const primary = join(root, "session-summary.json");
  if (existsSync(primary)) {
    out.push(primary);
  }
  const sess = join(root, "sessions");
  if (existsSync(sess)) {
    for (const f of readdirSync(sess)) {
      if (f.toLowerCase().endsWith(".json")) {
        out.push(join(sess, f));
      }
    }
  }
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const p of out) {
    const n = resolve(p);
    if (!seen.has(n)) {
      seen.add(n);
      deduped.push(n);
    }
  }
  return deduped.sort();
}

/** Root `trades.jsonl` + `sessions/<subdir>/trades.jsonl` (per archived multi-session dirs). */
export function discoverTradesJsonlPaths(rootDir: string): string[] {
  const root = resolve(rootDir);
  const out: string[] = [];
  const p0 = join(root, "trades.jsonl");
  if (existsSync(p0)) {
    out.push(p0);
  }
  const sess = join(root, "sessions");
  if (!existsSync(sess)) {
    return out;
  }
  for (const ent of readdirSync(sess, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    const t = join(sess, ent.name, "trades.jsonl");
    if (existsSync(t)) {
      out.push(t);
    }
  }
  return out;
}

type LooseSummary = Record<string, unknown>;

function num(x: unknown, fallback = 0): number {
  return typeof x === "number" && Number.isFinite(x) ? x : fallback;
}

function str(x: unknown): string | null {
  return typeof x === "string" && x.length > 0 ? x : null;
}

function coerceMispricingRow(
  raw: Partial<MispricingBucketTradeStats> & { bucket: EdgeBucketLabel }
): MispricingBucketTradeStats {
  const trades = num(raw.trades);
  let wins = raw.wins !== undefined ? num(raw.wins) : NaN;
  if (!Number.isFinite(wins) || wins < 0) {
    const wr = num(raw.winRatePercent);
    wins =
      trades > 0 && Number.isFinite(wr)
        ? Math.round((wr / 100) * trades)
        : 0;
  }
  const pnlTotal = num(raw.pnlTotal);
  const wrPct = trades > 0 ? (wins / trades) * 100 : 0;
  const avgPnl = trades > 0 ? pnlTotal / trades : 0;
  const avgMfe =
    raw.avgMfe !== null &&
    raw.avgMfe !== undefined &&
    Number.isFinite(raw.avgMfe as number)
      ? (raw.avgMfe as number)
      : null;
  const avgMae =
    raw.avgMae !== null &&
    raw.avgMae !== undefined &&
    Number.isFinite(raw.avgMae as number)
      ? (raw.avgMae as number)
      : null;
  return {
    bucket: raw.bucket,
    trades,
    wins,
    winRatePercent: wrPct,
    pnlTotal,
    avgPnlPerTrade: avgPnl,
    avgMfe,
    avgMae,
  };
}

function mergeMispricingTradeStats(
  sessions: readonly MispricingBucketTradeStats[][]
): MispricingBucketTradeStats[] {
  const perBucket = new Map<
    EdgeBucketLabel,
    {
      trades: number;
      wins: number;
      pnlSum: number;
      mfeSum: number;
      mfeW: number;
      maeSum: number;
      maeW: number;
    }
  >();
  for (const k of MISPRICING_BUCKET_DISPLAY_ORDER) {
    perBucket.set(k, {
      trades: 0,
      wins: 0,
      pnlSum: 0,
      mfeSum: 0,
      mfeW: 0,
      maeSum: 0,
      maeW: 0,
    });
  }

  for (const rows of sessions) {
    for (const raw of rows) {
      const r = coerceMispricingRow(raw);
      const acc = perBucket.get(r.bucket);
      if (acc === undefined) continue;
      acc.trades += r.trades;
      acc.wins += r.wins;
      acc.pnlSum += r.pnlTotal;
      if (r.avgMfe !== null && r.trades > 0) {
        acc.mfeSum += r.avgMfe * r.trades;
        acc.mfeW += r.trades;
      }
      if (r.avgMae !== null && r.trades > 0) {
        acc.maeSum += r.avgMae * r.trades;
        acc.maeW += r.trades;
      }
    }
  }

  const out: MispricingBucketTradeStats[] = [];
  for (const bucket of MISPRICING_BUCKET_DISPLAY_ORDER) {
    const x = perBucket.get(bucket)!;
    const n = x.trades;
    const wr = n > 0 ? (x.wins / n) * 100 : 0;
    out.push({
      bucket,
      trades: n,
      wins: x.wins,
      winRatePercent: wr,
      pnlTotal: x.pnlSum,
      avgPnlPerTrade: n > 0 ? x.pnlSum / n : 0,
      avgMfe: x.mfeW > 0 ? x.mfeSum / x.mfeW : null,
      avgMae: x.maeW > 0 ? x.maeSum / x.maeW : null,
    });
  }
  return out;
}

function mergeEdgeCounts(
  rows: readonly Record<EdgeBucketLabel, number>[]
): Record<EdgeBucketLabel, number> {
  const z = (): Record<EdgeBucketLabel, number> => ({
    "<0.01": 0,
    "0.01-0.03": 0,
    "0.03-0.05": 0,
    ">0.05": 0,
    unknown: 0,
  });
  const acc = z();
  for (const r of rows) {
    for (const k of MISPRICING_BUCKET_DISPLAY_ORDER) {
      acc[k] += num(r[k]);
    }
  }
  return acc;
}

type QualityAcc = {
  trades: number;
  wins: number;
  netPnlUsdt: number;
};

function mergeQualityBuckets(
  sessions: readonly NonNullable<
    BinaryRunAnalyticsReport["tradeOutcomeBreakdown"]
  >[]
): Record<
  string,
  { trades: number; wins: number; netPnlUsdt: number; winRatePercent: number }
> {
  const by = new Map<string, QualityAcc>();
  for (const br of sessions) {
    const bq = br.byQuality;
    if (bq === undefined) continue;
    for (const [q, v] of Object.entries(bq)) {
      const prev = by.get(q) ?? { trades: 0, wins: 0, netPnlUsdt: 0 };
      prev.trades += v.count;
      prev.wins += v.wins;
      prev.netPnlUsdt += v.netPnl;
      by.set(q, prev);
    }
  }
  const out: Record<
    string,
    { trades: number; wins: number; netPnlUsdt: number; winRatePercent: number }
  > = {};
  for (const [q, v] of by) {
    out[q] = {
      trades: v.trades,
      wins: v.wins,
      netPnlUsdt: v.netPnlUsdt,
      winRatePercent:
        v.trades > 0 ? (v.wins / v.trades) * 100 : 0,
    };
  }
  return out;
}

export type BinaryMultiSessionSessionRow = {
  summaryPath: string;
  summaryFileName: string;
  sessionStartedAt: string | null;
  sessionEndedAt: string | null;
  totalTrades: number;
  totalPnlUsdt: number;
  winRatePercent: number;
  maxDrawdown: number;
};

export type BinaryMultiSessionAggregateReport = {
  schema: typeof BINARY_MULTI_SESSION_SCHEMA;
  generatedAtIso: string;
  rootDirectory: string;
  summaryPathsUsed: readonly string[];
  tradesJsonlPathsUsed: readonly string[];

  totals: {
    sessionsAnalyzed: number;
    totalTrades: number;
    overallWinRatePercent: number;
    overallPnlUsdt: number;
    avgPnlPerTrade: number;
    maxSessionDrawdown: number;
    profitableSessions: number;
    losingSessions: number;
    flatSessions: number;
  };

  stability: {
    pctProfitableSessions: number;
    stddevPnlPerTrade: number | null;
    stddevSessionPnlUsdt: number | null;
    bestSession: {
      summaryPath: string;
      sessionStartedAt: string | null;
      totalPnlUsdt: number;
      totalTrades: number;
    };
    worstSession: {
      summaryPath: string;
      sessionStartedAt: string | null;
      totalPnlUsdt: number;
      totalTrades: number;
    };
  };

  breakdowns: {
    mispricingByBucket: MispricingBucketTradeStats[];
    edgeBucketTradeCounts: Record<EdgeBucketLabel, number>;
    qualityByBucket: Record<
      string,
      {
        trades: number;
        wins: number;
        netPnlUsdt: number;
        winRatePercent: number;
      }
    >;
  };

  sessions: BinaryMultiSessionSessionRow[];
};

function readSummary(path: string): LooseSummary | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as LooseSummary;
  } catch {
    return null;
  }
}

function binaryTradePnlsFromJsonl(files: readonly string[]): number[] {
  const pnls: number[] = [];
  for (const f of files) {
    let raw: string;
    try {
      raw = readFileSync(f, "utf8");
    } catch {
      continue;
    }
    for (const line of raw.split(/\r?\n/)) {
      if (line.trim().length === 0) continue;
      try {
        const row = JSON.parse(line) as Record<string, unknown>;
        if (row.marketMode !== "binary") continue;
        const pl = row.netPnlUsdt;
        if (typeof pl === "number" && Number.isFinite(pl)) {
          pnls.push(pl);
        }
      } catch {
        /* skip line */
      }
    }
  }
  return pnls;
}

/**
 * Rolls up binary sessions under `rootDir`:
 * `session-summary.json`, plus `sessions/*.json`; optional archived `sessions/<name>/trades.jsonl`.
 */
export function computeBinaryMultiSessionAggregate(
  rootDir: string
): BinaryMultiSessionAggregateReport | null {
  const rootDirectory = resolve(rootDir);
  const summaryPaths = discoverSessionSummaryPaths(rootDirectory);
  const tradesPaths = discoverTradesJsonlPaths(rootDirectory);

  type Parsed = {
    path: string;
    summary: LooseSummary;
    sim: {
      totalTrades: number;
      wins: number;
      losses: number;
      totalPnl: number;
      winRatePercent: number;
      maxDrawdown: number;
    };
    bra: BinaryRunAnalyticsReport | null;
  };

  const parsed: Parsed[] = [];
  for (const path of summaryPaths) {
    const summary = readSummary(path);
    if (summary === null) continue;
    if (summary.marketMode !== "binary") continue;
    const simRaw = summary.simulation as LooseSummary | undefined;
    const sim = {
      totalTrades: num(simRaw?.totalTrades),
      wins: num(simRaw?.wins),
      losses: num(simRaw?.losses),
      totalPnl: num(simRaw?.totalPnl),
      winRatePercent: num(simRaw?.winRatePercent),
      maxDrawdown: num(simRaw?.maxDrawdown),
    };
    const bra =
      summary.binaryRunAnalytics !== undefined &&
      summary.binaryRunAnalytics !== null
        ? (summary.binaryRunAnalytics as BinaryRunAnalyticsReport)
        : null;
    parsed.push({ path, summary, sim, bra });
  }

  if (parsed.length === 0) {
    return null;
  }

  let totalTradesAll = 0;
  let winsAll = 0;
  let pnlAll = 0;
  let maxDd = 0;
  let profitable = 0;
  let losing = 0;
  let flat = 0;

  const sessionPnls: number[] = [];
  const mispricingInputs: MispricingBucketTradeStats[][] = [];
  const edgeInputs: Record<EdgeBucketLabel, number>[] = [];
  const qualityInputs: BinaryRunAnalyticsReport["tradeOutcomeBreakdown"][] =
    [];

  const sessions: BinaryMultiSessionSessionRow[] = [];

  for (const p of parsed) {
    const { sim } = p;
    totalTradesAll += sim.totalTrades;
    winsAll += sim.wins;
    pnlAll += sim.totalPnl;
    maxDd = Math.max(maxDd, sim.maxDrawdown);
    sessionPnls.push(sim.totalPnl);
    if (sim.totalPnl > 0) profitable += 1;
    else if (sim.totalPnl < 0) losing += 1;
    else flat += 1;

    if (p.bra !== null) {
      mispricingInputs.push(p.bra.mispricingBucketTradeStats ?? []);
      edgeInputs.push(p.bra.edgeBucketBreakdown);
      qualityInputs.push(p.bra.tradeOutcomeBreakdown);
    }

    sessions.push({
      summaryPath: p.path,
      summaryFileName: basename(p.path),
      sessionStartedAt: str(p.summary.sessionStartedAt),
      sessionEndedAt: str(p.summary.sessionEndedAt),
      totalTrades: sim.totalTrades,
      totalPnlUsdt: sim.totalPnl,
      winRatePercent: sim.winRatePercent,
      maxDrawdown: sim.maxDrawdown,
    });
  }

  const nSess = parsed.length;
  const overallWin =
    totalTradesAll > 0 ? (winsAll / totalTradesAll) * 100 : 0;
  const avgPnlTrade =
    totalTradesAll > 0 ? pnlAll / totalTradesAll : 0;

  const tradePnls = binaryTradePnlsFromJsonl(tradesPaths);
  const stdTrades =
    tradePnls.length > 0 ? sampleStddev(tradePnls) : null;
  const stdSess = sampleStddev(sessionPnls);

  let best = sessions[0]!;
  let worst = sessions[0]!;
  for (const s of sessions) {
    if (s.totalPnlUsdt > best.totalPnlUsdt) {
      best = s;
    }
    if (s.totalPnlUsdt < worst.totalPnlUsdt) {
      worst = s;
    }
  }

  return {
    schema: BINARY_MULTI_SESSION_SCHEMA,
    generatedAtIso: new Date().toISOString(),
    rootDirectory,
    summaryPathsUsed: summaryPaths,
    tradesJsonlPathsUsed: tradesPaths,
    totals: {
      sessionsAnalyzed: nSess,
      totalTrades: totalTradesAll,
      overallWinRatePercent: overallWin,
      overallPnlUsdt: pnlAll,
      avgPnlPerTrade: avgPnlTrade,
      maxSessionDrawdown: maxDd,
      profitableSessions: profitable,
      losingSessions: losing,
      flatSessions: flat,
    },
    stability: {
      pctProfitableSessions: nSess > 0 ? (profitable / nSess) * 100 : 0,
      stddevPnlPerTrade: stdTrades,
      stddevSessionPnlUsdt: stdSess,
      bestSession: {
        summaryPath: best.summaryPath,
        sessionStartedAt: best.sessionStartedAt,
        totalPnlUsdt: best.totalPnlUsdt,
        totalTrades: best.totalTrades,
      },
      worstSession: {
        summaryPath: worst.summaryPath,
        sessionStartedAt: worst.sessionStartedAt,
        totalPnlUsdt: worst.totalPnlUsdt,
        totalTrades: worst.totalTrades,
      },
    },
    breakdowns: {
      mispricingByBucket: mergeMispricingTradeStats(mispricingInputs),
      edgeBucketTradeCounts: mergeEdgeCounts(edgeInputs),
      qualityByBucket: mergeQualityBuckets(qualityInputs),
    },
    sessions,
  };
}

export function formatBinaryMultiSessionAggregateConsole(
  r: BinaryMultiSessionAggregateReport
): string {
  const lines: string[] = [
    "",
    `=== Binary multi-session aggregate (${r.schema}) ===`,
    `Root: ${r.rootDirectory}`,
    `Generated: ${r.generatedAtIso}`,
    "",
    `Summaries read (${r.summaryPathsUsed.length}):`,
    ...r.summaryPathsUsed.map((p) => `  - ${p}`),
    "",
    `Trades JSONL (${r.tradesJsonlPathsUsed.length}):`,
    ...(r.tradesJsonlPathsUsed.length > 0
      ? r.tradesJsonlPathsUsed.map((p) => `  - ${p}`)
      : [`  (none — stddev per trade uses trade files when present)`]),
    "",
    "── Totals (binary sessions) ─────────────────────────────────",
    `  Sessions analyzed     ${r.totals.sessionsAnalyzed}`,
    `  Total trades          ${r.totals.totalTrades}`,
    `  Overall win rate %    ${r.totals.overallWinRatePercent.toFixed(2)}`,
    `  Overall PnL (USDT)    ${r.totals.overallPnlUsdt.toFixed(4)}`,
    `  Avg PnL / trade       ${r.totals.avgPnlPerTrade.toFixed(6)}`,
    `  Max session drawdown  ${r.totals.maxSessionDrawdown.toFixed(4)}  (max of per-session equity DD)`,
    `  Profitable sessions   ${r.totals.profitableSessions}`,
    `  Losing sessions       ${r.totals.losingSessions}`,
    `  Flat sessions         ${r.totals.flatSessions}`,
    "",
    "── Stability ────────────────────────────────────────────────",
    `  Profitable sessions % ${r.stability.pctProfitableSessions.toFixed(1)}`,
    `  Stddev PnL / trade    ${
      r.stability.stddevPnlPerTrade !== null
        ? r.stability.stddevPnlPerTrade.toFixed(6)
        : "n/a (no trade rows in JSONL)"
    }`,
    `  Stddev session PnL    ${
      r.stability.stddevSessionPnlUsdt !== null
        ? r.stability.stddevSessionPnlUsdt.toFixed(6)
        : "n/a"
    }`,
    `  Best session PnL      ${r.stability.bestSession.totalPnlUsdt.toFixed(4)}  (${r.stability.bestSession.summaryPath})`,
    `  Worst session PnL     ${r.stability.worstSession.totalPnlUsdt.toFixed(4)}  (${r.stability.worstSession.summaryPath})`,
    "",
    "── Mispricing bucket (merged entry edge / fair − ask) ───────",
    `${"Range".padEnd(18)} ${"n".padStart(5)} ${"wins".padStart(5)} ${"win%".padStart(
      7
    )} ${"ΣPnL".padStart(10)} ${"avgPnL".padStart(10)} ${"avgMFE".padStart(
      10
    )} ${"avgMAE".padStart(10)}`,
  ];
  for (const b of r.breakdowns.mispricingByBucket) {
    const lab = mispricingBucketDisplayLabel(b.bucket).padEnd(18);
    lines.push(
      `${lab} ${String(b.trades).padStart(5)} ${String(b.wins).padStart(5)} ${`${b.winRatePercent.toFixed(1)}%`.padStart(7)} ${b.pnlTotal.toFixed(4).padStart(10)} ${b.avgPnlPerTrade.toFixed(4).padStart(10)} ${(b.avgMfe !== null ? b.avgMfe.toFixed(6) : "—").padStart(10)} ${(b.avgMae !== null ? b.avgMae.toFixed(6) : "—").padStart(10)}`
    );
  }
  lines.push("");
  lines.push("── Edge bucket (trade counts by entry edge bin) ─────────────");
  for (const k of MISPRICING_BUCKET_DISPLAY_ORDER) {
    lines.push(
      `  ${mispricingBucketDisplayLabel(k).padEnd(16)} ${r.breakdowns.edgeBucketTradeCounts[k]}`
    );
  }
  lines.push("");
  lines.push("── Quality bucket (merged closed trades) ────────────────────");
  const qkeys = Object.keys(r.breakdowns.qualityByBucket).sort();
  if (qkeys.length === 0) {
    lines.push("  (no quality breakdown in session summaries)");
  } else {
    for (const q of qkeys) {
      const v = r.breakdowns.qualityByBucket[q]!;
      lines.push(
        `  ${q}: n=${v.trades} wins=${v.wins} win%=${v.winRatePercent.toFixed(
          1
        )} netPnl=${v.netPnlUsdt.toFixed(4)}`
      );
    }
  }
  lines.push("");
  lines.push("── Per session ───────────────────────────────────────────────");
  for (const s of r.sessions) {
    lines.push(
      `  ${s.summaryFileName}  trades=${s.totalTrades}  pnl=${s.totalPnlUsdt.toFixed(4)}  win%=${s.winRatePercent.toFixed(1)}  maxDD=${s.maxDrawdown.toFixed(4)}`
    );
  }
  lines.push(
    "──────────────────────────────────────────────────────────────"
  );
  return lines.join("\n");
}
