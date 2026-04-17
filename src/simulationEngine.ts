import type { AppConfig } from "./config.js";
import type { EntryDirection, EntryEvaluation } from "./entryConditions.js";
import type { QualityProfile } from "./preEntryQualityGate.js";
import { resolveQualityStakeMultiplier } from "./stakeSizing.js";
import type { ExitReason } from "./exitConditions.js";
import { buildHoldExitAudit, type HoldExitAudit } from "./holdExitAudit.js";
import {
  computeSpotExitDiagnostics,
  evaluateSpotExitConditions,
} from "./spotExitConditions.js";
import {
  spotEntryFillPrice,
  spotMarkForPosition,
  type SpotMicrostructure,
} from "./spotSpreadFilter.js";

export type SimulatedTrade = {
  id: number;
  symbol: string;
  direction: EntryDirection;
  /** Fixed notional deployed at entry (USDT). */
  stake: number;
  /** Position size in base asset (BTC): stake / entryPrice. */
  shares: number;
  entryPrice: number;
  exitPrice: number;
  entryBid?: number;
  entryAsk?: number;
  exitBid?: number;
  exitAsk?: number;
  grossPnl: number;
  feesEstimate: number;
  /** Net P/L after fees (applied to equity). */
  profitLoss: number;
  /** Account equity immediately before this trade’s P/L is applied. */
  equityBefore: number;
  /** Account equity immediately after this trade’s P/L is applied. */
  equityAfter: number;
  /** Deployed notional at entry (same as stake in fixed-stake model). */
  riskAtEntry: number;
  /** Config base stake before quality multiplier (if sizing applied). */
  baseStakePerTrade?: number;
  /** Effective multiplier from {@link resolveQualityStakeMultiplier}. */
  qualityStakeMultiplier?: number;
  entryQualityProfile?: QualityProfile;
  exitReason: ExitReason;
  /** Which strategy path opened this trade. */
  entryPath: "strong_spike_immediate" | "borderline_delayed";
  openedAt: number;
  closedAt: number;
  /** Hold-period mark extrema vs EXIT_PRICE / STOP_LOSS (diagnostics). */
  holdExitAudit?: HoldExitAudit;
};

/** Binance-style top of book passed into {@link SimulationEngine.onTick}. */
export type SpotBookSides = SpotMicrostructure;

/** Mark price for position: long → bid, short → ask. */
export function quotePriceForPositionDirection(
  direction: EntryDirection,
  book: SpotBookSides
): number {
  return spotMarkForPosition(direction, book);
}

export function selectPositionQuote(
  direction: EntryDirection,
  book: SpotBookSides
): {
  direction: EntryDirection;
  entrySide: "ask" | "bid";
  markSide: "bid" | "ask";
  fillReference: number;
  otherSide: number;
} {
  return {
    direction,
    entrySide: direction === "UP" ? "ask" : "bid",
    markSide: direction === "UP" ? "bid" : "ask",
    fillReference: spotEntryFillPrice(direction, book, 0),
    otherSide: direction === "UP" ? book.bestAsk : book.bestBid,
  };
}

function paperQuoteFieldsForLog(
  direction: EntryDirection,
  book: SpotBookSides
): Record<string, unknown> {
  const s = selectPositionQuote(direction, book);
  return {
    positionDirection: s.direction,
    entrySide: s.entrySide,
    markSide: s.markSide,
    bestBid: book.bestBid,
    bestAsk: book.bestAsk,
    spreadBps: book.spreadBps,
  };
}

type OpenSimPosition = {
  direction: EntryDirection;
  stake: number;
  shares: number;
  entryPrice: number;
  entryBid: number;
  entryAsk: number;
  entryPath: "strong_spike_immediate" | "borderline_delayed";
  openedAt: number;
  baseStakePerTrade: number;
  qualityStakeMultiplier: number;
  entryQualityProfile?: QualityProfile;
  /** Set when {@link SimulationEngineOptions.paperPositionMtmDiagnostics} is true. */
  paperOpenSeq?: number;
  /** Min/max mark on the held leg while open (every tick; used for exit audit + MTM logs). */
  holdMarkMin: number;
  holdMarkMax: number;
};

