import type { Instrument } from "../domain/instrument.js";
import type { InstrumentId } from "../domain/instrument.js";
import type { PositionSide } from "../domain/sides.js";
import type { TopOfBookL1 } from "../domain/book.js";
import type { Position } from "../domain/position.js";
import type {
  FuturesPaperExitDecision,
  FuturesPaperExitPendingReason,
  FuturesPaperExitTrigger,
  FuturesPaperCloseReason,
  FuturesPaperEngineConfig,
  FuturesPaperMarginDecision,
  FuturesPaperMarginSnapshot,
  FuturesPaperOpenResult,
  FuturesPaperRoundtrip,
} from "./futuresPaperTypes.js";

type InternalPosition = {
  instrumentId: InstrumentId;
  side: PositionSide;
  quantity: number;
  avgEntryPrice: number;
  openedAtMs: number;
  feesOpenQuote: number;
};

type InternalExitState = {
  trigger: FuturesPaperExitTrigger;
  firstTriggeredAtMs: number;
  lastAttemptAtMs: number;
  pendingReason: FuturesPaperExitPendingReason;
};

type ContractMeta = Pick<
  Instrument,
  "tickSize" | "lotSize" | "contractMultiplier" | "minQuantity"
>;

function slipFrac(slippageBps: number): number {
  return Math.max(0, slippageBps) / 10_000;
}

function feeHalfPerLeg(totalRoundTripBps: number): number {
  return Math.max(0, totalRoundTripBps) / 2 / 10_000;
}

function penaltyFrac(penaltyBps: number): number {
  return Math.max(0, penaltyBps) / 10_000;
}

function getMultiplier(contract?: ContractMeta | null): number {
  const m = contract?.contractMultiplier ?? 1;
  return Number.isFinite(m) && m > 0 ? m : 1;
}

function getInitialMarginRate(cfg: FuturesPaperEngineConfig): number {
  const explicit = cfg.initialMarginRate;
  if (Number.isFinite(explicit) && (explicit ?? 0) > 0) {
    return Math.min(explicit!, 0.99);
  }
  const leverage = cfg.leverage;
  if (Number.isFinite(leverage) && (leverage ?? 0) > 0) {
    return Math.min(1 / leverage!, 0.99);
  }
  return 0.05;
}

function getMaintenanceMarginRate(
  cfg: FuturesPaperEngineConfig,
  initialRate: number
): number {
  const explicit = cfg.maintenanceMarginRate;
  if (Number.isFinite(explicit) && (explicit ?? 0) > 0) {
    return Math.min(explicit!, Math.max(0.001, initialRate * 0.99));
  }
  return Math.max(0.001, initialRate * 0.75);
}

function getWarningRatio(cfg: FuturesPaperEngineConfig): number {
  const explicit = cfg.marginWarningRatio;
  return Number.isFinite(explicit) && (explicit ?? 0) > 1 ? explicit! : 1.25;
}

function getRiskRatio(cfg: FuturesPaperEngineConfig): number {
  const explicit = cfg.liquidationRiskRatio;
  return Number.isFinite(explicit) && (explicit ?? 0) > 1 ? explicit! : 1.05;
}

function getLiquidationPenaltyBps(cfg: FuturesPaperEngineConfig): number {
  const explicit = cfg.liquidationPenaltyBps;
  return Number.isFinite(explicit) && (explicit ?? 0) > 0 ? explicit! : 50;
}

function isProfitLockEnabled(cfg: FuturesPaperEngineConfig): boolean {
  return cfg.profitLockEnabled === true;
}

function getProfitLockThresholdQuote(cfg: FuturesPaperEngineConfig): number {
  const explicit = cfg.profitLockThresholdQuote;
  return Number.isFinite(explicit) && (explicit ?? 0) >= 0
    ? explicit!
    : 1;
}

function isTrailingProfitEnabled(cfg: FuturesPaperEngineConfig): boolean {
  return cfg.trailingProfitEnabled === true;
}

function getTrailingProfitDropQuote(cfg: FuturesPaperEngineConfig): number {
  const explicit = cfg.trailingProfitDropQuote;
  return Number.isFinite(explicit) && (explicit ?? 0) >= 0 ? explicit! : 0;
}

function getLotSize(contract?: ContractMeta | null): number {
  const lot = contract?.lotSize ?? 0;
  return Number.isFinite(lot) && lot > 0 ? lot : 0;
}

