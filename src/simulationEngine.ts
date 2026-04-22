import { debugMonitor } from "./config.js";
import type { AppConfig } from "./config.js";
import {
  effectiveBinaryMaxEntryPriceForSide,
  effectiveBinaryMinMispricingThreshold,
} from "./config/binarySideGating.js";
import type { EntryDirection, EntryEvaluation } from "./entryConditions.js";
import type { QualityProfile } from "./preEntryQualityGate.js";
import { resolveQualityStakeMultiplier } from "./stakeSizing.js";
import type { ExitReason } from "./exitConditions.js";
import { buildHoldExitAudit, type HoldExitAudit } from "./holdExitAudit.js";
import {
  binarySpreadExceedsHardMax,
  binaryYesMidFailsExtremeBand,
} from "./binary/entry/binaryQuoteEntryFilter.js";
import {
  computeBinaryExitDiagnostics,
  evaluateBinaryExitConditions,
} from "./binary/exit/binaryExitConditions.js";
import {
  computeSpotExitDiagnostics,
  evaluateSpotExitConditions,
} from "./legacy/spot/spotExitConditions.js";
import {
  BINARY_ENTRY_REJECTION_MODEL_EDGE_BELOW_MIN_THRESHOLD,
  BINARY_ENTRY_REJECTION_NEGATIVE_OR_ZERO_MODEL_EDGE,
  computeBinaryEntryEdge,
  formatEdgeEntryLogLine,
  resolveBinaryVenueAsks,
  shouldEnterTrade,
  binaryLegFromDirection,
} from "./binary/entry/edgeEntryDecision.js";
import {
  binaryOutcomeBuyFillPrice,
  binarySideFromStrategyDirection,
  type BinarySideBought,
} from "./binary/paper/binaryPaperExecution.js";
import {
  BINARY_PRE_ENTRY_REJECT_INVALID_OUTCOME_FILL,
  BINARY_PRE_ENTRY_REJECT_MAX_ENTRY_PRICE,
  BINARY_PRE_ENTRY_REJECT_YES_MID_EXTREME,
  BINARY_PRE_ENTRY_REJECT_SPREAD_TOO_WIDE_HARD,
  BINARY_PRE_ENTRY_REJECT_STAKE_ZERO,
  buildBinaryPreEntryAuditRecord,
  logBinaryPreEntryAuditDebug,
} from "./binary/monitor/binaryPreEntryAudit.js";
import { getPositionSize } from "./riskPositionSizing.js";
import {
  applyBinaryPaperVenueTick,
  binaryPaperGrossPnlUsdt,
  binaryPaperRoundTripFeeUsdt,
  binaryPaperUnrealizedPnlUsdt,
  openBinaryPaperPosition,
  type BinaryPaperLivePosition,
} from "./binary/paper/binaryPaperPosition.js";
import { buildBinaryPaperTradeLog } from "./binary/paper/binaryPaperTradeLog.js";
import type { PaperTradeEntryPath } from "./paperEntryPath.js";
import type { TradeEntryOpenReason } from "./tradeEntryOpenDiagnosis.js";
import type { BinaryOutcomePrices } from "./market/types.js";
import type { ExecutableBookQuote } from "./executionSpreadFilter.js";
import {
  legacySpotEntryFillPrice,
  legacySpotMarkForPosition,
} from "./legacy/spot/spotBookQuotes.js";

export type SimulatedTrade = {
  id: number;
  symbol: string;
  direction: EntryDirection;
  /** `spot` (default) vs Polymarket-style outcome paper. */
  executionModel?: "spot" | "binary";
  /** When `executionModel === "binary"`, which outcome was bought. */
  sideBought?: BinarySideBought;
  /** Held-outcome entry / exit (same as `entryPrice`/`exitPrice` in binary mode, explicit for logs). */
  entrySidePrice?: number;
  exitSidePrice?: number;
  yesPriceAtEntry?: number;
  noPriceAtEntry?: number;
  yesPriceAtExit?: number;
  noPriceAtExit?: number;
  /** Binary: underlying (e.g. BTC) signal mid at entry. */
  underlyingSignalPriceAtEntry?: number;
  /** Binary: underlying signal mid at exit. */
  underlyingSignalPriceAtExit?: number;
  /**
   * Binary: momentum-style P(BTC up) at entry (`estimateProbabilityUpFromPriceBuffer`); calibration label, not token fair.
   */
  estimatedProbabilityUpAtEntry?: number;
  /** Binary: horizon used for calibration labels (`PROBABILITY_TIME_HORIZON_MS`). */
  probabilityTimeHorizonMs?: number;
  /** Fixed notional deployed at entry (USDT). */
  stake: number;
  /** Spot: base size (BTC). Binary: outcome contracts = stake / entrySidePrice. */
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
  /**
   * Binary: (fair P on bought leg − ask) at entry. Fair is derived from momentum `p_up` + contrarian mapping
   * (`fairBuyLegProbabilityFromMomentumUp` / `computeBinaryEntryEdge`), not raw `estimatedProbabilityUpAtEntry`.
   */
  entryModelEdge?: number;
  exitReason: ExitReason;
  /** Which strategy path opened this trade. */
  entryPath: PaperTradeEntryPath;
  openedAt: number;
  closedAt: number;
  /** Hold-period mark extrema vs EXIT_PRICE / STOP_LOSS (diagnostics). */
  holdExitAudit?: HoldExitAudit;
  /**
   * Binary pipeline-backed entry snapshot (monitor / binary backtest). Omitted when the tick
   * did not carry pipeline diagnostics (e.g. legacy {@link botLoop} path).
   */
  entryOpenReason?: TradeEntryOpenReason;
};