export type SimulationTickInput = {
  now: number;
  entry: EntryEvaluation;
  /** Optional source tagging for attribution stats. */
  entryPath?: "strong_spike_immediate" | "borderline_delayed";
  /** From strategy decision / gate; drives stake multiplier when enabled. */
  entryQualityProfile?: QualityProfile;
  sides: SpotBookSides;
  symbol: string;
  /** Exit, stop (bps), sizing, cooldown, fees. */
  config: Pick<
    AppConfig,
    | "takeProfitBps"
    | "stopLossBps"
    | "paperSlippageBps"
    | "paperFeeRoundTripBps"
    | "exitTimeoutMs"
    | "entryCooldownMs"
    | "stakePerTrade"
    | "allowWeakQualityEntries"
    | "weakQualitySizeMultiplier"
    | "strongQualitySizeMultiplier"
    | "exceptionalQualitySizeMultiplier"
  >;
};

/** Aggregates from closed trades only (no live equity). */
export type SimulationTradeStats = {
  totalTrades: number;
  wins: number;
  losses: number;
  breakeven: number;
  winRate: number;
  totalProfit: number;
  averageProfitPerTrade: number;
};

export type SimulationPerformanceStats = SimulationTradeStats & {
  maxEquityDrawdown: number;
  currentEquity: number;
  initialEquity: number;
};

/** One closed-trade record for console / JSONL. */
export type TransparentTradeLog = {
  tradeId: number;
  symbol: string;
  /** ISO time at exit (close). */
  timestamp: string;
  direction: EntryDirection;
  stake: number;
  shares: number;
  entryPrice: number;
  exitPrice: number;
  grossPnl: number;
  feesEstimate: number;
  pnl: number;
  equityBefore: number;
  equityAfter: number;
  /** Strategy path that opened the trade. */
  reasonEntry: SimulatedTrade["entryPath"];
  reasonExit: ExitReason;
  baseStakePerTrade?: number;
  qualityStakeMultiplier?: number;
  entryQualityProfile?: QualityProfile;
  riskAtEntry?: number;
};

export function buildTransparentTradeLog(t: SimulatedTrade): TransparentTradeLog {
  return {
    tradeId: t.id,
    symbol: t.symbol,
    timestamp: new Date(t.closedAt).toISOString(),
    direction: t.direction,
    stake: t.stake,
    shares: t.shares,
    entryPrice: t.entryPrice,
    exitPrice: t.exitPrice,
    grossPnl: t.grossPnl,
    feesEstimate: t.feesEstimate,
    pnl: t.profitLoss,
    equityBefore: t.equityBefore,
    equityAfter: t.equityAfter,
    reasonEntry: t.entryPath,
    reasonExit: t.exitReason,
    ...(t.baseStakePerTrade !== undefined
      ? { baseStakePerTrade: t.baseStakePerTrade }
      : {}),
    ...(t.qualityStakeMultiplier !== undefined
      ? { qualityStakeMultiplier: t.qualityStakeMultiplier }
      : {}),
    ...(t.entryQualityProfile !== undefined
      ? { entryQualityProfile: t.entryQualityProfile }
      : {}),
    ...(t.riskAtEntry !== undefined ? { riskAtEntry: t.riskAtEntry } : {}),
  };
}

const SUMMARY_EVERY_N_TRADES = 10;

export type SimulationEngineOptions = {
  /** When true, no `[SIM]` console output (for backtests / batch runs). */
  silent?: boolean;
  /** Starting equity (must match {@link AppConfig.initialCapital} in live config). */
  initialEquity?: number;
  /**
   * Called after each closed paper trade (after the trade is appended to history).
   * Use for custom logging (e.g. live monitor); runs even when {@link silent} is true.
   */
  onTradeClosed?: (trade: SimulatedTrade) => void;
  /**
   * When true, emit `[PAPER-MTM]` JSON lines: open snapshot, every tick while open,
   * and close snapshot (does not change fills or exit decisions).
   */
  paperPositionMtmDiagnostics?: boolean;
};

const DEFAULT_INITIAL_EQUITY = 10_000;

export class SimulationEngine {
  private readonly silent: boolean;
  private readonly onTradeClosed: ((trade: SimulatedTrade) => void) | undefined;
  private readonly paperPositionMtmDiagnostics: boolean;
  private readonly initialEquity: number;
  private equity: number;
  private nextId = 1;
  private paperOpenSeqCounter = 0;
  private position: OpenSimPosition | null = null;
  private lastExitAt: number | null = null;
  private readonly trades: SimulatedTrade[] = [];

