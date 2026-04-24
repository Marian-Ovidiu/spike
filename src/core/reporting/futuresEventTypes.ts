/**
 * Neutral futures reporting schema (JSONL + session snapshot).
 * No prediction-market or binary-outcome semantics — see LEGACY_EXCLUSIONS.md.
 */
import type { InstrumentId } from "../domain/instrument.js";
import type { PositionSide } from "../domain/sides.js";
import type {
  FuturesPaperCloseReason,
  FuturesPaperExitPendingReason,
  FuturesPaperExitTrigger,
  FuturesPaperMarginSnapshot,
} from "../execution/futuresPaperTypes.js";

export const FUTURES_REPORT_SCHEMA_VERSION = 1 as const;

/** Shared envelope for every append-only JSONL row. */
export type FuturesReportEnvelope = {
  readonly schemaVersion: typeof FUTURES_REPORT_SCHEMA_VERSION;
  /** Wall-clock when the row was written (not necessarily exchange event time). */
  readonly recordedAtMs: number;
  /** Correlates all rows from one process run / monitor session. */
  readonly sessionId: string;
};

/** Compact movement summary (mirrors core signal naming, no venue fields). */
export type FuturesReportMovementSummary = {
  readonly strongestMoveFraction: number;
  readonly strongestMoveAbsolute: number;
  readonly impulseDirection: string;
  readonly thresholdFraction: number;
  readonly thresholdRatio: number;
  readonly strength: string;
  readonly referenceWindowLabel: string | null;
};

/** Compact window snapshot for logs (subset of full spike/window math). */
export type FuturesReportWindowSummary = {
  readonly strongestMoveFraction: number;
  readonly impulseDirection: string;
  readonly strength: string;
  readonly referenceWindowLabel: string | null;
  readonly referencePrice: number;
  readonly currentSample: number;
};

/**
 * Full signal path outcome after `evaluateSignalConditions` (or equivalent).
 * Emitted when the strategy layer evaluates the rolling window (may be every tick or throttled).
 */
export type SignalEvaluatedEvent = FuturesReportEnvelope & {
  readonly kind: "signal_evaluated";
  readonly instrumentId?: InstrumentId;
  readonly evaluation: {
    readonly actionable: boolean;
    readonly impulseDirection: string;
    readonly contrarianDirection: string;
    readonly strength: string;
    readonly rejections: readonly string[];
    readonly stableRangeDetected: boolean;
    readonly priorRangeFraction: number;
    readonly stableRangeQuality: string;
    readonly spikeDetected: boolean;
    readonly rangeDecisionNote: string;
    readonly movement: FuturesReportMovementSummary;
    readonly window: FuturesReportWindowSummary;
  };
};

/**
 * Lightweight row when the signal path fails (`actionable === false`).
 * Can be omitted if consumers filter {@link SignalEvaluatedEvent} instead.
 */
export type SignalRejectedEvent = FuturesReportEnvelope & {
  readonly kind: "signal_rejected";
  readonly instrumentId?: InstrumentId;
  readonly rejections: readonly string[];
  readonly impulseDirection: string;
  readonly contrarianDirection: string;
  readonly strength: string;
};

export type RiskEvaluatedEvent = FuturesReportEnvelope & {
  readonly kind: "risk_evaluated";
  readonly instrumentId?: InstrumentId;
  readonly evaluation: {
    readonly allowed: boolean;
    readonly rejectionReasons: readonly string[];
    readonly suggestedSizeQuote: number;
    readonly nowMs: number;
    readonly lastCooldownAnchorMs: number | null;
    readonly hasOpenPosition: boolean;
    readonly execution: {
      readonly feedStale: boolean;
      readonly spreadBps: number;
      readonly bookValid?: boolean;
    };
    readonly signal?: {
      readonly feedStale: boolean;
    };
    readonly proposedSizeQuote?: number;
  };
};

