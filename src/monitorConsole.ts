import type { StrategyTickResult } from "./botLoop.js";
import { formatEntryReasonsForLog } from "./entryConditions.js";
import type { Opportunity } from "./opportunityTracker.js";
import { SimulationEngine, type SimulatedTrade } from "./simulationEngine.js";
import type { BorderlineLifecycleRenderEvent } from "./strategyDecisionPipeline.js";
import {
  REJECTION_REASON_MESSAGES,
  type NormalizedRejectionReason,
} from "./decisionReasonBuilder.js";

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

const OPP_VALID_TOP =
  "┌── Opportunity (valid) ───────────────────────────────────────";
const OPP_REJECTED_TOP =
  "┌── Opportunity (REJECTED) ────────────────────────────────────";
const OPP_BOT =
  "└──────────────────────────────────────────────────────────────";
const TRADE_TOP =
  "┌── Paper trade closed ────────────────────────────────────────";
const TRADE_BOT =
  "└──────────────────────────────────────────────────────────────";
const BL_TOP = "┌── Borderline watch ──────────────────────────────────────────";
const BL_BOT = "└──────────────────────────────────────────────────────────────";

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
  const rangeQuality = entry.stableRangeQuality ?? "poor";
  const movement = entry.movementClassification ?? "no_signal";
  const y = fmtPrice(sides.upSidePrice);
  const no = fmtPrice(sides.downSidePrice);
  const pos = sim.getOpenPosition();
  const simHint = pos
    ? `open ${pos.direction} ×${pos.contracts} @ ${fmtPrice(pos.entryPrice)}`
    : "flat";

  let sig = "idle";
  if (entry.shouldEnter && entry.direction) {
    sig = `valid → ${entry.direction} (range ${rangeQuality}, move ${fmtPct4(entry.movement.strongestMovePercent * 100)})`;
  } else if (!entry.shouldEnter) {
    const human = formatEntryReasonsForLog(entry);
    if (movement === "borderline") {
      sig = human
        ? `borderline (${human}; range ${rangeQuality})`
        : `borderline (range ${rangeQuality})`;
    } else {
      sig = human
        ? `rejected (${human}; range ${rangeQuality})`
        : `rejected (range ${rangeQuality})`;
    }
    sig += ` [move ${fmtPct4(entry.movement.strongestMovePercent * 100)} cls ${entry.movement.classification}]`;
  }

  return `[live] ${t}  │  BTC $${fmtBtcUsd(btc)}  │  YES ${y}  NO ${no}  │  buf ${n}/${cap}  │  ${sig}  │  sim ${simHint}`;
}

/**
 * Extra strategy diagnostics appended below the compact tick line
 * when `DEBUG_MONITOR=1`.  Shows rolling range %, strongest recent
 * window move, and configured thresholds so you can tell at a glance
 * whether the market is close to triggering or completely flat.
 */
