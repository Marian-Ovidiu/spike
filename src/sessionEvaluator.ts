import type { Opportunity } from "./opportunityTracker.js";
import type { SimulatedTrade } from "./simulationEngine.js";

export type SpikeQualityBin = {
  label: string;
  minSpikePct: number;
  maxSpikePct: number;
  count: number;
  validCount: number;
  /** Fraction of opportunities in this bin where strategy would enter. */
  validRate: number;
  avgSpikePercent: number;
};

export type SessionEvaluation = {
  rawOpportunityCount: number;
  /** Closed paper trades / raw spike opportunities (null if no opportunities). */
  opportunityToTradeConversion: number | null;
  /** Mean gap between consecutive opportunity timestamps (ms). */
  avgMsBetweenOpportunities: number | null;
  /** Gross winning P/L ÷ gross losing P/L (null: no trades; Infinity: no losses). */
  profitFactor: number | null;
  /** Mean closed − open duration (ms). */
  avgHoldTimeMs: number | null;
  spikeQualityBins: SpikeQualityBin[];
  verdict: "promising" | "neutral";
  grossProfit: number;
  grossLoss: number;
  totalTrades: number;
  totalProfit: number;
  winRate: number;
};

export type SessionEvaluationInput = {
  opportunities: readonly Opportunity[];
  trades: readonly SimulatedTrade[];
  totalProfit: number;
  winRate: number;
};

function computeGrossPnL(trades: readonly SimulatedTrade[]): {
  grossProfit: number;
  grossLoss: number;
} {
  let grossProfit = 0;
  let grossLoss = 0;
  for (const t of trades) {
    if (t.profitLoss > 0) grossProfit += t.profitLoss;
    else if (t.profitLoss < 0) grossLoss += -t.profitLoss;
  }
  return { grossProfit, grossLoss };
}

function computeProfitFactor(
  grossProfit: number,
  grossLoss: number,
  tradeCount: number
): number | null {
  if (tradeCount === 0) return null;
  if (grossLoss <= 0) return grossProfit > 0 ? Number.POSITIVE_INFINITY : null;
  return grossProfit / grossLoss;
}

function avgTimeBetweenOpportunities(
  opps: readonly Opportunity[]
): number | null {
  if (opps.length < 2) return null;
  const sorted = [...opps].sort((a, b) => a.timestamp - b.timestamp);
  let sum = 0;
  for (let i = 1; i < sorted.length; i++) {
    sum += sorted[i]!.timestamp - sorted[i - 1]!.timestamp;
  }
  return sum / (sorted.length - 1);
}

function avgHoldTime(trades: readonly SimulatedTrade[]): number | null {
  if (trades.length === 0) return null;
  let sum = 0;
  for (const t of trades) {
    sum += t.closedAt - t.openedAt;
  }
  return sum / trades.length;
}

function spikeQualityBySize(opps: readonly Opportunity[]): SpikeQualityBin[] {
  if (opps.length === 0) return [];
  const sorted = [...opps].sort((a, b) => a.spikePercent - b.spikePercent);
  const n = sorted.length;
  const bins: { start: number; end: number }[] =
    n < 3
      ? [{ start: 0, end: n }]
      : [
          { start: 0, end: Math.ceil(n / 3) },
          { start: Math.ceil(n / 3), end: Math.ceil((2 * n) / 3) },
          { start: Math.ceil((2 * n) / 3), end: n },
        ];

  const labels = ["small spike %", "medium spike %", "large spike %"];
  const out: SpikeQualityBin[] = [];

  for (let b = 0; b < bins.length; b++) {
    const { start, end } = bins[b]!;
    const slice = sorted.slice(start, end);
    if (slice.length === 0) continue;
    const minSp = slice[0]!.spikePercent;
    const maxSp = slice[slice.length - 1]!.spikePercent;
    let validCount = 0;
    let sumSp = 0;
    for (const o of slice) {
      sumSp += o.spikePercent;
      if (o.status === "valid") validCount += 1;
    }
    const label = n < 3 ? "all opportunities" : labels[b] ?? `bin ${b + 1}`;
    out.push({
      label,
      minSpikePct: minSp,
      maxSpikePct: maxSp,
      count: slice.length,
      validCount,
      validRate: validCount / slice.length,
      avgSpikePercent: sumSp / slice.length,
    });
  }

  return out;
}