export type MarginWarningEvent = FuturesReportEnvelope & {
  readonly kind: "margin_warning";
  readonly tradeId: string;
  readonly instrumentId: InstrumentId;
  readonly side: PositionSide;
  readonly holdDurationMs: number;
  readonly margin: FuturesPaperMarginSnapshot;
  readonly warningRatio: number;
};

export type LiquidationRiskEvent = FuturesReportEnvelope & {
  readonly kind: "liquidation_risk";
  readonly tradeId: string;
  readonly instrumentId: InstrumentId;
  readonly side: PositionSide;
  readonly holdDurationMs: number;
  readonly margin: FuturesPaperMarginSnapshot;
  readonly riskRatio: number;
};

export type FuturesBalanceSnapshot = {
  readonly currentBalance: number;
  readonly currentEquity: number;
  readonly activeStake: number;
  readonly stakeMode: "fixed" | "compounding";
  readonly stopRequested: boolean;
  readonly stopReason: string | null;
};

export type FuturesBalanceDailyCurvePoint = {
  readonly date: string;
  readonly balanceStartOfDay: number;
  readonly balanceEndOfDay: number;
  readonly dailyReturnPct: number;
  readonly returnRatePctPerHour: number;
  readonly peakBalanceSeen: number;
  readonly maxDrawdownPctSeen: number;
};

export type FuturesBalanceHistoryRecord = FuturesReportEnvelope & {
  readonly kind:
    | "balance_initialized"
    | "balance_updated_after_trade"
    | "stake_mode_changed"
    | "stop_triggered_due_to_balance"
    | "periodic_balance_snapshot";
  readonly currentBalance: number;
  readonly currentEquity: number;
  readonly activeStake: number;
  readonly stakeMode: "fixed" | "compounding";
  readonly realizedNetPnlQuote: number;
  readonly tradesClosed: number;
  readonly closedWinCount: number;
  readonly closedLossCount: number;
  readonly stopRequested?: boolean;
  readonly stopReason?: string | null;
  readonly previousStakeMode?: "fixed" | "compounding";
  readonly previousActiveStake?: number;
  readonly newStakeMode?: "fixed" | "compounding";
  readonly newActiveStake?: number;
};

export type FuturesBalanceProgress = FuturesReportEnvelope & {
  readonly kind: "balance_progress";
  readonly sessionStartedAt: string;
  readonly snapshotAt: string;
  readonly runtimeMs: number;
  readonly outputDirectory: string;
  readonly instrumentId?: InstrumentId;
  readonly dailyCurve: readonly FuturesBalanceDailyCurvePoint[];
  readonly balance: FuturesBalanceSnapshot & {
    readonly startingBalance: number;
    readonly reserveBalance: number;
    readonly minBalanceToContinue: number;
    readonly fixedStakeUntilBalance: number;
  };
  readonly performance: {
    readonly realizedNetPnlQuote: number;
    readonly unrealizedPnlQuote: number;
    readonly returnPctOnStartingBalance: number;
    readonly peakBalance: number;
    readonly drawdownPct: number;
    readonly tradesOpened: number;
    readonly tradesClosed: number;
    readonly closedWinCount: number;
    readonly closedLossCount: number;
    readonly closedBreakevenCount: number;
    readonly avgWin: number;
    readonly avgLoss: number;
    readonly winRate: number;
  };
  readonly runStatus: {
    readonly hasOpenPosition: boolean;
    readonly currentTradeId?: string;
    readonly side?: PositionSide;
    readonly entryPrice?: number;
    readonly currentMarkPrice?: number;
    readonly holdDurationMs?: number;
  };
  readonly feed: {
    readonly bootstrapRestOk: boolean;
    readonly lastMessageAgeMs?: number;
    readonly feedStale?: boolean;
    readonly bookValid?: boolean;
  };
};