export function formatDebugTickExtras(
  prices: readonly number[],
  rangeThreshold: number,
  spikeThreshold: number,
  tradableSpikeMinPercent: number,
  maxPriorRangeForNormalEntry: number,
  hardRejectPriorRangePercent: number,
  maxOppositeSideEntryPrice: number,
  neutralQuoteBandMin: number,
  neutralQuoteBandMax: number,
  movement?: {
    classification: "no_signal" | "borderline" | "strong_spike";
    thresholdRatio: number;
    sourceWindowLabel: string | null;
  },
): string {
  const n = prices.length;
  if (n < 2) return "       [dbg] not enough prices for diagnostics";

  const prior = prices.slice(0, -1);
  const max = Math.max(...prior);
  const min = Math.min(...prior);
  const rangePct =
    min > 0 && Number.isFinite(min) && Number.isFinite(max)
      ? ((max - min) / min) * 100
      : 0;
  const rangeThreshPct = rangeThreshold * 100;
  const rangeOk = rangePct < rangeThreshPct;

  const current = prices[n - 1]!;
  let strongestPct = 0;
  let strongestRef = current;
  const lookback = Math.min(n - 1, 2); // ~10 seconds at 5s cadence
  for (let i = 1; i <= lookback; i++) {
    const ref = prices[n - 1 - i]!;
    if (ref > 0 && Number.isFinite(ref)) {
      const pct = (Math.abs(current - ref) / ref) * 100;
      if (pct > strongestPct) {
        strongestPct = pct;
        strongestRef = ref;
      }
    }
  }
  const spikeThreshPct = spikeThreshold * 100;
  const tradableSpikeMinPct = tradableSpikeMinPercent * 100;
  const priorRangeMaxPct = maxPriorRangeForNormalEntry * 100;
  const hardRejectPriorRangePct = hardRejectPriorRangePercent * 100;
  const neutralMin = Math.min(neutralQuoteBandMin, neutralQuoteBandMax);
  const neutralMax = Math.max(neutralQuoteBandMin, neutralQuoteBandMax);
  const priorRangeRatio =
    priorRangeMaxPct > 0
      ? rangePct / priorRangeMaxPct
      : Number.POSITIVE_INFINITY;

  const cls = movement?.classification ?? "no_signal";
  const ratio = movement?.thresholdRatio ?? 0;
  const src = movement?.sourceWindowLabel ?? "n/a";

  return [
    `       [dbg] range ${rangePct.toFixed(4)}% (thresh ${rangeThreshPct.toFixed(4)}%, ${rangeOk ? "stable" : "unstable"})` +
    `  │  best move ${strongestPct.toFixed(4)}% vs ref $${fmtBtcUsd(strongestRef)}` +
    `  │  spike thresh ${spikeThreshPct.toFixed(4)}%` +
    `  │  tradable min ${tradableSpikeMinPct.toFixed(4)}%` +
    `  │  prior max ${priorRangeMaxPct.toFixed(4)}% (${priorRangeRatio.toFixed(2)}x)` +
    `  │  hard reject ${hardRejectPriorRangePct.toFixed(4)}%` +
    `  │  maxOpp ${maxOppositeSideEntryPrice.toFixed(4)} neutral [${neutralMin.toFixed(4)}, ${neutralMax.toFixed(4)}]` +
    `  │  cls ${cls} (${ratio.toFixed(2)}x, src ${src})`,
  ].join("");
}

/**
 * Core rows shared by both valid and rejected opportunity blocks.
 */
function opportunityDetailRows(o: Opportunity): string[] {
  const ts = new Date(o.timestamp).toISOString();
  const dir = o.spikeDirection ?? "—";
  return [
    row("Observed", ts),
    row("BTC spot", `$${fmtBtcUsd(o.btcPrice)}`),
    row("Prev → last", `${o.previousPrice.toFixed(2)} → ${o.currentPrice.toFixed(2)}`),
    row("Spike move", `${fmtPct4(o.spikePercent)} (dir ${dir}, via ${o.spikeSource ?? "—"})`),
    row("Spike ref", `$${fmtBtcUsd(o.spikeReferencePrice)}`),
    row(
      "Movement",
      `${o.movementClassification} (${o.movementThresholdRatio.toFixed(2)}x)`,
    ),
    row("Quality", `${o.qualityProfile} (min ${fmtPct4(o.tradableSpikeMinPercent * 100)})`),
    row("Type / out", `${o.opportunityType} / ${o.opportunityOutcome}`),
    row("Prior range", fmtPct4(o.priorRangePercent)),
    row("Range quality", o.stableRangeQuality),
    row("YES / NO", `${fmtPrice(o.upSidePrice)} / ${fmtPrice(o.downSidePrice)}`),
    row("Stable prior", o.stableRangeDetected ? "yes" : "no"),
    row("Ctx spike", o.spikeDetected ? "yes" : "no"),
  ];
}

/**
 * Expanded block for a valid raw-spike opportunity (strategy would enter).
 */
export function formatValidOpportunityBlock(o: Opportunity): string {
  const lines = [
    "",
    OPP_VALID_TOP,
    ...opportunityDetailRows(o),
    row("Entry", "allowed"),
    OPP_BOT,
    "",
  ];
  return lines.join("\n");
}

/**
 * Expanded block for a rejected spike candidate — near-miss diagnostic.
 */
export function formatRejectedOpportunityBlock(o: Opportunity): string {
  const reasonCodes = o.entryRejectionReasons.length > 0
    ? o.entryRejectionReasons.join(", ")
    : "unknown";
  const reasonHuman = o.entryRejectionReasons
    .map((c) => REJECTION_REASON_MESSAGES[c as NormalizedRejectionReason] ?? c)
    .join("; ");

  const lines = [
    "",
    OPP_REJECTED_TOP,
    ...opportunityDetailRows(o),
    row("Entry", "REJECTED"),
    row("Reason codes", reasonCodes),
    row("Why", reasonHuman),
    OPP_BOT,
    "",
  ];
  return lines.join("\n");
}