function computeVerdict(
  e: Omit<SessionEvaluation, "verdict">
): "promising" | "neutral" {
  const n = e.totalTrades;
  const tp = e.totalProfit;
  const pf = e.profitFactor;

  if (n === 0) return "neutral";

  const noLosingTrades = pf === Number.POSITIVE_INFINITY;
  const finitePf =
    pf !== null && Number.isFinite(pf) ? pf : noLosingTrades ? 999 : 0;
  const strongProfit =
    tp > 0 && (noLosingTrades || finitePf >= 1.15);
  const balanced = tp > 0 && finitePf >= 1.05 && n >= 2;
  const goodWinRate = tp > 0 && e.winRate >= 45 && n >= 3 && (noLosingTrades || (pf !== null && finitePf >= 1));
  const efficient =
    (e.opportunityToTradeConversion ?? 0) >= 0.05 &&
    tp > 0 &&
    (noLosingTrades || finitePf >= 1.1);

  if (strongProfit || goodWinRate || efficient) return "promising";
  if (balanced && (e.opportunityToTradeConversion ?? 0) > 0) return "promising";
  return "neutral";
}

/**
 * Derive session-level metrics for interpretation after a live monitor run.
 */
export function evaluateSession(input: SessionEvaluationInput): SessionEvaluation {
  const opps = input.opportunities;
  const trades = input.trades;
  const oppCount = opps.length;
  const tradeCount = trades.length;

  const { grossProfit, grossLoss } = computeGrossPnL(trades);
  const profitFactor = computeProfitFactor(
    grossProfit,
    grossLoss,
    tradeCount
  );

  const opportunityToTradeConversion =
    oppCount > 0 ? tradeCount / oppCount : null;

  const base: Omit<SessionEvaluation, "verdict"> = {
    rawOpportunityCount: oppCount,
    opportunityToTradeConversion,
    avgMsBetweenOpportunities: avgTimeBetweenOpportunities(opps),
    profitFactor,
    avgHoldTimeMs: avgHoldTime(trades),
    spikeQualityBins: spikeQualityBySize(opps),
    grossProfit,
    grossLoss,
    totalTrades: tradeCount,
    totalProfit: input.totalProfit,
    winRate: input.winRate,
  };

  return {
    ...base,
    verdict: computeVerdict(base),
  };
}

function fmtMs(ms: number | null): string {
  if (ms === null) return "n/a";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)} s`;
  const m = Math.floor(s / 60);
  const rs = s - m * 60;
  return `${m}m ${rs.toFixed(0)}s`;
}

function fmtPct(n: number): string {
  return `${n.toFixed(1)}%`;
}

function fmtPf(pf: number | null): string {
  if (pf === null) return "n/a";
  if (!Number.isFinite(pf)) return "∞ (no losing trades)";
  return pf.toFixed(2);
}

/**
 * Human-readable session interpretation (stdout).
 */
export function printSessionEvaluationReport(evaluation: SessionEvaluation): void {
  const e = evaluation;
  const conv =
    e.opportunityToTradeConversion !== null && e.rawOpportunityCount > 0
      ? `${(e.opportunityToTradeConversion * 100).toFixed(1)}%  (${e.totalTrades} trades / ${e.rawOpportunityCount} opportunities)`
      : "n/a (no opportunities)";

  console.log("");
  console.log("──────── Session evaluation ───────────────────────────────────");
  console.log(
    `${"Opp→trade".padEnd(14)} ${conv}`
  );
  console.log(
    `${"Opp spacing".padEnd(14)} ${fmtMs(e.avgMsBetweenOpportunities)}`
  );
  console.log(`${"Profit factor".padEnd(14)} ${fmtPf(e.profitFactor)}`);
  console.log(`${"Avg hold".padEnd(14)} ${fmtMs(e.avgHoldTimeMs)}`);
  console.log(
    `${"Gross +/−".padEnd(14)} +${e.grossProfit.toFixed(4)} / −${e.grossLoss.toFixed(4)}`
  );

  if (e.spikeQualityBins.length > 0) {
    console.log(`${"Spike bins".padEnd(14)} valid-rate & avg |move| by tertile`);
    for (const bin of e.spikeQualityBins) {
      const range = `${bin.minSpikePct.toFixed(3)}–${bin.maxSpikePct.toFixed(3)}%`;
      console.log(
        `  ${bin.label.padEnd(16)} n=${bin.count}  valid ${fmtPct(bin.validRate * 100)}  avg spike ${bin.avgSpikePercent.toFixed(4)}%  [${range}]`
      );
    }
  }

  const verdictLabel = e.verdict === "promising" ? "PROMISING" : "NEUTRAL";
  console.log("");
  console.log(`${"Verdict".padEnd(14)} ${verdictLabel} — paper session (not predictive of live fills)`);
  console.log("──────────────────────────────────────────────────────────────");
  console.log("");
}
