/**
 * Shared single-tick pipeline: buffer mid → paper mark → signal → risk → optional open.
 * Used by live futures monitor and offline replay.
 */
import type { Instrument, InstrumentId } from "../domain/instrument.js";
import type { TopOfBookL1 } from "../domain/book.js";
import type { FuturesPaperEngine } from "../execution/FuturesPaperEngine.js";
import type { FuturesPaperExitDecision } from "../execution/futuresPaperTypes.js";
import type { FuturesPaperMarginDecision } from "../execution/futuresPaperTypes.js";
import type { FuturesPaperRoundtrip } from "../execution/futuresPaperTypes.js";
import type { EvaluateSignalConditionsInput } from "../signal/signalEvaluate.js";
import type { RollingPriceBuffer } from "../signal/rollingPriceBuffer.js";
import type { RiskEngine } from "../risk/RiskEngine.js";
import type { RiskEvaluationInput, RiskGateResult } from "../risk/riskTypes.js";
import { evaluateSignalConditions } from "../signal/signalEvaluate.js";
import type { SignalEvaluation } from "../signal/types.js";

export type FuturesStackRuntime = {
  instrumentId: InstrumentId;
  contract: Instrument;
  risk: RiskEngine;
  paper: FuturesPaperEngine;
  priceBuffer: RollingPriceBuffer;
  minSamples: number;
  signalInputBase: Omit<EvaluateSignalConditionsInput, "prices">;
  feedStaleMaxAgeMs: number;
  blockEntriesOnExecutionFeedStale: boolean;
  entryConfirmationTicks: number;
  entryRequireReversal: boolean;
  pendingEntry: FuturesPendingEntryState | null;
};

export type FuturesPendingEntryState = {
  tradeId: string;
  side: "long" | "short";
  impulseDirection: "up" | "down";
  contrarianDirection: "up" | "down";
  createdAtMs: number;
  createdTradeSequence: number;
  firstObservedMid: number;
  lastObservedMid: number;
  lastObservedAtMs: number;
  observedTicks: number;
  requiredTicks: number;
  requireReversal: boolean;
};

export type FuturesStackStepInput = {
  nowMs: number;
  tradeSequence: number;
  /** Signal mid (added to rolling buffer when finite). */
  mid: number | null;
  /** Mark price used for valuation and liquidation math. */
  markPrice: number | null;
  /** Executable top of book; when null, exits/on-open are skipped. */
  book: TopOfBookL1 | null;
  /** Age of execution path for staleness gates (replay: use 0 to disable age-based stale). */
  lastMessageAgeMs: number;
  lastCooldownAnchorMs: number | null;
};

export type FuturesStackOpenAttempt =
  | {
      ok: true;
      tradeId: string;
      side: "long" | "short";
      quantity: number;
      stakeQuote: number;
      entryPrice: number;
      avgEntryPrice: number;
      feesOpenQuote: number;
      entryConfirmation?: {
        requiredTicks: number;
        ticksObserved: number;
        requireReversal: boolean;
        satisfiedBy: "ticks" | "stall" | "reversal";
        referenceMid: number;
        lastObservedMid: number;
      };
      telemetry: FuturesOrderTelemetry;
    }
  | {
      ok: false;
      tradeId: string;
      reason: string;
      side: "long" | "short";
      quantity: number;
      stakeQuote: number;
      telemetry: FuturesOrderTelemetry;
    };

export type FuturesOrderTelemetry = {
  requestedQuantity: number;
  roundedQuantity: number;
  quantityRounded: boolean;
  quantityValidationReason: "invalid_raw_quantity" | "below_min_quantity" | null;
  lotSize: number;
  minQuantity: number;
  tickSize: number;
  contractMultiplier: number;
  entryPrice: number;
  fillPrice: number | null;
  targetNotionalQuote: number;
  executedNotionalQuote: number | null;
  notionalDeltaQuote: number | null;
  notionalDeltaBps: number | null;
  priceAligned: boolean;
};