function getMinQuantity(contract?: ContractMeta | null): number {
  const lot = getLotSize(contract);
  const min = contract?.minQuantity ?? lot;
  if (!Number.isFinite(min) || min <= 0) return lot;
  return lot > 0 ? Math.max(min, lot) : min;
}

function floorToIncrement(value: number, step: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(step) || step <= 0) return NaN;
  return Math.floor(value / step + 1e-12) * step;
}

function alignPriceToTick(
  price: number,
  tickSize: number,
  side: "up" | "down"
): number {
  if (!Number.isFinite(price) || !Number.isFinite(tickSize) || tickSize <= 0) {
    return NaN;
  }
  const ratio = price / tickSize;
  const ticks = side === "up"
    ? Math.ceil(ratio - 1e-12)
    : Math.floor(ratio + 1e-12);
  return ticks * tickSize;
}

function isValidQuantity(quantity: number, contract?: ContractMeta | null): boolean {
  if (!(quantity > 0) || !Number.isFinite(quantity)) return false;
  const lot = getLotSize(contract);
  if (!(lot > 0)) return true;
  const min = getMinQuantity(contract);
  const rounded = floorToIncrement(quantity, lot);
  const aligned = Math.abs(quantity - rounded) <= Math.max(1e-12, lot * 1e-9);
  return aligned && rounded > 0 && rounded >= min;
}

function isExecutableBook(book: TopOfBookL1 | null): book is TopOfBookL1 {
  if (!book) return false;
  return (
    Number.isFinite(book.bestBid) &&
    Number.isFinite(book.bestAsk) &&
    Number.isFinite(book.midPrice) &&
    Number.isFinite(book.spreadBps) &&
    book.bestBid > 0 &&
    book.bestAsk >= book.bestBid &&
    book.midPrice > 0
  );
}

function buildMarginSnapshot(input: {
  markPrice: number;
  position: InternalPosition;
  initialMarginRate: number;
  maintenanceMarginRate: number;
  contract?: ContractMeta | null;
}): FuturesPaperMarginSnapshot {
  const multiplier = getMultiplier(input.contract);
  const q = input.position.quantity;
  const entry = input.position.avgEntryPrice;
  const mark = input.markPrice;
  const positionNotionalQuote = mark * q * multiplier;
  const initialMarginQuote = entry * q * multiplier * input.initialMarginRate;
  const maintenanceMarginQuote =
    positionNotionalQuote * input.maintenanceMarginRate;
  const unrealizedPnlQuote =
    input.position.side === "long"
      ? (mark - entry) * q * multiplier
      : (entry - mark) * q * multiplier;
  const marginBalanceQuote =
    initialMarginQuote - input.position.feesOpenQuote + unrealizedPnlQuote;
  const marginRatio =
    maintenanceMarginQuote > 0
      ? marginBalanceQuote / maintenanceMarginQuote
      : Number.POSITIVE_INFINITY;
  const liquidationPriceEstimate =
    input.position.side === "long"
      ? (q * multiplier * entry +
          input.position.feesOpenQuote -
          initialMarginQuote) /
        (q * multiplier * (1 - input.maintenanceMarginRate))
      : (initialMarginQuote +
          q * multiplier * entry -
          input.position.feesOpenQuote) /
        (q * multiplier * (1 + input.maintenanceMarginRate));

  return {
    markPrice: mark,
    entryPrice: entry,
    side: input.position.side,
    quantity: q,
    contractMultiplier: multiplier,
    positionNotionalQuote,
    initialMarginQuote,
    maintenanceMarginQuote,
    marginBalanceQuote,
    unrealizedPnlQuote,
    marginRatio,
    liquidationPriceEstimate,
  };
}

