import type { InstrumentId } from "../domain/instrument.js";
import type { PositionSide } from "../domain/sides.js";
import type { FuturesPaperRoundtrip } from "../execution/futuresPaperTypes.js";
import type { SignalEvaluation } from "../signal/types.js";
import {
  FUTURES_REPORT_SCHEMA_VERSION,
  type FuturesSessionSummary,
  type LiquidationRiskEvent,
  type ExitExecutionSkippedEvent,
  type ExitPendingEvent,
  type ExitRetryEvent,
  type ExitRetryFailedEvent,
  type ForcedCloseEvent,
  type MarginWarningEvent,
  type ProfitLockTriggeredEvent,
  type TrailingProfitTriggeredEvent,
  type OrderInvalidQuantityEvent,
  type OrderNotionalMismatchEvent,
  type OrderQuantityRoundedEvent,
  type PaperLiquidationEvent,
  type PaperCloseEvent,
  type PaperOpenEvent,
  type PaperOpenRejectedEvent,
  type FuturesBalanceHistoryRecord,
  type FuturesBalanceProgress,
  type EntryConfirmationPendingEvent,
  type EntryConfirmationCancelledEvent,
  type RiskEvaluatedEvent,
  type SignalEvaluatedEvent,
  type SignalRejectedEvent,
  type TradeClosedEvent,
  type TradeOpenedEvent,
  type TradeUpdatedEvent,
  type SessionSummaryEvent,
  type FuturesSessionProgress,
} from "./futuresEventTypes.js";

function movementSummary(
  sig: SignalEvaluation
): SignalEvaluatedEvent["evaluation"]["movement"] {
  const m = sig.movement;
  return {
    strongestMoveFraction: m.strongestMoveFraction,
    strongestMoveAbsolute: m.strongestMoveAbsolute,
    impulseDirection: m.impulseDirection,
    thresholdFraction: m.thresholdFraction,
    thresholdRatio: m.thresholdRatio,
    strength: m.strength,
    referenceWindowLabel: m.referenceWindowLabel,
  };
}

function windowSummary(
  sig: SignalEvaluation
): SignalEvaluatedEvent["evaluation"]["window"] {
  const w = sig.window;
  return {
    strongestMoveFraction: w.strongestMoveFraction,
    impulseDirection: w.impulseDirection,
    strength: w.strength,
    referenceWindowLabel: w.referenceWindowLabel,
    referencePrice: w.referencePrice,
    currentSample: w.currentSample,
  };
}

export function buildSignalEvaluatedEvent(input: {
  sessionId: string;
  recordedAtMs: number;
  instrumentId?: InstrumentId;
  evaluation: SignalEvaluation;
}): SignalEvaluatedEvent {
  const e = input.evaluation;
  return {
    schemaVersion: FUTURES_REPORT_SCHEMA_VERSION,
    recordedAtMs: input.recordedAtMs,
    sessionId: input.sessionId,
    kind: "signal_evaluated",
    ...(input.instrumentId !== undefined
      ? { instrumentId: input.instrumentId }
      : {}),
    evaluation: {
      actionable: e.actionable,
      impulseDirection: e.impulseDirection,
      contrarianDirection: e.contrarianDirection,
      strength: e.strength,
      rejections: [...e.rejections],
      stableRangeDetected: e.stableRangeDetected,
      priorRangeFraction: e.priorRangeFraction,
      stableRangeQuality: e.stableRangeQuality,
      spikeDetected: e.spikeDetected,
      rangeDecisionNote: e.rangeDecisionNote,
      movement: movementSummary(e),
      window: windowSummary(e),
    },
  };
}

export function buildSignalRejectedEvent(input: {
  sessionId: string;
  recordedAtMs: number;
  instrumentId?: InstrumentId;
  evaluation: SignalEvaluation;
}): SignalRejectedEvent | null {
  if (input.evaluation.actionable) return null;
  const e = input.evaluation;
  return {
    schemaVersion: FUTURES_REPORT_SCHEMA_VERSION,
    recordedAtMs: input.recordedAtMs,
    sessionId: input.sessionId,
    kind: "signal_rejected",
    ...(input.instrumentId !== undefined
      ? { instrumentId: input.instrumentId }
      : {}),
    rejections: [...e.rejections],
    impulseDirection: e.impulseDirection,
    contrarianDirection: e.contrarianDirection,
    strength: e.strength,
  };
}

