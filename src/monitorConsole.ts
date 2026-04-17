import type { StrategyTickResult } from "./botLoop.js";
import {
  formatEntryReasonsForLog,
  type EntryEvaluation,
} from "./entryConditions.js";
import type { Opportunity } from "./opportunityTracker.js";
import type { HoldExitAudit, HoldExitAuditSummary } from "./holdExitAudit.js";
import {
  SimulationEngine,
  buildTransparentTradeLog,
  type SimulatedTrade,
} from "./simulationEngine.js";
import type {
  BorderlineLifecycleRenderEvent,
  StrategyDecision,
} from "./strategyDecisionPipeline.js";
import type { BinanceFeedHealth } from "./adapters/binanceSpotFeed.js";
import {
  REJECTION_REASON_MESSAGES,
  type NormalizedRejectionReason,
} from "./decisionReasonBuilder.js";
import {
  formatGateFunnelSection,
  type StrongSpikeGateFunnel,
} from "./monitorFunnelDiagnostics.js";
import type { QualityGateDiagnostics } from "./preEntryQualityGate.js";

function formatQualityGateDiagSummary(d: QualityGateDiagnostics): string {
  const dd = d.downgradeChain.map((s) => s.reasonCode).join(" → ");
  return `size_tier=${d.profileAfterSpikeSizeTier} final=${d.finalProfile} gate_passed=${d.qualityGatePassed} downgrades=${dd || "—"} weak_hints=${d.weakPrimaryReasons.join(",")}`;
}

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
    return `[live] ${t}  │  no spot book / feed`;
  }
  if (tick.kind === "warming") {
    return `[live] ${t}  │  mid $${fmtBtcUsd(tick.btc)}  │  warmup ${tick.n}/${minSamples}`;
  }
  if (tick.kind === "no_book") {
    return `[live] ${t}  │  mid $${fmtBtcUsd(tick.btc)}  │  invalid book  │  buf ${tick.n}/${tick.cap}`;
  }

  const { btc, n, cap, sides, entry } = tick;
  const rangeQuality = entry.stableRangeQuality ?? "poor";
  const movement = entry.movementClassification ?? "no_signal";
  const bid = fmtPrice(sides.bestBid);
  const ask = fmtPrice(sides.bestAsk);
  const spr =
    Number.isFinite(sides.spreadBps) ? `${sides.spreadBps.toFixed(2)}bps` : "n/a";
  const pos = sim.getOpenPosition();
  const simHint = pos
    ? `open ${pos.direction} stake ${pos.stake.toFixed(2)} sh ${pos.shares.toFixed(4)} @ ${fmtPrice(pos.entryPrice)}`
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

  return `[live] ${t}  │  mid $${fmtBtcUsd(btc)}  bid ${bid} ask ${ask} spr ${spr}  │  buf ${n}/${cap}  │  ${sig}  │  sim ${simHint}`;
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
  maxEntrySpreadBps: number,
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
    `  │  maxEntrySpr ${maxEntrySpreadBps.toFixed(2)}bps` +
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
    row("Prior range", fmtPct4(o.priorRangeFraction * 100)),
    row("Range quality", o.stableRangeQuality),
    row(
      "Bid / ask / spr",
      `${fmtPrice(o.bestBid)} / ${fmtPrice(o.bestAsk)} (${fmtPrice(o.midPrice)} mid, ${o.spreadBps.toFixed(2)} bps)`
    ),
    row("Stable prior", o.stableRangeDetected ? "yes" : "no"),
    row("Ctx spike", o.spikeDetected ? "yes" : "no"),
    ...(o.qualityGateDiagnostics
      ? [
          row("Quality gate", formatQualityGateDiagSummary(o.qualityGateDiagnostics)),
        ]
      : []),
    ...(o.pipelineQualityModifier
      ? [
          row(
            "Pipeline note",
            `${o.pipelineQualityModifier.reason} (profile ${o.pipelineQualityModifier.preModifierGateProfile ?? "?"} → effective ${o.pipelineQualityModifier.effectiveQualityProfile})`,
          ),
        ]
      : []),
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
      "Bid / ask / spr",
      e.bestBid === null || e.bestAsk === null
        ? "n/a"
        : `${fmtPrice(e.bestBid)} / ${fmtPrice(e.bestAsk)} (${e.midPrice !== null ? fmtBtcUsd(e.midPrice) : "n/a"} mid, ${e.spreadBps !== null ? `${e.spreadBps.toFixed(2)} bps` : "n/a"})`
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
function formatHoldExitAuditRows(a: HoldExitAudit): string[] {
  return [
    "",
    "  ── Exit threshold audit (hold min/max vs EXIT / STOP) ──",
    row("TP price (cfg)", fmtPrice(a.configExitPrice)),
    row("SL price (cfg)", fmtPrice(a.configStopLoss)),
    row("Hold mark lo", fmtPrice(a.holdMarkMin)),
    row("Hold mark hi", fmtPrice(a.holdMarkMax)),
    row("MFE (long)", fmtPrice(a.maxFavorableExcursion)),
    row("MAE (long)", fmtPrice(a.maxAdverseExcursion)),
    row("Min gap→TP", fmtPrice(a.minGapToProfitTarget)),
    row("Min buf→SL", fmtPrice(a.minBufferAboveStop)),
    row("Near target", a.targetWithinNearPriceBand ? "yes" : "no"),
    row("Near stop", a.stopWithinNearPriceBand ? "yes" : "no"),
    row("Timeout-only?", a.timeoutLikelyOnlyViableExit ? "likely" : "no"),
  ];
}