function estimateNetPnlAtExecutableExit(input: {
  position: InternalPosition;
  book: TopOfBookL1;
  contract?: ContractMeta | null;
  slippageBps: number;
  feeRoundTripBps: number;
}): { exitFillPrice: number; estimatedNetPnlAtExitQuote: number } | null {
  const p = input.position;
  const bid = input.book.bestBid;
  const ask = input.book.bestAsk;
  if (!Number.isFinite(bid) || !Number.isFinite(ask) || ask < bid) {
    return null;
  }

  const slip = slipFrac(input.slippageBps);
  const q = p.quantity;
  const entry = p.avgEntryPrice;
  const feeLeg = feeHalfPerLeg(input.feeRoundTripBps);
  const tick = input.contract?.tickSize ?? 0;
  const multiplier = getMultiplier(input.contract);

  const rawFill =
    p.side === "long"
      ? bid * (1 - slip)
      : ask * (1 + slip);
  const exitFill =
    tick > 0
      ? alignPriceToTick(rawFill, tick, p.side === "long" ? "down" : "up")
      : rawFill;

  const gross =
    p.side === "long"
      ? (exitFill - entry) * q * multiplier
      : (entry - exitFill) * q * multiplier;
  const notionalEntry = entry * q * multiplier;
  const notionalExit = exitFill * q * multiplier;
  const feesTotal = notionalEntry * feeLeg + notionalExit * feeLeg;
  return {
    exitFillPrice: exitFill,
    estimatedNetPnlAtExitQuote: gross - feesTotal,
  };
}

export class FuturesPaperEngine {
  private cfg: FuturesPaperEngineConfig;
  private pos: InternalPosition | null = null;
  private exitState: InternalExitState | null = null;
  private cumulativeRealizedPnlQuote = 0;
  private peakExecutableNetPnlQuote: number | null = null;

  constructor(config: FuturesPaperEngineConfig) {
    this.cfg = { ...config };
  }

  getConfig(): FuturesPaperEngineConfig {
    return { ...this.cfg };
  }

  setConfig(patch: Partial<FuturesPaperEngineConfig>): void {
    this.cfg = { ...this.cfg, ...patch };
  }

  /** Sum of {@link FuturesPaperRoundtrip.netPnlQuote} for all closed trades in this engine lifetime. */
  getCumulativeRealizedPnlQuote(): number {
    return this.cumulativeRealizedPnlQuote;
  }

  getOpenPosition(): Position | null {
    const p = this.pos;
    if (!p) return null;
    return {
      instrumentId: p.instrumentId,
      side: p.side,
      quantity: p.quantity,
      avgEntryPrice: p.avgEntryPrice,
      openedAtMs: p.openedAtMs,
    };
  }

  /** True if no position is open. */
  isFlat(): boolean {
    return this.pos === null;
  }

  /**
   * Market buy to open long. Fill at ask worsened by slippage.
   */
  openLong(input: {
    instrumentId: InstrumentId;
    quantity: number;
    book: TopOfBookL1;
    nowMs: number;
    contract?: ContractMeta;
  }): FuturesPaperOpenResult {
    if (this.pos !== null) {
      return { ok: false, reason: "position_already_open" };
    }
    const q = input.quantity;
    if (!isValidQuantity(q, input.contract)) {
      return { ok: false, reason: "invalid_quantity" };
    }
    const ask = input.book.bestAsk;
    const bid = input.book.bestBid;
    if (
      !Number.isFinite(ask) ||
      !Number.isFinite(bid) ||
      ask < bid ||
      ask <= 0
    ) {
      return { ok: false, reason: "invalid_book" };
    }
    const slip = slipFrac(this.cfg.slippageBps);
    const rawFill = ask * (1 + slip);
    const tick = input.contract?.tickSize ?? 0;
    const fill = tick > 0 ? alignPriceToTick(rawFill, tick, "up") : rawFill;
    const multiplier = getMultiplier(input.contract);
    const notional = fill * q * multiplier;
    const feeLeg = feeHalfPerLeg(this.cfg.feeRoundTripBps);
    const feesOpen = notional * feeLeg;

    this.pos = {
      instrumentId: input.instrumentId,
      side: "long",
      quantity: q,
      avgEntryPrice: fill,
      openedAtMs: input.nowMs,
      feesOpenQuote: feesOpen,
    };
    this.peakExecutableNetPnlQuote = null;

    return { ok: true, avgEntryPrice: fill, feesOpenQuote: feesOpen };
  }