export function buildRiskEvaluatedEvent(input: {
  sessionId: string;
  recordedAtMs: number;
  instrumentId?: InstrumentId;
  evaluation: RiskEvaluatedEvent["evaluation"];
}): RiskEvaluatedEvent {
  return {
    schemaVersion: FUTURES_REPORT_SCHEMA_VERSION,
    recordedAtMs: input.recordedAtMs,
    sessionId: input.sessionId,
    kind: "risk_evaluated",
    ...(input.instrumentId !== undefined
      ? { instrumentId: input.instrumentId }
      : {}),
    evaluation: {
      allowed: input.evaluation.allowed,
      rejectionReasons: [...input.evaluation.rejectionReasons],
      suggestedSizeQuote: input.evaluation.suggestedSizeQuote,
      nowMs: input.evaluation.nowMs,
      lastCooldownAnchorMs: input.evaluation.lastCooldownAnchorMs,
      hasOpenPosition: input.evaluation.hasOpenPosition,
      execution: {
        feedStale: input.evaluation.execution.feedStale,
        spreadBps: input.evaluation.execution.spreadBps,
        ...(input.evaluation.execution.bookValid !== undefined
          ? { bookValid: input.evaluation.execution.bookValid }
          : {}),
      },
      ...(input.evaluation.signal !== undefined
        ? { signal: { feedStale: input.evaluation.signal.feedStale } }
        : {}),
      ...(input.evaluation.proposedSizeQuote !== undefined
        ? { proposedSizeQuote: input.evaluation.proposedSizeQuote }
        : {}),
    },
  };
}

export function buildMarginWarningEvent(input: {
  sessionId: string;
  recordedAtMs: number;
  tradeId: string;
  instrumentId: InstrumentId;
  side: PositionSide;
  holdDurationMs: number;
  margin: MarginWarningEvent["margin"];
  warningRatio: number;
}): MarginWarningEvent {
  return {
    schemaVersion: FUTURES_REPORT_SCHEMA_VERSION,
    recordedAtMs: input.recordedAtMs,
    sessionId: input.sessionId,
    kind: "margin_warning",
    tradeId: input.tradeId,
    instrumentId: input.instrumentId,
    side: input.side,
    holdDurationMs: input.holdDurationMs,
    margin: input.margin,
    warningRatio: input.warningRatio,
  };
}

export function buildLiquidationRiskEvent(input: {
  sessionId: string;
  recordedAtMs: number;
  tradeId: string;
  instrumentId: InstrumentId;
  side: PositionSide;
  holdDurationMs: number;
  margin: LiquidationRiskEvent["margin"];
  riskRatio: number;
}): LiquidationRiskEvent {
  return {
    schemaVersion: FUTURES_REPORT_SCHEMA_VERSION,
    recordedAtMs: input.recordedAtMs,
    sessionId: input.sessionId,
    kind: "liquidation_risk",
    tradeId: input.tradeId,
    instrumentId: input.instrumentId,
    side: input.side,
    holdDurationMs: input.holdDurationMs,
    margin: input.margin,
    riskRatio: input.riskRatio,
  };
}

export function buildProfitLockTriggeredEvent(input: {
  sessionId: string;
  recordedAtMs: number;
  tradeId: string;
  instrumentId: InstrumentId;
  side: PositionSide;
  quantityBase: number;
  entryPrice: number;
  exitPrice: number;
  estimatedNetPnlAtExitQuote: number;
  thresholdQuote: number;
  holdDurationMs: number;
}): ProfitLockTriggeredEvent {
  return {
    schemaVersion: FUTURES_REPORT_SCHEMA_VERSION,
    recordedAtMs: input.recordedAtMs,
    sessionId: input.sessionId,
    kind: "profit_lock_triggered",
    tradeId: input.tradeId,
    instrumentId: input.instrumentId,
    side: input.side,
    quantityBase: input.quantityBase,
    entryPrice: input.entryPrice,
    exitPrice: input.exitPrice,
    estimatedNetPnlAtExitQuote: input.estimatedNetPnlAtExitQuote,
    thresholdQuote: input.thresholdQuote,
    holdDurationMs: input.holdDurationMs,
    closeReason: "profit_lock",
  };
}

