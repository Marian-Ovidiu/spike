import type { Instrument } from "../domain/instrument.js";
import type { TopOfBookL1 } from "../domain/book.js";
import type { PositionSide } from "../domain/sides.js";
import type {
  FuturesPaperCloseReason,
  FuturesPaperEngineConfig,
  FuturesPaperOpenResult,
  FuturesPaperRoundtrip,
} from "./futuresPaperTypes.js";
import { FuturesPaperEngine } from "./FuturesPaperEngine.js";

export type RealisticPaperEngineConfig = FuturesPaperEngineConfig & {
  readonly realisticMode?: boolean;
  readonly makerFeeBps?: number;
  readonly takerFeeBps?: number;
  readonly realisticSlippageBps?: number;
  readonly realisticLatencyMs?: number;
  readonly realisticSpreadBps?: number;
  readonly partialFillEnabled?: boolean;
  readonly partialFillRatio?: number;
  readonly fundingBpsPerHour?: number;
  readonly minNotionalQuote?: number;
};

type ContractMeta = Pick<
  Instrument,
  "tickSize" | "lotSize" | "contractMultiplier" | "minQuantity"
> & {
  readonly minNotional?: number;
};

type RealisticCosts = {
  spreadCostQuote: number;
  slippageCostQuote: number;
  latencyCostQuote: number;
  feeQuote: number;
  fillPrice: number;
  entryMidPrice: number;
  exitMidPrice: number;
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function getMultiplier(contract?: ContractMeta | null): number {
  const m = contract?.contractMultiplier ?? 1;
  return Number.isFinite(m) && m > 0 ? m : 1;
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

function getMinNotionalQuote(
  cfg: RealisticPaperEngineConfig,
  contract?: ContractMeta | null
): number {
  const contractMin = contract?.minNotional ?? 0;
  const configured = cfg.minNotionalQuote ?? 0;
  return Math.max(0, contractMin, configured);
}

function floorToIncrement(value: number, step: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(step) || step <= 0) return NaN;
  return Math.floor(value / step + 1e-12) * step;
}

function alignPriceToTick(
  price: number,
  tickSize: number,
  direction: "up" | "down"
): number {
  if (!Number.isFinite(price) || !Number.isFinite(tickSize) || tickSize <= 0) {
    return NaN;
  }
  const steps =
    direction === "up"
      ? Math.ceil(price / tickSize - 1e-12)
      : Math.floor(price / tickSize + 1e-12);
  return steps * tickSize;
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

function effectiveTakerFeeBps(cfg: RealisticPaperEngineConfig): number {
  if (Number.isFinite(cfg.takerFeeBps) && (cfg.takerFeeBps ?? 0) > 0) {
    return cfg.takerFeeBps!;
  }
  return Math.max(0, cfg.feeRoundTripBps) / 2;
}

function latencyBps(cfg: RealisticPaperEngineConfig): number {
  const ms = Math.max(0, cfg.realisticLatencyMs ?? 0);
  return Math.min(25, ms * 0.01);
}

function spreadBps(cfg: RealisticPaperEngineConfig, book: TopOfBookL1): number {
  return Math.max(0, book.spreadBps) + Math.max(0, cfg.realisticSpreadBps ?? 0);
}

function midpointAdjustedPrice(
  book: TopOfBookL1,
  side: PositionSide,
  cfg: RealisticPaperEngineConfig
): number {
  const totalSpreadBps = spreadBps(cfg, book);
  const half = (book.midPrice * totalSpreadBps) / 10_000 / 2;
  return side === "long" ? book.midPrice + half : book.midPrice - half;
}

function simulateLegFill(input: {
  book: TopOfBookL1;
  positionSide: PositionSide;
  isEntry: boolean;
  cfg: RealisticPaperEngineConfig;
  contract?: ContractMeta | null;
  quantity: number;
}): RealisticCosts {
  const spreadAdjustedPrice = midpointAdjustedPrice(
    input.book,
    input.positionSide === "long"
      ? input.isEntry
        ? "long"
        : "short"
      : input.isEntry
        ? "short"
        : "long",
    input.cfg
  );
  const slipBps = Math.max(0, input.cfg.realisticSlippageBps ?? 0);
  const latBps = latencyBps(input.cfg);
  const directionSign =
    (input.positionSide === "long" && input.isEntry) ||
    (input.positionSide === "short" && !input.isEntry)
      ? 1
      : -1;
  const slipOnlyFrac = slipBps / 10_000;
  const latOnlyFrac = latBps / 10_000;
  const preTickFill = spreadAdjustedPrice * (
    1 + directionSign * (slipOnlyFrac + latOnlyFrac)
  );
  const tickSize = input.contract?.tickSize ?? 0;
  const fillPrice = tickSize > 0
    ? alignPriceToTick(
        preTickFill,
        tickSize,
        directionSign > 0 ? "up" : "down"
      )
    : preTickFill;
  const multiplier = getMultiplier(input.contract);
  const spreadCostQuote =
    Math.abs(spreadAdjustedPrice - input.book.midPrice) * input.quantity * multiplier;
  const slipFill = spreadAdjustedPrice * (1 + directionSign * slipOnlyFrac);
  const slippageCostQuote =
    Math.abs(slipFill - spreadAdjustedPrice) * input.quantity * multiplier;
  const latencyCostQuote =
    Math.abs(fillPrice - slipFill) * input.quantity * multiplier;
  const feeQuote =
    fillPrice * input.quantity * multiplier * (effectiveTakerFeeBps(input.cfg) / 10_000);
  return {
    spreadCostQuote,
    slippageCostQuote,
    latencyCostQuote,
    feeQuote,
    fillPrice,
    entryMidPrice: input.book.midPrice,
    exitMidPrice: input.book.midPrice,
  };
}

function buildRoundtrip(input: {
  instrumentId: string;
  side: PositionSide;
  quantity: number;
  multiplier: number;
  entryPrice: number;
  exitPrice: number;
  entryMidPrice: number;
  exitMidPrice: number;
  grossPnlQuote: number;
  feesQuote: number;
  spreadCostQuote: number;
  slippageCostQuote: number;
  latencyCostQuote: number;
  fundingCostQuote: number;
  openedAtMs: number;
  closedAtMs: number;
  closeReason: FuturesPaperCloseReason;
}): FuturesPaperRoundtrip {
  const edgeBeforeCosts =
    input.side === "long"
      ? (input.exitMidPrice - input.entryMidPrice) * input.quantity * input.multiplier
      : (input.entryMidPrice - input.exitMidPrice) * input.quantity * input.multiplier;
  const edgeAfterCosts =
    edgeBeforeCosts -
    input.spreadCostQuote -
    input.slippageCostQuote -
    input.latencyCostQuote -
    input.fundingCostQuote;
  const netPnlQuote =
    input.grossPnlQuote - input.feesQuote - input.fundingCostQuote;
  return {
    instrumentId: input.instrumentId,
    side: input.side,
    quantity: input.quantity,
    entryPrice: input.entryPrice,
    exitPrice: input.exitPrice,
    grossPnlQuote: input.grossPnlQuote,
    feesQuote: input.feesQuote,
    netPnlQuote,
    grossPnl: input.grossPnlQuote,
    fees: input.feesQuote,
    spreadCost: input.spreadCostQuote,
    slippageCost: input.slippageCostQuote,
    latencyCost: input.latencyCostQuote,
    fundingCost: input.fundingCostQuote,
    netPnl: netPnlQuote,
    edgeBeforeCosts,
    edgeAfterCosts,
    openedAtMs: input.openedAtMs,
    closedAtMs: input.closedAtMs,
    closeReason: input.closeReason,
  };
}

export class RealisticPaperEngine extends FuturesPaperEngine {
  constructor(config: RealisticPaperEngineConfig) {
    super(config);
  }

  openLong(input: {
    instrumentId: string;
    quantity: number;
    book: TopOfBookL1;
    nowMs: number;
    contract?: ContractMeta;
  }): FuturesPaperOpenResult {
    return this.openRealisticPosition("long", input);
  }

  openShort(input: {
    instrumentId: string;
    quantity: number;
    book: TopOfBookL1;
    nowMs: number;
    contract?: ContractMeta;
  }): FuturesPaperOpenResult {
    return this.openRealisticPosition("short", input);
  }

  private realisticCfg(): RealisticPaperEngineConfig {
    return this.cfg as RealisticPaperEngineConfig;
  }

  protected detectProfitProtectionTrigger(
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
    const cfg = this.realisticCfg();
    if (
      !p ||
      (!cfg.profitLockEnabled && !cfg.trailingProfitEnabled) ||
      !isExecutableBook(book)
    ) {
      return null;
    }
    const estimate = this.estimateNetPnlAtExecutableExit({
      position: p,
      book,
      contract: contract ?? null,
    });
    if (!estimate) return null;
    const threshold =
      Number.isFinite(cfg.profitLockThresholdQuote) &&
      (cfg.profitLockThresholdQuote ?? 0) >= 0
        ? cfg.profitLockThresholdQuote!
        : 1;
    const trailingEnabled = cfg.trailingProfitEnabled === true;
    const currentEstimate = estimate.netPnlQuote;
    const priorPeak = this.peakExecutableNetPnlQuote ?? Number.NEGATIVE_INFINITY;
    const nextPeak = Math.max(priorPeak, currentEstimate);
    this.peakExecutableNetPnlQuote = nextPeak;

    if (trailingEnabled) {
      if (nextPeak < threshold) return null;
      const dropThreshold = Math.max(0, cfg.trailingProfitDropQuote ?? 0);
      const dropFromPeak = nextPeak - currentEstimate;
      if (dropFromPeak >= dropThreshold) {
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

  protected closeAtBook(
    book: TopOfBookL1,
    nowMs: number,
    reason: FuturesPaperCloseReason,
    forced: boolean,
    contract?: ContractMeta,
    slippageBpsOverride?: number
  ): FuturesPaperRoundtrip | null {
    const cfg = this.realisticCfg();
    const p = this.pos;
    if (!p || !isExecutableBook(book)) return null;
    const sim = this.simulateExitFill({
      book,
      contract: contract ?? null,
      positionSide: p.side,
      quantity: p.quantity,
      ...(slippageBpsOverride !== undefined
        ? { slippageBpsOverride }
        : {}),
    });
    const grossPnlQuote =
      p.side === "long"
        ? (sim.fillPrice - p.avgEntryPrice) * p.quantity * getMultiplier(contract)
        : (p.avgEntryPrice - sim.fillPrice) * p.quantity * getMultiplier(contract);
    const fundingCostQuote = this.computeFundingCost(
      p,
      sim.exitMidPrice,
      nowMs,
      contract
    );
    const feesQuote = (p.feesOpenQuote ?? 0) + sim.feeQuote;
    const roundtrip = buildRoundtrip({
      instrumentId: p.instrumentId,
      side: p.side,
      quantity: p.quantity,
      multiplier: getMultiplier(contract),
      entryPrice: p.avgEntryPrice,
      exitPrice: sim.fillPrice,
      entryMidPrice: p.entryMidPrice ?? p.avgEntryPrice,
      exitMidPrice: sim.exitMidPrice,
      grossPnlQuote,
      feesQuote,
      spreadCostQuote: (p.spreadCostQuote ?? 0) + sim.spreadCostQuote,
      slippageCostQuote: (p.slippageCostQuote ?? 0) + sim.slippageCostQuote,
      latencyCostQuote: (p.latencyCostQuote ?? 0) + sim.latencyCostQuote,
      fundingCostQuote,
      openedAtMs: p.openedAtMs,
      closedAtMs: nowMs,
      closeReason: forced ? "forced_exit" : reason,
    });
    this.cumulativeRealizedPnlQuote += roundtrip.netPnlQuote;
    this.pos = null;
    this.peakExecutableNetPnlQuote = null;
    return roundtrip;
  }

  protected forceCloseWithoutBook(
    nowMs: number,
    trigger: "take_profit" | "stop_loss" | "exit_timeout" | "profit_lock" | "trailing_profit",
    contract?: ContractMeta
  ): FuturesPaperRoundtrip {
    const cfg = this.realisticCfg();
    const p = this.pos;
    if (!p) {
      throw new Error("forceCloseWithoutBook called without open position");
    }
    const fallbackPrice = this.forceFallbackExitPrice(p, contract);
    const grossPnlQuote =
      p.side === "long"
        ? (fallbackPrice - p.avgEntryPrice) * p.quantity * getMultiplier(contract)
        : (p.avgEntryPrice - fallbackPrice) * p.quantity * getMultiplier(contract);
    const fundingCostQuote = this.computeFundingCost(
      p,
      p.entryMidPrice ?? p.avgEntryPrice,
      nowMs,
      contract
    );
    const feesQuote = (p.feesOpenQuote ?? 0) +
      fallbackPrice * p.quantity * getMultiplier(contract) * (effectiveTakerFeeBps(cfg) / 10_000);
    const roundtrip = buildRoundtrip({
      instrumentId: p.instrumentId,
      side: p.side,
      quantity: p.quantity,
      multiplier: getMultiplier(contract),
      entryPrice: p.avgEntryPrice,
      exitPrice: fallbackPrice,
      entryMidPrice: p.entryMidPrice ?? p.avgEntryPrice,
      exitMidPrice: p.entryMidPrice ?? p.avgEntryPrice,
      grossPnlQuote,
      feesQuote,
      spreadCostQuote: p.spreadCostQuote ?? 0,
      slippageCostQuote: p.slippageCostQuote ?? 0,
      latencyCostQuote: p.latencyCostQuote ?? 0,
      fundingCostQuote,
      openedAtMs: p.openedAtMs,
      closedAtMs: nowMs,
      closeReason: "forced_exit",
    });
    this.cumulativeRealizedPnlQuote += roundtrip.netPnlQuote;
    this.pos = null;
    this.peakExecutableNetPnlQuote = null;
    return roundtrip;
  }

  protected closeLiquidationWithoutBook(
    markPrice: number,
    nowMs: number,
    contract?: ContractMeta,
    liquidationPenaltyBps?: number
  ): FuturesPaperRoundtrip | null {
    const cfg = this.realisticCfg();
    const p = this.pos;
    if (!p || !Number.isFinite(markPrice) || !(markPrice > 0)) return null;
    const penalty = Math.max(0, (liquidationPenaltyBps ?? 0) + Math.max(0, cfg.realisticSlippageBps ?? 0) + latencyBps(cfg));
    const dir = p.side === "long" ? -1 : 1;
    const rawFill = markPrice * (1 + dir * (penalty / 10_000));
    const exitPrice = this.normalizePrice(rawFill, contract, p.side === "long" ? "down" : "up");
    const grossPnlQuote =
      p.side === "long"
        ? (exitPrice - p.avgEntryPrice) * p.quantity * getMultiplier(contract)
        : (p.avgEntryPrice - exitPrice) * p.quantity * getMultiplier(contract);
    const fundingCostQuote = this.computeFundingCost(p, markPrice, nowMs, contract);
    const feesQuote = (p.feesOpenQuote ?? 0) +
      exitPrice * p.quantity * getMultiplier(contract) * (effectiveTakerFeeBps(cfg) / 10_000);
    const roundtrip = buildRoundtrip({
      instrumentId: p.instrumentId,
      side: p.side,
      quantity: p.quantity,
      multiplier: getMultiplier(contract),
      entryPrice: p.avgEntryPrice,
      exitPrice,
      entryMidPrice: p.entryMidPrice ?? p.avgEntryPrice,
      exitMidPrice: markPrice,
      grossPnlQuote,
      feesQuote,
      spreadCostQuote: p.spreadCostQuote ?? 0,
      slippageCostQuote: p.slippageCostQuote ?? 0,
      latencyCostQuote: p.latencyCostQuote ?? 0,
      fundingCostQuote,
      openedAtMs: p.openedAtMs,
      closedAtMs: nowMs,
      closeReason: "paper_liquidation",
    });
    this.cumulativeRealizedPnlQuote += roundtrip.netPnlQuote;
    this.pos = null;
    this.peakExecutableNetPnlQuote = null;
    return roundtrip;
  }

  private openRealisticPosition(
    side: PositionSide,
    input: {
      instrumentId: string;
      quantity: number;
      book: TopOfBookL1;
      nowMs: number;
      contract?: ContractMeta;
    }
  ): FuturesPaperOpenResult {
    const cfg = this.realisticCfg();
    if (this.pos !== null) {
      return { ok: false, reason: "position_already_open" };
    }
    if (!isExecutableBook(input.book)) {
      return { ok: false, reason: "invalid_book" };
    }
    const contract = input.contract ?? null;
    const lotSize = getLotSize(contract);
    const minQuantity = getMinQuantity(contract);
    const normalizedQuantity =
      lotSize > 0 ? floorToIncrement(input.quantity, lotSize) : input.quantity;
    if (!(normalizedQuantity > 0) || !Number.isFinite(normalizedQuantity)) {
      return { ok: false, reason: "invalid_quantity" };
    }
    if (normalizedQuantity < minQuantity) {
      return { ok: false, reason: "invalid_quantity" };
    }

    const partialFillRatio = cfg.partialFillEnabled
      ? clamp(cfg.partialFillRatio ?? 1, 0, 1)
      : 1;
    const filledQuantity =
      lotSize > 0
        ? floorToIncrement(normalizedQuantity * partialFillRatio, lotSize)
        : normalizedQuantity * partialFillRatio;
    if (!(filledQuantity > 0) || !Number.isFinite(filledQuantity)) {
      return { ok: false, reason: "invalid_quantity" };
    }
    if (filledQuantity < minQuantity) {
      return { ok: false, reason: "invalid_quantity" };
    }

    const baseEntryPrice =
      side === "long" ? input.book.bestAsk : input.book.bestBid;
    const spreadAdjustedPrice = midpointAdjustedPrice(input.book, side, cfg);
    const sim = this.simulateEntryFill({
      book: input.book,
      positionSide: side,
      contract,
      quantity: filledQuantity,
    });
    const notionalQuote = sim.fillPrice * filledQuantity * getMultiplier(contract);
    if (notionalQuote < getMinNotionalQuote(cfg, contract)) {
      return { ok: false, reason: "below_min_notional" };
    }
    this.pos = {
      instrumentId: input.instrumentId as string,
      side,
      quantity: filledQuantity,
      avgEntryPrice: sim.fillPrice,
      entryMidPrice: input.book.midPrice,
      openedAtMs: input.nowMs,
      feesOpenQuote: sim.feeQuote,
      spreadCostQuote: sim.spreadCostQuote,
      slippageCostQuote: sim.slippageCostQuote,
      latencyCostQuote: sim.latencyCostQuote,
      edgeBeforeCostsQuote:
        side === "long"
          ? (input.book.bestAsk - input.book.midPrice) * filledQuantity * getMultiplier(contract)
          : (input.book.midPrice - input.book.bestBid) * filledQuantity * getMultiplier(contract),
    };
    this.peakExecutableNetPnlQuote = null;
    return {
      ok: true,
      avgEntryPrice: sim.fillPrice,
      feesOpenQuote: sim.feeQuote,
    };
  }

  private simulateEntryFill(input: {
    book: TopOfBookL1;
    positionSide: PositionSide;
    contract?: ContractMeta | null;
    quantity: number;
  }): RealisticCosts {
    const cfg = this.realisticCfg();
    const spreadAdjustedPrice = midpointAdjustedPrice(input.book, input.positionSide, cfg);
    const slipBps = Math.max(0, cfg.realisticSlippageBps ?? 0);
    const latBps = latencyBps(cfg);
    const adverseFrac = (slipBps + latBps) / 10_000;
    const preTickFill =
      input.positionSide === "long"
        ? spreadAdjustedPrice * (1 + adverseFrac)
        : spreadAdjustedPrice * (1 - adverseFrac);
    const fillPrice = this.normalizePrice(
      preTickFill,
      input.contract ?? null,
      input.positionSide === "long" ? "up" : "down"
    );
    const multiplier = getMultiplier(input.contract);
    const spreadCostQuote =
      Math.abs(spreadAdjustedPrice - input.book.midPrice) * input.quantity * multiplier;
    const slippageCostQuote =
      Math.abs(
        spreadAdjustedPrice *
          (input.positionSide === "long" ? adverseFrac : -adverseFrac)
      ) * input.quantity * multiplier;
    const latencyCostQuote =
      Math.abs(fillPrice - (input.positionSide === "long"
        ? spreadAdjustedPrice * (1 + slipBps / 10_000)
        : spreadAdjustedPrice * (1 - slipBps / 10_000))) *
      input.quantity *
      multiplier;
    const feeQuote =
      fillPrice * input.quantity * multiplier * (effectiveTakerFeeBps(cfg) / 10_000);
    return {
      spreadCostQuote,
      slippageCostQuote,
      latencyCostQuote,
      feeQuote,
      fillPrice,
      entryMidPrice: input.book.midPrice,
      exitMidPrice: input.book.midPrice,
    };
  }

  private simulateExitFill(input: {
    book: TopOfBookL1;
    positionSide: PositionSide;
    contract?: ContractMeta | null;
    quantity: number;
    slippageBpsOverride?: number;
  }): RealisticCosts {
    const cfg = this.realisticCfg();
    const closingSide: PositionSide = input.positionSide;
    const spreadAdjustedPrice = midpointAdjustedPrice(
      input.book,
      closingSide === "long" ? "short" : "long",
      cfg
    );
  const slipBps = Math.max(0, input.slippageBpsOverride ?? cfg.realisticSlippageBps ?? 0);
  const latBps = latencyBps(cfg);
  const slipOnlyFrac = slipBps / 10_000;
  const latOnlyFrac = latBps / 10_000;
  const preTickFill =
      closingSide === "long"
        ? spreadAdjustedPrice * (1 - slipOnlyFrac - latOnlyFrac)
        : spreadAdjustedPrice * (1 + slipOnlyFrac + latOnlyFrac);
  const fillPrice = this.normalizePrice(
      preTickFill,
      input.contract ?? null,
      closingSide === "long" ? "down" : "up"
    );
  const multiplier = getMultiplier(input.contract);
  const spreadCostQuote =
    Math.abs(spreadAdjustedPrice - input.book.midPrice) * input.quantity * multiplier;
  const slipFill =
      closingSide === "long"
        ? spreadAdjustedPrice * (1 - slipOnlyFrac)
        : spreadAdjustedPrice * (1 + slipOnlyFrac);
    const slippageCostQuote =
      Math.abs(slipFill - spreadAdjustedPrice) * input.quantity * multiplier;
    const latencyCostQuote =
      Math.abs(fillPrice - slipFill) * input.quantity * multiplier;
    const feeQuote =
      fillPrice * input.quantity * multiplier * (effectiveTakerFeeBps(cfg) / 10_000);
    return {
      spreadCostQuote,
      slippageCostQuote,
      latencyCostQuote,
      feeQuote,
      fillPrice,
      entryMidPrice: input.book.midPrice,
      exitMidPrice: input.book.midPrice,
    };
  }

  private estimateNetPnlAtExecutableExit(input: {
    position: NonNullable<ReturnType<FuturesPaperEngine["getOpenPosition"]>>;
    book: TopOfBookL1;
    contract?: ContractMeta | null;
  }): { netPnlQuote: number } | null {
    const cfg = this.realisticCfg();
    if (!isExecutableBook(input.book)) return null;
    const sim = this.simulateExitFill({
      book: input.book,
      positionSide: input.position.side,
      contract: input.contract ?? null,
      quantity: input.position.quantity,
    });
    const grossPnlQuote =
      input.position.side === "long"
        ? (sim.fillPrice - input.position.avgEntryPrice) * input.position.quantity * getMultiplier(input.contract)
        : (input.position.avgEntryPrice - sim.fillPrice) * input.position.quantity * getMultiplier(input.contract);
    const fundingCostQuote = this.computeFundingCost(
      {
        instrumentId: input.position.instrumentId,
        side: input.position.side,
        quantity: input.position.quantity,
        avgEntryPrice: input.position.avgEntryPrice,
        openedAtMs: input.position.openedAtMs,
        feesOpenQuote: 0,
      },
      input.book.midPrice,
      Date.now(),
      input.contract ?? null
    );
    const netPnlQuote = grossPnlQuote - sim.feeQuote - fundingCostQuote;
    return { netPnlQuote };
  }

  private forceFallbackExitPrice(
    position: NonNullable<ReturnType<FuturesPaperEngine["getOpenPosition"]>>,
    contract?: ContractMeta | null
  ): number {
    const cfg = this.realisticCfg();
    const penaltyBps =
      Math.max(0, cfg.forcedExitPenaltyBps) +
      Math.max(0, cfg.realisticSlippageBps ?? 0) +
      latencyBps(cfg);
    const raw =
      position.side === "long"
        ? position.avgEntryPrice * (1 - penaltyBps / 10_000)
        : position.avgEntryPrice * (1 + penaltyBps / 10_000);
    return this.normalizePrice(
      raw,
      contract ?? null,
      position.side === "long" ? "down" : "up"
    );
  }

  private computeFundingCost(
    position: NonNullable<ReturnType<FuturesPaperEngine["getOpenPosition"]>> & {
      readonly instrumentId?: string;
      readonly feesOpenQuote?: number;
      readonly entryMidPrice?: number;
    },
    exitMidPrice: number,
    nowMs: number,
    contract?: ContractMeta | null
  ): number {
    const cfg = this.realisticCfg();
    const fundingBps = Math.max(0, cfg.fundingBpsPerHour ?? 0);
    if (fundingBps <= 0) return 0;
    const hours = Math.max(0, nowMs - position.openedAtMs) / 3_600_000;
    if (hours <= 0) return 0;
    const multiplier = getMultiplier(contract);
    const entryNotional = position.avgEntryPrice * position.quantity * multiplier;
    const exitNotional = exitMidPrice * position.quantity * multiplier;
    const avgNotional = (entryNotional + exitNotional) / 2;
    return avgNotional * (fundingBps / 10_000) * hours;
  }

  private normalizePrice(
    price: number,
    contract: ContractMeta | null | undefined,
    direction: "up" | "down"
  ): number {
    const tick = contract?.tickSize ?? 0;
    if (!(tick > 0)) return price;
    return alignPriceToTick(price, tick, direction);
  }
}
