import type { StrategyTickResult } from "./botLoop.js";
import { formatEntryReasonsForLog } from "./entryConditions.js";
import type { Opportunity } from "./opportunityTracker.js";
import { SimulationEngine, type SimulatedTrade } from "./simulationEngine.js";

/** Fixed label width for boxed rows (label + two spaces before value). */
const LW = 14;

function row(label: string, value: string): string {
  return `│ ${label.padEnd(LW)}  ${value}`;
}

function fmtTime(): string {
  return new Date().toLocaleTimeString("en-GB", { hour12: false });
}

export function fmtBtcUsd(n: number): string {
  return n.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function fmtPrice(n: number): string {
  if (!Number.isFinite(n)) return "n/a";
  return n.toFixed(4);
}

export function fmtPct4(n: number): string {
  if (!Number.isFinite(n)) return "n/a";
  return `${n.toFixed(4)}%`;
}

function formatHoldDurationMs(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  const sec = Math.floor(ms / 1000);
  const min = Math.floor(sec / 60);
  const remS = sec % 60;
  if (min === 0) return `${sec}s`;
  return `${min}m ${remS}s`;
}

function exitReasonLabel(reason: SimulatedTrade["exitReason"]): string {
  switch (reason) {
    case "profit":
      return "take profit";
    case "stop":
      return "stop loss";
    case "timeout":
      return "time exit";
    default:
      return reason;
  }
}

function formatPnl(pnl: number): string {
  return pnl >= 0 ? `+${pnl.toFixed(4)}` : pnl.toFixed(4);
}

const OPP_TOP =
  "┌── Opportunity (valid) ───────────────────────────────────────";
const OPP_BOT =
  "└──────────────────────────────────────────────────────────────";
const TRADE_TOP =
  "┌── Paper trade closed ────────────────────────────────────────";
const TRADE_BOT =
  "└──────────────────────────────────────────────────────────────";

function bestWorstTradeSummary(sim: SimulationEngine): {
  best: string;
  worst: string;
} {
  const trades = sim.getTradeHistory();
  if (trades.length === 0) return { best: "—", worst: "—" };
  let best = trades[0]!;
  let worst = trades[0]!;
  for (const t of trades) {
    if (t.profitLoss > best.profitLoss) best = t;
    if (t.profitLoss < worst.profitLoss) worst = t;
  }
  const fmt = (t: SimulatedTrade) =>
    `#${t.id} ${t.profitLoss >= 0 ? "+" : ""}${t.profitLoss.toFixed(4)}`;
  return { best: fmt(best), worst: fmt(worst) };
}

/**
 * One compact line per monitor tick — no object dumps.
 */
export function formatMonitorTickLine(
  tick: StrategyTickResult,
  sim: SimulationEngine,
  minSamples: number
): string {
  const t = fmtTime();
  if (tick.kind === "no_btc") {
    return `[live] ${t}  │  BTC fetch failed`;
  }
  if (tick.kind === "warming") {
    return `[live] ${t}  │  BTC $${fmtBtcUsd(tick.btc)}  │  warmup ${tick.n}/${minSamples}`;
  }
  if (tick.kind === "no_sides") {
    return `[live] ${t}  │  BTC $${fmtBtcUsd(tick.btc)}  │  no quotes  │  buf ${tick.n}/${tick.cap}`;
  }

  const { btc, n, cap, sides, entry } = tick;
  const y = fmtPrice(sides.upSidePrice);
  const no = fmtPrice(sides.downSidePrice);
  const pos = sim.getOpenPosition();
  const simHint = pos
    ? `open ${pos.direction} ×${pos.contracts} @ ${fmtPrice(pos.entryPrice)}`
    : "flat";

  let sig = "idle";
  if (entry.shouldEnter && entry.direction) {
    sig = `valid → ${entry.direction}`;
  } else if (!entry.shouldEnter) {
    const human = formatEntryReasonsForLog(entry);
    sig = human ? `rejected (${human})` : "rejected";
  }

  return `[live] ${t}  │  BTC $${fmtBtcUsd(btc)}  │  YES ${y}  NO ${no}  │  buf ${n}/${cap}  │  ${sig}  │  sim ${simHint}`;
}

/**
 * Expanded block for a valid raw-spike opportunity (strategy would enter).
 */
export function formatValidOpportunityBlock(o: Opportunity): string {
  const ts = new Date(o.timestamp).toISOString();
  const dir = o.spikeDirection ?? "—";
  const lines = [
    "",
    OPP_TOP,
    row("Observed", ts),
    row("BTC spot", `$${fmtBtcUsd(o.btcPrice)}`),
    row("Prev → last", `${o.previousPrice.toFixed(2)} → ${o.currentPrice.toFixed(2)}`),
    row("Spike move", `${fmtPct4(o.spikePercent)} (dir ${dir})`),
    row("Prior range", fmtPct4(o.priorRangePercent)),
    row("YES / NO", `${fmtPrice(o.upSidePrice)} / ${fmtPrice(o.downSidePrice)}`),
    row("Stable prior", o.stableRangeDetected ? "yes" : "no"),
    row("Ctx spike", o.spikeDetected ? "yes" : "no"),
    row("Entry", "allowed"),
    OPP_BOT,
    "",
  ];
  return lines.join("\n");
}

export function logValidOpportunityBlock(o: Opportunity): void {
  if (o.status !== "valid") return;
  console.log(formatValidOpportunityBlock(o));
}

/**
 * Expanded block when a paper trade closes.
 */
export function formatPaperTradeClosedBlock(trade: SimulatedTrade): string {
  const holdMs = trade.closedAt - trade.openedAt;
  const lines = [
    "",
    TRADE_TOP,
    row("Trade id", `#${trade.id}`),
    row("Direction", trade.direction),
    row("Contracts", String(trade.contracts)),
    row("Entry price", fmtPrice(trade.entryPrice)),
    row("Exit price", fmtPrice(trade.exitPrice)),
    row("P / L", formatPnl(trade.profitLoss)),
    row("Exit reason", exitReasonLabel(trade.exitReason)),
    row("Hold time", formatHoldDurationMs(holdMs)),
    row("Closed at", new Date(trade.closedAt).toISOString()),
    TRADE_BOT,
    "",
  ];
  return lines.join("\n");
}

export function logPaperTradeClosedBlock(trade: SimulatedTrade): void {
  console.log(formatPaperTradeClosedBlock(trade));
}

export function printLiveMonitorBanner(params: {
  quotesDetail: string;
  tickIntervalSec: number;
  bufferSlots: number;
  minSamples: number;
  persistPath: string;
}): void {
  const L = 13;
  console.log("");
  console.log("════════ Live monitor (observation + paper sim) ══════════════");
  console.log(`${"Quotes".padEnd(L)} ${params.quotesDetail}`);
  console.log(`${"Tick".padEnd(L)} every ${params.tickIntervalSec}s`);
  console.log(
    `${"Buffer".padEnd(L)} ${params.bufferSlots} slots (min ${params.minSamples} samples)`
  );
  console.log(`${"Orders".padEnd(L)} none — monitor never sends real orders`);
  console.log(`${"Paper sim".padEnd(L)} strategy entries; trade block on each close`);
  console.log(`${"Persist".padEnd(L)} ${params.persistPath}`);
  console.log(`${"Stop".padEnd(L)} Ctrl+C — report + session-summary.json`);
  console.log("══════════════════════════════════════════════════════════════");
  console.log("");
}

export function formatDurationMs(ms: number): string {
  const secTotal = Math.floor(ms / 1000);
  const h = Math.floor(secTotal / 3600);
  const m = Math.floor((secTotal % 3600) / 60);
  const s = secTotal % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export function printPeriodicRuntimeSummary(
  headline: string,
  counters: {
    ticksObserved: number;
    btcFetchFailures: number;
    spikeEventsDetected: number;
    candidateOpportunities: number;
    validOpportunities: number;
    rejectedOpportunities: number;
  },
  sim: SimulationEngine
): void {
  const perf = sim.getPerformanceStats();
  const bestWorst = bestWorstTradeSummary(sim);
  const wr = Number.isFinite(perf.winRate) ? perf.winRate.toFixed(1) : "0.0";
  const totalPl = formatPnl(perf.totalProfit);
  const avgPl = formatPnl(perf.averageProfitPerTrade);
  console.log("");
  console.log(`── ${headline} ──`);
  console.log(
    `${"Session".padEnd(10)} ticks ${counters.ticksObserved}  │  BTC fail ${counters.btcFetchFailures}  │  spikes ${counters.spikeEventsDetected}  │  cand ${counters.candidateOpportunities}  │  valid ${counters.validOpportunities}  │  rej ${counters.rejectedOpportunities}`
  );
  console.log(
    `${"Paper P/L".padEnd(10)} trades ${perf.totalTrades}  │  W ${perf.wins}  L ${perf.losses}  BE ${perf.breakeven}  │  win% ${wr}  │  Σ ${totalPl}  │  avg ${avgPl}`
  );
  console.log(
    `${"Risk".padEnd(10)} max DD ${perf.maxEquityDrawdown.toFixed(4)}  │  equity ${perf.currentEquity.toFixed(2)} (start ${perf.initialEquity.toFixed(2)})`
  );
  console.log(`${"Best/worst".padEnd(10)} ${bestWorst.best}  │  ${bestWorst.worst}`);
  console.log("");
}

export function printShutdownReport(
  startedAtMs: number,
  counters: {
    ticksObserved: number;
    validOpportunities: number;
    rejectedOpportunities: number;
  },
  perf: {
    totalTrades: number;
    winRate: number;
    totalProfit: number;
    maxEquityDrawdown: number;
    currentEquity: number;
    initialEquity: number;
  }
): void {
  const durationMs = Math.max(0, Date.now() - startedAtMs);
  const wr = Number.isFinite(perf.winRate) ? perf.winRate.toFixed(1) : "0.0";
  const totalPl = formatPnl(perf.totalProfit);
  const oppFound = counters.validOpportunities + counters.rejectedOpportunities;
  console.log("");
  console.log("════════ Live monitor — final report (shutdown) ══════════════");
  console.log(`${"Runtime".padEnd(14)} ${formatDurationMs(durationMs)}`);
  console.log(`${"Ticks".padEnd(14)} ${counters.ticksObserved}`);
  console.log(`${"Opportunities".padEnd(14)} ${oppFound} (raw spike events)`);
  console.log(`${"Trades (sim)".padEnd(14)} ${perf.totalTrades}`);
  console.log(`${"Win rate".padEnd(14)} ${wr}%`);
  console.log(`${"Total P/L".padEnd(14)} ${totalPl}`);
  console.log(`${"Max drawdown".padEnd(14)} ${perf.maxEquityDrawdown.toFixed(4)}`);
  console.log(
    `${"Equity".padEnd(14)} ${perf.currentEquity.toFixed(2)} (start ${perf.initialEquity.toFixed(2)})`
  );
  console.log("══════════════════════════════════════════════════════════════");
  console.log("");
}