export function buildTrailingProfitTriggeredEvent(input: {
  sessionId: string;
  recordedAtMs: number;
  tradeId: string;
  instrumentId: InstrumentId;
  side: PositionSide;
  quantityBase: number;
  entryPrice: number;
  exitPrice: number;
  estimatedNetPnlAtExitQuote: number;
  peakEstimatedNetPnlAtExitQuote: number;
  dropFromPeakQuote: number;
  dropThresholdQuote: number;
  thresholdQuote: number;
  holdDurationMs: number;
}): TrailingProfitTriggeredEvent {
  return {
    schemaVersion: FUTURES_REPORT_SCHEMA_VERSION,
    recordedAtMs: input.recordedAtMs,
    sessionId: input.sessionId,
    kind: "trailing_profit_triggered",
    tradeId: input.tradeId,
    instrumentId: input.instrumentId,
    side: input.side,
    quantityBase: input.quantityBase,
    entryPrice: input.entryPrice,
    exitPrice: input.exitPrice,
    estimatedNetPnlAtExitQuote: input.estimatedNetPnlAtExitQuote,
    peakEstimatedNetPnlAtExitQuote: input.peakEstimatedNetPnlAtExitQuote,
    dropFromPeakQuote: input.dropFromPeakQuote,
    dropThresholdQuote: input.dropThresholdQuote,
    thresholdQuote: input.thresholdQuote,
    holdDurationMs: input.holdDurationMs,
    closeReason: "trailing_profit",
  };
}

export function buildPaperLiquidationEvent(input: {
  sessionId: string;
  recordedAtMs: number;
  tradeId: string;
  instrumentId: InstrumentId;
  side: PositionSide;
  quantityBase: number;
  entryPrice: number;
  markPrice: number;
  liquidationPriceEstimate: number;
  initialMarginQuote: number;
  maintenanceMarginQuote: number;
  marginBalanceQuote: number;
  unrealizedPnlQuote: number;
  marginRatio: number;
  liquidatedAtMs: number;
  liquidationReason: PaperLiquidationEvent["liquidationReason"];
}): PaperLiquidationEvent {
  return {
    schemaVersion: FUTURES_REPORT_SCHEMA_VERSION,
    recordedAtMs: input.recordedAtMs,
    sessionId: input.sessionId,
    kind: "paper_liquidation",
    tradeId: input.tradeId,
    instrumentId: input.instrumentId,
    side: input.side,
    quantityBase: input.quantityBase,
    entryPrice: input.entryPrice,
    markPrice: input.markPrice,
    liquidationPriceEstimate: input.liquidationPriceEstimate,
    initialMarginQuote: input.initialMarginQuote,
    maintenanceMarginQuote: input.maintenanceMarginQuote,
    marginBalanceQuote: input.marginBalanceQuote,
    unrealizedPnlQuote: input.unrealizedPnlQuote,
    marginRatio: input.marginRatio,
    liquidatedAtMs: input.liquidatedAtMs,
    closeReason: "paper_liquidation",
    liquidationReason: input.liquidationReason,
  };
}

export function buildTradeUpdatedEvent(input: {
  sessionId: string;
  recordedAtMs: number;
  tradeId: string;
  instrumentId: InstrumentId;
  updatedAtMs: number;
  midPrice?: number;
  markPrice?: number;
  unrealizedPnlQuote?: number;
  holdDurationMs?: number;
}): TradeUpdatedEvent {
  return {
    schemaVersion: FUTURES_REPORT_SCHEMA_VERSION,
    recordedAtMs: input.recordedAtMs,
    sessionId: input.sessionId,
    kind: "trade_updated",
    tradeId: input.tradeId,
    instrumentId: input.instrumentId,
    updatedAtMs: input.updatedAtMs,
    ...(input.midPrice !== undefined ? { midPrice: input.midPrice } : {}),
    ...(input.markPrice !== undefined ? { markPrice: input.markPrice } : {}),
    ...(input.unrealizedPnlQuote !== undefined
      ? { unrealizedPnlQuote: input.unrealizedPnlQuote }
      : {}),
    ...(input.holdDurationMs !== undefined
      ? { holdDurationMs: input.holdDurationMs }
      : {}),
  };
}