  constructor(options?: SimulationEngineOptions) {
    this.silent = options?.silent === true;
    this.onTradeClosed = options?.onTradeClosed;
    this.paperPositionMtmDiagnostics = options?.paperPositionMtmDiagnostics === true;
    const start = options?.initialEquity;
    this.initialEquity =
      start !== undefined && Number.isFinite(start) && start > 0
        ? start
        : DEFAULT_INITIAL_EQUITY;
    this.equity = this.initialEquity;
  }

  getTradeHistory(): readonly SimulatedTrade[] {
    return this.trades;
  }

  /** Paper position currently open, if any. */
  getOpenPosition(): Readonly<{
    direction: EntryDirection;
    entryPrice: number;
    stake: number;
    shares: number;
  }> | null {
    if (!this.position) return null;
    return {
      direction: this.position.direction,
      entryPrice: this.position.entryPrice,
      stake: this.position.stake,
      shares: this.position.shares,
    };
  }

  /**
   * True when a new entry can be accepted right now, considering open position
   * and post-exit cooldown.
   */
  canOpenNewPosition(now: number, cooldownMs: number): boolean {
    if (this.position !== null) return false;
    if (this.lastExitAt !== null && now - this.lastExitAt < cooldownMs) {
      return false;
    }
    return true;
  }

  /**
   * Full P/L summary from **closed trades only** (same numbers as summing
   * `profitLoss` on {@link getTradeHistory} and replaying equity).
   */
  getPerformanceStats(): SimulationPerformanceStats {
    return computePerformanceFromClosedTrades(this.trades, this.initialEquity);
  }