export function logValidOpportunityBlock(o: Opportunity): void {
  if (o.status !== "valid") return;
  console.log(formatValidOpportunityBlock(o));
}

export function logRejectedOpportunityBlock(o: Opportunity): void {
  if (o.status !== "rejected") return;
  console.log(formatRejectedOpportunityBlock(o));
}

/**
 * Log an expanded diagnostic block for any recorded opportunity
 * (valid or rejected).
 */
export function logOpportunityBlock(o: Opportunity): void {
  if (o.status === "valid") {
    console.log(formatValidOpportunityBlock(o));
  } else {
    console.log(formatRejectedOpportunityBlock(o));
  }
}

function borderlineEventTitle(type: BorderlineLifecycleRenderEvent["type"]): string {
  switch (type) {
    case "created":
      return "candidate created";
    case "watch":
      return "watch update";
    case "promoted":
      return "candidate promoted";
    case "cancelled":
      return "candidate cancelled";
    case "expired":
      return "candidate expired";
    default:
      return type;
  }
}

export function formatBorderlineLifecycleBlock(
  e: BorderlineLifecycleRenderEvent
): string {
  const lines = [
    "",
    BL_TOP,
    row("Event", borderlineEventTitle(e.type)),
    row("Candidate id", e.candidateId),
    row("Detect tick", String(e.detectionTick)),
    row("Move dir", e.moveDirection ?? "—"),
    row("Move %", fmtPct4(e.movePercent)),
    row("Threshold %", fmtPct4(e.thresholdPercent)),
    row("Ratio", `${e.thresholdRatio.toFixed(2)}x`),
    row("Source", e.sourceWindowLabel ?? "—"),
    row("Contrarian", e.suggestedContrarianDirection ?? "—"),
    row("Watch left", String(e.watchTicksRemaining)),
    row(
      "BTC now",
      e.currentBtcPrice === null ? "n/a" : `$${fmtBtcUsd(e.currentBtcPrice)}`
    ),
    row(
      "YES / NO",
      e.yesPrice === null || e.noPrice === null
        ? "n/a"
        : `${fmtPrice(e.yesPrice)} / ${fmtPrice(e.noPrice)}`
    ),
    row("Post move", e.postMoveClassification ?? "n/a"),
    row("Reason", e.reason),
    BL_BOT,
    "",
  ];
  return lines.join("\n");
}