export function buildPaperOpenEvent(input: {
  sessionId: string;
  recordedAtMs: number;
  tradeId: string;
  instrumentId: InstrumentId;
  side: PositionSide;
  quantityBase: number;
  avgEntryPrice: number;
  openedAtMs: number;
  stakeQuote?: number;
  feesOpenQuote?: number;
  impulseDirection?: string;
  contrarianDirection?: string;
  strength?: string;
  entryConfirmation?: PaperOpenEvent["entryConfirmation"];
}): PaperOpenEvent {
  return {
    schemaVersion: FUTURES_REPORT_SCHEMA_VERSION,
    recordedAtMs: input.recordedAtMs,
    sessionId: input.sessionId,
    kind: "paper_open",
    tradeId: input.tradeId,
    instrumentId: input.instrumentId,
    side: input.side,
    quantityBase: input.quantityBase,
    avgEntryPrice: input.avgEntryPrice,
    openedAtMs: input.openedAtMs,
    ...(input.stakeQuote !== undefined ? { stakeQuote: input.stakeQuote } : {}),
    ...(input.feesOpenQuote !== undefined
      ? { feesOpenQuote: input.feesOpenQuote }
      : {}),
    ...(input.impulseDirection !== undefined
      ? { impulseDirection: input.impulseDirection }
      : {}),
    ...(input.contrarianDirection !== undefined
      ? { contrarianDirection: input.contrarianDirection }
      : {}),
    ...(input.strength !== undefined ? { strength: input.strength } : {}),
    ...(input.entryConfirmation !== undefined
      ? { entryConfirmation: input.entryConfirmation }
      : {}),
  };
}

export function buildPaperOpenRejectedEvent(input: {
  sessionId: string;
  recordedAtMs: number;
  tradeId: string;
  instrumentId: InstrumentId;
  reason: string;
  side: PositionSide;
  quantityBase: number;
  stakeQuote: number;
  impulseDirection?: string;
  contrarianDirection?: string;
  strength?: string;
}): PaperOpenRejectedEvent {
  return {
    schemaVersion: FUTURES_REPORT_SCHEMA_VERSION,
    recordedAtMs: input.recordedAtMs,
    sessionId: input.sessionId,
    kind: "paper_open_rejected",
    tradeId: input.tradeId,
    instrumentId: input.instrumentId,
    reason: input.reason,
    side: input.side,
    quantityBase: input.quantityBase,
    stakeQuote: input.stakeQuote,
    ...(input.impulseDirection !== undefined
      ? { impulseDirection: input.impulseDirection }
      : {}),
    ...(input.contrarianDirection !== undefined
      ? { contrarianDirection: input.contrarianDirection }
      : {}),
    ...(input.strength !== undefined ? { strength: input.strength } : {}),
  };
}

export function buildEntryConfirmationPendingEvent(input: {
  sessionId: string;
  recordedAtMs: number;
  tradeId: string;
  instrumentId: InstrumentId;
  side: PositionSide;
  impulseDirection: "up" | "down";
  contrarianDirection: "up" | "down";
  requiredTicks: number;
  ticksObserved: number;
  firstObservedAtMs: number;
  lastObservedAtMs: number;
  referenceMid: number;
  lastObservedMid: number;
  requireReversal: boolean;
  pendingReason: EntryConfirmationPendingEvent["pendingReason"];
}): EntryConfirmationPendingEvent {
  return {
    schemaVersion: FUTURES_REPORT_SCHEMA_VERSION,
    recordedAtMs: input.recordedAtMs,
    sessionId: input.sessionId,
    kind: "entry_confirmation_pending",
    tradeId: input.tradeId,
    instrumentId: input.instrumentId,
    side: input.side,
    impulseDirection: input.impulseDirection,
    contrarianDirection: input.contrarianDirection,
    requiredTicks: input.requiredTicks,
    ticksObserved: input.ticksObserved,
    firstObservedAtMs: input.firstObservedAtMs,
    lastObservedAtMs: input.lastObservedAtMs,
    referenceMid: input.referenceMid,
    lastObservedMid: input.lastObservedMid,
    requireReversal: input.requireReversal,
    pendingReason: input.pendingReason,
  };
}