  /**
   * Paper spot execution: fill at bid/ask + slippage; exit marks on bid (long) / ask (short).
   */
  onTick(input: SimulationTickInput): void {
    const { now, entry, sides, config, symbol } = input;

    if (this.position) {
      const mark = quotePriceForPositionDirection(this.position.direction, sides);
      if (!Number.isFinite(mark)) {
        return;
      }

      {
        const lo = this.position.holdMarkMin;
        const hi = this.position.holdMarkMax;
        this.position.holdMarkMin = Math.min(lo, mark);
        this.position.holdMarkMax = Math.max(hi, mark);
      }

      if (this.paperPositionMtmDiagnostics && this.position.paperOpenSeq !== undefined) {
        const { shares, entryPrice, direction, openedAt, paperOpenSeq } =
          this.position;
        const exitDiag = computeSpotExitDiagnostics({
          direction,
          markPrice: mark,
          entryFillPrice: entryPrice,
          takeProfitBps: config.takeProfitBps,
          stopLossBps: config.stopLossBps,
          openedAt: this.position.openedAt,
          timeoutMs: config.exitTimeoutMs,
          now,
        });
        const unrealizedPnl =
          direction === "UP"
            ? shares * (mark - entryPrice)
            : shares * (entryPrice - mark);
        const markMin = this.position.holdMarkMin;
        const markMax = this.position.holdMarkMax;
        const markRangeWhileOpen = markMax - markMin;
        logPaperMtmLine({
          kind: "paper_mtm_tick",
          tradeId: paperOpenSeq,
          paperOpenSeq,
          openCorrelationId: openedAt,
          timestamp: new Date(now).toISOString(),
          direction,
          entryPrice,
          symbol,
          ...paperQuoteFieldsForLog(direction, sides),
          fullQuoteBook: { bestBid: sides.bestBid, bestAsk: sides.bestAsk, spreadBps: sides.spreadBps },
          markPrice: mark,
          markPriceSource: markPriceSourceLabel(direction),
          unrealizedPnl,
          takeProfitBps: config.takeProfitBps,
          stopLossBps: config.stopLossBps,
          holdDurationMs: exitDiag.elapsedMs,
          exitConditionStatus: {
            targetHit: exitDiag.targetHit,
            stopHit: exitDiag.stopHit,
            timeoutReached: exitDiag.timeoutReached,
          },
          markMinWhileOpen: markMin,
          markMaxWhileOpen: markMax,
          markRangeWhileOpen,
          markStaticSoFar: markRangeWhileOpen < 1e-9,
        });
      }

      const exit = evaluateSpotExitConditions({
        direction: this.position.direction,
        markPrice: mark,
        entryFillPrice: this.position.entryPrice,
        takeProfitBps: config.takeProfitBps,
        stopLossBps: config.stopLossBps,
        openedAt: this.position.openedAt,
        timeoutMs: config.exitTimeoutMs,
        now,
      });

      if (exit.shouldExit && exit.reason !== null) {
        this.closePosition(
          mark,
          now,
          exit.reason,
          sides,
          symbol,
          config
        );
      }
      return;
    }

    if (entry.shouldEnter && entry.direction !== null) {
      if (this.lastExitAt !== null) {
        const waited = now - this.lastExitAt;
        if (waited < config.entryCooldownMs) {
          return;
        }
      }
      const fill = spotEntryFillPrice(entry.direction, sides, config.paperSlippageBps);
      if (!Number.isFinite(fill) || fill <= 0) {
        return;
      }

      const baseStake = config.stakePerTrade;
      const qualityMult = resolveQualityStakeMultiplier(
        input.entryQualityProfile,
        config
      );
      const stake = baseStake * qualityMult;
      if (!(stake > 0)) {
        if (!this.silent) {
          console.log(
            `[SIM] Skip entry: effective stake must be > 0 (base=${baseStake.toFixed(2)} mult=${qualityMult.toFixed(4)})`
          );
        }
        return;
      }

      const shares = stake / fill;

      const paperOpenSeq = this.paperPositionMtmDiagnostics
        ? ++this.paperOpenSeqCounter
        : undefined;

      this.position = {
        direction: entry.direction,
        stake,
        shares,
        entryPrice: fill,
        entryBid: sides.bestBid,
        entryAsk: sides.bestAsk,
        entryPath: input.entryPath ?? "strong_spike_immediate",
        openedAt: now,
        baseStakePerTrade: baseStake,
        qualityStakeMultiplier: qualityMult,
        holdMarkMin: quotePriceForPositionDirection(entry.direction, sides),
        holdMarkMax: quotePriceForPositionDirection(entry.direction, sides),
        ...(this.paperPositionMtmDiagnostics && paperOpenSeq !== undefined
          ? { paperOpenSeq }
          : {}),
        ...(input.entryQualityProfile !== undefined
          ? { entryQualityProfile: input.entryQualityProfile }
          : {}),
      };

      if (this.paperPositionMtmDiagnostics && paperOpenSeq !== undefined) {
        logPaperMtmLine({
          kind: "paper_mtm_open",
          tradeId: paperOpenSeq,
          paperOpenSeq,
          openCorrelationId: now,
          timestamp: new Date(now).toISOString(),
          direction: entry.direction,
          symbol,
          fillPrice: fill,
          quoteSnapshot: {
            bestBid: sides.bestBid,
            bestAsk: sides.bestAsk,
            mid: sides.midPrice,
            spreadBps: sides.spreadBps,
          },
          ...paperQuoteFieldsForLog(entry.direction, sides),
          markPriceSource: markPriceSourceLabel(entry.direction),
          sideRationale: buildEntrySideRationale(entry, entry.direction),
          entryEvalSnapshot: {
            spikeDetected: entry.spikeDetected,
            movementClassification: entry.movementClassification,
            strongestMoveDirection:
              entry.windowSpike?.strongestMoveDirection ?? null,
            shouldEnter: entry.shouldEnter,
          },
          takeProfitBps: config.takeProfitBps,
          stopLossBps: config.stopLossBps,
          exitTimeoutMs: config.exitTimeoutMs,
        });
      }

      if (!this.silent) {
        const prof = input.entryQualityProfile ?? "—";
        const leg = selectPositionQuote(entry.direction, sides);
        console.log(
          `[SIM] Open ${entry.direction} ${symbol} | fill@${leg.entrySide}=${fill.toFixed(2)} | sizing base=${baseStake.toFixed(2)} profile=${prof} mult=${qualityMult.toFixed(4)} → stake=${stake.toFixed(2)} qty=${shares.toFixed(6)} BTC`
        );
      }
    }
  }