export function formatPaperTradeClosedBlock(trade: SimulatedTrade): string {
  const holdMs = trade.closedAt - trade.openedAt;
  const log = buildTransparentTradeLog(trade);
  const lines = [
    "",
    TRADE_TOP,
    row("Trade id", `#${trade.id}`),
    row("Timestamp (exit)", log.timestamp),
    row("Direction", trade.direction),
    row("Stake", trade.stake.toFixed(2)),
    row("Shares", trade.shares.toFixed(6)),
    row("Entry price", fmtPrice(trade.entryPrice)),
    row("Exit price", fmtPrice(trade.exitPrice)),
    row("P / L", formatPnl(trade.profitLoss)),
    row("Equity before", log.equityBefore.toFixed(4)),
    row("Equity after", log.equityAfter.toFixed(4)),
    row("Reason (entry)", log.reasonEntry),
    row("Reason (exit)", exitReasonLabel(trade.exitReason)),
    row("Hold time", formatHoldDurationMs(holdMs)),
    row("Opened at", new Date(trade.openedAt).toISOString()),
    row("Closed at", new Date(trade.closedAt).toISOString()),
    ...(trade.holdExitAudit !== undefined
      ? formatHoldExitAuditRows(trade.holdExitAudit)
      : []),
    "",
    "  Full log (JSON, recalculable):",
    ...JSON.stringify(log, null, 2)
      .split("\n")
      .map((line) => `  ${line}`),
    TRADE_BOT,
    "",
  ];
  return lines.join("\n");
}

export function logPaperTradeClosedBlock(trade: SimulatedTrade): void {
  console.log(formatPaperTradeClosedBlock(trade));
}