export function buildEntryConfirmationCancelledEvent(input: {
  sessionId: string;
  recordedAtMs: number;
  tradeId: string;
  instrumentId: InstrumentId;
  side: PositionSide;
  impulseDirection: "up" | "down";
  contrarianDirection: "up" | "down";
  requiredTicks: number;
  ticksObserved: number;
  firstObservedAtMs: number;
  lastObservedAtMs: number;
  referenceMid: number;
  lastObservedMid: number;
  requireReversal: boolean;
  cancelReason: EntryConfirmationCancelledEvent["cancelReason"];
}): EntryConfirmationCancelledEvent {
  return {
    schemaVersion: FUTURES_REPORT_SCHEMA_VERSION,
    recordedAtMs: input.recordedAtMs,
    sessionId: input.sessionId,
    kind: "entry_confirmation_cancelled",
    tradeId: input.tradeId,
    instrumentId: input.instrumentId,
    side: input.side,
    impulseDirection: input.impulseDirection,
    contrarianDirection: input.contrarianDirection,
    requiredTicks: input.requiredTicks,
    ticksObserved: input.ticksObserved,
    firstObservedAtMs: input.firstObservedAtMs,
    lastObservedAtMs: input.lastObservedAtMs,
    referenceMid: input.referenceMid,
    lastObservedMid: input.lastObservedMid,
    requireReversal: input.requireReversal,
    cancelReason: input.cancelReason,
  };
}

export function buildOrderQuantityRoundedEvent(input: {
  sessionId: string;
  recordedAtMs: number;
  tradeId: string;
  instrumentId: InstrumentId;
  side: PositionSide;
  requestedQuantity: number;
  roundedQuantity: number;
  lotSize: number;
  minQuantity: number;
}): OrderQuantityRoundedEvent {
  return {
    schemaVersion: FUTURES_REPORT_SCHEMA_VERSION,
    recordedAtMs: input.recordedAtMs,
    sessionId: input.sessionId,
    kind: "order_quantity_rounded",
    tradeId: input.tradeId,
    instrumentId: input.instrumentId,
    side: input.side,
    requestedQuantity: input.requestedQuantity,
    roundedQuantity: input.roundedQuantity,
    lotSize: input.lotSize,
    minQuantity: input.minQuantity,
    quantityDelta: input.roundedQuantity - input.requestedQuantity,
  };
}

export function buildOrderInvalidQuantityEvent(input: {
  sessionId: string;
  recordedAtMs: number;
  tradeId: string;
  instrumentId: InstrumentId;
  side: PositionSide;
  requestedQuantity: number;
  roundedQuantity: number;
  lotSize: number;
  minQuantity: number;
  reason: OrderInvalidQuantityEvent["reason"];
}): OrderInvalidQuantityEvent {
  return {
    schemaVersion: FUTURES_REPORT_SCHEMA_VERSION,
    recordedAtMs: input.recordedAtMs,
    sessionId: input.sessionId,
    kind: "order_invalid_quantity",
    tradeId: input.tradeId,
    instrumentId: input.instrumentId,
    side: input.side,
    requestedQuantity: input.requestedQuantity,
    roundedQuantity: input.roundedQuantity,
    lotSize: input.lotSize,
    minQuantity: input.minQuantity,
    reason: input.reason,
  };
}

export function buildOrderNotionalMismatchEvent(input: {
  sessionId: string;
  recordedAtMs: number;
  tradeId: string;
  instrumentId: InstrumentId;
  side: PositionSide;
  requestedQuantity: number;
  roundedQuantity: number;
  entryPrice: number;
  fillPrice: number;
  contractMultiplier: number;
  targetNotionalQuote: number;
  executedNotionalQuote: number;
  priceAligned: boolean;
}): OrderNotionalMismatchEvent {
  return {
    schemaVersion: FUTURES_REPORT_SCHEMA_VERSION,
    recordedAtMs: input.recordedAtMs,
    sessionId: input.sessionId,
    kind: "order_notional_mismatch",
    tradeId: input.tradeId,
    instrumentId: input.instrumentId,
    side: input.side,
    requestedQuantity: input.requestedQuantity,
    roundedQuantity: input.roundedQuantity,
    entryPrice: input.entryPrice,
    fillPrice: input.fillPrice,
    contractMultiplier: input.contractMultiplier,
    targetNotionalQuote: input.targetNotionalQuote,
    executedNotionalQuote: input.executedNotionalQuote,
    notionalDeltaQuote: input.executedNotionalQuote - input.targetNotionalQuote,
    notionalDeltaBps:
      input.targetNotionalQuote > 0
        ? ((input.executedNotionalQuote - input.targetNotionalQuote) /
            input.targetNotionalQuote) *
          10_000
        : 0,
    quantityRounded: Math.abs(input.roundedQuantity - input.requestedQuantity) > 1e-12,
    priceAligned: input.priceAligned,
  };
}