  private closePosition(
    exitMark: number,
    closedAt: number,
    exitReason: ExitReason,
    bookAtExit: SpotBookSides,
    symbol: string,
    cfg: SimulationTickInput["config"]
  ): void {
    if (!this.position) return;

    const {
      direction,
      stake,
      shares,
      entryPrice,
      entryPath,
      openedAt,
      baseStakePerTrade,
      qualityStakeMultiplier,
      entryQualityProfile,
      paperOpenSeq,
      holdMarkMin,
      holdMarkMax,
      entryBid,
      entryAsk,
    } = this.position;
    this.position = null;

    const equityBefore = this.equity;
    const grossPnl =
      direction === "UP"
        ? shares * (exitMark - entryPrice)
        : shares * (entryPrice - exitMark);
    const feesEstimate = stake * (cfg.paperFeeRoundTripBps / 10_000);
    const profitLoss = grossPnl - feesEstimate;
    const equityAfter = equityBefore + profitLoss;
    const riskAtEntry = stake;

    this.equity = equityAfter;

    const tpPx =
      direction === "UP"
        ? entryPrice * (1 + cfg.takeProfitBps / 10_000)
        : entryPrice * (1 - cfg.takeProfitBps / 10_000);
    const slPx =
      direction === "UP"
        ? entryPrice * (1 - cfg.stopLossBps / 10_000)
        : entryPrice * (1 + cfg.stopLossBps / 10_000);

    const holdExitAudit = buildHoldExitAudit({
      direction,
      entryPrice,
      exitMark,
      holdMarkMin,
      holdMarkMax,
      configExitPrice: tpPx,
      configStopLoss: slPx,
      exitReason,
    });

    const closedTradeId = this.nextId++;
    const record: SimulatedTrade = {
      id: closedTradeId,
      symbol,
      direction,
      stake,
      shares,
      entryPrice,
      exitPrice: exitMark,
      entryBid,
      entryAsk,
      exitBid: bookAtExit.bestBid,
      exitAsk: bookAtExit.bestAsk,
      grossPnl,
      feesEstimate,
      profitLoss,
      equityBefore,
      equityAfter,
      riskAtEntry,
      baseStakePerTrade,
      qualityStakeMultiplier,
      ...(entryQualityProfile !== undefined
        ? { entryQualityProfile }
        : {}),
      exitReason,
      entryPath,
      openedAt,
      closedAt,
      holdExitAudit,
    };
    this.trades.push(record);
    this.lastExitAt = closedAt;

    if (paperOpenSeq !== undefined) {
      const minObs = holdMarkMin;
      const maxObs = holdMarkMax;
      const rangeObs = maxObs - minObs;
      const finalDiag = computeSpotExitDiagnostics({
        direction,
        markPrice: exitMark,
        entryFillPrice: entryPrice,
        takeProfitBps: cfg.takeProfitBps,
        stopLossBps: cfg.stopLossBps,
        openedAt,
        timeoutMs: cfg.exitTimeoutMs,
        now: closedAt,
      });
      const flatTape = rangeObs < 1e-9;
      logPaperMtmLine({
        kind: "paper_mtm_close",
        tradeId: paperOpenSeq,
        paperOpenSeq,
        openCorrelationId: openedAt,
        closedTradeId,
        timestamp: new Date(closedAt).toISOString(),
        direction,
        symbol,
        quoteSnapshot: bookAtExit,
        ...paperQuoteFieldsForLog(direction, bookAtExit),
        exitRuleFired: exitReason,
        finalMarkPrice: exitMark,
        markPriceSource: markPriceSourceLabel(direction),
        entryPrice,
        grossPnl,
        feesEstimate,
        pnlClosed: profitLoss,
        exitDiagnosticsAtClose: {
          targetHit: finalDiag.targetHit,
          stopHit: finalDiag.stopHit,
          timeoutReached: finalDiag.timeoutReached,
        },
        markMinWhileOpen: minObs,
        markMaxWhileOpen: maxObs,
        markRangeWhileOpen: rangeObs,
        markTapeFlatAcrossHold: flatTape,
        exitMarkEqualsEntryMark: Math.abs(exitMark - entryPrice) < 1e-9,
        flatTapeHint: flatTape
          ? "Mark flat while open — check Binance book feed freshness."
          : "Mark range > 0 while open.",
        holdExitAudit,
      });
    }

    this.onTradeClosed?.(record);
    this.printTradeResult(record);
    if (
      !this.silent &&
      this.trades.length > 0 &&
      this.trades.length % SUMMARY_EVERY_N_TRADES === 0
    ) {
      this.printPerformanceSummary();
    }
  }