export type ProfitLockTriggeredEvent = FuturesReportEnvelope & {
  readonly kind: "profit_lock_triggered";
  readonly tradeId: string;
  readonly instrumentId: InstrumentId;
  readonly side: PositionSide;
  readonly quantityBase: number;
  readonly entryPrice: number;
  readonly exitPrice: number;
  readonly estimatedNetPnlAtExitQuote: number;
  readonly thresholdQuote: number;
  readonly holdDurationMs: number;
  readonly closeReason: "profit_lock";
};

export type TrailingProfitTriggeredEvent = FuturesReportEnvelope & {
  readonly kind: "trailing_profit_triggered";
  readonly tradeId: string;
  readonly instrumentId: InstrumentId;
  readonly side: PositionSide;
  readonly quantityBase: number;
  readonly entryPrice: number;
  readonly exitPrice: number;
  readonly estimatedNetPnlAtExitQuote: number;
  readonly peakEstimatedNetPnlAtExitQuote: number;
  readonly dropFromPeakQuote: number;
  readonly dropThresholdQuote: number;
  readonly thresholdQuote: number;
  readonly holdDurationMs: number;
  readonly closeReason: "trailing_profit";
};

export type PaperLiquidationEvent = FuturesReportEnvelope & {
  readonly kind: "paper_liquidation";
  readonly tradeId: string;
  readonly instrumentId: InstrumentId;
  readonly side: PositionSide;
  readonly quantityBase: number;
  readonly entryPrice: number;
  readonly markPrice: number;
  readonly liquidationPriceEstimate: number;
  readonly initialMarginQuote: number;
  readonly maintenanceMarginQuote: number;
  readonly marginBalanceQuote: number;
  readonly unrealizedPnlQuote: number;
  readonly marginRatio: number;
  readonly liquidatedAtMs: number;
  readonly closeReason: "paper_liquidation";
  readonly liquidationReason: "maintenance_breach" | "threshold_breach";
};

/** Paper/sim execution: position opened at the venue model. */
export type PaperOpenEvent = FuturesReportEnvelope & {
  readonly kind: "paper_open";
  readonly tradeId: string;
  readonly instrumentId: InstrumentId;
  readonly side: PositionSide;
  /** Base quantity (coins / contracts). */
  readonly quantityBase: number;
  readonly avgEntryPrice: number;
  /** Intended stake in quote currency before fees (if sized from quote). */
  readonly stakeQuote?: number;
  readonly feesOpenQuote?: number;
  readonly openedAtMs: number;
  readonly impulseDirection?: string;
  readonly contrarianDirection?: string;
  readonly strength?: string;
  readonly entryConfirmation?: {
    readonly requiredTicks: number;
    readonly ticksObserved: number;
    readonly requireReversal: boolean;
    readonly satisfiedBy: "ticks" | "stall" | "reversal";
    readonly referenceMid: number;
    readonly lastObservedMid: number;
  };
};

export type PaperOpenRejectedEvent = FuturesReportEnvelope & {
  readonly kind: "paper_open_rejected";
  readonly tradeId: string;
  readonly instrumentId: InstrumentId;
  readonly reason: string;
  readonly side: PositionSide;
  readonly quantityBase: number;
  readonly stakeQuote: number;
  readonly impulseDirection?: string;
  readonly contrarianDirection?: string;
  readonly strength?: string;
};

export type EntryConfirmationPendingReason =
  | "waiting_ticks"
  | "waiting_slowdown"
  | "waiting_reversal"
  | "risk_blocked"
  | "execution_blocked";

export type EntryConfirmationCancelReason =
  | "signal_invalid"
  | "direction_changed";