export function buildExitPendingEvent(input: {
  sessionId: string;
  recordedAtMs: number;
  tradeId: string;
  instrumentId: InstrumentId;
  trigger: ExitPendingEvent["trigger"];
  pendingReason: ExitPendingEvent["pendingReason"];
  firstTriggeredAtMs: number;
  lastAttemptAtMs: number;
  graceDeadlineAtMs: number;
  attemptCount: number;
}): ExitPendingEvent {
  return {
    schemaVersion: FUTURES_REPORT_SCHEMA_VERSION,
    recordedAtMs: input.recordedAtMs,
    sessionId: input.sessionId,
    kind: "exit_pending",
    tradeId: input.tradeId,
    instrumentId: input.instrumentId,
    trigger: input.trigger,
    pendingReason: input.pendingReason,
    firstTriggeredAtMs: input.firstTriggeredAtMs,
    lastAttemptAtMs: input.lastAttemptAtMs,
    graceDeadlineAtMs: input.graceDeadlineAtMs,
    attemptCount: input.attemptCount,
  };
}

export function buildExitRetryEvent(input: {
  sessionId: string;
  recordedAtMs: number;
  tradeId: string;
  instrumentId: InstrumentId;
  trigger: ExitRetryEvent["trigger"];
  pendingReason: ExitRetryEvent["pendingReason"];
  attemptCount: number;
  lastAttemptAtMs: number;
}): ExitRetryEvent {
  return {
    schemaVersion: FUTURES_REPORT_SCHEMA_VERSION,
    recordedAtMs: input.recordedAtMs,
    sessionId: input.sessionId,
    kind: "exit_retry",
    tradeId: input.tradeId,
    instrumentId: input.instrumentId,
    trigger: input.trigger,
    pendingReason: input.pendingReason,
    attemptCount: input.attemptCount,
    lastAttemptAtMs: input.lastAttemptAtMs,
  };
}

export function buildExitRetryFailedEvent(input: {
  sessionId: string;
  recordedAtMs: number;
  tradeId: string;
  instrumentId: InstrumentId;
  trigger: ExitRetryFailedEvent["trigger"];
  pendingReason: ExitRetryFailedEvent["pendingReason"];
  attemptCount: number;
  lastAttemptAtMs: number;
  graceDeadlineAtMs: number;
  closeReason: ExitRetryFailedEvent["closeReason"];
}): ExitRetryFailedEvent {
  return {
    schemaVersion: FUTURES_REPORT_SCHEMA_VERSION,
    recordedAtMs: input.recordedAtMs,
    sessionId: input.sessionId,
    kind: "exit_retry_failed",
    tradeId: input.tradeId,
    instrumentId: input.instrumentId,
    trigger: input.trigger,
    pendingReason: input.pendingReason,
    attemptCount: input.attemptCount,
    lastAttemptAtMs: input.lastAttemptAtMs,
    graceDeadlineAtMs: input.graceDeadlineAtMs,
    closeReason: input.closeReason,
  };
}

export function buildForcedCloseEvent(input: {
  sessionId: string;
  recordedAtMs: number;
  tradeId: string;
  instrumentId: InstrumentId;
  trigger: ForcedCloseEvent["trigger"];
  pendingReason: ForcedCloseEvent["pendingReason"];
  attemptCount: number;
  forcedAtMs: number;
  closeReason: ForcedCloseEvent["closeReason"];
}): ForcedCloseEvent {
  return {
    schemaVersion: FUTURES_REPORT_SCHEMA_VERSION,
    recordedAtMs: input.recordedAtMs,
    sessionId: input.sessionId,
    kind: "forced_close",
    tradeId: input.tradeId,
    instrumentId: input.instrumentId,
    trigger: input.trigger,
    pendingReason: input.pendingReason,
    attemptCount: input.attemptCount,
    forcedAtMs: input.forcedAtMs,
    closeReason: input.closeReason,
  };
}