/** Mark price for position: long → bid, short → ask. */
export function quotePriceForPositionDirection(
  direction: EntryDirection,
  book: ExecutableBookQuote
): number {
  return legacySpotMarkForPosition(direction, book);
}

export function selectPositionQuote(
  direction: EntryDirection,
  book: ExecutableBookQuote
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
    fillReference: legacySpotEntryFillPrice(direction, book, 0),
    otherSide: direction === "UP" ? book.bestAsk : book.bestBid,
  };
}

function paperQuoteFieldsForLog(
  direction: EntryDirection,
  book: ExecutableBookQuote
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
  executionModel: "spot" | "binary";
  direction: EntryDirection;
  sideBought?: BinarySideBought;
  /** Binary paper: venue snapshot + sizing (authoritative for marks between ticks). */
  binaryPaper?: BinaryPaperLivePosition;
  yesPriceAtEntry?: number;
  noPriceAtEntry?: number;
  underlyingSignalAtEntry?: number;
  stake: number;
  shares: number;
  entryPrice: number;
  /** Spot only — omitted in binary mode (no BTC bid/ask book semantics). */
  entryBid?: number;
  entryAsk?: number;
  entryPath: PaperTradeEntryPath;
  openedAt: number;
  baseStakePerTrade: number;
  qualityStakeMultiplier: number;
  entryQualityProfile?: QualityProfile;
  /** Binary: fair P(buy leg) − ask at entry (contrarian mapping from momentum p_up). */
  entryModelEdge?: number;
  /** Binary: momentum P(BTC up) at entry tick (calibration vs realized horizon). */
  estimatedProbabilityUpAtEntry?: number;
  /** Set when {@link SimulationEngineOptions.paperPositionMtmDiagnostics} is true. */
  paperOpenSeq?: number;
  /** Min/max mark on the held leg while open (every tick; used for exit audit + MTM logs). */
  holdMarkMin: number;
  holdMarkMax: number;
  /** Binary: decision snapshot at open (JSONL `entryOpenReason`). */
  entryOpenReason?: TradeEntryOpenReason;
};

export type SimulationTickInput = {
  now: number;
  entry: EntryEvaluation;
  /** Optional source tagging for attribution stats. */
  entryPath?: PaperTradeEntryPath;
  /** From strategy decision / gate; drives stake multiplier when enabled. */
  entryQualityProfile?: QualityProfile;
  /**
   * Executable **venue** top-of-book (binary: synthetic bid/ask around YES/NO; spot: Binance).
   * Never used as the BTC rolling-buffer series — that comes from {@link BotContext.signalFeed}.
   */
  executionBook: ExecutableBookQuote;
  symbol: string;
  /**
   * `binary` → outcome-token paper (requires `binaryOutcomes` each tick).
   * Omitted or `spot` → legacy spot bid/ask execution.
   */
  marketMode?: "spot" | "binary";
  /** YES/NO prices for the current tick (binary mode). */
  binaryOutcomes?: BinaryOutcomePrices | null;
  /**
   * Underlying signal mid this tick (binary: BTC spot; spot: same as book mid).
   * Used for trade logs comparing signal vs venue repricing.
   */
  underlyingSignalPrice?: number;
  /**
   * Binary: momentum P(BTC up) from the probability engine — **not** Polymarket YES fair until mapped for edge.
   * Edge uses contrarian fair on the buy leg (`binaryEdgeSemantics` / `computeBinaryEntryEdge`).
   */
  estimatedProbabilityUp?: number;
  /** Exit, stop (bps), sizing, cooldown, fees. */
  config: Pick<
    AppConfig,
    | "takeProfitBps"
    | "stopLossBps"
    | "binaryPaperSlippageBps"
    | "paperFeeRoundTripBps"
    | "exitTimeoutMs"
    | "binaryTakeProfitPriceDelta"
    | "binaryStopLossPriceDelta"
    | "binaryExitTimeoutMs"
    | "binaryMaxEntryPrice"
    | "binaryEnableSideSpecificGating"
    | "binaryYesMinMispricingThreshold"
    | "binaryNoMinMispricingThreshold"
    | "binaryYesMaxEntryPrice"
    | "binaryNoMaxEntryPrice"
    | "binaryYesMidExtremeFilterEnabled"
    | "binaryYesMidBandMin"
    | "binaryYesMidBandMax"
    | "binaryHardMaxSpreadBps"
    | "entryCooldownMs"
    | "stakePerTrade"
    | "allowWeakQualityEntries"
    | "weakQualitySizeMultiplier"
    | "strongQualitySizeMultiplier"
    | "exceptionalQualitySizeMultiplier"
    | "minEdgeThreshold"
    | "riskPercentPerTrade"
    | "maxTradeSize"
    | "minTradeSize"
    | "probabilityTimeHorizonMs"
  >;
  /** Binary pipeline-backed: copied onto the open position and closed trade record. */
  entryOpenReason?: TradeEntryOpenReason;
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
  executionModel?: "spot" | "binary";
  sideBought?: BinarySideBought;
  entrySidePrice?: number;
  exitSidePrice?: number;
  yesPriceAtEntry?: number;
  noPriceAtEntry?: number;
  yesPriceAtExit?: number;
  noPriceAtExit?: number;
  underlyingSignalPriceAtEntry?: number;
  underlyingSignalPriceAtExit?: number;
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
  /** Binary trades: explicit grouping of BTC signal vs YES/NO venue in JSONL. */
  layers?: {
    signal: {
      underlyingBtcMidAtEntry?: number;
      underlyingBtcMidAtExit?: number;
    };
    executionVenue: {
      yesPriceAtEntry?: number;
      noPriceAtEntry?: number;
      yesPriceAtExit?: number;
      noPriceAtExit?: number;
    };
  };
};