export type EntryConfirmationPendingEvent = FuturesReportEnvelope & {
  readonly kind: "entry_confirmation_pending";
  readonly tradeId: string;
  readonly instrumentId: InstrumentId;
  readonly side: PositionSide;
  readonly impulseDirection: "up" | "down";
  readonly contrarianDirection: "up" | "down";
  readonly requiredTicks: number;
  readonly ticksObserved: number;
  readonly firstObservedAtMs: number;
  readonly lastObservedAtMs: number;
  readonly referenceMid: number;
  readonly lastObservedMid: number;
  readonly requireReversal: boolean;
  readonly pendingReason: EntryConfirmationPendingReason;
};

export type EntryConfirmationCancelledEvent = FuturesReportEnvelope & {
  readonly kind: "entry_confirmation_cancelled";
  readonly tradeId: string;
  readonly instrumentId: InstrumentId;
  readonly side: PositionSide;
  readonly impulseDirection: "up" | "down";
  readonly contrarianDirection: "up" | "down";
  readonly requiredTicks: number;
  readonly ticksObserved: number;
  readonly firstObservedAtMs: number;
  readonly lastObservedAtMs: number;
  readonly referenceMid: number;
  readonly lastObservedMid: number;
  readonly requireReversal: boolean;
  readonly cancelReason: EntryConfirmationCancelReason;
};

export type OrderQuantityRoundedEvent = FuturesReportEnvelope & {
  readonly kind: "order_quantity_rounded";
  readonly tradeId: string;
  readonly instrumentId: InstrumentId;
  readonly side: PositionSide;
  readonly requestedQuantity: number;
  readonly roundedQuantity: number;
  readonly lotSize: number;
  readonly minQuantity: number;
  readonly quantityDelta: number;
};

export type OrderInvalidQuantityEvent = FuturesReportEnvelope & {
  readonly kind: "order_invalid_quantity";
  readonly tradeId: string;
  readonly instrumentId: InstrumentId;
  readonly side: PositionSide;
  readonly requestedQuantity: number;
  readonly roundedQuantity: number;
  readonly lotSize: number;
  readonly minQuantity: number;
  readonly reason: "invalid_raw_quantity" | "below_min_quantity" | "invalid_book";
};

export type OrderNotionalMismatchEvent = FuturesReportEnvelope & {
  readonly kind: "order_notional_mismatch";
  readonly tradeId: string;
  readonly instrumentId: InstrumentId;
  readonly side: PositionSide;
  readonly requestedQuantity: number;
  readonly roundedQuantity: number;
  readonly entryPrice: number;
  readonly fillPrice: number;
  readonly contractMultiplier: number;
  readonly targetNotionalQuote: number;
  readonly executedNotionalQuote: number;
  readonly notionalDeltaQuote: number;
  readonly notionalDeltaBps: number;
  readonly quantityRounded: boolean;
  readonly priceAligned: boolean;
};

export type ExitPendingEvent = FuturesReportEnvelope & {
  readonly kind: "exit_pending";
  readonly tradeId: string;
  readonly instrumentId: InstrumentId;
  readonly trigger: FuturesPaperExitTrigger;
  readonly pendingReason: FuturesPaperExitPendingReason;
  readonly firstTriggeredAtMs: number;
  readonly lastAttemptAtMs: number;
  readonly graceDeadlineAtMs: number;
  readonly attemptCount: number;
};

export type ExitRetryEvent = FuturesReportEnvelope & {
  readonly kind: "exit_retry";
  readonly tradeId: string;
  readonly instrumentId: InstrumentId;
  readonly trigger: FuturesPaperExitTrigger;
  readonly pendingReason: FuturesPaperExitPendingReason;
  readonly attemptCount: number;
  readonly lastAttemptAtMs: number;
};

export type ExitRetryFailedEvent = FuturesReportEnvelope & {
  readonly kind: "exit_retry_failed";
  readonly tradeId: string;
  readonly instrumentId: InstrumentId;
  readonly trigger: FuturesPaperExitTrigger;
  readonly pendingReason: FuturesPaperExitPendingReason;
  readonly attemptCount: number;
  readonly lastAttemptAtMs: number;
  readonly graceDeadlineAtMs: number;
  readonly closeReason: FuturesPaperCloseReason;
};