export function buildExitExecutionSkippedEvent(input: {
  sessionId: string;
  recordedAtMs: number;
  tradeId: string;
  instrumentId: InstrumentId;
  trigger: ExitExecutionSkippedEvent["trigger"];
  pendingReason: ExitExecutionSkippedEvent["pendingReason"];
  attemptCount: number;
  executionSkipReason: ExitExecutionSkippedEvent["executionSkipReason"];
}): ExitExecutionSkippedEvent {
  return {
    schemaVersion: FUTURES_REPORT_SCHEMA_VERSION,
    recordedAtMs: input.recordedAtMs,
    sessionId: input.sessionId,
    kind: "exit_execution_skipped",
    tradeId: input.tradeId,
    instrumentId: input.instrumentId,
    trigger: input.trigger,
    pendingReason: input.pendingReason,
    attemptCount: input.attemptCount,
    executionSkipReason: input.executionSkipReason,
  };
}

export function buildPaperCloseEvent(input: {
  sessionId: string;
  recordedAtMs: number;
  tradeId: string;
  roundtrip: FuturesPaperRoundtrip;
}): PaperCloseEvent {
  const r = input.roundtrip;
  const holdDurationMs = Math.max(0, r.closedAtMs - r.openedAtMs);
  return {
    schemaVersion: FUTURES_REPORT_SCHEMA_VERSION,
    recordedAtMs: input.recordedAtMs,
    sessionId: input.sessionId,
    kind: "paper_close",
    tradeId: input.tradeId,
    instrumentId: r.instrumentId,
    side: r.side,
    quantityBase: r.quantity,
    entryPrice: r.entryPrice,
    exitPrice: r.exitPrice,
    grossPnlQuote: r.grossPnlQuote,
    feesQuote: r.feesQuote,
    ...(r.spreadCost !== undefined ? { spreadCostQuote: r.spreadCost } : {}),
    ...(r.slippageCost !== undefined ? { slippageCostQuote: r.slippageCost } : {}),
    ...(r.latencyCost !== undefined ? { latencyCostQuote: r.latencyCost } : {}),
    ...(r.fundingCost !== undefined ? { fundingCostQuote: r.fundingCost } : {}),
    netPnlQuote: r.netPnlQuote,
    ...(r.grossPnl !== undefined ? { grossPnl: r.grossPnl } : {}),
    ...(r.fees !== undefined ? { fees: r.fees } : {}),
    ...(r.spreadCost !== undefined ? { spreadCost: r.spreadCost } : {}),
    ...(r.slippageCost !== undefined ? { slippageCost: r.slippageCost } : {}),
    ...(r.latencyCost !== undefined ? { latencyCost: r.latencyCost } : {}),
    ...(r.fundingCost !== undefined ? { fundingCost: r.fundingCost } : {}),
    ...(r.netPnl !== undefined ? { netPnl: r.netPnl } : {}),
    ...(r.edgeBeforeCosts !== undefined
      ? { edgeBeforeCosts: r.edgeBeforeCosts }
      : {}),
    ...(r.edgeAfterCosts !== undefined ? { edgeAfterCosts: r.edgeAfterCosts } : {}),
    openedAtMs: r.openedAtMs,
    closedAtMs: r.closedAtMs,
    closeReason: r.closeReason,
    holdDurationMs,
  };
}

export function buildSessionSummaryEvent(input: {
  sessionId: string;
  recordedAtMs: number;
  summary: FuturesSessionSummary;
}): SessionSummaryEvent {
  return {
    schemaVersion: FUTURES_REPORT_SCHEMA_VERSION,
    recordedAtMs: input.recordedAtMs,
    sessionId: input.sessionId,
    kind: "session_summary",
    summary: input.summary,
  };
}