export function logBorderlineLifecycleBlock(
  e: BorderlineLifecycleRenderEvent
): void {
  console.log(formatBorderlineLifecycleBlock(e));
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
  spikeThreshold: number;
  tradableSpikeMinPercent: number;
  maxPriorRangeForNormalEntry: number;
  hardRejectPriorRangePercent: number;
  strongSpikeConfirmationTicks: number;
  exceptionalSpikePercent: number;
  exceptionalSpikeOverridesCooldown: boolean;
  maxOppositeSideEntryPrice: number;
  neutralQuoteBandMin: number;
  neutralQuoteBandMax: number;
  persistPath: string;
  debugMode?: boolean;
}): void {
  const L = 13;
  console.log("");
  console.log("════════ Live monitor (observation + paper sim) ══════════════");
  console.log(`${"Quotes".padEnd(L)} ${params.quotesDetail}`);
  console.log(`${"Tick".padEnd(L)} every ${params.tickIntervalSec}s`);
  console.log(
    `${"Buffer".padEnd(L)} ${params.bufferSlots} slots (min ${params.minSamples} samples)`
  );
  console.log(
    `${"Thresholds".padEnd(L)} spike ${fmtPct4(params.spikeThreshold * 100)} | tradable min ${fmtPct4(
      params.tradableSpikeMinPercent * 100
    )} | max prior ${fmtPct4(params.maxPriorRangeForNormalEntry * 100)} | hard reject ${fmtPct4(
      params.hardRejectPriorRangePercent * 100
    )}`
  );
  console.log(
    `${"Strong mode".padEnd(L)} confirmation watch ${params.strongSpikeConfirmationTicks} tick(s) before entry`
  );
  console.log(
    `${"Exceptional".padEnd(L)} >= ${fmtPct4(params.exceptionalSpikePercent * 100)} | cooldown override ${params.exceptionalSpikeOverridesCooldown ? "ON" : "OFF"}`
  );
  console.log(
    `${"Quote caps".padEnd(L)} opposite<=${fmtPrice(params.maxOppositeSideEntryPrice)} | neutral [${fmtPrice(Math.min(params.neutralQuoteBandMin, params.neutralQuoteBandMax))}, ${fmtPrice(Math.max(params.neutralQuoteBandMin, params.neutralQuoteBandMax))}]`
  );
  console.log(`${"Orders".padEnd(L)} none — monitor never sends real orders`);
  console.log(`${"Paper sim".padEnd(L)} strategy entries; trade block on each close`);
  console.log(`${"Persist".padEnd(L)} ${params.persistPath}`);
  if (params.debugMode) {
    console.log(`${"Debug".padEnd(L)} ON (DEBUG_MONITOR=1) — verbose diagnostics per tick`);
  }
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
    strongSpikeSignals?: number;
    strongSpikeEntries?: number;
    borderlineSignals?: number;
    noSignalMoves?: number;
    borderlineMoves?: number;
    strongSpikeMoves?: number;
    borderlinePromotions?: number;
    borderlineCandidatesCreated?: number;
    borderlineCancellations?: number;
    borderlineExpirations?: number;
    blockedByCooldown?: number;
    blockedByActivePosition?: number;
    blockedByInvalidQuotes?: number;
    blockedByNoisyRange?: number;
    blockedByWidePriorRange?: number;
    blockedByHardRejectUnstableContext?: number;
    rejectedByWeakSpikeQuality?: number;
    rejectedByPriorRangeTooWide?: number;
    rejectedByHardUnstableContext?: number;
    rejectedByStrongSpikeContinuation?: number;
    rejectedByBorderlineContinuation?: number;
    rejectedByExpensiveOppositeSide?: number;
    exceptionalSpikeSignals?: number;
    exceptionalSpikeEntries?: number;
    cooldownOverridesUsed?: number;
    blockedByExpensiveOppositeSide?: number;
    blockedByNeutralQuotes?: number;
    borderlineTradesClosed?: number;
    borderlineWinRate?: number;
    borderlinePnL?: number;
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
  if (counters.strongSpikeSignals !== undefined) {
    console.log(
      `${"Signals".padEnd(10)} strong ${counters.strongSpikeSignals} (entries ${counters.strongSpikeEntries ?? 0})  │  borderline ${counters.borderlineSignals ?? 0} (promoted ${counters.borderlinePromotions ?? 0})`
    );
    console.log(
      `${"Exceptional".padEnd(10)} signals ${counters.exceptionalSpikeSignals ?? 0}  │  entries ${counters.exceptionalSpikeEntries ?? 0}`
    );
  }
  if (counters.noSignalMoves !== undefined) {
    console.log(
      `${"Movement".padEnd(10)} no_signal ${counters.noSignalMoves}  │  borderline ${counters.borderlineMoves ?? 0}  │  strong ${counters.strongSpikeMoves ?? 0}`
    );
  }
  if (counters.borderlineCandidatesCreated !== undefined) {
    console.log(
      `${"Watch".padEnd(10)} created ${counters.borderlineCandidatesCreated}  │  promoted ${counters.borderlinePromotions ?? 0}  │  cancelled ${counters.borderlineCancellations ?? 0}  │  expired ${counters.borderlineExpirations ?? 0}`
    );
  }
  if (counters.blockedByCooldown !== undefined) {
    console.log(
      `${"Blocked".padEnd(10)} cooldown ${counters.blockedByCooldown}  │  active-pos ${counters.blockedByActivePosition ?? 0}  │  invalid-quote ${counters.blockedByInvalidQuotes ?? 0}  │  noisy-range ${counters.blockedByNoisyRange ?? 0}  │  wide-prior ${counters.blockedByWidePriorRange ?? 0}  │  hard-reject ${counters.blockedByHardRejectUnstableContext ?? 0}  │  expensive-opp ${counters.blockedByExpensiveOppositeSide ?? 0}  │  neutral ${counters.blockedByNeutralQuotes ?? 0}`
    );
    console.log(
      `${"Rejected".padEnd(10)} weak-quality ${counters.rejectedByWeakSpikeQuality ?? 0}  │  prior-wide ${counters.rejectedByPriorRangeTooWide ?? 0}  │  hard-unstable ${counters.rejectedByHardUnstableContext ?? 0}  │  strong-cont ${counters.rejectedByStrongSpikeContinuation ?? 0}  │  borderline-cont ${counters.rejectedByBorderlineContinuation ?? 0}  │  expensive-opp ${counters.rejectedByExpensiveOppositeSide ?? 0}  │  neutral ${counters.blockedByNeutralQuotes ?? 0}`
    );
    console.log(
      `${"Override".padEnd(10)} cooldown overrides ${counters.cooldownOverridesUsed ?? 0}`
    );
  }
  if (
    counters.rejectedByWeakSpikeQuality !== undefined &&
    counters.rejectedByPriorRangeTooWide !== undefined &&
    counters.rejectedByHardUnstableContext !== undefined
  ) {
    console.log(
      `${"Quality".padEnd(10)} weak ${counters.rejectedByWeakSpikeQuality}  │  strong ${Math.max(0, (counters.strongSpikeSignals ?? 0) - (counters.rejectedByWeakSpikeQuality ?? 0) - (counters.exceptionalSpikeSignals ?? 0))}  │  exceptional ${counters.exceptionalSpikeSignals ?? 0}`
    );
  }
  if (counters.borderlineTradesClosed !== undefined) {
    const bw = counters.borderlineWinRate ?? 0;
    const bp = counters.borderlinePnL ?? 0;
    console.log(
      `${"Borderline".padEnd(10)} trades ${counters.borderlineTradesClosed}  │  win% ${bw.toFixed(1)}  │  Σ ${bp >= 0 ? "+" : ""}${bp.toFixed(4)}`
    );
  }
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
  },
  extended?: {
    strongSpikeWinRate: number;
    delayedBorderlineWinRate: number;
    averageStrongSpikePnL: number;
    averageBorderlinePnL: number;
    borderlinePnL: number;
    borderlineNetImpact: "positive" | "negative" | "flat";
    borderlinePromotions: number;
    borderlineSignals: number;
    qualityWeak?: number;
    qualityStrong?: number;
    qualityExceptional?: number;
    topRejectionReasons?: Array<{ reason: string; count: number }>;
    verdict: "helpful" | "neutral" | "harmful";
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
  if (extended !== undefined) {
    console.log(
      `${"Strong win%".padEnd(14)} ${extended.strongSpikeWinRate.toFixed(1)}%`
    );
    console.log(
      `${"Border win%".padEnd(14)} ${extended.delayedBorderlineWinRate.toFixed(1)}%`
    );
    console.log(
      `${"Strong avg P/L".padEnd(14)} ${extended.averageStrongSpikePnL >= 0 ? "+" : ""}${extended.averageStrongSpikePnL.toFixed(4)}`
    );
    console.log(
      `${"Border avg P/L".padEnd(14)} ${extended.averageBorderlinePnL >= 0 ? "+" : ""}${extended.averageBorderlinePnL.toFixed(4)}`
    );
    console.log(
      `${"Border Σ P/L".padEnd(14)} ${extended.borderlinePnL >= 0 ? "+" : ""}${extended.borderlinePnL.toFixed(4)} (${extended.borderlineNetImpact})`
    );
    console.log(
      `${"Borderline".padEnd(14)} ${extended.borderlinePromotions}/${extended.borderlineSignals} promoted`
    );
    if (
      extended.qualityWeak !== undefined &&
      extended.qualityStrong !== undefined &&
      extended.qualityExceptional !== undefined
    ) {
      console.log(
        `${"Quality mix".padEnd(14)} weak ${extended.qualityWeak}  | strong ${extended.qualityStrong}  | exceptional ${extended.qualityExceptional}`
      );
    }
    if ((extended.topRejectionReasons?.length ?? 0) > 0) {
      console.log(`${"Top reject".padEnd(14)} (top-5)`);
      for (const item of extended.topRejectionReasons ?? []) {
        const label = REJECTION_REASON_MESSAGES[item.reason as NormalizedRejectionReason] ?? item.reason;
        console.log(`  - ${label}: ${item.count}`);
      }
    }
    console.log(`${"Border verdict".padEnd(14)} ${extended.verdict.toUpperCase()}`);
  }
  console.log("══════════════════════════════════════════════════════════════");
  console.log("");
}
