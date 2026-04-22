import type { StrategyTickResult } from "./botLoop.js";
import { debugMonitor } from "./config.js";
import { logMonitorDebug } from "./monitor/monitorDebugLog.js";
import {
  ENTRY_REASON_CODES,
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
import {
  type BorderlineLifecycleRenderEvent,
  type StrategyDecision,
} from "./strategy/strategyDecisionPipeline.js";
import type { BinaryQuoteSessionSnapshot } from "./binary/monitor/binaryMonitorQuoteStats.js";
import type { MonitorTickFormatContext } from "./binary/monitor/binaryMonitorTickTypes.js";
import type {
  BinaryOutcomePrices,
  MarketFeedDiagnostics,
  MarketMode,
} from "./market/types.js";
import { REJECTION_REASON_MESSAGES } from "./decisionReasonBuilder.js";
import {
  formatGateFunnelSection,
  type StrongSpikeGateFunnel,
} from "./monitorFunnelDiagnostics.js";
import type { QualityGateDiagnostics } from "./preEntryQualityGate.js";
import {
  normalizeDecisionRejectionReasons,
  normalizeEntryReasons,
  type NormalizedRejectionReason,
} from "./rejectionReasons.js";
import {
  formatBinaryYesNoComparativeConsole,
  formatMispricingBucketAnalysisConsole,
  type BinaryRunAnalyticsReport,
  type BinaryYesNoComparativeReport,
} from "./analyze/binaryRunAnalytics.js";

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

/** Clock for default (non-debug) live lines — Italian locale. */
function fmtTimeIt(): string {
  return new Date().toLocaleTimeString("it-IT", { hour12: false });
}

const LIVE_IT_REJECTION: Record<NormalizedRejectionReason, string> = {
  missing_quote_data: "dati quotazione assenti",
  invalid_market_prices: "prezzi non validi",
  active_position_open: "posizione già aperta",
  entry_cooldown_active: "cooldown attivo",
  quality_gate_rejected: "attesa conferma",
  hard_reject_unstable_pre_spike_context: "contesto instabile",
  prior_range_too_wide_for_mean_reversion: "intervallo precedente troppo ampio",
  pre_spike_range_too_noisy: "contesto rumoroso",
  borderline_watch_pending: "attesa conferma",
  borderline_cancelled_continuation: "continuazione sul limite",
  strong_spike_continuation: "continuazione troppo forte",
  opposite_side_price_too_high: "lato opposto troppo caro",
  market_quotes_too_neutral: "prezzi troppo neutri",
  no_signal_below_borderline: "movimento troppo debole",
  feed_stale: "dati mercato obsoleti",
  quote_feed_stale: "quotazione binaria obsoleta",
  entry_side_price_too_high: "prezzo d'ingresso troppo alto",
  binary_yes_mid_extreme: "YES fuori banda (mercato quasi risolto)",
  spread_too_wide_hard_block: "spread troppo ampio (limite rigido)",
  missing_binary_quotes: "prezzi YES/NO assenti",
  negative_or_zero_model_edge: "edge modello assente o non positivo",
  model_edge_below_min_threshold: "edge modello sotto soglia minima",
  pipeline_quality_downgrade: "qualità/conferma pipeline insufficiente",
  pipeline_profile_weak: "profilo qualità pipeline non forte/eccezionale",
  pipeline_delayed_confirmation_failed: "conferma ritardata non soddisfatta",
  pipeline_confirmation_noise: "tick di conferma rumoroso",
  pipeline_watch_path_blocked: "in attesa conferma watch (pipeline)",
  pipeline_invalid_market_coupled_downgrade:
    "libro/spread non valido in conferma forte",
};

/** Fallback when reasons are not yet normalized to {@link NormalizedRejectionReason}. */
const RAW_ENTRY_REASON_IT: Record<string, string> = {
  [ENTRY_REASON_CODES.MARKET_NOT_STABLE]: "contesto troppo rumoroso",
  [ENTRY_REASON_CODES.RANGE_TOO_NOISY]: "contesto troppo rumoroso",
  [ENTRY_REASON_CODES.SPIKE_NOT_STRONG_ENOUGH]: "movimento troppo debole",
  [ENTRY_REASON_CODES.SPREAD_TOO_WIDE]: "spread troppo ampio",
  [ENTRY_REASON_CODES.INVALID_BOOK]: "libro ordini non valido",
  [ENTRY_REASON_CODES.NO_SPIKE_DIRECTION]: "movimento piatto",
  pipeline_blocked_entry: "bloccato dalla strategia",
};

function movementClassificationIt(
  c: EntryEvaluation["movementClassification"]
): string {
  switch (c) {
    case "no_signal":
      return "nessun segnale";
    case "borderline":
      return "segnale al limite";
    case "strong_spike":
      return "segnale forte";
    default:
      return "stato segnale sconosciuto";
  }
}

function primaryRejectionIt(
  entry: EntryEvaluation,
  pipeline?: { decision: StrategyDecision; hasOpenPosition: boolean }
): string {
  if (pipeline !== undefined) {
    const { decision, hasOpenPosition } = pipeline;
    const qg = decision.qualityGateReasons ?? [];
    if (qg.includes("weak_quality_borderline_blocked_by_config")) {
      return "qualità troppo debole";
    }
    if (qg.includes("weak_quality_no_signal_blocked_by_config")) {
      return "qualità troppo debole";
    }
    if (qg.includes("borderline_move_requires_confirmation")) {
      return "attesa conferma";
    }
    if (
      decision.action !== "enter_immediate" &&
      decision.action !== "promote_borderline_candidate"
    ) {
      const dr = normalizeDecisionRejectionReasons({
        decision,
        entry,
        hasOpenPosition,
      });
      if (dr.length > 0) {
        return dr
          .slice(0, 2)
          .map((r) => LIVE_IT_REJECTION[r])
          .join(" · ");
      }
    }
  }

  const norm = normalizeEntryReasons(entry);
  if (norm.length > 0) {
    return norm
      .slice(0, 2)
      .map((r) => LIVE_IT_REJECTION[r])
      .join(" · ");
  }
  for (const code of entry.reasons) {
    const it = RAW_ENTRY_REASON_IT[code];
    if (it) return it;
  }
  return "ingresso non consentito";
}

function compactSimStatusIt(sim: SimulationEngine): string {
  return sim.getOpenPosition() === null ? "simulazione ferma" : "posizione aperta";
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

function exitReasonLabelIt(reason: SimulatedTrade["exitReason"]): string {
  switch (reason) {
    case "profit":
      return "profitto";
    case "stop":
      return "stop";
    case "timeout":
      return "timeout";
    default:
      return String(reason);
  }
}

function formatPnl(pnl: number): string {
  return pnl >= 0 ? `+${pnl.toFixed(4)}` : pnl.toFixed(4);
}

/** One-line Italian summary when `DEBUG_MONITOR` is off (full block only in debug). */
export function formatPaperTradeClosedLineCompactIt(t: SimulatedTrade): string {
  const pl = formatPnl(t.profitLoss);
  const isBin = t.executionModel === "binary";
  const leg =
    isBin && t.sideBought !== undefined
      ? `comprato ${t.sideBought}`
      : `${t.direction}`;
  return `[carta] chiusura #${t.id} │ ${leg} │ P/L netto ${pl} USDT │ uscita: ${exitReasonLabelIt(t.exitReason)}`;
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
 * One compact Italian line per tick (live monitor). Verbose English / book / quote
 * diagnostics are printed only via {@link logMonitorDebug} when `DEBUG_MONITOR=1`.
 */
/** When set on a ready tick, refines the Italian “scartato” line from pipeline output. */
export type MonitorLiveLinePipelineContext = {
  decision: StrategyDecision;
  pipelineEntry: EntryEvaluation;
  hasOpenPosition: boolean;
};

export type { MonitorTickFormatContext };

/** Verbose English live line (YES/NO, venue book, spread, buffer) — use only behind {@link logMonitorDebug}. */
export function formatMonitorTickLineVerboseEnglish(
  tick: StrategyTickResult,
  sim: SimulationEngine,
  minSamples: number,
  fmtCtx?: MonitorTickFormatContext,
  universeMode?: MarketMode
): string {
  const t = fmtTime();
  if (tick.kind === "no_btc") {
    return `[live] ${t}  │  no signal feed book / feed`;
  }
  const binaryLabels = fmtCtx?.marketMode === "binary" || universeMode === "binary";
  if (tick.kind === "warming") {
    const label = binaryLabels ? "BTC signal" : "mid";
    return `[live] ${t}  │  ${label} $${fmtBtcUsd(tick.btc)}  │  warmup ${tick.n}/${minSamples}`;
  }
  if (tick.kind === "no_book") {
    const label = binaryLabels ? "BTC signal" : "mid";
    return `[live] ${t}  │  ${label} $${fmtBtcUsd(tick.btc)}  │  invalid execution book  │  buf ${tick.n}/${tick.cap}`;
  }

  const { n, cap, executionBook, entry, underlyingSignalPrice } = tick;
  const rangeQuality = entry.stableRangeQuality ?? "poor";
  const movement = entry.movementClassification ?? "no_signal";
  const pos = sim.getOpenPosition();
  const entrySide =
    entry.direction === "UP" ? "YES" : entry.direction === "DOWN" ? "NO" : "—";

  let sig = "idle";
  if (entry.shouldEnter && entry.direction) {
    sig =
      fmtCtx?.marketMode === "binary"
        ? `valid → buy ${entrySide} (range ${rangeQuality}, move ${fmtPct4(entry.movement.strongestMovePercent * 100)})`
        : `valid → ${entry.direction} (range ${rangeQuality}, move ${fmtPct4(entry.movement.strongestMovePercent * 100)})`;
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

  const simHint =
    pos === null
      ? "flat"
      : pos.executionModel === "binary" && pos.sideBought !== undefined
        ? `open BUY ${pos.sideBought} stake ${pos.stake.toFixed(2)} contracts ${pos.shares.toFixed(4)} @ ${fmtPrice(pos.entryPrice)}`
        : `open ${pos.direction} stake ${pos.stake.toFixed(2)} sh ${pos.shares.toFixed(6)} @ ${fmtPrice(pos.entryPrice)}`;

  if (fmtCtx?.marketMode === "binary") {
    const bo = fmtCtx.binaryOutcomes;
    const yn =
      bo !== null &&
      Number.isFinite(bo.yesPrice) &&
      Number.isFinite(bo.noPrice) &&
      bo.yesPrice > 0 &&
      bo.noPrice > 0
        ? `YES ${fmtPrice(bo.yesPrice)} NO ${fmtPrice(bo.noPrice)}`
        : "YES/NO n/a";
    const st = fmtCtx.quoteStale
      ? `STALE${fmtCtx.quoteStaleReason ? ` (${fmtCtx.quoteStaleReason})` : ""}`
      : "fresh";
    const qAge =
      fmtCtx.quoteAgeMs !== null && Number.isFinite(fmtCtx.quoteAgeMs)
        ? `${Math.round(fmtCtx.quoteAgeMs)}ms`
        : "n/a";
    const intent =
      entry.direction !== null ? `intent buy ${entrySide}` : "no entry dir";
    const bid = fmtPrice(executionBook.bestBid);
    const ask = fmtPrice(executionBook.bestAsk);
    const spr =
      Number.isFinite(executionBook.spreadBps)
        ? `${executionBook.spreadBps.toFixed(2)}bps`
        : "n/a";
    const sigPx = fmtCtx.underlyingSignalPrice;
    const sigStale =
      fmtCtx.signalFeedPossiblyStale === true ? " [BTC feed stale?]" : "";
    return `[live] ${t}  │  signal BTC $${fmtBtcUsd(sigPx)}${sigStale}  │  ${yn}  │  quote ${st} (venueAge ${qAge})  │  ${intent}  │  venue book ${bid}/${ask} spr ${spr}  │  buf ${n}/${cap}  │  ${sig}  │  sim ${simHint}`;
  }

  const bid = fmtPrice(executionBook.bestBid);
  const ask = fmtPrice(executionBook.bestAsk);
  const spr =
    Number.isFinite(executionBook.spreadBps)
      ? `${executionBook.spreadBps.toFixed(2)}bps`
      : "n/a";
  return `[live] ${t}  │  mid $${fmtBtcUsd(underlyingSignalPrice)}  bid ${bid} ask ${ask} spr ${spr}  │  buf ${n}/${cap}  │  ${sig}  │  sim ${simHint}`;
}

function formatMonitorTickLineCompact(
  tick: StrategyTickResult,
  sim: SimulationEngine,
  minSamples: number,
  fmtCtx?: MonitorTickFormatContext,
  universeMode?: MarketMode,
  pipelineCtx?: MonitorLiveLinePipelineContext
): string {
  const t = fmtTimeIt();
  if (tick.kind === "no_btc") {
    return `[live] ${t} │ nessun dato BTC dal feed`;
  }
  const binaryLabels = fmtCtx?.marketMode === "binary" || universeMode === "binary";
  if (tick.kind === "warming") {
    const label = binaryLabels ? "BTC (segnale)" : "BTC";
    return `[live] ${t} │ ${label} $${fmtBtcUsd(tick.btc)} │ riscaldamento ${tick.n}/${minSamples}`;
  }
  if (tick.kind === "no_book") {
    const label = binaryLabels ? "BTC (segnale)" : "BTC";
    return `[live] ${t} │ ${label} $${fmtBtcUsd(tick.btc)} │ libro esecuzione non valido`;
  }

  const { underlyingSignalPrice } = tick;
  const entry =
    pipelineCtx !== undefined ? pipelineCtx.pipelineEntry : tick.entry;
  const movementCls = entry.movementClassification ?? "no_signal";
  const movPct = fmtPct4(entry.movement.strongestMovePercent * 100);
  const btcPx =
    fmtCtx?.marketMode === "binary"
      ? fmtCtx.underlyingSignalPrice
      : underlyingSignalPrice;

  const mid = " │ ";
  const btcLabel = fmtCtx?.marketMode === "binary" ? "segnale BTC" : "BTC";
  if (entry.shouldEnter && entry.direction) {
    return `[live] ${t}${mid}${btcLabel} $${fmtBtcUsd(btcPx)}${mid}movimento ${movPct}${mid}entrata ${entry.direction}${mid}${compactSimStatusIt(sim)}`;
  }

  const statoSegnale = movementClassificationIt(movementCls);
  const pipeHint =
    pipelineCtx !== undefined
      ? {
          decision: pipelineCtx.decision,
          hasOpenPosition: pipelineCtx.hasOpenPosition,
        }
      : undefined;
  const scarto = `scartato: ${primaryRejectionIt(entry, pipeHint)}`;
  return `[live] ${t}${mid}${btcLabel} $${fmtBtcUsd(btcPx)}${mid}movimento ${movPct}${mid}${statoSegnale}${mid}${scarto}${mid}${compactSimStatusIt(sim)}`;
}

export function formatMonitorTickLine(
  tick: StrategyTickResult,
  sim: SimulationEngine,
  minSamples: number,
  fmtCtx?: MonitorTickFormatContext,
  /** When `fmtCtx` is unset, still pick binary-native labels for warmup / no-book lines. */
  universeMode?: MarketMode,
  /** Ready-tick path: pass after {@link runStrategyDecisionPipeline} so the Italian reason matches the pipeline. */
  pipelineCtx?: MonitorLiveLinePipelineContext
): string {
  return formatMonitorTickLineCompact(
    tick,
    sim,
    minSamples,
    fmtCtx,
    universeMode,
    pipelineCtx
  );
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
  const mode = o.marketMode ?? "binary";
  const sharedTail = [
    row(
      "Movement",
      `${o.movementClassification} (${o.movementThresholdRatio.toFixed(2)}x)`,
    ),
    row("Quality", `${o.qualityProfile} (min ${fmtPct4(o.tradableSpikeMinPercent * 100)})`),
    row("Type / out", `${o.opportunityType} / ${o.opportunityOutcome}`),
    row("Prior range", fmtPct4(o.priorRangeFraction * 100)),
    row("Range quality", o.stableRangeQuality),
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

  if (mode === "binary") {
    const yn =
      o.yesPrice !== undefined && o.noPrice !== undefined
        ? `${fmtPrice(o.yesPrice)} / ${fmtPrice(o.noPrice)}`
        : "n/a";
    const qMeta =
      o.binaryQuoteStale === true
        ? `stale${o.binaryQuoteAgeMs !== null && o.binaryQuoteAgeMs !== undefined ? ` (venueAge ${Math.round(o.binaryQuoteAgeMs)}ms)` : ""}`
        : o.binaryQuoteStale === false
          ? `fresh${o.binaryQuoteAgeMs !== null && o.binaryQuoteAgeMs !== undefined ? ` (venueAge ${Math.round(o.binaryQuoteAgeMs)}ms)` : ""}`
          : "n/a";
    const head: string[] = [
      row("Observed", ts),
      row("Universe", "binary"),
      row("Price series", `$${fmtBtcUsd(o.btcPrice)} (window ref)`),
      row("Prev → last", `${o.previousPrice.toFixed(2)} → ${o.currentPrice.toFixed(2)}`),
      row("Spike move", `${fmtPct4(o.spikePercent)} (dir ${dir}, via ${o.spikeSource ?? "—"})`),
      row("Spike ref", `$${fmtBtcUsd(o.spikeReferencePrice)}`),
      row("YES / NO", yn),
      row("Quote state", qMeta),
      ...(o.binaryQuestion !== undefined && o.binaryQuestion.length > 0
        ? [
            row(
              "Question",
              o.binaryQuestion.length > 120
                ? `${o.binaryQuestion.slice(0, 120)}…`
                : o.binaryQuestion,
            ),
          ]
        : []),
      ...(o.binarySlug !== undefined && o.binarySlug.length > 0
        ? [row("Slug", o.binarySlug)]
        : []),
      ...(o.binaryMarketId !== undefined && o.binaryMarketId.length > 0
        ? [row("Market id", o.binaryMarketId)]
        : []),
      ...(o.entryOutcomeSide !== undefined && o.entryOutcomeSide !== null
        ? [row("Entry side", `BUY ${o.entryOutcomeSide} (if entered)`)]
        : []),
      row(
        "Synth book",
        `${fmtPrice(o.bestBid)} / ${fmtPrice(o.bestAsk)} (mid ${fmtPrice(o.midPrice)}, ${o.spreadBps.toFixed(2)} bps)`,
      ),
    ];
    return [...head, ...sharedTail];
  }

  return [
    row("Observed", ts),
    row("Universe", "spot"),
    row("BTC spot", `$${fmtBtcUsd(o.btcPrice)}`),
    row("Prev → last", `${o.previousPrice.toFixed(2)} → ${o.currentPrice.toFixed(2)}`),
    row("Spike move", `${fmtPct4(o.spikePercent)} (dir ${dir}, via ${o.spikeSource ?? "—"})`),
    row("Spike ref", `$${fmtBtcUsd(o.spikeReferencePrice)}`),
    row(
      "Bid / ask / spr",
      `${fmtPrice(o.bestBid)} / ${fmtPrice(o.bestAsk)} (${fmtPrice(o.midPrice)} mid, ${o.spreadBps.toFixed(2)} bps)`
    ),
    ...sharedTail,
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
  logMonitorDebug(formatValidOpportunityBlock(o));
}

export function logRejectedOpportunityBlock(o: Opportunity): void {
  if (o.status !== "rejected") return;
  logMonitorDebug(formatRejectedOpportunityBlock(o));
}

/**
 * Log an expanded diagnostic block for any recorded opportunity
 * (valid or rejected).
 */
export function logOpportunityBlock(o: Opportunity): void {
  if (o.status === "valid") {
    logMonitorDebug(formatValidOpportunityBlock(o));
  } else {
    logMonitorDebug(formatRejectedOpportunityBlock(o));
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
    case "entry_rejected_weak":
      return "entry gate reject (weak)";
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
  logMonitorDebug(formatBorderlineLifecycleBlock(e));
}

/**
 * Expanded block when a paper trade closes.
 */
function formatHoldExitAuditRows(a: HoldExitAudit): string[] {
  const b = a.binaryPriceSide;
  const header = b
    ? "  ── Exit audit (binary outcome: price deltas vs entry) ──"
    : "  ── Exit threshold audit (hold min/max vs EXIT / STOP) ──";
  const rows: string[] = [
    "",
    header,
    ...(b
      ? [
          row("TP delta (cfg)", fmtPrice(b.takeProfitPriceDelta)),
          row("SL delta (cfg)", fmtPrice(b.stopLossPriceDelta)),
          row("TP target price", fmtPrice(b.profitTargetPrice)),
          row("SL threshold price", fmtPrice(b.stopLossThresholdPrice)),
        ]
      : []),
    row("TP price (cfg)", fmtPrice(a.configExitPrice)),
    row("SL price (cfg)", fmtPrice(a.configStopLoss)),
    row("Hold mark lo", fmtPrice(a.holdMarkMin)),
    row("Hold mark hi", fmtPrice(a.holdMarkMax)),
    ...(b
      ? [
          row("MFE (price pts)", fmtPrice(b.maxFavorableExcursionPoints)),
          row("MAE (price pts)", fmtPrice(b.maxAdverseExcursionPoints)),
          row("Min gap→TP (pts)", fmtPrice(b.minGapToTakeProfitPoints)),
          row("Min gap→SL (pts)", fmtPrice(b.minGapToStopLossPoints)),
        ]
      : [
          row("MFE (long)", fmtPrice(a.maxFavorableExcursion)),
          row("MAE (long)", fmtPrice(a.maxAdverseExcursion)),
          row("Min gap→TP", fmtPrice(a.minGapToProfitTarget)),
          row("Min buf→SL", fmtPrice(a.minBufferAboveStop)),
        ]),
    row("Near target", a.targetWithinNearPriceBand ? "yes" : "no"),
    row("Near stop", a.stopWithinNearPriceBand ? "yes" : "no"),
    row("Timeout-only?", a.timeoutLikelyOnlyViableExit ? "likely" : "no"),
  ];
  return rows;
}

export function formatPaperTradeClosedBlock(trade: SimulatedTrade): string {
  const holdMs = trade.closedAt - trade.openedAt;
  const log = buildTransparentTradeLog(trade);
  const isBin = trade.executionModel === "binary";
  const lines = [
    "",
    TRADE_TOP,
    row("Trade id", `#${trade.id}`),
    row("Timestamp (exit)", log.timestamp),
    row("Execution", isBin ? "binary (outcome paper)" : "spot"),
    ...(isBin
      ? [
          row("Signal", `${trade.direction} (contrarian vs spike)`),
          ...(trade.sideBought !== undefined
            ? [row("Bought", `YES/NO leg: ${trade.sideBought}`)]
            : []),
        ]
      : [row("Direction", trade.direction)]),
    ...(isBin
      ? []
      : trade.sideBought !== undefined
        ? [row("Side bought", trade.sideBought)]
        : []),
    row("Stake", trade.stake.toFixed(2)),
    row(isBin ? "Contracts" : "Shares", isBin ? trade.shares.toFixed(4) : trade.shares.toFixed(6)),
    ...(isBin
      ? [
          row(
            "Entry outcome px",
            fmtPrice(trade.entrySidePrice ?? trade.entryPrice)
          ),
          row("Exit outcome px", fmtPrice(trade.exitSidePrice ?? trade.exitPrice)),
        ]
      : [
          row("Entry price", fmtPrice(trade.entryPrice)),
          row("Exit price", fmtPrice(trade.exitPrice)),
        ]),
    ...(trade.yesPriceAtEntry !== undefined && trade.noPriceAtEntry !== undefined
      ? [
          row("YES/NO @ entry", `${fmtPrice(trade.yesPriceAtEntry)} / ${fmtPrice(trade.noPriceAtEntry)}`),
        ]
      : []),
    ...(trade.yesPriceAtExit !== undefined && trade.noPriceAtExit !== undefined
      ? [
          row("YES/NO @ exit", `${fmtPrice(trade.yesPriceAtExit)} / ${fmtPrice(trade.noPriceAtExit)}`),
        ]
      : []),
    ...(trade.underlyingSignalPriceAtEntry !== undefined
      ? [row("BTC signal @ entry", `$${fmtBtcUsd(trade.underlyingSignalPriceAtEntry)}`)]
      : []),
    ...(trade.underlyingSignalPriceAtExit !== undefined
      ? [row("BTC signal @ exit", `$${fmtBtcUsd(trade.underlyingSignalPriceAtExit)}`)]
      : []),
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
  if (debugMonitor) {
    console.log(formatPaperTradeClosedBlock(trade));
  } else {
    console.log(formatPaperTradeClosedLineCompactIt(trade));
  }
}

export function printLiveMonitorBanner(params: {
  /** e.g. Binance Spot bookTicker + aggTrade */
  dataSourceDetail: string;
  /** From `MARKET_MODE` — selects feed + execution universe. */
  marketMode?: MarketMode;
  /** Binary paper sim: absolute price deltas on the bought outcome. */
  binaryPaperExits?: {
    takeProfitPriceDelta: number;
    stopLossPriceDelta: number;
    exitTimeoutMs: number;
    maxOppositeSideEntryPrice: number;
  };
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
  /** Binary: human-readable separation of underlying signal vs execution venue. */
  binaryBannerLayers?: {
    signalSource: string;
    signalSymbol: string;
    executionSlugLine: string;
  };
  /**
   * Binary: one line from {@link formatBinaryExecutionVenueBannerLine} — Gamma vs synthetic,
   * selector kind, value, and source env key.
   */
  binaryVenueLine?: string;
  /** When `AUTO_DISCOVER_BINARY_MARKET` picked the venue, echo slug / title / ids / validation. */
  binaryAutoDiscoveryBanner?: {
    slug: string;
    title: string;
    marketId: string;
    conditionId: string | null;
    tokenIds: [string, string];
    validationResult: string;
  };
  /**
   * Effective spike/range/borderline gates with env vs default provenance
   * (from {@link formatSignalDetectionBannerLines}).
   */
  signalDetectionBannerLines?: readonly string[];
}): void {
  const L = 13;
  console.log("");
  console.log("════════ Live monitor (observation + paper sim) ══════════════");
  if (params.testMode === true) {
    console.log(`${"Mode".padEnd(L)} TEST MODE ACTIVE — diagnostic preset (not production)`);
  }
  if (params.marketMode !== undefined) {
    console.log(`${"Market".padEnd(L)} ${params.marketMode} (MARKET_MODE)`);
  }
  if (params.marketMode === "binary" && params.binaryBannerLayers !== undefined) {
    const b = params.binaryBannerLayers;
    console.log(
      `${"Underlying".padEnd(L)} ${b.signalSource}  ${b.signalSymbol} (spike / buffer)`
    );
    if (params.binaryVenueLine !== undefined) {
      console.log(`${"Venue".padEnd(L)} ${params.binaryVenueLine}`);
    }
    if (params.binaryAutoDiscoveryBanner !== undefined) {
      const d = params.binaryAutoDiscoveryBanner;
      console.log(`${"Discovery".padEnd(L)} AUTO DISCOVER ACTIVE`);
      console.log(`${"".padEnd(L)} slug ${d.slug}`);
      console.log(`${"".padEnd(L)} title ${d.title}`);
      console.log(`${"".padEnd(L)} market_id ${d.marketId}  condition_id ${d.conditionId ?? "—"}`);
      console.log(
        `${"".padEnd(L)} token_ids ${d.tokenIds[0]!.slice(0, 20)}…  ${d.tokenIds[1]!.slice(0, 20)}…`
      );
      console.log(`${"".padEnd(L)} validation ${d.validationResult}`);
    }
    console.log(`${"Execution".padEnd(L)} ${b.executionSlugLine}`);
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
  if (
    params.signalDetectionBannerLines !== undefined &&
    params.signalDetectionBannerLines.length > 0
  ) {
    console.log(`${"Signal eff.".padEnd(L)} (canonical env = effective value)`);
    for (const line of params.signalDetectionBannerLines) {
      console.log(`${"".padEnd(L)} ${line}`);
    }
  }
  if (params.marketMode === "binary" && params.binaryPaperExits !== undefined) {
    const b = params.binaryPaperExits;
    console.log(
      `${"Binary exits".padEnd(L)} TP +${b.takeProfitPriceDelta.toFixed(4)}  SL −${b.stopLossPriceDelta.toFixed(4)} (outcome px)  timeout ${Math.round(b.exitTimeoutMs / 1000)}s`
    );
    console.log(
      `${"Opp. cap".padEnd(L)} max opposite-side entry ${b.maxOppositeSideEntryPrice.toFixed(4)} (binary quote gate)`
    );
  }
  console.log(
    `${"Synth spr cap".padEnd(L)} max entry spread ${params.maxEntrySpreadBps.toFixed(2)} bps (synthetic executable book)`
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
  testMode?: boolean,
  marketMode?: MarketMode
): void {
  const perf = sim.getPerformanceStats();
  const bestWorst = bestWorstTradeSummary(sim);
  const wr = Number.isFinite(perf.winRate) ? perf.winRate.toFixed(1) : "0.0";
  const totalPl = formatPnl(perf.totalProfit);
  const avgPl = formatPnl(perf.averageProfitPerTrade);
  const failLabel = marketMode === "binary" ? "series fail" : "BTC fail";
  console.log("");
  if (testMode === true) {
    console.log("TEST MODE ACTIVE — diagnostic stats (not production baseline)");
  }
  console.log(`── ${headline} ──`);
  console.log(
    `${"Session".padEnd(10)} ticks ${counters.ticksObserved}  │  ${failLabel} ${counters.btcFetchFailures}  │  spikes ${counters.spikeEventsDetected}  │  cand ${counters.candidateOpportunities}  │  valid ${counters.validOpportunities}  │  trades ${counters.tradesExecuted ?? "—"}  │  rej ${counters.rejectedOpportunities}`
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
    /** Execution universe for this monitor run (mirrors session-summary.json). */
    marketMode?: MarketMode;
    /** Active vs ignored config sections (same string as startup / session-summary). */
    configGroupSummary?: string;
    exitThresholdAudit?: HoldExitAuditSummary | null;
    marketFeedDiagnostics?: MarketFeedDiagnostics;
    signalFeedDiagnostics?: MarketFeedDiagnostics;
    binaryQuoteSession?: BinaryQuoteSessionSnapshot;
    rejectedByPipelineQualityDowngradeLegacy?: number;
    pipelineQualityDowngradeBreakdown?: Record<string, number>;
    /** Binary: YES vs NO funnel + trade aggregates (see session `binaryRunAnalytics.yesNoComparative`). */
    binaryYesNoComparative?: BinaryYesNoComparativeReport;
    /** Binary: full run analytics (mispricing table, session-summary parity). */
    binaryRunAnalytics?: BinaryRunAnalyticsReport | null;
    /** Non-borderline split (same totals as legacy strong-spike aggregate when summed). */
    strongSpikeImmediateTradesClosed?: number;
    strongSpikeImmediateWinRate?: number;
    averageStrongSpikeImmediatePnL?: number;
    strongSpikeConfirmedTradesClosed?: number;
    strongSpikeConfirmedWinRate?: number;
    averageStrongSpikeConfirmedPnL?: number;
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
  if (extended?.marketMode !== undefined) {
    console.log(`${"MARKET_MODE".padEnd(14)} ${extended.marketMode}`);
  }
  if (extended?.configGroupSummary !== undefined) {
    console.log(`${"Config groups".padEnd(14)} ${extended.configGroupSummary}`);
  }
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
      `${"Strong win%".padEnd(14)} ${extended.strongSpikeWinRate.toFixed(1)}% (all non-borderline)`
    );
    if (
      extended.strongSpikeImmediateTradesClosed !== undefined &&
      extended.strongSpikeImmediateTradesClosed > 0
    ) {
      console.log(
        `${"Strong imm".padEnd(14)} n=${extended.strongSpikeImmediateTradesClosed}  win% ${(extended.strongSpikeImmediateWinRate ?? 0).toFixed(1)}  avg ${(extended.averageStrongSpikeImmediatePnL ?? 0) >= 0 ? "+" : ""}${(extended.averageStrongSpikeImmediatePnL ?? 0).toFixed(4)}`
      );
    }
    if (
      extended.strongSpikeConfirmedTradesClosed !== undefined &&
      extended.strongSpikeConfirmedTradesClosed > 0
    ) {
      console.log(
        `${"Strong cnf".padEnd(14)} n=${extended.strongSpikeConfirmedTradesClosed}  win% ${(extended.strongSpikeConfirmedWinRate ?? 0).toFixed(1)}  avg ${(extended.averageStrongSpikeConfirmedPnL ?? 0) >= 0 ? "+" : ""}${(extended.averageStrongSpikeConfirmedPnL ?? 0).toFixed(4)}`
      );
    }
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
    if (
      extended.rejectedByPipelineQualityDowngradeLegacy !== undefined &&
      extended.rejectedByPipelineQualityDowngradeLegacy > 0
    ) {
      console.log(
        `${"Pipe Q rollup".padEnd(14)} ${extended.rejectedByPipelineQualityDowngradeLegacy} rejects (compat bucket = any pipeline_* / legacy pipeline_quality_downgrade)`
      );
    }
    if (
      extended.pipelineQualityDowngradeBreakdown !== undefined &&
      Object.keys(extended.pipelineQualityDowngradeBreakdown).length > 0
    ) {
      console.log(
        `${"Pipe Q detail".padEnd(14)} ${JSON.stringify(extended.pipelineQualityDowngradeBreakdown)}`
      );
    }
    if (extended.binaryYesNoComparative !== undefined) {
      console.log("");
      console.log(formatBinaryYesNoComparativeConsole(extended.binaryYesNoComparative));
    }
    if (extended.binaryRunAnalytics !== undefined && extended.binaryRunAnalytics !== null) {
      console.log("");
      console.log(
        formatMispricingBucketAnalysisConsole(
          extended.binaryRunAnalytics.mispricingBucketTradeStats
        )
      );
    }
    console.log(`${"Border verdict".padEnd(14)} ${extended.verdict.toUpperCase()}`);
    if (extended.gateFunnel !== undefined) {
      for (const ln of formatGateFunnelSection(extended.gateFunnel)) {
        console.log(ln);
      }
    }
    if (extended.binaryQuoteSession !== undefined) {
      const q = extended.binaryQuoteSession;
      console.log("");
      console.log("──────── Binary — signal vs venue repricing (session) ────────");
      console.log(
        `${"BTC max tickΔ".padEnd(14)} ${q.maxBtcSignalTickMovePct.toFixed(4)}% (single-tick |Δsignal|/signal)`
      );
      console.log(
        `${"BTC max winΔ".padEnd(14)} ${q.maxBtcRollingWindowRangePct.toFixed(4)}% (rolling buffer range / min)`
      );
      console.log(
        `${"YES max tickΔ".padEnd(14)} ${q.maxYesTickMoveAbs.toFixed(6)} (abs price move tick-to-tick)`
      );
      console.log(
        `${"NO max tickΔ".padEnd(14)} ${q.maxNoTickMoveAbs.toFixed(6)} (abs price move tick-to-tick)`
      );
      console.log(
        `${"Unique pairs".padEnd(14)} ${q.uniqueQuotePairsObserved} distinct YES|NO snapshots (6dp)`
      );
      console.log(
        `${"Quote changes".padEnd(14)} ${q.quoteChangeCount} tick-to-tick pair transitions`
      );
      console.log(
        `${"Flat quotes".padEnd(14)} ${q.flatQuoteTicks} ticks unchanged vs prior (${q.flatQuotePercent.toFixed(1)}% of ${Math.max(0, q.ticksWithValidQuote - 1)} comparables)`
      );
      console.log(
        `${"Ticks w/ quote".padEnd(14)} ${q.ticksWithValidQuote} ready ticks with finite YES/NO`
      );
      console.log("────────────────────────────────────────────────────────────────────");
    }
    if (extended.marketFeedDiagnostics !== undefined) {
      const d = extended.marketFeedDiagnostics;
      console.log("");
      if (d.mode === "spot") {
        const { symbol, health, lastMessageAgeMs } = d;
        console.log("──────── Market data feed — spot (session) ────────");
        console.log(
          `${"Symbol".padEnd(14)} ${symbol}  connected=${health.connected}  lastMsgAge≈${Math.round(lastMessageAgeMs)}ms`
        );
        console.log(
          `${"WS stats".padEnd(14)} connects ${health.connectCount}  disconnects ${health.disconnectCount}  msgs ${health.messagesTotal}`
        );
        if (health.lastError !== null) {
          console.log(`${"Last WS err".padEnd(14)} ${health.lastError}`);
        }
      } else if (d.source === "polymarket_gamma") {
        console.log("──────── Market data feed — binary (Polymarket Gamma) ────────");
        console.log(`${"Query".padEnd(14)} ${d.symbol}`);
        console.log(`${"Gamma API".padEnd(14)} ${d.gammaBaseUrl}`);
        console.log(
          `${"HTTP".padEnd(14)} polls=${d.pollCount} attempts=${d.httpAttempts} lastErr=${d.lastError ?? "—"}`
        );
        console.log(
          `${"Stale policy".padEnd(14)} maxQuoteAgeMs=${d.maxQuoteAgeMs} maxSilenceMs=${d.maxPollSilenceMs}`
        );
        console.log(
          `${"Stale".padEnd(14)} ${d.stale}${d.staleReason ? ` — ${d.staleReason}` : ""}`
        );
        if (d.quote !== null) {
          const q = d.quote;
          console.log(`${"Market id".padEnd(14)} ${q.marketId}`);
          console.log(`${"Condition".padEnd(14)} ${q.conditionId ?? "—"}`);
          console.log(`${"Slug".padEnd(14)} ${q.slug || "—"}`);
          const qn = q.question.length > 140 ? `${q.question.slice(0, 140)}…` : q.question;
          console.log(`${"Question".padEnd(14)} ${qn}`);
          console.log(`${"YES / NO".padEnd(14)} ${q.yesPrice} / ${q.noPrice}`);
          console.log(
            `${"Observed".padEnd(14)} ${new Date(q.observedAtMs).toISOString()}  quoteAgeMs=${q.quoteAgeMs ?? "—"}`
          );
          console.log(
            `${"State".padEnd(14)} active=${q.active} closed=${q.closed} volume=${q.volume ?? "—"}`
          );
        }
      } else {
        console.log("──────── Market data feed — binary (synthetic env) ────────");
        console.log(`${"Symbol".padEnd(14)} ${d.symbol}`);
        console.log(
          `${"UP / DOWN".padEnd(14)} ${d.upPrice} / ${d.downPrice}  (synthetic ${d.syntheticSpreadBps} bps)`
        );
        console.log(
          `${"Last update".padEnd(14)} ${new Date(d.lastUpdateAtMs).toISOString()}`
        );
      }
      console.log("────────────────────────────────────────────────────────────────────");
    }
    if (extended.signalFeedDiagnostics !== undefined) {
      const d = extended.signalFeedDiagnostics;
      if (d.mode === "spot") {
        const { symbol, health, lastMessageAgeMs } = d;
        console.log("");
        console.log("──────── Signal feed — BTC spot (session) ────────");
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
    }
    if (extended.exitThresholdAudit !== undefined && extended.exitThresholdAudit !== null) {
      const a = extended.exitThresholdAudit;
      const binAudit = a.binaryOutcomeExitAudit;
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
      if (binAudit !== undefined) {
        console.log("");
        console.log("  (binary subset — outcome price points vs TP/SL Δ)");
        console.log(
          `${"  Trades".padEnd(12)} ${binAudit.tradesAudited}  │  cfg TP+Δ ${binAudit.avgConfiguredTakeProfitDelta.toFixed(4)}  SL−Δ ${binAudit.avgConfiguredStopLossDelta.toFixed(4)}`
        );
        console.log(
          `${"  Avg gaps".padEnd(12)} min→TP ${binAudit.avgMinGapToTakeProfitPoints.toFixed(4)}  min→SL ${binAudit.avgMinGapToStopLossPoints.toFixed(4)}`
        );
        console.log(
          `${"  Avg MFE/MAE".padEnd(12)} ${binAudit.avgMaxFavorableExcursionPoints.toFixed(4)} / ${binAudit.avgMaxAdverseExcursionPoints.toFixed(4)} (pts on held leg)`
        );
      }
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
  /**
   * When set, pipeline deferred strong-spike confirmation — raw entry may still show `shouldEnter`
   * but paper execution clears it until promote (`strong_spike_waiting_confirmation_tick`).
   */
  pipelineWatchPathDeferredNote?: string;
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
  const pipelineWaitingConfirmationNote =
    decision.action === "none" &&
    decision.reason === "strong_spike_waiting_confirmation_tick" &&
    entry.shouldEnter;
  return {
    spikePercent: entry.movement.strongestMovePercent * 100,
    priorRange: entry.priorRangeFraction * 100,
    stableRange: entry.stableRangeDetected,
    classification: entry.movementClassification,
    entryAllowed,
    rejectionReasons: entryAllowed
      ? []
      : collectSpikeTraceRejectionReasons(entry, decision),
    ...(pipelineWaitingConfirmationNote
      ? {
          pipelineWatchPathDeferredNote:
            "strong_spike_waiting_confirmation_tick (paper entry cleared until promote)",
        }
      : {}),
  };
}

export function logSpikeDecisionTrace(payload: SpikeDecisionTracePayload): void {
  logMonitorDebug("[debug] spike decision trace");
  logMonitorDebug(JSON.stringify(payload, null, 2));
}