export function buildSessionProgressEvent(input: {
  sessionId: string;
  recordedAtMs: number;
  sessionStartedAt: string;
  snapshotAt: string;
  runtimeMs: number;
  outputDirectory: string;
  instrumentId?: InstrumentId;
  counters: FuturesSessionProgress["counters"];
  pnl: FuturesSessionProgress["pnl"];
  balance?: FuturesSessionProgress["balance"];
  feed: FuturesSessionProgress["feed"];
  position?: FuturesSessionProgress["position"];
}): FuturesSessionProgress {
  return {
    schemaVersion: FUTURES_REPORT_SCHEMA_VERSION,
    recordedAtMs: input.recordedAtMs,
    sessionId: input.sessionId,
    kind: "session_progress",
    sessionStartedAt: input.sessionStartedAt,
    snapshotAt: input.snapshotAt,
    runtimeMs: input.runtimeMs,
    outputDirectory: input.outputDirectory,
    ...(input.instrumentId !== undefined ? { instrumentId: input.instrumentId } : {}),
    counters: input.counters,
    pnl: input.pnl,
    ...(input.balance !== undefined ? { balance: input.balance } : {}),
    ...(input.position !== undefined ? { position: input.position } : {}),
    feed: input.feed,
  };
}

export function buildBalanceProgressEvent(input: {
  sessionId: string;
  recordedAtMs: number;
  sessionStartedAt: string;
  snapshotAt: string;
  runtimeMs: number;
  outputDirectory: string;
  instrumentId?: InstrumentId;
  dailyCurve: FuturesBalanceProgress["dailyCurve"];
  balance: FuturesBalanceProgress["balance"];
  performance: FuturesBalanceProgress["performance"];
  runStatus: FuturesBalanceProgress["runStatus"];
  feed: FuturesBalanceProgress["feed"];
}): FuturesBalanceProgress {
  return {
    schemaVersion: FUTURES_REPORT_SCHEMA_VERSION,
    recordedAtMs: input.recordedAtMs,
    sessionId: input.sessionId,
    kind: "balance_progress",
    sessionStartedAt: input.sessionStartedAt,
    snapshotAt: input.snapshotAt,
    runtimeMs: input.runtimeMs,
    outputDirectory: input.outputDirectory,
    ...(input.instrumentId !== undefined ? { instrumentId: input.instrumentId } : {}),
    dailyCurve: input.dailyCurve,
    balance: input.balance,
    performance: input.performance,
    runStatus: input.runStatus,
    feed: input.feed,
  };
}

export function buildBalanceHistoryRecord(input: {
  sessionId: string;
  recordedAtMs: number;
  kind: FuturesBalanceHistoryRecord["kind"];
  currentBalance: number;
  currentEquity: number;
  activeStake: number;
  stakeMode: FuturesBalanceHistoryRecord["stakeMode"];
  realizedNetPnlQuote: number;
  tradesClosed: number;
  closedWinCount: number;
  closedLossCount: number;
  stopRequested?: boolean;
  stopReason?: string | null;
  previousStakeMode?: FuturesBalanceHistoryRecord["previousStakeMode"];
  previousActiveStake?: number;
  newStakeMode?: FuturesBalanceHistoryRecord["newStakeMode"];
  newActiveStake?: number;
}): FuturesBalanceHistoryRecord {
  return {
    schemaVersion: FUTURES_REPORT_SCHEMA_VERSION,
    recordedAtMs: input.recordedAtMs,
    sessionId: input.sessionId,
    kind: input.kind,
    currentBalance: input.currentBalance,
    currentEquity: input.currentEquity,
    activeStake: input.activeStake,
    stakeMode: input.stakeMode,
    realizedNetPnlQuote: input.realizedNetPnlQuote,
    tradesClosed: input.tradesClosed,
    closedWinCount: input.closedWinCount,
    closedLossCount: input.closedLossCount,
    ...(input.stopRequested !== undefined
      ? { stopRequested: input.stopRequested }
      : {}),
    ...(input.stopReason !== undefined ? { stopReason: input.stopReason } : {}),
    ...(input.previousStakeMode !== undefined
      ? { previousStakeMode: input.previousStakeMode }
      : {}),
    ...(input.previousActiveStake !== undefined
      ? { previousActiveStake: input.previousActiveStake }
      : {}),
    ...(input.newStakeMode !== undefined ? { newStakeMode: input.newStakeMode } : {}),
    ...(input.newActiveStake !== undefined ? { newActiveStake: input.newActiveStake } : {}),
  };
}

export function buildTradeOpenedEvent(input: Parameters<typeof buildPaperOpenEvent>[0]): TradeOpenedEvent {
  return buildPaperOpenEvent(input);
}

export function buildTradeClosedEvent(input: Parameters<typeof buildPaperCloseEvent>[0]): TradeClosedEvent {
  return buildPaperCloseEvent(input);
}