export type FuturesStackTickDiagnostics = {
  signalActionable: boolean;
  riskAllowed: boolean;
};

export type FuturesEntryConfirmationUpdate =
  | {
      kind: "pending";
      tradeId: string;
      side: "long" | "short";
      impulseDirection: "up" | "down";
      contrarianDirection: "up" | "down";
      requiredTicks: number;
      ticksObserved: number;
      firstObservedAtMs: number;
      lastObservedAtMs: number;
      referenceMid: number;
      lastObservedMid: number;
      requireReversal: boolean;
      pendingReason:
        | "waiting_ticks"
        | "waiting_slowdown"
        | "waiting_reversal"
        | "risk_blocked"
        | "execution_blocked";
    }
  | {
      kind: "cancelled";
      tradeId: string;
      side: "long" | "short";
      impulseDirection: "up" | "down";
      contrarianDirection: "up" | "down";
      requiredTicks: number;
      ticksObserved: number;
      firstObservedAtMs: number;
      lastObservedAtMs: number;
      referenceMid: number;
      lastObservedMid: number;
      requireReversal: boolean;
      cancelReason: "signal_invalid" | "direction_changed";
    };

export type FuturesStackStepResult = {
  lastCooldownAnchorMs: number | null;
  closedRoundtrip: FuturesPaperRoundtrip | null;
  exitDecision: FuturesPaperExitDecision | null;
  marginDecision: FuturesPaperMarginDecision | null;
  openAttempt: FuturesStackOpenAttempt | null;
  signalEvaluation: SignalEvaluation | null;
  riskEvaluationInput: RiskEvaluationInput | null;
  riskEvaluation: RiskGateResult | null;
  entryConfirmation: FuturesEntryConfirmationUpdate | null;
  /** Present when an open succeeded (for monitor / replay logging). */
  openSignalSnapshot?: {
    impulseDirection: string;
    contrarianDirection: string;
    strength: string;
  };
  /** Set once past warmup (enough prices); useful for replay summaries. */
  tickDiagnostics?: FuturesStackTickDiagnostics;
};

export function isExecutableBook(b: TopOfBookL1 | null): b is TopOfBookL1 {
  if (!b) return false;
  return (
    Number.isFinite(b.bestBid) &&
    Number.isFinite(b.bestAsk) &&
    Number.isFinite(b.midPrice) &&
    Number.isFinite(b.spreadBps) &&
    b.bestBid > 0 &&
    b.bestAsk >= b.bestBid
  );
}

function entryPriceForSide(book: TopOfBookL1, side: "long" | "short"): number {
  return side === "long" ? book.bestAsk : book.bestBid;
}

function positionSideFromSignalDirection(
  direction: "up" | "down"
): "long" | "short" {
  return direction === "up" ? "long" : "short";
}

function getContractMultiplier(contract: Instrument): number {
  const m = contract.contractMultiplier ?? 1;
  return Number.isFinite(m) && m > 0 ? m : 1;
}