  /**
   * Market sell to open short. Fill at bid worsened by slippage (receive less).
   */
  openShort(input: {
    instrumentId: InstrumentId;
    quantity: number;
    book: TopOfBookL1;
    nowMs: number;
    contract?: ContractMeta;
  }): FuturesPaperOpenResult {
    if (this.pos !== null) {
      return { ok: false, reason: "position_already_open" };
    }
    const q = input.quantity;
    if (!isValidQuantity(q, input.contract)) {
      return { ok: false, reason: "invalid_quantity" };
    }
    const bid = input.book.bestBid;
    const ask = input.book.bestAsk;
    if (
      !Number.isFinite(bid) ||
      !Number.isFinite(ask) ||
      ask < bid ||
      bid <= 0
    ) {
      return { ok: false, reason: "invalid_book" };
    }
    const slip = slipFrac(this.cfg.slippageBps);
    const rawFill = bid * (1 - slip);
    const tick = input.contract?.tickSize ?? 0;
    const fill = tick > 0 ? alignPriceToTick(rawFill, tick, "down") : rawFill;
    const multiplier = getMultiplier(input.contract);
    const notional = fill * q * multiplier;
    const feeLeg = feeHalfPerLeg(this.cfg.feeRoundTripBps);
    const feesOpen = notional * feeLeg;

    this.pos = {
      instrumentId: input.instrumentId,
      side: "short",
      quantity: q,
      avgEntryPrice: fill,
      openedAtMs: input.nowMs,
      feesOpenQuote: feesOpen,
    };
    this.peakExecutableNetPnlQuote = null;

    return { ok: true, avgEntryPrice: fill, feesOpenQuote: feesOpen };
  }

  /**
   * Flatten at current book (e.g. operator exit). Long → sell bid; Short → buy ask.
   */
  closeManual(book: TopOfBookL1, nowMs: number): FuturesPaperRoundtrip | null {
    this.exitState = null;
    return this.closeAtBook(book, nowMs, "manual", false, undefined);
  }

  /**
   * Evaluate TP / SL / timeout using **mid** triggers, execute exits at book with slippage.
   */
  evaluateExit(
    book: TopOfBookL1 | null,
    nowMs: number,
    contract?: ContractMeta
  ): FuturesPaperExitDecision | null {
    const p = this.pos;
    if (!p) return null;

    const profitProtectionCandidate =
      this.detectProfitProtectionTrigger(book, contract);
    const trigger =
      this.detectExitTrigger(book?.midPrice ?? null, nowMs) ??
      profitProtectionCandidate?.trigger ??
      null;
    const activeTrigger = this.exitState?.trigger ?? trigger;
    if (!activeTrigger) {
      return null;
    }

    const gracePeriodMs = Math.max(0, this.cfg.exitGracePeriodMs);
    const firstTriggeredAtMs = this.exitState?.firstTriggeredAtMs ?? nowMs;
    const graceDeadlineAtMs = firstTriggeredAtMs + gracePeriodMs;
    const attemptAtMs = nowMs;

    if (isExecutableBook(book)) {
      const closed =
        (activeTrigger === "profit_lock" || activeTrigger === "trailing_profit") &&
        profitProtectionCandidate
          ? this.closeAtBook(book, nowMs, activeTrigger, false, contract)
          : this.closeAtBook(book, nowMs, activeTrigger, false, contract);
      this.exitState = null;
      if (!closed) {
        throw new Error("Invariant: executable book must close position");
      }
      const profitProtectionDetails =
        activeTrigger === "trailing_profit" &&
        profitProtectionCandidate &&
        profitProtectionCandidate.trigger === "trailing_profit"
          ? {
              peakEstimatedNetPnlAtExitQuote:
                profitProtectionCandidate.peakEstimatedNetPnlAtExitQuote,
              dropFromPeakQuote: profitProtectionCandidate.dropFromPeakQuote,
              dropThresholdQuote:
                profitProtectionCandidate.dropThresholdQuote,
              thresholdQuote: profitProtectionCandidate.thresholdQuote,
            }
          : activeTrigger === "profit_lock" &&
              profitProtectionCandidate &&
              profitProtectionCandidate.trigger === "profit_lock"
            ? { thresholdQuote: getProfitLockThresholdQuote(this.cfg) }
            : {};
      return {
        kind: "closed",
        trigger: activeTrigger,
        forced: false,
        estimatedNetPnlAtExitQuote:
          activeTrigger === "profit_lock" ||
          activeTrigger === "trailing_profit"
            ? profitProtectionCandidate?.estimatedNetPnlAtExitQuote ?? closed.netPnlQuote
            : closed.netPnlQuote,
        ...profitProtectionDetails,
        roundtrip: closed,
      };
    }

    const pendingReason: FuturesPaperExitPendingReason =
      book === null
        ? this.exitState
          ? "retry_failed"
          : "trigger_reached_book_missing"
        : this.exitState
          ? "retry_failed"
          : "trigger_reached_book_invalid";

    if (gracePeriodMs > 0 && attemptAtMs < graceDeadlineAtMs) {
      this.exitState = {
        trigger: activeTrigger,
        firstTriggeredAtMs,
        lastAttemptAtMs: attemptAtMs,
        pendingReason,
      };
      return {
        kind: "pending",
        trigger: activeTrigger,
        pendingReason,
        firstTriggeredAtMs,
        lastAttemptAtMs: attemptAtMs,
        graceDeadlineAtMs,
      };
    }

    const forced = this.forceCloseWithoutBook(nowMs, activeTrigger, contract);
    this.exitState = null;
    return {
      kind: "closed",
      trigger: activeTrigger,
      forced: true,
      estimatedNetPnlAtExitQuote: forced.netPnlQuote,
      roundtrip: forced,
    };
  }