export function buildTransparentTradeLog(t: SimulatedTrade): TransparentTradeLog {
  return {
    tradeId: t.id,
    symbol: t.symbol,
    timestamp: new Date(t.closedAt).toISOString(),
    direction: t.direction,
    ...(t.executionModel !== undefined ? { executionModel: t.executionModel } : {}),
    ...(t.sideBought !== undefined ? { sideBought: t.sideBought } : {}),
    ...(t.entrySidePrice !== undefined ? { entrySidePrice: t.entrySidePrice } : {}),
    ...(t.exitSidePrice !== undefined ? { exitSidePrice: t.exitSidePrice } : {}),
    ...(t.yesPriceAtEntry !== undefined ? { yesPriceAtEntry: t.yesPriceAtEntry } : {}),
    ...(t.noPriceAtEntry !== undefined ? { noPriceAtEntry: t.noPriceAtEntry } : {}),
    ...(t.yesPriceAtExit !== undefined ? { yesPriceAtExit: t.yesPriceAtExit } : {}),
    ...(t.noPriceAtExit !== undefined ? { noPriceAtExit: t.noPriceAtExit } : {}),
    ...(t.underlyingSignalPriceAtEntry !== undefined
      ? { underlyingSignalPriceAtEntry: t.underlyingSignalPriceAtEntry }
      : {}),
    ...(t.underlyingSignalPriceAtExit !== undefined
      ? { underlyingSignalPriceAtExit: t.underlyingSignalPriceAtExit }
      : {}),
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
    ...(t.executionModel === "binary"
      ? {
          layers: {
            signal: {
              ...(t.underlyingSignalPriceAtEntry !== undefined
                ? { underlyingBtcMidAtEntry: t.underlyingSignalPriceAtEntry }
                : {}),
              ...(t.underlyingSignalPriceAtExit !== undefined
                ? { underlyingBtcMidAtExit: t.underlyingSignalPriceAtExit }
                : {}),
            },
            executionVenue: {
              ...(t.yesPriceAtEntry !== undefined
                ? { yesPriceAtEntry: t.yesPriceAtEntry }
                : {}),
              ...(t.noPriceAtEntry !== undefined
                ? { noPriceAtEntry: t.noPriceAtEntry }
                : {}),
              ...(t.yesPriceAtExit !== undefined
                ? { yesPriceAtExit: t.yesPriceAtExit }
                : {}),
              ...(t.noPriceAtExit !== undefined
                ? { noPriceAtExit: t.noPriceAtExit }
                : {}),
            },
          },
        }
      : {}),
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
  /** Last binary entry skip in {@link onTickBinary} (for tests / monitor diagnostics). */
  private lastBinaryEntryRejectionReason: string | null = null;
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
  /**
   * When the previous tick attempted a binary entry that was skipped after
   * `entry.shouldEnter`, the rejection code (e.g. `negative_or_zero_model_edge`).
   */
  getLastBinaryEntryRejectionReason(): string | null {
    return this.lastBinaryEntryRejectionReason;
  }

  getOpenPosition(): Readonly<{
    direction: EntryDirection;
    entryPrice: number;
    stake: number;
    shares: number;
    executionModel?: "spot" | "binary";
    sideBought?: BinarySideBought;
    /** Binary: mark on the held outcome after the latest venue quote. */
    currentHeldOutcomeMark?: number;
    yesMidLast?: number;
    noMidLast?: number;
  }> | null {
    if (!this.position) return null;
    const bp = this.position.binaryPaper;
    return {
      direction: this.position.direction,
      entryPrice: this.position.entryPrice,
      stake: this.position.stake,
      shares: this.position.shares,
      ...(this.position.executionModel === "binary"
        ? {
            executionModel: "binary" as const,
            ...(this.position.sideBought !== undefined
              ? { sideBought: this.position.sideBought }
              : {}),
            ...(bp !== undefined
              ? {
                  currentHeldOutcomeMark: bp.heldOutcomeMark,
                  yesMidLast: bp.yesMidLast,
                  noMidLast: bp.noMidLast,
                }
              : {}),
          }
        : {}),
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

  onTick(input: SimulationTickInput): void {
    const mode = input.marketMode ?? "binary";
    if (mode === "binary") {
      this.onTickBinary(input);
      return;
    }
    this.onTickSpot(input);
  }

  /**
   * Paper spot execution: fill at bid/ask + slippage; exit marks on bid (long) / ask (short).
   */
  private onTickSpot(input: SimulationTickInput): void {
    const { now, entry, executionBook, config, symbol } = input;

    if (this.position) {
      const mark = quotePriceForPositionDirection(this.position.direction, executionBook);
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
          ...paperQuoteFieldsForLog(direction, executionBook),
          fullQuoteBook: {
            bestBid: executionBook.bestBid,
            bestAsk: executionBook.bestAsk,
            spreadBps: executionBook.spreadBps,
          },
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
          executionBook,
          symbol,
          config,
          null,
          input.underlyingSignalPrice
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
      const fill = legacySpotEntryFillPrice(
        entry.direction,
        executionBook,
        config.binaryPaperSlippageBps
      );
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
        executionModel: "spot",
        direction: entry.direction,
        stake,
        shares,
        entryPrice: fill,
        entryBid: executionBook.bestBid,
        entryAsk: executionBook.bestAsk,
        entryPath: input.entryPath ?? "strong_spike_immediate",
        openedAt: now,
        baseStakePerTrade: baseStake,
        qualityStakeMultiplier: qualityMult,
        holdMarkMin: quotePriceForPositionDirection(entry.direction, executionBook),
        holdMarkMax: quotePriceForPositionDirection(entry.direction, executionBook),
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
            bestBid: executionBook.bestBid,
            bestAsk: executionBook.bestAsk,
            mid: executionBook.midPrice,
            spreadBps: executionBook.spreadBps,
          },
          ...paperQuoteFieldsForLog(entry.direction, executionBook),
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
        const leg = selectPositionQuote(entry.direction, executionBook);
        console.log(
          `[SIM] Open ${entry.direction} ${symbol} | fill@${leg.entrySide}=${fill.toFixed(2)} | sizing base=${baseStake.toFixed(2)} profile=${prof} mult=${qualityMult.toFixed(4)} → stake=${stake.toFixed(2)} qty=${shares.toFixed(6)} BTC`
        );
      }
    }
  }

  private onTickBinary(input: SimulationTickInput): void {
    this.lastBinaryEntryRejectionReason = null;
    const { now, entry, executionBook, config, symbol } = input;
    const bo = input.binaryOutcomes;
    if (
      bo === null ||
      bo === undefined ||
      !Number.isFinite(bo.yesPrice) ||
      !Number.isFinite(bo.noPrice)
    ) {
      return;
    }

    if (this.position) {
      const bp = this.position.binaryPaper;
      if (bp === undefined || this.position.sideBought === undefined) return;
      const quote = { yesMid: bo.yesPrice, noMid: bo.noPrice };
      const { holdMarkMin, holdMarkMax } = applyBinaryPaperVenueTick(
        bp,
        quote,
        this.position.holdMarkMin,
        this.position.holdMarkMax
      );
      this.position.holdMarkMin = holdMarkMin;
      this.position.holdMarkMax = holdMarkMax;
      const mark = bp.heldOutcomeMark;
      if (!Number.isFinite(mark)) return;
      const side = bp.sideBought;

      if (this.paperPositionMtmDiagnostics && this.position.paperOpenSeq !== undefined) {
        const { entryPrice, openedAt, paperOpenSeq, direction } = this.position;
        const exitDiag = computeBinaryExitDiagnostics({
          markPrice: mark,
          entryFillPrice: entryPrice,
          takeProfitPriceDelta: config.binaryTakeProfitPriceDelta,
          stopLossPriceDelta: config.binaryStopLossPriceDelta,
          openedAt: this.position.openedAt,
          timeoutMs: config.binaryExitTimeoutMs,
          now,
        });
        const unrealizedPnl = binaryPaperUnrealizedPnlUsdt(bp, quote);
        const tpTarget = entryPrice + config.binaryTakeProfitPriceDelta;
        const slThr = entryPrice - config.binaryStopLossPriceDelta;
        logPaperMtmLine({
          kind: "paper_mtm_tick",
          tradeId: paperOpenSeq,
          paperOpenSeq,
          openCorrelationId: openedAt,
          timestamp: new Date(now).toISOString(),
          direction,
          executionModel: "binary",
          sideBought: side,
          entryPrice,
          symbol,
          yesMid: bo.yesPrice,
          noMid: bo.noPrice,
          markPrice: mark,
          markPriceSource: markPriceSourceBinary(side),
          unrealizedPnl,
          binaryTakeProfitPriceDelta: config.binaryTakeProfitPriceDelta,
          binaryStopLossPriceDelta: config.binaryStopLossPriceDelta,
          binaryProfitTargetPrice: tpTarget,
          binaryStopLossThresholdPrice: slThr,
          binaryExitTimeoutMs: config.binaryExitTimeoutMs,
          holdDurationMs: exitDiag.elapsedMs,
          exitConditionStatus: {
            targetHit: exitDiag.targetHit,
            stopHit: exitDiag.stopHit,
            timeoutReached: exitDiag.timeoutReached,
          },
          markMinWhileOpen: this.position.holdMarkMin,
          markMaxWhileOpen: this.position.holdMarkMax,
          markRangeWhileOpen: this.position.holdMarkMax - this.position.holdMarkMin,
          markStaticSoFar:
            this.position.holdMarkMax - this.position.holdMarkMin < 1e-9,
        });
      }

      const exit = evaluateBinaryExitConditions({
        markPrice: mark,
        entryFillPrice: this.position.entryPrice,
        takeProfitPriceDelta: config.binaryTakeProfitPriceDelta,
        stopLossPriceDelta: config.binaryStopLossPriceDelta,
        openedAt: this.position.openedAt,
        timeoutMs: config.binaryExitTimeoutMs,
        now,
      });

      if (exit.shouldExit && exit.reason !== null) {
        this.closePosition(
          mark,
          now,
          exit.reason,
          executionBook,
          symbol,
          config,
          bo,
          input.underlyingSignalPrice
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
      if (
        binarySpreadExceedsHardMax(
          executionBook.spreadBps,
          config.binaryHardMaxSpreadBps
        )
      ) {
        this.lastBinaryEntryRejectionReason =
          BINARY_PRE_ENTRY_REJECT_SPREAD_TOO_WIDE_HARD;
        if (!this.silent) {
          console.log(
            `[SIM] Skip binary entry: ${BINARY_PRE_ENTRY_REJECT_SPREAD_TOO_WIDE_HARD} spreadBps=${Number.isFinite(executionBook.spreadBps) ? executionBook.spreadBps.toFixed(2) : "NaN"} max=${config.binaryHardMaxSpreadBps}`
          );
        }
        const asksSpread = resolveBinaryVenueAsks({
          executionBook,
          yesMid: bo.yesPrice,
          noMid: bo.noPrice,
        });
        logBinaryPreEntryAuditDebug(
          buildBinaryPreEntryAuditRecord({
            entry,
            venueYesMid: bo.yesPrice,
            venueNoMid: bo.noPrice,
            resolvedYesAsk: asksSpread.yesAsk,
            resolvedNoAsk: asksSpread.noAsk,
            estimatedProbabilityUp: input.estimatedProbabilityUp,
            entryModelEdge: Number.NaN,
            minEdgeThreshold: config.minEdgeThreshold,
            qualityProfile: input.entryQualityProfile,
            action: "reject",
            primaryRejectionReason: BINARY_PRE_ENTRY_REJECT_SPREAD_TOO_WIDE_HARD,
          })
        );
        return;
      }
      const asks = resolveBinaryVenueAsks({
        executionBook,
        yesMid: bo.yesPrice,
        noMid: bo.noPrice,
      });
      if (
        binaryYesMidFailsExtremeBand(
          bo.yesPrice,
          config.binaryYesMidExtremeFilterEnabled,
          config.binaryYesMidBandMin,
          config.binaryYesMidBandMax
        )
      ) {
        this.lastBinaryEntryRejectionReason =
          BINARY_PRE_ENTRY_REJECT_YES_MID_EXTREME;
        if (!this.silent) {
          console.log(
            `[SIM] Skip binary entry: ${BINARY_PRE_ENTRY_REJECT_YES_MID_EXTREME} yesMid=${bo.yesPrice.toFixed(
              4
            )} band=[${config.binaryYesMidBandMin},${config.binaryYesMidBandMax}]`
          );
        }
        logBinaryPreEntryAuditDebug(
          buildBinaryPreEntryAuditRecord({
            entry,
            venueYesMid: bo.yesPrice,
            venueNoMid: bo.noPrice,
            resolvedYesAsk: asks.yesAsk,
            resolvedNoAsk: asks.noAsk,
            estimatedProbabilityUp: input.estimatedProbabilityUp,
            entryModelEdge: Number.NaN,
            minEdgeThreshold: config.minEdgeThreshold,
            qualityProfile: input.entryQualityProfile,
            action: "reject",
            primaryRejectionReason: BINARY_PRE_ENTRY_REJECT_YES_MID_EXTREME,
          })
        );
        return;
      }
      const pUpSzEdge = input.estimatedProbabilityUp;
      // Edge uses mean-reversion fair P on the bought leg (see edgeEntryDecision).
      const entryModelEdge =
        pUpSzEdge !== undefined && Number.isFinite(pUpSzEdge)
          ? computeBinaryEntryEdge({
              estimatedProbabilityUp: pUpSzEdge,
              direction: entry.direction,
              yesAsk: asks.yesAsk,
              noAsk: asks.noAsk,
            })
          : Number.NaN;

      if (!Number.isFinite(entryModelEdge) || entryModelEdge <= 0) {
        this.lastBinaryEntryRejectionReason =
          BINARY_ENTRY_REJECTION_NEGATIVE_OR_ZERO_MODEL_EDGE;
        if (!this.silent) {
          const eStr = Number.isFinite(entryModelEdge)
            ? entryModelEdge.toFixed(6)
            : "NaN";
          console.log(
            `[SIM] Skip binary entry: ${BINARY_ENTRY_REJECTION_NEGATIVE_OR_ZERO_MODEL_EDGE} entryModelEdge=${eStr}`
          );
        }
        logBinaryPreEntryAuditDebug(
          buildBinaryPreEntryAuditRecord({
            entry,
            venueYesMid: bo.yesPrice,
            venueNoMid: bo.noPrice,
            resolvedYesAsk: asks.yesAsk,
            resolvedNoAsk: asks.noAsk,
            estimatedProbabilityUp: input.estimatedProbabilityUp,
            entryModelEdge,
            minEdgeThreshold: config.minEdgeThreshold,
            qualityProfile: input.entryQualityProfile,
            action: "reject",
            primaryRejectionReason:
              BINARY_ENTRY_REJECTION_NEGATIVE_OR_ZERO_MODEL_EDGE,
          })
        );
        return;
      }

      const sideBought = binarySideFromStrategyDirection(entry.direction);
      const minThr = effectiveBinaryMinMispricingThreshold(config, sideBought);
      if (minThr > 0) {
        const edgeResult = shouldEnterTrade({
          estimatedProbabilityUp: pUpSzEdge!,
          marketPriceYesAsk: asks.yesAsk,
          marketPriceNoAsk: asks.noAsk,
          minEdgeThreshold: minThr,
          side: binaryLegFromDirection(entry.direction),
        });
        if (!edgeResult.shouldEnter && !this.silent && !debugMonitor) {
          console.log(`[SIM] ${formatEdgeEntryLogLine(edgeResult)}`);
        }
        if (!edgeResult.shouldEnter) {
          this.lastBinaryEntryRejectionReason =
            BINARY_ENTRY_REJECTION_MODEL_EDGE_BELOW_MIN_THRESHOLD;
          if (!this.silent) {
            console.log(
              `[SIM] Skip binary entry: ${BINARY_ENTRY_REJECTION_MODEL_EDGE_BELOW_MIN_THRESHOLD} minEdgeThreshold=${minThr.toFixed(4)}`
            );
          }
          logBinaryPreEntryAuditDebug(
            buildBinaryPreEntryAuditRecord({
              entry,
              venueYesMid: bo.yesPrice,
              venueNoMid: bo.noPrice,
              resolvedYesAsk: asks.yesAsk,
              resolvedNoAsk: asks.noAsk,
              estimatedProbabilityUp: input.estimatedProbabilityUp,
              entryModelEdge,
              minEdgeThreshold: minThr,
              qualityProfile: input.entryQualityProfile,
              action: "reject",
              primaryRejectionReason:
                BINARY_ENTRY_REJECTION_MODEL_EDGE_BELOW_MIN_THRESHOLD,
            })
          );
          return;
        }
      }

      const fill = binaryOutcomeBuyFillPrice(
        sideBought,
        bo.yesPrice,
        bo.noPrice,
        config.binaryPaperSlippageBps
      );
      if (!Number.isFinite(fill) || fill <= 0) {
        logBinaryPreEntryAuditDebug(
          buildBinaryPreEntryAuditRecord({
            entry,
            venueYesMid: bo.yesPrice,
            venueNoMid: bo.noPrice,
            resolvedYesAsk: asks.yesAsk,
            resolvedNoAsk: asks.noAsk,
            estimatedProbabilityUp: input.estimatedProbabilityUp,
            entryModelEdge,
            minEdgeThreshold: minThr,
            qualityProfile: input.entryQualityProfile,
            action: "reject",
            primaryRejectionReason: BINARY_PRE_ENTRY_REJECT_INVALID_OUTCOME_FILL,
          })
        );
        return;
      }

      const maxEntryPx = effectiveBinaryMaxEntryPriceForSide(config, sideBought);
      if (maxEntryPx > 0 && fill > maxEntryPx) {
        if (!this.silent) {
          console.log(
            `[SIM] Skip binary entry: fill ${fill.toFixed(4)} > max entry price (${sideBought}) ${maxEntryPx}`
          );
        }
        logBinaryPreEntryAuditDebug(
          buildBinaryPreEntryAuditRecord({
            entry,
            venueYesMid: bo.yesPrice,
            venueNoMid: bo.noPrice,
            resolvedYesAsk: asks.yesAsk,
            resolvedNoAsk: asks.noAsk,
            estimatedProbabilityUp: input.estimatedProbabilityUp,
            entryModelEdge,
            minEdgeThreshold: minThr,
            qualityProfile: input.entryQualityProfile,
            action: "reject",
            primaryRejectionReason: BINARY_PRE_ENTRY_REJECT_MAX_ENTRY_PRICE,
          })
        );
        return;
      }

      const edgeForSize = entryModelEdge;
      const stakeCap =
        config.maxTradeSize > 0
          ? config.maxTradeSize
          : Math.max(config.stakePerTrade, config.minTradeSize, 1);
      const baseStake = getPositionSize({
        accountBalance: this.equity,
        edge: edgeForSize,
        riskPercentPerTrade: config.riskPercentPerTrade,
        maxTradeSize: stakeCap,
        minTradeSize: config.minTradeSize,
      });
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
        logBinaryPreEntryAuditDebug(
          buildBinaryPreEntryAuditRecord({
            entry,
            venueYesMid: bo.yesPrice,
            venueNoMid: bo.noPrice,
            resolvedYesAsk: asks.yesAsk,
            resolvedNoAsk: asks.noAsk,
            estimatedProbabilityUp: input.estimatedProbabilityUp,
            entryModelEdge,
            minEdgeThreshold: minThr,
            qualityProfile: input.entryQualityProfile,
            action: "reject",
            primaryRejectionReason: BINARY_PRE_ENTRY_REJECT_STAKE_ZERO,
          })
        );
        return;
      }

      const binaryPaper = openBinaryPaperPosition({
        direction: entry.direction,
        quote: { yesMid: bo.yesPrice, noMid: bo.noPrice },
        slippageBps: config.binaryPaperSlippageBps,
        stakeUsdt: stake,
      });
      const shares = binaryPaper.contracts;
      const paperOpenSeq = this.paperPositionMtmDiagnostics
        ? ++this.paperOpenSeqCounter
        : undefined;

      this.position = {
        executionModel: "binary",
        direction: entry.direction,
        sideBought: binaryPaper.sideBought,
        binaryPaper,
        yesPriceAtEntry: binaryPaper.yesMidAtEntry,
        noPriceAtEntry: binaryPaper.noMidAtEntry,
        ...(input.underlyingSignalPrice !== undefined &&
        Number.isFinite(input.underlyingSignalPrice) &&
        input.underlyingSignalPrice > 0
          ? { underlyingSignalAtEntry: input.underlyingSignalPrice }
          : {}),
        stake: binaryPaper.stakeUsdt,
        shares,
        entryPrice: binaryPaper.entryOutcomePrice,
        entryPath: input.entryPath ?? "strong_spike_immediate",
        openedAt: now,
        baseStakePerTrade: baseStake,
        qualityStakeMultiplier: qualityMult,
        holdMarkMin: binaryPaper.heldOutcomeMark,
        holdMarkMax: binaryPaper.heldOutcomeMark,
        ...(this.paperPositionMtmDiagnostics && paperOpenSeq !== undefined
          ? { paperOpenSeq }
          : {}),
        ...(input.entryQualityProfile !== undefined
          ? { entryQualityProfile: input.entryQualityProfile }
          : {}),
        ...(Number.isFinite(entryModelEdge) ? { entryModelEdge } : {}),
        ...(input.estimatedProbabilityUp !== undefined &&
        Number.isFinite(input.estimatedProbabilityUp)
          ? { estimatedProbabilityUpAtEntry: input.estimatedProbabilityUp }
          : {}),
        ...(input.entryOpenReason !== undefined
          ? { entryOpenReason: input.entryOpenReason }
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
          executionModel: "binary",
          sideBought,
          symbol,
          fillPrice: fill,
          binaryOutcomes: bo,
          markPriceSource: markPriceSourceBinary(sideBought),
          sideRationale: buildEntrySideRationale(entry, entry.direction),
          entryEvalSnapshot: {
            spikeDetected: entry.spikeDetected,
            movementClassification: entry.movementClassification,
            strongestMoveDirection:
              entry.windowSpike?.strongestMoveDirection ?? null,
            shouldEnter: entry.shouldEnter,
          },
          binaryTakeProfitPriceDelta: config.binaryTakeProfitPriceDelta,
          binaryStopLossPriceDelta: config.binaryStopLossPriceDelta,
          binaryProfitTargetPrice: fill + config.binaryTakeProfitPriceDelta,
          binaryStopLossThresholdPrice: fill - config.binaryStopLossPriceDelta,
          binaryExitTimeoutMs: config.binaryExitTimeoutMs,
          binaryMaxEntryPrice: maxEntryPx,
        });
      }

      logBinaryPreEntryAuditDebug(
        buildBinaryPreEntryAuditRecord({
          entry,
          venueYesMid: bo.yesPrice,
          venueNoMid: bo.noPrice,
          resolvedYesAsk: asks.yesAsk,
          resolvedNoAsk: asks.noAsk,
          estimatedProbabilityUp: input.estimatedProbabilityUp,
          entryModelEdge,
          minEdgeThreshold: minThr,
          qualityProfile: input.entryQualityProfile,
          action: "enter",
          primaryRejectionReason: null,
        })
      );

      if (!this.silent) {
        const prof = input.entryQualityProfile ?? "—";
        console.log(
          `[SIM] Open binary ${entry.direction} → buy ${sideBought} ${symbol} | fill=${fill.toFixed(4)} | base stake=${baseStake.toFixed(2)} profile=${prof} mult=${qualityMult.toFixed(4)} → stake=${stake.toFixed(2)} contracts=${shares.toFixed(4)} | TP+Δ=${(fill + config.binaryTakeProfitPriceDelta).toFixed(4)} SL−Δ=${(fill - config.binaryStopLossPriceDelta).toFixed(4)}`
        );
      }
    }
  }

  private closePosition(
    exitMark: number,
    closedAt: number,
    exitReason: ExitReason,
    executionBookAtExit: ExecutableBookQuote,
    symbol: string,
    cfg: SimulationTickInput["config"],
    binaryOutcomesAtExit: BinaryOutcomePrices | null,
    underlyingSignalAtExit?: number
  ): void {
    if (!this.position) return;

    const {
      executionModel,
      direction,
      sideBought,
      yesPriceAtEntry,
      noPriceAtEntry,
      underlyingSignalAtEntry,
      stake,
      shares,
      entryPrice,
      entryPath,
      openedAt,
      baseStakePerTrade,
      qualityStakeMultiplier,
      entryQualityProfile,
      entryModelEdge,
      estimatedProbabilityUpAtEntry,
      paperOpenSeq,
      holdMarkMin,
      holdMarkMax,
      entryBid,
      entryAsk,
      entryOpenReason,
    } = this.position;
    this.position = null;

    const isBinary = executionModel === "binary";

    const equityBefore = this.equity;
    const grossPnl = isBinary
      ? binaryPaperGrossPnlUsdt(shares, entryPrice, exitMark)
      : direction === "UP"
        ? shares * (exitMark - entryPrice)
        : shares * (entryPrice - exitMark);
    const feesEstimate = isBinary
      ? binaryPaperRoundTripFeeUsdt(stake, cfg.paperFeeRoundTripBps)
      : stake * (cfg.paperFeeRoundTripBps / 10_000);
    const profitLoss = grossPnl - feesEstimate;
    const equityAfter = equityBefore + profitLoss;
    const riskAtEntry = stake;

    this.equity = equityAfter;

    const tpPx = isBinary
      ? entryPrice + cfg.binaryTakeProfitPriceDelta
      : direction === "UP"
        ? entryPrice * (1 + cfg.takeProfitBps / 10_000)
        : entryPrice * (1 - cfg.takeProfitBps / 10_000);
    const slPx = isBinary
      ? entryPrice - cfg.binaryStopLossPriceDelta
      : direction === "UP"
        ? entryPrice * (1 - cfg.stopLossBps / 10_000)
        : entryPrice * (1 + cfg.stopLossBps / 10_000);

    const holdExitAudit = isBinary
      ? buildHoldExitAudit({
          mode: "binary",
          entryPrice,
          exitMark,
          holdMarkMin,
          holdMarkMax,
          takeProfitPriceDelta: cfg.binaryTakeProfitPriceDelta,
          stopLossPriceDelta: cfg.binaryStopLossPriceDelta,
          exitReason,
        })
      : buildHoldExitAudit({
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
      ...(!isBinary && entryBid !== undefined && entryAsk !== undefined
        ? { entryBid, entryAsk }
        : {}),
      ...(isBinary
        ? {
            executionModel: "binary" as const,
            ...(sideBought !== undefined ? { sideBought } : {}),
            entrySidePrice: entryPrice,
            exitSidePrice: exitMark,
            ...(yesPriceAtEntry !== undefined ? { yesPriceAtEntry } : {}),
            ...(noPriceAtEntry !== undefined ? { noPriceAtEntry } : {}),
            ...(underlyingSignalAtEntry !== undefined &&
            Number.isFinite(underlyingSignalAtEntry)
              ? { underlyingSignalPriceAtEntry: underlyingSignalAtEntry }
              : {}),
            ...(underlyingSignalAtExit !== undefined &&
            Number.isFinite(underlyingSignalAtExit)
              ? { underlyingSignalPriceAtExit: underlyingSignalAtExit }
              : {}),
            ...(binaryOutcomesAtExit !== null
              ? {
                  yesPriceAtExit: binaryOutcomesAtExit.yesPrice,
                  noPriceAtExit: binaryOutcomesAtExit.noPrice,
                }
              : {}),
          }
        : {}),
      ...(!isBinary
        ? {
            exitBid: executionBookAtExit.bestBid,
            exitAsk: executionBookAtExit.bestAsk,
          }
        : {}),
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
      ...(isBinary &&
      entryModelEdge !== undefined &&
      Number.isFinite(entryModelEdge)
        ? { entryModelEdge }
        : {}),
      ...(isBinary &&
      estimatedProbabilityUpAtEntry !== undefined &&
      Number.isFinite(estimatedProbabilityUpAtEntry)
        ? {
            estimatedProbabilityUpAtEntry,
            probabilityTimeHorizonMs:
              cfg.probabilityTimeHorizonMs ?? 30_000,
          }
        : {}),
      exitReason,
      entryPath,
      openedAt,
      closedAt,
      holdExitAudit,
      ...(isBinary && entryOpenReason !== undefined ? { entryOpenReason } : {}),
    };
    this.trades.push(record);
    this.lastExitAt = closedAt;

    if (paperOpenSeq !== undefined) {
      const minObs = holdMarkMin;
      const maxObs = holdMarkMax;
      const rangeObs = maxObs - minObs;
      const finalDiag = isBinary
        ? computeBinaryExitDiagnostics({
            markPrice: exitMark,
            entryFillPrice: entryPrice,
            takeProfitPriceDelta: cfg.binaryTakeProfitPriceDelta,
            stopLossPriceDelta: cfg.binaryStopLossPriceDelta,
            openedAt,
            timeoutMs: cfg.binaryExitTimeoutMs,
            now: closedAt,
          })
        : computeSpotExitDiagnostics({
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
        ...(isBinary
          ? {
              executionModel: "binary",
              sideBought,
              binaryOutcomesAtExit: binaryOutcomesAtExit ?? undefined,
            }
          : {
              quoteSnapshot: executionBookAtExit,
              ...paperQuoteFieldsForLog(direction, executionBookAtExit),
            }),
        exitRuleFired: exitReason,
        finalMarkPrice: exitMark,
        markPriceSource: isBinary
          ? sideBought !== undefined
            ? markPriceSourceBinary(sideBought)
            : "binary"
          : markPriceSourceLabel(direction),
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
          ? isBinary
            ? "Held outcome price flat while open — check quote feed."
            : "Mark flat while open — check Binance book feed freshness."
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
    const payload =
      t.executionModel === "binary"
        ? {
            ...buildBinaryPaperTradeLog(t),
            openedAt: new Date(t.openedAt).toISOString(),
            closedAt: new Date(t.closedAt).toISOString(),
            holdExitAudit: t.holdExitAudit,
          }
        : buildTransparentTradeLog(t);
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

function markPriceSourceBinary(side: BinarySideBought): string {
  return side === "YES" ? "yesPrice (held YES MTM)" : "noPrice (held NO MTM)";
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