function getMinQuantity(contract: Instrument): number {
  const lot = Number.isFinite(contract.lotSize) && contract.lotSize > 0 ? contract.lotSize : 0;
  const min = contract.minQuantity ?? lot;
  if (!Number.isFinite(min) || min <= 0) return lot;
  return lot > 0 ? Math.max(lot, min) : min;
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

function buildTelemetry(input: {
  contract: Instrument;
  requestedQuantity: number;
  roundedQuantity: number;
  quantityValidationReason: FuturesOrderTelemetry["quantityValidationReason"];
  entryPrice: number;
  fillPrice: number | null;
  targetNotionalQuote: number;
  executedNotionalQuote: number | null;
  priceAligned: boolean;
}): FuturesOrderTelemetry {
  const multiplier = getContractMultiplier(input.contract);
  const deltaQuote =
    input.executedNotionalQuote !== null
      ? input.executedNotionalQuote - input.targetNotionalQuote
      : null;
  const deltaBps =
    deltaQuote !== null && input.targetNotionalQuote > 0
      ? (deltaQuote / input.targetNotionalQuote) * 10_000
      : null;
  return {
    requestedQuantity: input.requestedQuantity,
    roundedQuantity: input.roundedQuantity,
    quantityRounded:
      Math.abs(input.requestedQuantity - input.roundedQuantity) > 1e-12,
    quantityValidationReason: input.quantityValidationReason,
    lotSize: input.contract.lotSize,
    minQuantity: getMinQuantity(input.contract),
    tickSize: input.contract.tickSize,
    contractMultiplier: multiplier,
    entryPrice: input.entryPrice,
    fillPrice: input.fillPrice,
    targetNotionalQuote: input.targetNotionalQuote,
    executedNotionalQuote: input.executedNotionalQuote,
    notionalDeltaQuote: deltaQuote,
    notionalDeltaBps: deltaBps,
    priceAligned: input.priceAligned,
  };
}

function buildEntryConfirmationState(input: {
  tradeId: string;
  side: "long" | "short";
  impulseDirection: "up" | "down";
  contrarianDirection: "up" | "down";
  createdAtMs: number;
  tradeSequence: number;
  mid: number;
  requiredTicks: number;
  requireReversal: boolean;
}): FuturesPendingEntryState {
  return {
    tradeId: input.tradeId,
    side: input.side,
    impulseDirection: input.impulseDirection,
    contrarianDirection: input.contrarianDirection,
    createdAtMs: input.createdAtMs,
    createdTradeSequence: input.tradeSequence,
    firstObservedMid: input.mid,
    lastObservedMid: input.mid,
    lastObservedAtMs: input.createdAtMs,
    observedTicks: 0,
    requiredTicks: Math.max(0, Math.trunc(input.requiredTicks)),
    requireReversal: input.requireReversal,
  };
}

function evaluateEntryConfirmation(
  state: FuturesPendingEntryState,
  currentMid: number,
  nowMs: number,
  tickSize: number
): {
  observedState: FuturesPendingEntryState;
  pendingReason:
    | "waiting_ticks"
    | "waiting_slowdown"
    | "waiting_reversal"
    | "risk_blocked"
    | "execution_blocked";
  satisfied: boolean;
  satisfiedBy?: "ticks" | "stall" | "reversal";
} {
  const nextObservedTicks = state.observedTicks + 1;
  const requiredTicks = state.requiredTicks;
  const delta = currentMid - state.lastObservedMid;
  const eps = Number.isFinite(tickSize) && tickSize > 0 ? tickSize * 0.25 : 1e-9;
  const movedAgainstSpike =
    state.side === "short" ? delta <= -Math.max(eps, tickSize > 0 ? tickSize : eps) : delta >= Math.max(eps, tickSize > 0 ? tickSize : eps);
  const stoppedMoving =
    state.side === "short" ? delta <= eps : delta >= -eps;

  const observedState: FuturesPendingEntryState = {
    ...state,
    observedTicks: nextObservedTicks,
    lastObservedMid: currentMid,
    lastObservedAtMs: nowMs,
  };

  if (nextObservedTicks < requiredTicks) {
    return {
      observedState,
      pendingReason: "waiting_ticks",
      satisfied: false,
    };
  }

  if (state.requireReversal) {
    if (movedAgainstSpike) {
      return {
        observedState,
        pendingReason: "risk_blocked",
        satisfied: true,
        satisfiedBy: "reversal",
      };
    }
    return {
      observedState,
      pendingReason: "waiting_reversal",
      satisfied: false,
    };
  }

  if (stoppedMoving) {
    return {
      observedState,
      pendingReason: "risk_blocked",
      satisfied: true,
      satisfiedBy: movedAgainstSpike ? "reversal" : "stall",
    };
  }

  return {
    observedState,
    pendingReason: "waiting_slowdown",
    satisfied: false,
  };
}

export function runFuturesStackStep(
  rt: FuturesStackRuntime,
  input: FuturesStackStepInput
): FuturesStackStepResult {
  const {
    instrumentId,
    contract,
    risk,
    paper,
    priceBuffer,
    minSamples,
    signalInputBase,
    feedStaleMaxAgeMs,
    blockEntriesOnExecutionFeedStale,
  } = rt;

  let lastCooldownAnchorMs = input.lastCooldownAnchorMs;

  if (input.mid !== null && Number.isFinite(input.mid)) {
    priceBuffer.addPrice(input.mid);
  }

  let closedRoundtrip: FuturesPaperRoundtrip | null = null;
  const exitDecision = paper.evaluateExit(input.book, input.nowMs, contract);
  if (exitDecision?.kind === "closed") {
    closedRoundtrip = exitDecision.roundtrip;
    lastCooldownAnchorMs = exitDecision.roundtrip.closedAtMs;
  }

  const marginDecision = paper.evaluateMargin({
    markPrice: input.markPrice,
    nowMs: input.nowMs,
    book: input.book,
    contract,
  });
  const liquidatedThisTick = marginDecision?.kind === "liquidated";
  if (liquidatedThisTick) {
    closedRoundtrip = marginDecision.roundtrip;
    lastCooldownAnchorMs = marginDecision.roundtrip.closedAtMs;
  }

  const prices = priceBuffer.getPrices();
  if (prices.length < minSamples) {
    return {
      lastCooldownAnchorMs,
      closedRoundtrip,
      exitDecision,
      marginDecision,
      openAttempt: null,
      signalEvaluation: null,
      riskEvaluationInput: null,
      riskEvaluation: null,
      entryConfirmation: null,
    };
  }

  const sig = evaluateSignalConditions({
    ...signalInputBase,
    prices,
  });

  const feedAgeMs = input.lastMessageAgeMs;
  const execStale =
    blockEntriesOnExecutionFeedStale &&
    feedStaleMaxAgeMs > 0 &&
    feedAgeMs > feedStaleMaxAgeMs;

  const riskCfg = risk.getConfig();
  const sigStale =
    riskCfg.blockEntriesOnSignalFeedStale &&
    feedStaleMaxAgeMs > 0 &&
    feedAgeMs > feedStaleMaxAgeMs;

  const book = input.book;
  const spreadBps = book?.spreadBps ?? Number.NaN;
  const baseRisk: RiskEvaluationInput = {
    nowMs: input.nowMs,
    lastCooldownAnchorMs,
    hasOpenPosition: !paper.isFlat(),
    execution: {
      feedStale: execStale,
      spreadBps,
      bookValid: isExecutableBook(book),
    },
  };
  const riskInput: RiskEvaluationInput = riskCfg.blockEntriesOnSignalFeedStale
    ? { ...baseRisk, signal: { feedStale: sigStale } }
    : baseRisk;

  const gate = risk.evaluateNewEntry(riskInput);
  const tickDiagnostics: FuturesStackTickDiagnostics = {
    signalActionable: sig.actionable,
    riskAllowed: gate.allowed,
  };
  const currentMid =
    input.mid !== null && Number.isFinite(input.mid)
      ? input.mid
      : input.book?.midPrice ?? null;
  const entryConfirmationTicks = Math.max(0, Math.trunc(rt.entryConfirmationTicks));
  const confirmationEnabled = entryConfirmationTicks > 0 || rt.entryRequireReversal;

  const emptyResult = (
    extra: Partial<FuturesStackStepResult> = {}
  ): FuturesStackStepResult => ({
    lastCooldownAnchorMs,
    closedRoundtrip,
    exitDecision,
    marginDecision,
    openAttempt: null,
    signalEvaluation: sig,
    riskEvaluationInput: riskInput,
    riskEvaluation: gate,
    entryConfirmation: null,
    tickDiagnostics,
    ...extra,
  });

  if (liquidatedThisTick) {
    return emptyResult();
  }

  const dir = sig.contrarianDirection;
  const validDirection = dir === "up" || dir === "down";
  const positionSide = validDirection ? positionSideFromSignalDirection(dir) : null;
  const snapshot = validDirection
    ? {
        impulseDirection: sig.impulseDirection,
        contrarianDirection: sig.contrarianDirection,
        strength: sig.strength,
      }
    : null;
  const pending = rt.pendingEntry;

  if (pending) {
    if (!sig.actionable || !validDirection || pending.contrarianDirection !== dir) {
      const cancelReason: "signal_invalid" | "direction_changed" =
        !sig.actionable || !validDirection ? "signal_invalid" : "direction_changed";
      const cancelled = {
        kind: "cancelled" as const,
        tradeId: pending.tradeId,
        side: pending.side,
        impulseDirection: pending.impulseDirection,
        contrarianDirection: pending.contrarianDirection,
        requiredTicks: pending.requiredTicks,
        ticksObserved: pending.observedTicks,
        firstObservedAtMs: pending.createdAtMs,
        lastObservedAtMs: pending.lastObservedAtMs,
        referenceMid: pending.firstObservedMid,
        lastObservedMid: pending.lastObservedMid,
        requireReversal: pending.requireReversal,
        cancelReason,
      };
      rt.pendingEntry = null;
      return emptyResult({ entryConfirmation: cancelled });
    }

    if (!(currentMid !== null && Number.isFinite(currentMid))) {
      const observedState = {
        ...pending,
        observedTicks: pending.observedTicks + 1,
        lastObservedAtMs: input.nowMs,
      };
      rt.pendingEntry = observedState;
      return emptyResult({
        entryConfirmation: {
          kind: "pending",
          tradeId: observedState.tradeId,
          side: observedState.side,
          impulseDirection: observedState.impulseDirection,
          contrarianDirection: observedState.contrarianDirection,
          requiredTicks: observedState.requiredTicks,
          ticksObserved: observedState.observedTicks,
          firstObservedAtMs: observedState.createdAtMs,
          lastObservedAtMs: observedState.lastObservedAtMs,
          referenceMid: observedState.firstObservedMid,
          lastObservedMid: observedState.lastObservedMid,
          requireReversal: observedState.requireReversal,
          pendingReason: "execution_blocked",
        },
      });
    }

    const confirmation = evaluateEntryConfirmation(
      pending,
      currentMid,
      input.nowMs,
      contract.tickSize
    );
    rt.pendingEntry = confirmation.observedState;

    if (!confirmation.satisfied) {
      return emptyResult({
        entryConfirmation: {
          kind: "pending",
          tradeId: confirmation.observedState.tradeId,
          side: confirmation.observedState.side,
          impulseDirection: confirmation.observedState.impulseDirection,
          contrarianDirection: confirmation.observedState.contrarianDirection,
          requiredTicks: confirmation.observedState.requiredTicks,
          ticksObserved: confirmation.observedState.observedTicks,
          firstObservedAtMs: confirmation.observedState.createdAtMs,
          lastObservedAtMs: confirmation.observedState.lastObservedAtMs,
          referenceMid: confirmation.observedState.firstObservedMid,
          lastObservedMid: confirmation.observedState.lastObservedMid,
          requireReversal: confirmation.observedState.requireReversal,
          pendingReason: confirmation.pendingReason,
        },
      });
    }

    if (!gate.allowed || !isExecutableBook(book)) {
      const pendingReason: "risk_blocked" | "execution_blocked" = !gate.allowed
        ? "risk_blocked"
        : "execution_blocked";
      return emptyResult({
        entryConfirmation: {
          kind: "pending",
          tradeId: confirmation.observedState.tradeId,
          side: confirmation.observedState.side,
          impulseDirection: confirmation.observedState.impulseDirection,
          contrarianDirection: confirmation.observedState.contrarianDirection,
          requiredTicks: confirmation.observedState.requiredTicks,
          ticksObserved: confirmation.observedState.observedTicks,
          firstObservedAtMs: confirmation.observedState.createdAtMs,
          lastObservedAtMs: confirmation.observedState.lastObservedAtMs,
          referenceMid: confirmation.observedState.firstObservedMid,
          lastObservedMid: confirmation.observedState.lastObservedMid,
          requireReversal: confirmation.observedState.requireReversal,
          pendingReason,
        },
      });
    }

    rt.pendingEntry = null;
    const tradeId = confirmation.observedState.tradeId;
    const positionSide = confirmation.observedState.side;
    const executableBook = book as TopOfBookL1;
    const rawEntryPrice = entryPriceForSide(executableBook, positionSide);
    const entryPrice = alignPriceToTick(
      rawEntryPrice,
      contract.tickSize,
      positionSide === "long" ? "up" : "down"
    );
    if (!(entryPrice > 0) || !Number.isFinite(entryPrice)) {
      const invalidTelemetry = buildTelemetry({
        contract,
        requestedQuantity: NaN,
        roundedQuantity: NaN,
        quantityValidationReason: null,
        entryPrice: rawEntryPrice,
        fillPrice: null,
        targetNotionalQuote: gate.suggestedSizeQuote,
        executedNotionalQuote: null,
        priceAligned: false,
      });
      return emptyResult({
        openAttempt: {
          ok: false,
          tradeId,
          reason: "invalid_book",
          side: positionSide,
          quantity: 0,
          stakeQuote: gate.suggestedSizeQuote,
          telemetry: invalidTelemetry,
        },
      });
    }

    const multiplier = getContractMultiplier(contract);
    const lotSize = contract.lotSize > 0 ? contract.lotSize : 0;
    const minQuantity = getMinQuantity(contract);
    const requestedQuantity = gate.suggestedSizeQuote / (entryPrice * multiplier);
    const roundedQuantity =
      lotSize > 0 ? floorToIncrement(requestedQuantity, lotSize) : requestedQuantity;
    const quantityValidationReason:
      | FuturesOrderTelemetry["quantityValidationReason"]
      = !(requestedQuantity > 0) || !Number.isFinite(requestedQuantity)
        ? "invalid_raw_quantity"
        : roundedQuantity < minQuantity
          ? "below_min_quantity"
          : null;
    const priceAligned = Math.abs(rawEntryPrice - entryPrice) > 1e-12;
    const invalidTelemetry = buildTelemetry({
      contract,
      requestedQuantity,
      roundedQuantity,
      quantityValidationReason,
      entryPrice,
      fillPrice: null,
      targetNotionalQuote: gate.suggestedSizeQuote,
      executedNotionalQuote: null,
      priceAligned,
    });
    if (
      quantityValidationReason !== null ||
      !(roundedQuantity > 0) ||
      !Number.isFinite(roundedQuantity)
    ) {
      return emptyResult({
        openAttempt: {
          ok: false,
          tradeId,
          reason: "invalid_quantity",
          side: positionSide,
          quantity: 0,
          stakeQuote: gate.suggestedSizeQuote,
          telemetry: invalidTelemetry,
        },
      });
    }

    const openOk =
      positionSide === "long"
        ? paper.openLong({
            instrumentId,
            quantity: roundedQuantity,
            book: executableBook,
            nowMs: input.nowMs,
            contract,
          })
        : paper.openShort({
            instrumentId,
            quantity: roundedQuantity,
            book: executableBook,
            nowMs: input.nowMs,
            contract,
          });

    if (!openOk.ok) {
      return emptyResult({
        openAttempt: {
          ok: false,
          tradeId,
          reason: openOk.reason,
          side: positionSide,
          quantity: roundedQuantity,
          stakeQuote: gate.suggestedSizeQuote,
          telemetry: invalidTelemetry,
        },
      });
    }

    const executedNotionalQuote = openOk.avgEntryPrice * roundedQuantity * multiplier;
    const telemetry = buildTelemetry({
      contract,
      requestedQuantity,
      roundedQuantity,
      quantityValidationReason: null,
      entryPrice,
      fillPrice: openOk.avgEntryPrice,
      targetNotionalQuote: gate.suggestedSizeQuote,
      executedNotionalQuote,
      priceAligned,
    });
    return {
      lastCooldownAnchorMs,
      closedRoundtrip,
      exitDecision,
      marginDecision,
      openAttempt: {
        ok: true,
        tradeId,
        side: positionSide,
        quantity: roundedQuantity,
        stakeQuote: gate.suggestedSizeQuote,
        entryPrice,
        avgEntryPrice: openOk.avgEntryPrice,
        feesOpenQuote: openOk.feesOpenQuote,
        entryConfirmation: {
          requiredTicks: confirmation.observedState.requiredTicks,
          ticksObserved: confirmation.observedState.observedTicks,
          requireReversal: confirmation.observedState.requireReversal,
          satisfiedBy: confirmation.satisfiedBy ?? "ticks",
          referenceMid: confirmation.observedState.firstObservedMid,
          lastObservedMid: confirmation.observedState.lastObservedMid,
        },
        telemetry,
      },
      ...(snapshot ? { openSignalSnapshot: snapshot } : {}),
      signalEvaluation: sig,
      riskEvaluationInput: riskInput,
      riskEvaluation: gate,
      entryConfirmation: null,
      tickDiagnostics,
    };
  }

  if (
    !sig.actionable ||
    !validDirection ||
    !paper.isFlat() ||
    !(currentMid !== null && Number.isFinite(currentMid))
  ) {
    return emptyResult();
  }

  if (!confirmationEnabled) {
    const positionSide = positionSideFromSignalDirection(dir as "up" | "down");
    const executableBook = book as TopOfBookL1;
    const rawEntryPrice = entryPriceForSide(executableBook, positionSide);
    const entryPrice = alignPriceToTick(
      rawEntryPrice,
      contract.tickSize,
      positionSide === "long" ? "up" : "down"
    );
    if (!(entryPrice > 0) || !Number.isFinite(entryPrice)) {
      const invalidTelemetry = buildTelemetry({
        contract,
        requestedQuantity: NaN,
        roundedQuantity: NaN,
        quantityValidationReason: null,
        entryPrice: rawEntryPrice,
        fillPrice: null,
        targetNotionalQuote: gate.suggestedSizeQuote,
        executedNotionalQuote: null,
        priceAligned: false,
      });
      return emptyResult({
        openAttempt: {
          ok: false,
          tradeId: `${instrumentId}:invalid_entry_price:${input.nowMs}:${input.tradeSequence}`,
          reason: "invalid_book",
          side: positionSide,
          quantity: 0,
          stakeQuote: gate.suggestedSizeQuote,
          telemetry: invalidTelemetry,
        },
      });
    }

    const multiplier = getContractMultiplier(contract);
    const lotSize = contract.lotSize > 0 ? contract.lotSize : 0;
    const minQuantity = getMinQuantity(contract);
    const requestedQuantity = gate.suggestedSizeQuote / (entryPrice * multiplier);
    const roundedQuantity =
      lotSize > 0 ? floorToIncrement(requestedQuantity, lotSize) : requestedQuantity;
    const quantityValidationReason:
      | FuturesOrderTelemetry["quantityValidationReason"]
      = !(requestedQuantity > 0) || !Number.isFinite(requestedQuantity)
        ? "invalid_raw_quantity"
        : roundedQuantity < minQuantity
          ? "below_min_quantity"
          : null;
    const priceAligned = Math.abs(rawEntryPrice - entryPrice) > 1e-12;
    const invalidTelemetry = buildTelemetry({
      contract,
      requestedQuantity,
      roundedQuantity,
      quantityValidationReason,
      entryPrice,
      fillPrice: null,
      targetNotionalQuote: gate.suggestedSizeQuote,
      executedNotionalQuote: null,
      priceAligned,
    });

    if (
      quantityValidationReason !== null ||
      !(roundedQuantity > 0) ||
      !Number.isFinite(roundedQuantity)
    ) {
      return emptyResult({
        openAttempt: {
          ok: false,
          tradeId: `${instrumentId}:invalid_quantity:${input.nowMs}:${input.tradeSequence}`,
          reason: "invalid_quantity",
          side: positionSide,
          quantity: 0,
          stakeQuote: gate.suggestedSizeQuote,
          telemetry: invalidTelemetry,
        },
      });
    }

    const tradeId = `${instrumentId}:${input.nowMs}:${input.tradeSequence}`;
    const openOk =
      positionSide === "long"
        ? paper.openLong({
            instrumentId,
            quantity: roundedQuantity,
            book: executableBook,
            nowMs: input.nowMs,
            contract,
          })
        : paper.openShort({
            instrumentId,
            quantity: roundedQuantity,
            book: executableBook,
            nowMs: input.nowMs,
            contract,
          });

    if (!openOk.ok) {
      return emptyResult({
        openAttempt: {
          ok: false,
          tradeId,
          reason: openOk.reason,
          side: positionSide,
          quantity: roundedQuantity,
          stakeQuote: gate.suggestedSizeQuote,
          telemetry: invalidTelemetry,
        },
      });
    }

    const executedNotionalQuote = openOk.avgEntryPrice * roundedQuantity * multiplier;
    const telemetry = buildTelemetry({
      contract,
      requestedQuantity,
      roundedQuantity,
      quantityValidationReason: null,
      entryPrice,
      fillPrice: openOk.avgEntryPrice,
      targetNotionalQuote: gate.suggestedSizeQuote,
      executedNotionalQuote,
      priceAligned,
    });
    return {
      lastCooldownAnchorMs,
      closedRoundtrip,
      exitDecision,
      marginDecision,
      openAttempt: {
        ok: true,
        tradeId,
        side: positionSide,
        quantity: roundedQuantity,
        stakeQuote: gate.suggestedSizeQuote,
        entryPrice,
        avgEntryPrice: openOk.avgEntryPrice,
        feesOpenQuote: openOk.feesOpenQuote,
        telemetry,
      },
      ...(snapshot ? { openSignalSnapshot: snapshot } : {}),
      signalEvaluation: sig,
      riskEvaluationInput: riskInput,
      riskEvaluation: gate,
      entryConfirmation: null,
      tickDiagnostics,
    };
  }

  const tradeId = `${instrumentId}:${input.nowMs}:${input.tradeSequence}`;
  const pendingImpulseDirection: "up" | "down" =
    sig.impulseDirection === "up" || sig.impulseDirection === "down"
      ? sig.impulseDirection
      : dir;
  const pendingState = buildEntryConfirmationState({
    tradeId,
    side: positionSideFromSignalDirection(dir as "up" | "down"),
    impulseDirection: pendingImpulseDirection,
    contrarianDirection: dir,
    createdAtMs: input.nowMs,
    tradeSequence: input.tradeSequence,
    mid: currentMid,
    requiredTicks: entryConfirmationTicks,
    requireReversal: rt.entryRequireReversal,
  });
  rt.pendingEntry = pendingState;
  return emptyResult({
    entryConfirmation: {
      kind: "pending",
      tradeId: pendingState.tradeId,
      side: pendingState.side,
      impulseDirection: pendingState.impulseDirection,
      contrarianDirection: pendingState.contrarianDirection,
      requiredTicks: pendingState.requiredTicks,
      ticksObserved: pendingState.observedTicks,
      firstObservedAtMs: pendingState.createdAtMs,
      lastObservedAtMs: pendingState.lastObservedAtMs,
      referenceMid: pendingState.firstObservedMid,
      lastObservedMid: pendingState.lastObservedMid,
      requireReversal: pendingState.requireReversal,
      pendingReason: pendingState.requireReversal ? "waiting_reversal" : "waiting_ticks",
    },
  });
}