  onBook(
    book: TopOfBookL1 | null,
    nowMs: number,
    contract?: ContractMeta
  ): FuturesPaperRoundtrip | null {
    const decision = this.evaluateExit(book, nowMs, contract);
    if (!decision || decision.kind !== "closed") return null;
    return decision.roundtrip;
  }

  evaluateMargin(input: {
    markPrice: number | null;
    nowMs: number;
    book?: TopOfBookL1 | null;
    contract?: ContractMeta;
  }): FuturesPaperMarginDecision | null {
    const p = this.pos;
    if (!p) return null;

    const markPrice = input.markPrice;
    if (!(markPrice !== null && Number.isFinite(markPrice) && markPrice > 0)) {
      return null;
    }

    const mark = markPrice as number;
    const initialMarginRate = getInitialMarginRate(this.cfg);
    const maintenanceMarginRate = getMaintenanceMarginRate(
      this.cfg,
      initialMarginRate
    );
    const warningRatio = getWarningRatio(this.cfg);
    const riskRatio = getRiskRatio(this.cfg);
    const snapshot = buildMarginSnapshot({
      markPrice: mark,
      position: p,
      initialMarginRate,
      maintenanceMarginRate,
      contract: input.contract ?? null,
    });

    const liquidationTriggered =
      snapshot.marginRatio <= 1 ||
      (p.side === "long"
        ? mark <= snapshot.liquidationPriceEstimate
        : mark >= snapshot.liquidationPriceEstimate);

    if (liquidationTriggered) {
      const liquidationPenaltyBps = getLiquidationPenaltyBps(this.cfg);
      const roundtrip = isExecutableBook(input.book ?? null)
        ? this.closeAtBook(
            input.book!,
            input.nowMs,
            "paper_liquidation",
            true,
            input.contract,
            this.cfg.slippageBps + liquidationPenaltyBps
          )
        : this.closeLiquidationWithoutBook(
            mark,
            input.nowMs,
            input.contract,
            liquidationPenaltyBps
          );
      this.exitState = null;
      if (!roundtrip) return null;
      return {
        kind: "liquidated",
        snapshot,
        liquidationReason: "maintenance_breach",
        roundtrip,
      };
    }

    if (snapshot.marginRatio <= riskRatio) {
      return {
        kind: "liquidation_risk",
        snapshot,
        riskRatio,
      };
    }

    if (snapshot.marginRatio <= warningRatio) {
      return {
        kind: "margin_warning",
        snapshot,
        warningRatio,
      };
    }

    return {
      kind: "ok",
      snapshot,
    };
  }