export type ForcedCloseEvent = FuturesReportEnvelope & {
  readonly kind: "forced_close";
  readonly tradeId: string;
  readonly instrumentId: InstrumentId;
  readonly trigger: FuturesPaperExitTrigger;
  readonly pendingReason: FuturesPaperExitPendingReason;
  readonly attemptCount: number;
  readonly forcedAtMs: number;
  readonly closeReason: FuturesPaperCloseReason;
};

export type ExitExecutionSkippedEvent = FuturesReportEnvelope & {
  readonly kind: "exit_execution_skipped";
  readonly tradeId: string;
  readonly instrumentId: InstrumentId;
  readonly trigger: FuturesPaperExitTrigger;
  readonly pendingReason: FuturesPaperExitPendingReason;
  readonly attemptCount: number;
  readonly executionSkipReason: "book_missing" | "book_invalid";
};

/** Mark-to-market or heartbeat while a position is open. */
export type TradeUpdatedEvent = FuturesReportEnvelope & {
  readonly kind: "trade_updated";
  readonly tradeId: string;
  readonly instrumentId: InstrumentId;
  readonly updatedAtMs: number;
  readonly midPrice?: number;
  readonly markPrice?: number;
  readonly unrealizedPnlQuote?: number;
  readonly holdDurationMs?: number;
};

/** Closed round-trip (realized P/L). */
export type PaperCloseEvent = FuturesReportEnvelope & {
  readonly kind: "paper_close";
  readonly tradeId: string;
  readonly instrumentId: InstrumentId;
  readonly side: PositionSide;
  readonly quantityBase: number;
  readonly entryPrice: number;
  readonly exitPrice: number;
  readonly grossPnlQuote: number;
  readonly feesQuote: number;
  readonly spreadCostQuote?: number;
  readonly slippageCostQuote?: number;
  readonly latencyCostQuote?: number;
  readonly fundingCostQuote?: number;
  readonly netPnlQuote: number;
  readonly grossPnl?: number;
  readonly fees?: number;
  readonly spreadCost?: number;
  readonly slippageCost?: number;
  readonly latencyCost?: number;
  readonly fundingCost?: number;
  readonly netPnl?: number;
  readonly edgeBeforeCosts?: number;
  readonly edgeAfterCosts?: number;
  readonly openedAtMs: number;
  readonly closedAtMs: number;
  readonly closeReason: FuturesPaperCloseReason;
  readonly holdDurationMs: number;
};

/** Backward-compatible alias for existing consumers. */
export type TradeOpenedEvent = PaperOpenEvent;

/** Backward-compatible alias for existing consumers. */
export type TradeClosedEvent = PaperCloseEvent;

export type SessionSummaryEvent = FuturesReportEnvelope & {
  readonly kind: "session_summary";
  readonly summary: FuturesSessionSummary;
};