export function printLiveMonitorBanner(params: {
  /** e.g. Binance Spot bookTicker + aggTrade */
  dataSourceDetail: string;
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
  maxEntrySpreadBps: number;
  persistPath: string;
  debugMode?: boolean;
  /** When true, prints an explicit diagnostic banner (TEST_MODE=1). */
  testMode?: boolean;
}): void {
  const L = 13;
  console.log("");
  console.log("════════ Live monitor (observation + paper sim) ══════════════");
  if (params.testMode === true) {
    console.log(`${"Mode".padEnd(L)} TEST MODE ACTIVE — diagnostic preset (not production)`);
  }
  console.log(`${"Data".padEnd(L)} ${params.dataSourceDetail}`);
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
    `${"Spread cap".padEnd(L)} max entry spread ${params.maxEntrySpreadBps.toFixed(2)} bps (bid/ask)`
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
    /** Funnel: positions opened (paper sim). */
    tradesExecuted?: number;
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
  sim: SimulationEngine,
  testMode?: boolean
): void {
  const perf = sim.getPerformanceStats();
  const bestWorst = bestWorstTradeSummary(sim);
  const wr = Number.isFinite(perf.winRate) ? perf.winRate.toFixed(1) : "0.0";
  const totalPl = formatPnl(perf.totalProfit);
  const avgPl = formatPnl(perf.averageProfitPerTrade);
  console.log("");
  if (testMode === true) {
    console.log("TEST MODE ACTIVE — diagnostic stats (not production baseline)");
  }
  console.log(`── ${headline} ──`);
  console.log(
    `${"Session".padEnd(10)} ticks ${counters.ticksObserved}  │  BTC fail ${counters.btcFetchFailures}  │  spikes ${counters.spikeEventsDetected}  │  cand ${counters.candidateOpportunities}  │  valid ${counters.validOpportunities}  │  trades ${counters.tradesExecuted ?? "—"}  │  rej ${counters.rejectedOpportunities}`
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
    spikeEventsDetected: number;
    candidateOpportunities: number;
    validOpportunities: number;
    rejectedOpportunities: number;
    tradesExecuted: number;
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
    gateFunnel?: StrongSpikeGateFunnel;
    /** When true, every shutdown report line is clearly marked as diagnostic. */
    testMode?: boolean;
    exitThresholdAudit?: HoldExitAuditSummary | null;
    /** Binance public WS health at shutdown (live monitor). */
    binanceFeedDiagnostics?: {
      symbol: string;
      health: BinanceFeedHealth;
      lastMessageAgeMs: number;
    };
  }
): void {
  const durationMs = Math.max(0, Date.now() - startedAtMs);
  const wr = Number.isFinite(perf.winRate) ? perf.winRate.toFixed(1) : "0.0";
  const totalPl = formatPnl(perf.totalProfit);
  const oppFound = counters.validOpportunities + counters.rejectedOpportunities;
  console.log("");
  console.log("════════ Live monitor — final report (shutdown) ══════════════");
  if (extended?.testMode === true) {
    console.log(`${"!!".padEnd(14)} TEST MODE ACTIVE — diagnostic run (not production)`);
  }
  console.log(`${"Runtime".padEnd(14)} ${formatDurationMs(durationMs)}`);
  console.log(`${"Ticks".padEnd(14)} ${counters.ticksObserved}`);
  console.log(
    `${"Funnel".padEnd(14)} spikes ${counters.spikeEventsDetected} → cand ${counters.candidateOpportunities} → valid ${counters.validOpportunities} → opened ${counters.tradesExecuted}`
  );
  console.log(
    `${"Strong rows".padEnd(14)} ${oppFound} stored (valid+rej JSONL); rejected count is diagnostic rows`
  );
  console.log(`${"Trades closed".padEnd(14)} ${perf.totalTrades} (paper sim)`);
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
    if (extended.gateFunnel !== undefined) {
      for (const ln of formatGateFunnelSection(extended.gateFunnel)) {
        console.log(ln);
      }
    }
    if (extended.binanceFeedDiagnostics !== undefined) {
      const { symbol, health, lastMessageAgeMs } = extended.binanceFeedDiagnostics;
      console.log("");
      console.log("──────── Binance Spot feed (session) ────────");
      console.log(
        `${"Symbol".padEnd(14)} ${symbol}  connected=${health.connected}  lastMsgAge≈${Math.round(lastMessageAgeMs)}ms`
      );
      console.log(
        `${"WS stats".padEnd(14)} connects ${health.connectCount}  disconnects ${health.disconnectCount}  msgs ${health.messagesTotal}`
      );
      if (health.lastError !== null) {
        console.log(`${"Last WS err".padEnd(14)} ${health.lastError}`);
      }
      console.log("────────────────────────────────────────────────────────────────────");
    }
    if (extended.exitThresholdAudit !== undefined && extended.exitThresholdAudit !== null) {
      const a = extended.exitThresholdAudit;
      console.log("");
      console.log("──────── Exit thresholds vs observed marks (closed trades) ────────");
      console.log(
        `${"Audited".padEnd(14)} ${a.tradesAudited} closed trade(s) with hold min/max marks`
      );
      console.log(
        `${"Timeouts".padEnd(14)} ${a.closedByTimeout}  │  likely only viable exit: ${a.timeoutsLikelyOnlyViableExit} (${a.pctTimeoutsOnlyViableExit.toFixed(1)}% of timeouts, ${a.pctAllTradesTimeoutOnlyViable.toFixed(1)}% of all)`
      );
      console.log(
        `${"Near target".padEnd(14)} ${a.tradesEverNearTarget} trade(s) (best gap ≤ ${a.nearTargetPriceThreshold.toFixed(4)} to EXIT_PRICE)`
      );
      console.log(
        `${"Near stop".padEnd(14)} ${a.tradesEverNearStop} trade(s) (tightest buffer ≤ ${a.nearStopPriceThreshold.toFixed(4)} above STOP_LOSS)`
      );
      console.log(
        `${"Avg gap→TP".padEnd(14)} ${a.avgMinGapToProfitTarget.toFixed(4)} (lower = closer to target at high mark)`
      );
      console.log(
        `${"Avg buffer→SL".padEnd(14)} ${a.avgMinBufferAboveStop.toFixed(4)} (lower = closer to stop at low mark)`
      );
      console.log(
        `${"Avg MFE / MAE".padEnd(14)} ${a.avgMaxFavorableExcursion.toFixed(4)} / ${a.avgMaxAdverseExcursion.toFixed(4)}`
      );
      console.log("────────────────────────────────────────────────────────────────────");
    }
  }
  console.log("══════════════════════════════════════════════════════════════");
  console.log("");
}