  private closeAtBook(
    book: TopOfBookL1,
    nowMs: number,
    reason: FuturesPaperCloseReason,
    forced: boolean,
    contract?: ContractMeta,
    slippageBpsOverride?: number
  ): FuturesPaperRoundtrip | null {
    const p = this.pos;
    if (!p) return null;

    const bid = book.bestBid;
    const ask = book.bestAsk;
    if (!Number.isFinite(bid) || !Number.isFinite(ask) || ask < bid) {
      return null;
    }

    const slip = slipFrac(slippageBpsOverride ?? this.cfg.slippageBps);
    const q = p.quantity;
    const entry = p.avgEntryPrice;
    const feeLeg = feeHalfPerLeg(this.cfg.feeRoundTripBps);
    const tick = contract?.tickSize ?? 0;
    const multiplier = getMultiplier(contract);

    let exitFill: number;
    let gross: number;

    if (p.side === "long") {
      const rawFill = bid * (1 - slip);
      exitFill = tick > 0 ? alignPriceToTick(rawFill, tick, "down") : rawFill;
      gross = (exitFill - entry) * q * multiplier;
    } else {
      const rawFill = ask * (1 + slip);
      exitFill = tick > 0 ? alignPriceToTick(rawFill, tick, "up") : rawFill;
      gross = (entry - exitFill) * q * multiplier;
    }

    const notionalEntry = entry * q * multiplier;
    const notionalExit = exitFill * q * multiplier;
    const feesOpen = notionalEntry * feeLeg;
    const feesClose = notionalExit * feeLeg;
    const feesTotal = feesOpen + feesClose;
    const net = gross - feesTotal;

    this.cumulativeRealizedPnlQuote += net;
    const roundtrip: FuturesPaperRoundtrip = {
      instrumentId: p.instrumentId,
      side: p.side,
      quantity: q,
      entryPrice: entry,
      exitPrice: exitFill,
      grossPnlQuote: gross,
      feesQuote: feesTotal,
      netPnlQuote: net,
      openedAtMs: p.openedAtMs,
      closedAtMs: nowMs,
      closeReason:
        reason === "paper_liquidation"
          ? "paper_liquidation"
          : forced
            ? "forced_exit"
            : reason,
    };

    this.pos = null;
    this.peakExecutableNetPnlQuote = null;
    return roundtrip;
  }

  private forceCloseWithoutBook(
    nowMs: number,
    trigger: FuturesPaperExitTrigger,
    contract?: ContractMeta
  ): FuturesPaperRoundtrip {
    const p = this.pos;
    if (!p) {
      throw new Error("forceCloseWithoutBook called without open position");
    }

    const penalty = penaltyFrac(this.cfg.forcedExitPenaltyBps);
    const q = p.quantity;
    const entry = p.avgEntryPrice;
    const feeLeg = feeHalfPerLeg(this.cfg.feeRoundTripBps);
    const tick = contract?.tickSize ?? 0;
    const multiplier = getMultiplier(contract);

    const rawFill =
      p.side === "long"
        ? entry * (1 - penalty)
        : entry * (1 + penalty);
    const exitFill =
      tick > 0
        ? alignPriceToTick(rawFill, tick, p.side === "long" ? "down" : "up")
        : rawFill;
    const gross =
      p.side === "long"
        ? (exitFill - entry) * q * multiplier
        : (entry - exitFill) * q * multiplier;
    const notionalEntry = entry * q * multiplier;
    const notionalExit = exitFill * q * multiplier;
    const feesTotal = notionalEntry * feeLeg + notionalExit * feeLeg;
    const net = gross - feesTotal;

    this.cumulativeRealizedPnlQuote += net;
    const roundtrip: FuturesPaperRoundtrip = {
      instrumentId: p.instrumentId,
      side: p.side,
      quantity: q,
      entryPrice: entry,
      exitPrice: exitFill,
      grossPnlQuote: gross,
      feesQuote: feesTotal,
      netPnlQuote: net,
      openedAtMs: p.openedAtMs,
      closedAtMs: nowMs,
      closeReason: "forced_exit",
    };
    this.pos = null;
    this.peakExecutableNetPnlQuote = null;
    return roundtrip;
  }

  private closeLiquidationWithoutBook(
    markPrice: number,
    nowMs: number,
    contract?: ContractMeta,
    liquidationPenaltyBps?: number
  ): FuturesPaperRoundtrip | null {
    const p = this.pos;
    if (!p) return null;
    if (!Number.isFinite(markPrice) || !(markPrice > 0)) return null;

    const penalty = penaltyFrac(
      (liquidationPenaltyBps ?? getLiquidationPenaltyBps(this.cfg)) +
        this.cfg.slippageBps
    );
    const q = p.quantity;
    const entry = p.avgEntryPrice;
    const feeLeg = feeHalfPerLeg(this.cfg.feeRoundTripBps);
    const tick = contract?.tickSize ?? 0;
    const multiplier = getMultiplier(contract);

    const rawFill =
      p.side === "long"
        ? markPrice * (1 - penalty)
        : markPrice * (1 + penalty);
    const exitFill =
      tick > 0
        ? alignPriceToTick(rawFill, tick, p.side === "long" ? "down" : "up")
        : rawFill;
    const gross =
      p.side === "long"
        ? (exitFill - entry) * q * multiplier
        : (entry - exitFill) * q * multiplier;
    const notionalEntry = entry * q * multiplier;
    const notionalExit = exitFill * q * multiplier;
    const feesTotal = notionalEntry * feeLeg + notionalExit * feeLeg;
    const net = gross - feesTotal;

    this.cumulativeRealizedPnlQuote += net;
    const roundtrip: FuturesPaperRoundtrip = {
      instrumentId: p.instrumentId,
      side: p.side,
      quantity: q,
      entryPrice: entry,
      exitPrice: exitFill,
      grossPnlQuote: gross,
      feesQuote: feesTotal,
      netPnlQuote: net,
      openedAtMs: p.openedAtMs,
      closedAtMs: nowMs,
      closeReason: "paper_liquidation",
    };
    this.pos = null;
    this.peakExecutableNetPnlQuote = null;
    return roundtrip;
  }