  private printPerformanceSummary(): void {
    if (this.silent) return;
    const s = this.getPerformanceStats();
    const wr = Number.isFinite(s.winRate) ? s.winRate.toFixed(1) : "0.0";
    const total =
      s.totalProfit >= 0
        ? `+${s.totalProfit.toFixed(4)}`
        : s.totalProfit.toFixed(4);
    const avg =
      s.averageProfitPerTrade >= 0
        ? `+${s.averageProfitPerTrade.toFixed(4)}`
        : s.averageProfitPerTrade.toFixed(4);
    console.log(
      `[SIM] ─── Performance summary (${s.totalTrades} trades) ───`
    );
    console.log(
      `[SIM]   Total: ${s.totalTrades} | Wins: ${s.wins} | Losses: ${s.losses} | Breakeven: ${s.breakeven} | Win rate: ${wr}%`
    );
    console.log(`[SIM]   Total P/L: ${total} | Avg P/L per trade: ${avg}`);
    console.log(
      `[SIM]   Equity: ${s.currentEquity.toFixed(2)} (start ${s.initialEquity.toFixed(2)}) | Max equity DD: ${s.maxEquityDrawdown.toFixed(4)}`
    );
  }

  private printTradeResult(t: SimulatedTrade): void {
    if (this.silent) return;
    const payload = buildTransparentTradeLog(t);
    console.log("[SIM] Trade closed (full log):");
    console.log(JSON.stringify(payload, null, 2));
  }
}

function logPaperMtmLine(payload: Record<string, unknown>): void {
  console.log(`[PAPER-MTM] ${JSON.stringify(payload)}`);
}

function markPriceSourceLabel(direction: EntryDirection): string {
  return direction === "UP"
    ? "bestBid — long BTC exit/MTM"
    : "bestAsk — short BTC exit/MTM";
}

function buildEntrySideRationale(
  entry: EntryEvaluation,
  direction: EntryDirection
): string {
  const dom = entry.windowSpike?.strongestMoveDirection;
  if (dom === "UP" && direction === "DOWN") {
    return "Micro-window dominant move UP → contrarian entry on DOWN leg; simulator fill = downSidePrice.";
  }
  if (dom === "DOWN" && direction === "UP") {
    return "Micro-window dominant move DOWN → contrarian entry on UP leg; simulator fill = upSidePrice.";
  }
  return `Direction ${direction} with dominantMove=${String(dom ?? "n/a")} (delayed borderline / pipeline may differ from one-tick spike).`;
}

/**
 * Win/loss counts, totals, and avg P/L from closed trades only
 * (`profitLoss` sums to `totalProfit`).
 */
export function computeSimulationPerformance(
  trades: readonly SimulatedTrade[]
): SimulationTradeStats {
  const totalTrades = trades.length;
  let wins = 0;
  let losses = 0;
  let breakeven = 0;
  let totalProfit = 0;

  for (const t of trades) {
    totalProfit += t.profitLoss;
    if (t.profitLoss > 0) wins += 1;
    else if (t.profitLoss < 0) losses += 1;
    else breakeven += 1;
  }

  const winRate = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;
  const averageProfitPerTrade =
    totalTrades > 0 ? totalProfit / totalTrades : 0;

  return {
    totalTrades,
    wins,
    losses,
    breakeven,
    winRate,
    totalProfit,
    averageProfitPerTrade,
  };
}

/**
 * Paper performance for reporting: everything is derived from `trades` + starting equity.
 * Max drawdown = peak-to-trough of running account equity after each closed trade.
 */
export function computePerformanceFromClosedTrades(
  trades: readonly SimulatedTrade[],
  initialEquity: number
): SimulationPerformanceStats {
  const base = computeSimulationPerformance(trades);
  let equity = initialEquity;
  let peak = initialEquity;
  let maxEquityDrawdown = 0;
  for (const t of trades) {
    equity += t.profitLoss;
    peak = Math.max(peak, equity);
    maxEquityDrawdown = Math.max(maxEquityDrawdown, peak - equity);
  }
  return {
    ...base,
    maxEquityDrawdown,
    currentEquity: equity,
    initialEquity,
  };
}