export type FuturesSessionProgress = FuturesReportEnvelope & {
  readonly kind: "session_progress";
  readonly sessionStartedAt: string;
  readonly snapshotAt: string;
  readonly runtimeMs: number;
  readonly outputDirectory: string;
  readonly instrumentId?: InstrumentId;
  readonly counters: {
    readonly ticks: number;
    readonly signalsEvaluated: number;
    readonly signalsRejected: number;
    readonly tradesOpened: number;
    readonly tradesClosed: number;
    readonly marginWarningCount: number;
    readonly liquidationRiskCount: number;
    readonly profitLockTriggeredCount: number;
    readonly trailingProfitTriggeredCount: number;
    readonly paperLiquidationCount: number;
    readonly riskBlockedEntries: number;
    readonly entryConfirmationPendingCount: number;
    readonly entryConfirmationCancelledCount: number;
    readonly entryConfirmationSatisfiedCount: number;
    readonly exitPendingCount: number;
    readonly exitRetryCount: number;
    readonly exitRetryFailedCount: number;
    readonly exitExecutionSkippedCount: number;
    readonly forcedCloseCount: number;
    readonly quantityRoundedCount: number;
    readonly invalidOrderQuantityCount: number;
    readonly notionalMismatchCount: number;
  };
  readonly pnl: {
    readonly realizedNetPnlQuote: number;
    readonly closedWinCount: number;
    readonly closedLossCount: number;
    readonly closedBreakevenCount: number;
  };
  readonly balance?: FuturesBalanceSnapshot;
  readonly position?: {
    readonly hasOpenPosition: true;
    readonly currentTradeId: string;
    readonly side: PositionSide;
    readonly entryPrice: number;
    readonly currentMarkPrice: number;
    readonly unrealizedPnlQuote: number;
    readonly holdDurationMs: number;
  };
  readonly feed: {
    readonly bootstrapRestOk: boolean;
    readonly lastMessageAgeMs?: number;
    readonly feedStale?: boolean;
    readonly bookValid?: boolean;
  };
};

/** Union of all lines appended to `futures-events.jsonl`. */
export type FuturesJsonlEvent =
  | SignalEvaluatedEvent
  | SignalRejectedEvent
  | RiskEvaluatedEvent
  | MarginWarningEvent
  | LiquidationRiskEvent
  | ProfitLockTriggeredEvent
  | TrailingProfitTriggeredEvent
  | PaperLiquidationEvent
  | PaperOpenEvent
  | PaperOpenRejectedEvent
  | EntryConfirmationPendingEvent
  | EntryConfirmationCancelledEvent
  | OrderQuantityRoundedEvent
  | OrderInvalidQuantityEvent
  | OrderNotionalMismatchEvent
  | ExitPendingEvent
  | ExitRetryEvent
  | ExitRetryFailedEvent
  | ForcedCloseEvent
  | ExitExecutionSkippedEvent
  | TradeUpdatedEvent
  | PaperCloseEvent
  | SessionSummaryEvent;

/** Single-file session rollup (pretty JSON, not JSONL). */
export type FuturesSessionSummary = {
  readonly schemaVersion: typeof FUTURES_REPORT_SCHEMA_VERSION;
  readonly kind: "session_summary";
  readonly sessionId: string;
  readonly sessionStartedAt: string;
  readonly sessionEndedAt: string;
  readonly runtimeMs: number;
  readonly outputDirectory: string;
  readonly instrumentId?: InstrumentId;
  readonly counters: {
    readonly ticks: number;
    readonly signalsEvaluated: number;
    readonly signalsRejected: number;
    readonly tradesOpened: number;
    readonly tradesClosed: number;
    readonly marginWarningCount: number;
  readonly liquidationRiskCount: number;
  readonly profitLockTriggeredCount: number;
  readonly trailingProfitTriggeredCount: number;
  readonly paperLiquidationCount: number;
    readonly riskBlockedEntries: number;
    readonly entryConfirmationPendingCount: number;
    readonly entryConfirmationCancelledCount: number;
    readonly entryConfirmationSatisfiedCount: number;
    readonly exitPendingCount: number;
    readonly exitRetryCount: number;
    readonly exitRetryFailedCount: number;
    readonly exitExecutionSkippedCount: number;
    readonly forcedCloseCount: number;
    readonly quantityRoundedCount: number;
    readonly invalidOrderQuantityCount: number;
    readonly notionalMismatchCount: number;
  };
  readonly pnl: {
    readonly realizedNetPnlQuote: number;
    readonly closedWinCount: number;
    readonly closedLossCount: number;
    readonly closedBreakevenCount: number;
  };
  readonly balance?: FuturesBalanceSnapshot;
  readonly feed?: {
    readonly bootstrapRestOk: boolean;
    readonly messagesApprox?: number;
  };
};