  private detectProfitProtectionTrigger(
    book: TopOfBookL1 | null,
    contract?: ContractMeta
  ):
    | {
        trigger: "profit_lock";
        estimatedNetPnlAtExitQuote: number;
      }
      | {
          trigger: "trailing_profit";
          estimatedNetPnlAtExitQuote: number;
          peakEstimatedNetPnlAtExitQuote: number;
          dropFromPeakQuote: number;
          dropThresholdQuote: number;
          thresholdQuote: number;
        }
    | null {
    const p = this.pos;
    if (!p || (!isProfitLockEnabled(this.cfg) && !isTrailingProfitEnabled(this.cfg))) {
      return null;
    }
    if (!isExecutableBook(book)) return null;

    const estimate = estimateNetPnlAtExecutableExit({
      position: p,
      book,
      contract: contract ?? null,
      slippageBps: this.cfg.slippageBps,
      feeRoundTripBps: this.cfg.feeRoundTripBps,
    });
    if (!estimate) return null;

    const threshold = getProfitLockThresholdQuote(this.cfg);
    const trailingEnabled = isTrailingProfitEnabled(this.cfg);
    const currentEstimate = estimate.estimatedNetPnlAtExitQuote;
    const priorPeak = this.peakExecutableNetPnlQuote ?? Number.NEGATIVE_INFINITY;
    const nextPeak = Math.max(priorPeak, currentEstimate);
    this.peakExecutableNetPnlQuote = nextPeak;

    if (trailingEnabled) {
      if (nextPeak < threshold) return null;
      const dropThreshold = getTrailingProfitDropQuote(this.cfg);
      const dropFromPeak = nextPeak - currentEstimate;
      if (dropThreshold >= 0 && dropFromPeak >= dropThreshold) {
    return {
      trigger: "trailing_profit",
      estimatedNetPnlAtExitQuote: currentEstimate,
      peakEstimatedNetPnlAtExitQuote: nextPeak,
      dropFromPeakQuote: dropFromPeak,
      dropThresholdQuote: dropThreshold,
      thresholdQuote: threshold,
    };
  }
      return null;
    }

    if (currentEstimate < threshold) return null;

    return {
      trigger: "profit_lock",
      estimatedNetPnlAtExitQuote: currentEstimate,
    };
  }

  private detectExitTrigger(
    mid: number | null,
    nowMs: number
  ): FuturesPaperExitTrigger | null {
    const p = this.pos;
    if (!p) return null;

    const timeoutMs = Math.max(0, this.cfg.exitTimeoutMs);
    const tp = Math.max(0, this.cfg.takeProfitBps) / 10_000;
    const sl = Math.max(0, this.cfg.stopLossBps) / 10_000;

    if (timeoutMs > 0 && nowMs - p.openedAtMs >= timeoutMs) {
      return "exit_timeout";
    }

    if (mid === null || !Number.isFinite(mid) || mid <= 0) {
      return null;
    }

    const entry = p.avgEntryPrice;
    if (p.side === "long") {
      if (sl > 0 && mid <= entry * (1 - sl)) return "stop_loss";
      if (tp > 0 && mid >= entry * (1 + tp)) return "take_profit";
    } else {
      if (sl > 0 && mid >= entry * (1 + sl)) return "stop_loss";
      if (tp > 0 && mid <= entry * (1 - tp)) return "take_profit";
    }

    return null;
  }
}