/** JSON-serializable spike snapshot for DEBUG_MONITOR decision tracing. */
export type SpikeDecisionTracePayload = {
  /** Strongest window move as percent points (e.g. 0.42 = 0.42%). */
  spikePercent: number;
  /** Prior-window relative range as percent points (fraction × 100), same convention as spikePercent. */
  priorRange: number;
  /** Whether pre-spike range passed stability detection. */
  stableRange: boolean;
  classification: EntryEvaluation["movementClassification"];
  /** Strategy would enter on this tick (immediate or borderline promotion). */
  entryAllowed: boolean;
  /** Non-empty when entry is blocked; normalized / entry codes. */
  rejectionReasons: readonly string[];
};

function collectSpikeTraceRejectionReasons(
  entry: EntryEvaluation,
  decision: StrategyDecision
): string[] {
  if (decision.reasons && decision.reasons.length > 0) {
    return [...decision.reasons];
  }
  if (!entry.shouldEnter && entry.reasons.length > 0) {
    return [...entry.reasons];
  }
  if (decision.reason.trim().length > 0) {
    return [decision.reason];
  }
  return [];
}

/**
 * Build a single object when a spike is detected: context, classification,
 * and why entry was allowed or rejected (use with DEBUG_MONITOR=1).
 */
export function buildSpikeDecisionTracePayload(input: {
  entry: EntryEvaluation;
  decision: StrategyDecision;
}): SpikeDecisionTracePayload {
  const { entry, decision } = input;
  const entryAllowed =
    decision.action === "enter_immediate" ||
    decision.action === "promote_borderline_candidate";
  return {
    spikePercent: entry.movement.strongestMovePercent * 100,
    priorRange: entry.priorRangeFraction * 100,
    stableRange: entry.stableRangeDetected,
    classification: entry.movementClassification,
    entryAllowed,
    rejectionReasons: entryAllowed
      ? []
      : collectSpikeTraceRejectionReasons(entry, decision),
  };
}

export function logSpikeDecisionTrace(payload: SpikeDecisionTracePayload): void {
  console.log("[debug] spike decision trace");
  console.log(JSON.stringify(payload, null, 2));
}
