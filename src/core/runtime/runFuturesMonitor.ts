/**
 * Single coherent pipeline: config → market → signal → risk → paper execution → reporting.
 *
 * Does not use `simulationEngine` or `strategyDecisionPipeline`.
 */
import { randomUUID } from "node:crypto";
import type { InstrumentId } from "../domain/instrument.js";
import type { TopOfBookL1 } from "../domain/book.js";
import { BalanceEngine } from "./BalanceEngine.js";
import type { FuturesPaperExitDecision } from "../execution/futuresPaperTypes.js";
import type { FuturesPaperMarginDecision } from "../execution/futuresPaperTypes.js";
import type { FuturesPaperRoundtrip } from "../execution/futuresPaperTypes.js";
import type {
  FuturesBalanceDailyCurvePoint,
  FuturesBalanceSnapshot,
  FuturesBalanceHistoryRecord,
  FuturesJsonlEvent,
  FuturesSessionSummary,
} from "../reporting/futuresEventTypes.js";
import {
  FuturesReportingPersistence,
  buildEntryConfirmationCancelledEvent,
  buildEntryConfirmationPendingEvent,
  buildExitExecutionSkippedEvent,
  buildExitPendingEvent,
  buildExitRetryEvent,
  buildExitRetryFailedEvent,
  buildForcedCloseEvent,
  buildOrderInvalidQuantityEvent,
  buildOrderNotionalMismatchEvent,
  buildOrderQuantityRoundedEvent,
  buildBalanceProgressEvent,
  buildBalanceHistoryRecord,
  buildLiquidationRiskEvent,
  buildMarginWarningEvent,
  buildProfitLockTriggeredEvent,
  buildTrailingProfitTriggeredEvent,
  buildPaperCloseEvent,
  buildPaperLiquidationEvent,
  buildPaperOpenEvent,
  buildPaperOpenRejectedEvent,
  buildRiskEvaluatedEvent,
  buildSessionSummaryEvent,
  buildSignalEvaluatedEvent,
  buildTradeUpdatedEvent,
} from "../reporting/index.js";
import { createFuturesMonitorRuntime, type FuturesMonitorRuntime } from "./futuresBootstrap.js";
import { runFuturesStackStep, type FuturesEntryConfirmationUpdate, type FuturesStackOpenAttempt, type FuturesStackRuntime } from "./futuresStackStep.js";
import type { PositionSide } from "../domain/sides.js";
import type { SignalEvaluation } from "../signal/types.js";
import type { RiskEvaluationInput, RiskGateResult } from "../risk/riskTypes.js";

function envBool(key: string, fallback: boolean): boolean {
  const v = process.env[key]?.trim().toLowerCase();
  if (!v) return fallback;
  if (v === "1" || v === "true" || v === "yes") return true;
  if (v === "0" || v === "false" || v === "no") return false;
  return fallback;
}

type ActiveTradeState = {
  tradeId: string;
  side: PositionSide;
  quantity: number;
  avgEntryPrice: number;
  openedAtMs: number;
  contractMultiplier: number;
};

type BalanceSnapshotState = FuturesBalanceSnapshot | null;

type BalanceConfigState = {
  startingBalance: number;
  reserveBalance: number;
  minBalanceToContinue: number;
  fixedStakeUntilBalance: number;
} | null;

type FeedSnapshotState = {
  lastMessageAgeMs: number | null;
  feedStale: boolean | null;
  bookValid: boolean | null;
  markPrice: number | null;
};

type ActiveExitState = {
  tradeId: string;
  trigger: FuturesPaperExitDecision["trigger"];
  pendingReason: Extract<FuturesPaperExitDecision, { kind: "pending" }>["pendingReason"];
  firstTriggeredAtMs: number;
  lastAttemptAtMs: number;
  graceDeadlineAtMs: number;
  attemptCount: number;
};

function isExecutableBook(book: TopOfBookL1 | null): boolean {
  if (!book) return false;
  return (
    Number.isFinite(book.bestBid) &&
    Number.isFinite(book.bestAsk) &&
    Number.isFinite(book.midPrice) &&
    Number.isFinite(book.spreadBps) &&
    book.bestBid > 0 &&
    book.bestAsk >= book.bestBid
  );
}

class FuturesMonitorReporter {
  private readonly persistence = new FuturesReportingPersistence();
  private readonly sessionId = `futures-${Date.now()}-${randomUUID().slice(0, 8)}`;
  private readonly startedAtMs = Date.now();
  private readonly startedAtIso = new Date(this.startedAtMs).toISOString();
  private activeTrade: ActiveTradeState | null = null;
  private finalized = false;
  private bootstrapRestOk = false;
  private feedSnapshot: FeedSnapshotState = {
    lastMessageAgeMs: null,
    feedStale: null,
    bookValid: null,
    markPrice: null,
  };
  private balanceSnapshot: BalanceSnapshotState = null;
  private balanceConfig: BalanceConfigState = null;
  private peakBalanceQuote: number | null = null;
  private balanceHistory: FuturesBalanceHistoryRecord[] = [];

  private ticks = 0;
  private signalsEvaluated = 0;
  private signalsRejected = 0;
  private tradesOpened = 0;
  private tradesClosed = 0;
  private riskBlockedEntries = 0;
  private entryConfirmationPendingCount = 0;
  private entryConfirmationCancelledCount = 0;
  private entryConfirmationSatisfiedCount = 0;
  private exitPendingCount = 0;
  private exitRetryCount = 0;
  private exitRetryFailedCount = 0;
  private exitExecutionSkippedCount = 0;
  private forcedCloseCount = 0;
  private quantityRoundedCount = 0;
  private invalidOrderQuantityCount = 0;
  private notionalMismatchCount = 0;
  private marginWarningCount = 0;
  private liquidationRiskCount = 0;
  private profitLockTriggeredCount = 0;
  private trailingProfitTriggeredCount = 0;
  private paperLiquidationCount = 0;
  private cumulativeRealizedNetPnlQuote = 0;
  private cumulativeWinNetPnlQuote = 0;
  private cumulativeLossNetPnlQuote = 0;
  private closedWinCount = 0;
  private closedLossCount = 0;
  private closedBreakevenCount = 0;
  private activeExit: ActiveExitState | null = null;
  private activeMarginLevel: "warning" | "risk" | null = null;

  constructor(
    private readonly instrumentId: InstrumentId,
    private readonly profitLockThresholdQuote: number
  ) {}

  getSessionId(): string {
    return this.sessionId;
  }

  getOutputDir(): string {
    return this.persistence.getOutputDir();
  }

  getProgressPath(): string {
    return this.persistence.getBalanceProgressPath();
  }

  getHistoryPath(): string {
    return this.persistence.getBalanceHistoryPath();
  }

  setBalanceConfig(config: NonNullable<BalanceConfigState>): void {
    this.balanceConfig = config;
    this.peakBalanceQuote = config.startingBalance;
  }

  setBalanceSnapshot(snapshot: BalanceSnapshotState): void {
    this.balanceSnapshot = snapshot;
    if (snapshot !== null) {
      this.peakBalanceQuote =
        this.peakBalanceQuote === null
          ? snapshot.currentBalance
          : Math.max(this.peakBalanceQuote, snapshot.currentBalance);
    }
  }

  recordBalanceInitialized(recordedAtMs: number): void {
    const snapshot = this.balanceSnapshot;
    if (snapshot === null || this.balanceConfig === null) return;
    this.appendBalanceHistory(
      buildBalanceHistoryRecord({
        sessionId: this.sessionId,
        recordedAtMs,
        kind: "balance_initialized",
        currentBalance: snapshot.currentBalance,
        currentEquity: snapshot.currentEquity,
        activeStake: snapshot.activeStake,
        stakeMode: snapshot.stakeMode,
        realizedNetPnlQuote: this.cumulativeRealizedNetPnlQuote,
        tradesClosed: this.tradesClosed,
        closedWinCount: this.closedWinCount,
        closedLossCount: this.closedLossCount,
        stopRequested: snapshot.stopRequested,
        stopReason: snapshot.stopReason,
      })
    );
  }

  recordBalanceAfterTrade(recordedAtMs: number, previous: BalanceSnapshotState): void {
    const snapshot = this.balanceSnapshot;
    if (snapshot === null) return;
    this.appendBalanceHistory(
      buildBalanceHistoryRecord({
        sessionId: this.sessionId,
        recordedAtMs,
        kind: "balance_updated_after_trade",
        currentBalance: snapshot.currentBalance,
        currentEquity: snapshot.currentEquity,
        activeStake: snapshot.activeStake,
        stakeMode: snapshot.stakeMode,
        realizedNetPnlQuote: this.cumulativeRealizedNetPnlQuote,
        tradesClosed: this.tradesClosed,
        closedWinCount: this.closedWinCount,
        closedLossCount: this.closedLossCount,
        stopRequested: snapshot.stopRequested,
        stopReason: snapshot.stopReason,
      })
    );

    if (previous !== null && previous.stakeMode !== snapshot.stakeMode) {
      this.appendBalanceHistory(
        buildBalanceHistoryRecord({
          sessionId: this.sessionId,
          recordedAtMs,
          kind: "stake_mode_changed",
          currentBalance: snapshot.currentBalance,
          currentEquity: snapshot.currentEquity,
          activeStake: snapshot.activeStake,
          stakeMode: snapshot.stakeMode,
          realizedNetPnlQuote: this.cumulativeRealizedNetPnlQuote,
          tradesClosed: this.tradesClosed,
          closedWinCount: this.closedWinCount,
          closedLossCount: this.closedLossCount,
          previousStakeMode: previous.stakeMode,
          previousActiveStake: previous.activeStake,
          newStakeMode: snapshot.stakeMode,
          newActiveStake: snapshot.activeStake,
        })
      );
    }

    if (previous !== null && !previous.stopRequested && snapshot.stopRequested) {
      this.appendBalanceHistory(
        buildBalanceHistoryRecord({
          sessionId: this.sessionId,
          recordedAtMs,
          kind: "stop_triggered_due_to_balance",
          currentBalance: snapshot.currentBalance,
          currentEquity: snapshot.currentEquity,
          activeStake: snapshot.activeStake,
          stakeMode: snapshot.stakeMode,
          realizedNetPnlQuote: this.cumulativeRealizedNetPnlQuote,
          tradesClosed: this.tradesClosed,
          closedWinCount: this.closedWinCount,
          closedLossCount: this.closedLossCount,
          stopRequested: snapshot.stopRequested,
          stopReason: snapshot.stopReason,
        })
      );
    }
  }

  recordPeriodicBalanceSnapshot(recordedAtMs: number): void {
    const snapshot = this.balanceSnapshot;
    if (snapshot === null) return;
    this.appendBalanceHistory(
      buildBalanceHistoryRecord({
        sessionId: this.sessionId,
        recordedAtMs,
        kind: "periodic_balance_snapshot",
        currentBalance: snapshot.currentBalance,
        currentEquity: snapshot.currentEquity,
        activeStake: snapshot.activeStake,
        stakeMode: snapshot.stakeMode,
        realizedNetPnlQuote: this.cumulativeRealizedNetPnlQuote,
        tradesClosed: this.tradesClosed,
        closedWinCount: this.closedWinCount,
        closedLossCount: this.closedLossCount,
        stopRequested: snapshot.stopRequested,
        stopReason: snapshot.stopReason,
      })
    );
  }

  private appendBalanceHistory(record: FuturesBalanceHistoryRecord): void {
    this.balanceHistory.push(record);
    this.persistence.appendBalanceHistory(record);
  }

  hasActiveTrade(): boolean {
    return this.activeTrade !== null;
  }

  getActiveTrade(): ActiveTradeState | null {
    return this.activeTrade;
  }

  private logConsole(event: Record<string, unknown>): void {
    console.log(JSON.stringify({ channel: "futures_monitor", ...event }));
  }

  private append(event: FuturesJsonlEvent): void {
    this.persistence.appendEvent(event);
    this.logConsole(event);
  }

  setBootstrapRestOk(ok: boolean): void {
    this.bootstrapRestOk = ok;
  }

  recordFeedSnapshot(input: {
    lastMessageAgeMs: number;
    feedStale: boolean;
    bookValid: boolean;
    markPrice: number | null;
  }): void {
    this.feedSnapshot = {
      lastMessageAgeMs: input.lastMessageAgeMs,
      feedStale: input.feedStale,
      bookValid: input.bookValid,
      markPrice: input.markPrice,
    };
  }

  recordTick(): void {
    this.ticks += 1;
  }

  recordSignal(
    recordedAtMs: number,
    evaluation: SignalEvaluation
  ): void {
    this.signalsEvaluated += 1;
    if (!evaluation.actionable) {
      this.signalsRejected += 1;
    }
    this.append(
      buildSignalEvaluatedEvent({
        sessionId: this.sessionId,
        recordedAtMs,
        instrumentId: this.instrumentId,
        evaluation,
      })
    );
  }

  recordEntryConfirmation(
    recordedAtMs: number,
    update: FuturesEntryConfirmationUpdate
  ): void {
    if (update.kind === "pending") {
      this.entryConfirmationPendingCount += 1;
      this.append(
        buildEntryConfirmationPendingEvent({
          sessionId: this.sessionId,
          recordedAtMs,
          tradeId: update.tradeId,
          instrumentId: this.instrumentId,
          side: update.side,
          impulseDirection: update.impulseDirection,
          contrarianDirection: update.contrarianDirection,
          requiredTicks: update.requiredTicks,
          ticksObserved: update.ticksObserved,
          firstObservedAtMs: update.firstObservedAtMs,
          lastObservedAtMs: update.lastObservedAtMs,
          referenceMid: update.referenceMid,
          lastObservedMid: update.lastObservedMid,
          requireReversal: update.requireReversal,
          pendingReason: update.pendingReason,
        })
      );
      return;
    }

    this.entryConfirmationCancelledCount += 1;
    this.append(
      buildEntryConfirmationCancelledEvent({
        sessionId: this.sessionId,
        recordedAtMs,
        tradeId: update.tradeId,
        instrumentId: this.instrumentId,
        side: update.side,
        impulseDirection: update.impulseDirection,
        contrarianDirection: update.contrarianDirection,
        requiredTicks: update.requiredTicks,
        ticksObserved: update.ticksObserved,
        firstObservedAtMs: update.firstObservedAtMs,
        lastObservedAtMs: update.lastObservedAtMs,
        referenceMid: update.referenceMid,
        lastObservedMid: update.lastObservedMid,
        requireReversal: update.requireReversal,
        cancelReason: update.cancelReason,
      })
    );
  }

  recordRisk(
    recordedAtMs: number,
    evaluation: RiskEvaluationInput,
    gate: RiskGateResult
  ): void {
    this.append(
      buildRiskEvaluatedEvent({
        sessionId: this.sessionId,
        recordedAtMs,
        instrumentId: this.instrumentId,
        evaluation: {
          ...evaluation,
          allowed: gate.allowed,
          rejectionReasons: [...gate.rejectionReasons],
          suggestedSizeQuote: gate.suggestedSizeQuote,
        },
      })
    );
  }

  recordExitLifecycle(
    recordedAtMs: number,
    decision: FuturesPaperExitDecision | null,
    book: TopOfBookL1 | null
  ): void {
    const trade = this.activeTrade;
    if (!trade || !decision) return;

    if (decision.kind === "pending") {
      const priorExit = this.activeExit;
      const sameExit =
        priorExit !== null &&
        priorExit.tradeId === trade.tradeId &&
        priorExit.trigger === decision.trigger;
      const nextAttemptCount = sameExit ? priorExit!.attemptCount + 1 : 1;
      this.activeExit = {
        tradeId: trade.tradeId,
        trigger: decision.trigger,
        pendingReason: decision.pendingReason,
        firstTriggeredAtMs: sameExit
          ? priorExit!.firstTriggeredAtMs
          : decision.firstTriggeredAtMs,
        lastAttemptAtMs: decision.lastAttemptAtMs,
        graceDeadlineAtMs: decision.graceDeadlineAtMs,
        attemptCount: nextAttemptCount,
      };

      if (sameExit) {
        this.exitRetryCount += 1;
        this.append(
          buildExitRetryEvent({
            sessionId: this.sessionId,
            recordedAtMs,
            tradeId: trade.tradeId,
            instrumentId: this.instrumentId,
            trigger: decision.trigger,
            pendingReason: decision.pendingReason,
            attemptCount: nextAttemptCount,
            lastAttemptAtMs: decision.lastAttemptAtMs,
          })
        );
      } else {
        this.exitPendingCount += 1;
        this.append(
          buildExitPendingEvent({
            sessionId: this.sessionId,
            recordedAtMs,
            tradeId: trade.tradeId,
            instrumentId: this.instrumentId,
            trigger: decision.trigger,
            pendingReason: decision.pendingReason,
            firstTriggeredAtMs: decision.firstTriggeredAtMs,
            lastAttemptAtMs: decision.lastAttemptAtMs,
            graceDeadlineAtMs: decision.graceDeadlineAtMs,
            attemptCount: nextAttemptCount,
          })
        );
      }

      if (!isExecutableBook(book)) {
        this.exitExecutionSkippedCount += 1;
        this.append(
          buildExitExecutionSkippedEvent({
            sessionId: this.sessionId,
            recordedAtMs,
            tradeId: trade.tradeId,
            instrumentId: this.instrumentId,
            trigger: decision.trigger,
            pendingReason: decision.pendingReason,
            attemptCount: nextAttemptCount,
            executionSkipReason: book === null ? "book_missing" : "book_invalid",
          })
        );
      }
      return;
    }

    const priorExit = this.activeExit;
    const sameExit =
      priorExit !== null &&
      priorExit.tradeId === trade.tradeId &&
      priorExit.trigger === decision.trigger;

    if (sameExit) {
      const attemptCount = priorExit!.attemptCount + 1;
      this.exitRetryCount += 1;
      this.append(
        buildExitRetryEvent({
          sessionId: this.sessionId,
          recordedAtMs,
          tradeId: trade.tradeId,
          instrumentId: this.instrumentId,
          trigger: decision.trigger,
          pendingReason: priorExit!.pendingReason,
          attemptCount,
          lastAttemptAtMs: recordedAtMs,
        })
      );

      if (decision.forced) {
        this.exitRetryFailedCount += 1;
        this.forcedCloseCount += 1;
        this.append(
          buildExitRetryFailedEvent({
            sessionId: this.sessionId,
            recordedAtMs,
            tradeId: trade.tradeId,
            instrumentId: this.instrumentId,
            trigger: decision.trigger,
            pendingReason: priorExit!.pendingReason,
            attemptCount,
            lastAttemptAtMs: recordedAtMs,
            graceDeadlineAtMs: priorExit!.graceDeadlineAtMs,
            closeReason: "forced_exit",
          })
        );
        this.append(
          buildForcedCloseEvent({
            sessionId: this.sessionId,
            recordedAtMs,
            tradeId: trade.tradeId,
            instrumentId: this.instrumentId,
            trigger: decision.trigger,
            pendingReason: priorExit!.pendingReason,
            attemptCount,
            forcedAtMs: recordedAtMs,
            closeReason: "forced_exit",
          })
        );
      }
    } else if (decision.forced) {
      this.forcedCloseCount += 1;
      this.append(
        buildForcedCloseEvent({
          sessionId: this.sessionId,
          recordedAtMs,
          tradeId: trade.tradeId,
          instrumentId: this.instrumentId,
          trigger: decision.trigger,
          pendingReason: "retry_failed",
          attemptCount: 1,
          forcedAtMs: recordedAtMs,
          closeReason: "forced_exit",
        })
      );
    }

    this.activeExit = null;
  }

  recordProfitLockTriggered(
    recordedAtMs: number,
    nowMs: number,
    decision: Extract<FuturesPaperExitDecision, { kind: "closed" }>,
    thresholdQuote: number
  ): void {
    const trade = this.activeTrade;
    if (!trade || decision.trigger !== "profit_lock") return;
    this.profitLockTriggeredCount += 1;
    this.append(
      buildProfitLockTriggeredEvent({
        sessionId: this.sessionId,
        recordedAtMs,
        tradeId: trade.tradeId,
        instrumentId: this.instrumentId,
        side: trade.side,
        quantityBase: decision.roundtrip.quantity,
        entryPrice: decision.roundtrip.entryPrice,
        exitPrice: decision.roundtrip.exitPrice,
        estimatedNetPnlAtExitQuote: decision.estimatedNetPnlAtExitQuote,
        thresholdQuote,
        holdDurationMs: Math.max(0, nowMs - trade.openedAtMs),
      })
    );
  }

  recordTrailingProfitTriggered(
    recordedAtMs: number,
    nowMs: number,
    decision: Extract<FuturesPaperExitDecision, { kind: "closed" }>,
    thresholdQuote: number
  ): void {
    const trade = this.activeTrade;
    if (!trade || decision.trigger !== "trailing_profit") return;
    this.trailingProfitTriggeredCount += 1;
    const peakEstimatedNetPnlAtExitQuote =
      decision.peakEstimatedNetPnlAtExitQuote ??
      decision.estimatedNetPnlAtExitQuote;
    const dropFromPeakQuote =
      decision.dropFromPeakQuote ??
      Math.max(0, peakEstimatedNetPnlAtExitQuote - decision.estimatedNetPnlAtExitQuote);
    const dropThresholdQuote =
      decision.dropThresholdQuote ?? thresholdQuote;
    const effectiveThresholdQuote =
      decision.thresholdQuote ?? thresholdQuote;
    this.append(
      buildTrailingProfitTriggeredEvent({
        sessionId: this.sessionId,
        recordedAtMs,
        tradeId: trade.tradeId,
        instrumentId: this.instrumentId,
        side: trade.side,
        quantityBase: decision.roundtrip.quantity,
        entryPrice: decision.roundtrip.entryPrice,
        exitPrice: decision.roundtrip.exitPrice,
        estimatedNetPnlAtExitQuote: decision.estimatedNetPnlAtExitQuote,
        peakEstimatedNetPnlAtExitQuote,
        dropFromPeakQuote,
        dropThresholdQuote,
        thresholdQuote: effectiveThresholdQuote,
        holdDurationMs: Math.max(0, nowMs - trade.openedAtMs),
      })
    );
  }

  recordMarginLifecycle(
    recordedAtMs: number,
    nowMs: number,
    decision: FuturesPaperMarginDecision | null
  ): void {
    const trade = this.activeTrade;
    if (!trade || !decision) {
      if (!trade) this.activeMarginLevel = null;
      return;
    }

    const holdDurationMs = Math.max(0, nowMs - trade.openedAtMs);
    if (decision.kind === "margin_warning") {
      if (this.activeMarginLevel === "warning" || this.activeMarginLevel === "risk") {
        this.activeMarginLevel = "warning";
        return;
      }
      this.marginWarningCount += 1;
      this.activeMarginLevel = "warning";
      this.append(
        buildMarginWarningEvent({
          sessionId: this.sessionId,
          recordedAtMs,
          tradeId: trade.tradeId,
          instrumentId: this.instrumentId,
          side: trade.side,
          holdDurationMs,
          margin: decision.snapshot,
          warningRatio: decision.warningRatio,
        })
      );
      return;
    }

    if (decision.kind === "liquidation_risk") {
      if (this.activeMarginLevel !== "risk") {
        this.liquidationRiskCount += 1;
        this.activeMarginLevel = "risk";
        this.append(
          buildLiquidationRiskEvent({
            sessionId: this.sessionId,
            recordedAtMs,
            tradeId: trade.tradeId,
            instrumentId: this.instrumentId,
            side: trade.side,
            holdDurationMs,
            margin: decision.snapshot,
            riskRatio: decision.riskRatio,
          })
        );
      }
      return;
    }

    if (decision.kind === "liquidated") {
      this.paperLiquidationCount += 1;
      this.activeMarginLevel = null;
      this.append(
        buildPaperLiquidationEvent({
          sessionId: this.sessionId,
          recordedAtMs,
          tradeId: trade.tradeId,
          instrumentId: this.instrumentId,
          side: trade.side,
          quantityBase: decision.roundtrip.quantity,
          entryPrice: decision.roundtrip.entryPrice,
          markPrice: decision.snapshot.markPrice,
          liquidationPriceEstimate: decision.snapshot.liquidationPriceEstimate,
          initialMarginQuote: decision.snapshot.initialMarginQuote,
          maintenanceMarginQuote: decision.snapshot.maintenanceMarginQuote,
          marginBalanceQuote: decision.snapshot.marginBalanceQuote,
          unrealizedPnlQuote: decision.snapshot.unrealizedPnlQuote,
          marginRatio: decision.snapshot.marginRatio,
          liquidatedAtMs: decision.roundtrip.closedAtMs,
          liquidationReason: decision.liquidationReason,
        })
      );
      return;
    }

    this.activeMarginLevel = null;
  }

  recordTradeClosed(
    recordedAtMs: number,
    roundtrip: FuturesPaperRoundtrip
  ): void {
    const tradeId = this.activeTrade?.tradeId ?? `${this.sessionId}:trade:orphan`;
    this.tradesClosed += 1;
    this.cumulativeRealizedNetPnlQuote += roundtrip.netPnlQuote;
    if (roundtrip.netPnlQuote > 0) {
      this.closedWinCount += 1;
      this.cumulativeWinNetPnlQuote += roundtrip.netPnlQuote;
    } else if (roundtrip.netPnlQuote < 0) {
      this.closedLossCount += 1;
      this.cumulativeLossNetPnlQuote += roundtrip.netPnlQuote;
    } else {
      this.closedBreakevenCount += 1;
    }
    this.activeTrade = null;
    this.activeExit = null;
    this.activeMarginLevel = null;
    this.append(
      buildPaperCloseEvent({
        sessionId: this.sessionId,
        recordedAtMs,
        tradeId,
        roundtrip,
      })
    );
  }

  recordTradeUpdate(
    recordedAtMs: number,
    nowMs: number,
    midPrice: number,
    markPrice: number
  ): void {
    const trade = this.activeTrade;
    if (!trade) return;
    const unrealizedPnlQuote =
      trade.side === "long"
        ? (markPrice - trade.avgEntryPrice) * trade.quantity * trade.contractMultiplier
        : (trade.avgEntryPrice - markPrice) * trade.quantity * trade.contractMultiplier;
    this.append(
      buildTradeUpdatedEvent({
        sessionId: this.sessionId,
        recordedAtMs,
        tradeId: trade.tradeId,
        instrumentId: this.instrumentId,
        updatedAtMs: nowMs,
        midPrice,
        markPrice,
        unrealizedPnlQuote,
        holdDurationMs: Math.max(0, nowMs - trade.openedAtMs),
      })
    );
  }

  writeProgressSnapshot(recordedAtMs: number): void {
    this.recordPeriodicBalanceSnapshot(recordedAtMs);
    this.persistence.writeBalanceProgress(this.buildBalanceProgressSnapshot(recordedAtMs));
  }

  private deriveDailyCurve(): FuturesBalanceDailyCurvePoint[] {
    const groups = new Map<
      string,
      {
        startAtMs: number;
        endAtMs: number;
        startBalance: number;
        endBalance: number;
        peakBalance: number;
        maxDrawdownPct: number;
      }
    >();

    for (const record of this.balanceHistory) {
      const date = new Date(record.recordedAtMs).toISOString().slice(0, 10);
      const currentBalance = record.currentBalance;
      const existing = groups.get(date);
      if (!existing) {
        groups.set(date, {
          startAtMs: record.recordedAtMs,
          endAtMs: record.recordedAtMs,
          startBalance: currentBalance,
          endBalance: currentBalance,
          peakBalance: currentBalance,
          maxDrawdownPct: 0,
        });
        continue;
      }

      existing.endAtMs = record.recordedAtMs;
      existing.endBalance = currentBalance;
      existing.peakBalance = Math.max(existing.peakBalance, currentBalance);
      const drawdownPct =
        existing.peakBalance > 0
          ? Math.max(0, ((existing.peakBalance - currentBalance) / existing.peakBalance) * 100)
          : 0;
      existing.maxDrawdownPct = Math.max(existing.maxDrawdownPct, drawdownPct);
    }

    return [...groups.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([date, entry]) => {
        const spanHours = Math.max((entry.endAtMs - entry.startAtMs) / 3_600_000, 0);
        const dailyReturnPct =
          entry.startBalance > 0
            ? ((entry.endBalance - entry.startBalance) / entry.startBalance) * 100
            : 0;
        const returnRatePctPerHour = spanHours > 0 ? dailyReturnPct / spanHours : 0;
        return {
          date,
          balanceStartOfDay: entry.startBalance,
          balanceEndOfDay: entry.endBalance,
          dailyReturnPct,
          returnRatePctPerHour,
          peakBalanceSeen: entry.peakBalance,
          maxDrawdownPctSeen: entry.maxDrawdownPct,
        };
      });
  }

  private buildBalanceProgressSnapshot(recordedAtMs: number) {
    const nowIso = new Date(recordedAtMs).toISOString();
    const trade = this.activeTrade;
    const markPrice = this.feedSnapshot.markPrice;
    const hasOpenPosition =
      trade !== null && Number.isFinite(markPrice ?? Number.NaN);
    const balance = this.balanceSnapshot ?? {
      currentBalance: 0,
      currentEquity: 0,
      activeStake: 0,
      stakeMode: "fixed" as const,
      stopRequested: false,
      stopReason: null,
    };
    const balanceConfig = this.balanceConfig ?? {
      startingBalance: 0,
      reserveBalance: 0,
      minBalanceToContinue: 0,
      fixedStakeUntilBalance: 0,
    };
    const peakBalance = this.peakBalanceQuote ?? balance.currentBalance;
    const winRate = this.tradesClosed > 0 ? this.closedWinCount / this.tradesClosed : 0;
    const avgWin = this.closedWinCount > 0 ? this.cumulativeWinNetPnlQuote / this.closedWinCount : 0;
    const avgLoss = this.closedLossCount > 0 ? this.cumulativeLossNetPnlQuote / this.closedLossCount : 0;
    const returnPctOnStartingBalance =
      balanceConfig.startingBalance > 0
        ? ((balance.currentBalance - balanceConfig.startingBalance) /
            balanceConfig.startingBalance) *
          100
        : 0;
    const drawdownPct =
      peakBalance > 0
        ? Math.max(0, ((peakBalance - balance.currentBalance) / peakBalance) * 100)
        : 0;

    return buildBalanceProgressEvent({
      sessionId: this.sessionId,
      recordedAtMs,
      sessionStartedAt: this.startedAtIso,
      snapshotAt: nowIso,
      runtimeMs: Math.max(0, recordedAtMs - this.startedAtMs),
      outputDirectory: this.persistence.getBalanceProgressOutputDir(),
      instrumentId: this.instrumentId,
      dailyCurve: this.deriveDailyCurve(),
      balance: {
        startingBalance: balanceConfig.startingBalance,
        reserveBalance: balanceConfig.reserveBalance,
        currentBalance: balance.currentBalance,
        currentEquity: balance.currentEquity,
        activeStake: balance.activeStake,
        stakeMode: balance.stakeMode,
        minBalanceToContinue: balanceConfig.minBalanceToContinue,
        fixedStakeUntilBalance: balanceConfig.fixedStakeUntilBalance,
        stopRequested: balance.stopRequested,
        stopReason: balance.stopReason,
      },
      performance: {
        realizedNetPnlQuote: this.cumulativeRealizedNetPnlQuote,
        unrealizedPnlQuote:
          hasOpenPosition && trade && Number.isFinite(markPrice ?? Number.NaN)
            ? this.computeUnrealizedPnlQuote(markPrice as number)
            : 0,
        returnPctOnStartingBalance,
        peakBalance,
        drawdownPct,
        tradesOpened: this.tradesOpened,
        tradesClosed: this.tradesClosed,
        closedWinCount: this.closedWinCount,
        closedLossCount: this.closedLossCount,
        closedBreakevenCount: this.closedBreakevenCount,
        avgWin,
        avgLoss,
        winRate,
      },
      runStatus: hasOpenPosition && trade && Number.isFinite(markPrice ?? Number.NaN)
        ? {
            hasOpenPosition: true as const,
            currentTradeId: trade.tradeId,
            side: trade.side,
            entryPrice: trade.avgEntryPrice,
            currentMarkPrice: markPrice as number,
            holdDurationMs: Math.max(0, recordedAtMs - trade.openedAtMs),
          }
        : {
            hasOpenPosition: false as const,
          },
      feed: {
        bootstrapRestOk: this.bootstrapRestOk,
        ...(this.feedSnapshot.lastMessageAgeMs !== null
          ? { lastMessageAgeMs: this.feedSnapshot.lastMessageAgeMs }
          : {}),
        ...(this.feedSnapshot.feedStale !== null
          ? { feedStale: this.feedSnapshot.feedStale }
          : {}),
        ...(this.feedSnapshot.bookValid !== null
          ? { bookValid: this.feedSnapshot.bookValid }
          : {}),
      },
    });
  }

  private computeUnrealizedPnlQuote(markPrice: number): number {
    const trade = this.activeTrade;
    if (!trade || !Number.isFinite(markPrice)) return 0;
    return trade.side === "long"
      ? (markPrice - trade.avgEntryPrice) * trade.quantity * trade.contractMultiplier
      : (trade.avgEntryPrice - markPrice) * trade.quantity * trade.contractMultiplier;
  }

  recordOpenSuccess(
    recordedAtMs: number,
    attempt: Extract<FuturesStackOpenAttempt, { ok: true }>,
    openedAtMs: number,
    snapshot?: { impulseDirection: string; contrarianDirection: string; strength: string }
  ): void {
    const signalFields = snapshot
      ? {
          ...(snapshot.impulseDirection !== undefined
            ? { impulseDirection: snapshot.impulseDirection }
            : {}),
          ...(snapshot.contrarianDirection !== undefined
            ? { contrarianDirection: snapshot.contrarianDirection }
            : {}),
          ...(snapshot.strength !== undefined ? { strength: snapshot.strength } : {}),
        }
      : {};
    const telemetry = attempt.telemetry;
    this.tradesOpened += 1;
    if (attempt.entryConfirmation) {
      this.entryConfirmationSatisfiedCount += 1;
    }
    if (telemetry.quantityRounded) {
      this.quantityRoundedCount += 1;
      this.append(
        buildOrderQuantityRoundedEvent({
          sessionId: this.sessionId,
          recordedAtMs,
          tradeId: attempt.tradeId,
          instrumentId: this.instrumentId,
          side: attempt.side,
          requestedQuantity: telemetry.requestedQuantity,
          roundedQuantity: telemetry.roundedQuantity,
          lotSize: telemetry.lotSize,
          minQuantity: telemetry.minQuantity,
        })
      );
    }
    if (
      telemetry.executedNotionalQuote !== null &&
      telemetry.notionalDeltaQuote !== null &&
      telemetry.notionalDeltaBps !== null &&
      (Math.abs(telemetry.notionalDeltaBps) >= 1 || telemetry.quantityRounded || telemetry.priceAligned)
    ) {
      this.notionalMismatchCount += 1;
      this.append(
        buildOrderNotionalMismatchEvent({
          sessionId: this.sessionId,
          recordedAtMs,
          tradeId: attempt.tradeId,
          instrumentId: this.instrumentId,
          side: attempt.side,
          requestedQuantity: telemetry.requestedQuantity,
          roundedQuantity: telemetry.roundedQuantity,
          entryPrice: telemetry.entryPrice,
          fillPrice: telemetry.fillPrice ?? attempt.avgEntryPrice,
          contractMultiplier: telemetry.contractMultiplier,
          targetNotionalQuote: telemetry.targetNotionalQuote,
          executedNotionalQuote: telemetry.executedNotionalQuote,
          priceAligned: telemetry.priceAligned,
        })
      );
    }
    this.activeTrade = {
      tradeId: attempt.tradeId,
      side: attempt.side,
      quantity: attempt.quantity,
      avgEntryPrice: attempt.avgEntryPrice,
      openedAtMs,
      contractMultiplier: telemetry.contractMultiplier,
    };
    this.append(
      buildPaperOpenEvent({
        sessionId: this.sessionId,
        recordedAtMs,
        tradeId: attempt.tradeId,
        instrumentId: this.instrumentId,
        side: attempt.side,
        quantityBase: attempt.quantity,
        avgEntryPrice: attempt.avgEntryPrice,
        openedAtMs,
        stakeQuote: attempt.stakeQuote,
        feesOpenQuote: attempt.feesOpenQuote,
        ...(attempt.entryConfirmation !== undefined
          ? { entryConfirmation: attempt.entryConfirmation }
          : {}),
        ...signalFields,
      })
    );
  }

  recordOpenRejected(
    recordedAtMs: number,
    attempt: Extract<FuturesStackOpenAttempt, { ok: false }>,
    snapshot?: { impulseDirection: string; contrarianDirection: string; strength: string }
  ): void {
    const signalFields = snapshot
      ? {
          ...(snapshot.impulseDirection !== undefined
            ? { impulseDirection: snapshot.impulseDirection }
            : {}),
          ...(snapshot.contrarianDirection !== undefined
            ? { contrarianDirection: snapshot.contrarianDirection }
            : {}),
          ...(snapshot.strength !== undefined ? { strength: snapshot.strength } : {}),
        }
      : {};
    const telemetry = attempt.telemetry;
    if (attempt.reason === "invalid_quantity") {
      this.invalidOrderQuantityCount += 1;
      this.append(
        buildOrderInvalidQuantityEvent({
          sessionId: this.sessionId,
          recordedAtMs,
          tradeId: attempt.tradeId,
          instrumentId: this.instrumentId,
          side: attempt.side,
          requestedQuantity: telemetry.requestedQuantity,
          roundedQuantity: telemetry.roundedQuantity,
          lotSize: telemetry.lotSize,
          minQuantity: telemetry.minQuantity,
          reason: telemetry.quantityValidationReason ?? "invalid_raw_quantity",
        })
      );
    }
    this.append(
      buildPaperOpenRejectedEvent({
        sessionId: this.sessionId,
        recordedAtMs,
        tradeId: attempt.tradeId,
        instrumentId: this.instrumentId,
        reason: attempt.reason,
        side: attempt.side,
        quantityBase: attempt.quantity,
        stakeQuote: attempt.stakeQuote,
        ...signalFields,
      })
    );
  }

  recordRiskBlockedIfNeeded(signalActionable: boolean, riskAllowed: boolean): void {
    if (signalActionable && !riskAllowed) {
      this.riskBlockedEntries += 1;
    }
  }

  finish(bootstrapRestOk: boolean, realizedNetPnlQuote: number): void {
    if (this.finalized) return;
    this.finalized = true;

    const endedAtMs = Date.now();
    const summary: FuturesSessionSummary = {
      schemaVersion: 1,
      kind: "session_summary",
      sessionId: this.sessionId,
      sessionStartedAt: this.startedAtIso,
      sessionEndedAt: new Date(endedAtMs).toISOString(),
      runtimeMs: Math.max(0, endedAtMs - this.startedAtMs),
      outputDirectory: this.persistence.getOutputDir(),
      instrumentId: this.instrumentId,
      counters: {
        ticks: this.ticks,
        signalsEvaluated: this.signalsEvaluated,
        signalsRejected: this.signalsRejected,
        tradesOpened: this.tradesOpened,
        tradesClosed: this.tradesClosed,
        marginWarningCount: this.marginWarningCount,
        liquidationRiskCount: this.liquidationRiskCount,
        profitLockTriggeredCount: this.profitLockTriggeredCount,
        trailingProfitTriggeredCount: this.trailingProfitTriggeredCount,
        paperLiquidationCount: this.paperLiquidationCount,
        riskBlockedEntries: this.riskBlockedEntries,
        entryConfirmationPendingCount: this.entryConfirmationPendingCount,
        entryConfirmationCancelledCount: this.entryConfirmationCancelledCount,
        entryConfirmationSatisfiedCount: this.entryConfirmationSatisfiedCount,
        exitPendingCount: this.exitPendingCount,
        exitRetryCount: this.exitRetryCount,
        exitRetryFailedCount: this.exitRetryFailedCount,
        exitExecutionSkippedCount: this.exitExecutionSkippedCount,
        forcedCloseCount: this.forcedCloseCount,
        quantityRoundedCount: this.quantityRoundedCount,
        invalidOrderQuantityCount: this.invalidOrderQuantityCount,
        notionalMismatchCount: this.notionalMismatchCount,
      },
      pnl: {
        realizedNetPnlQuote,
        closedWinCount: this.closedWinCount,
        closedLossCount: this.closedLossCount,
        closedBreakevenCount: this.closedBreakevenCount,
      },
      ...(this.balanceSnapshot !== null
        ? { balance: this.balanceSnapshot }
        : {}),
      feed: {
        bootstrapRestOk,
      },
    };

    this.append(
      buildSessionSummaryEvent({
        sessionId: this.sessionId,
        recordedAtMs: endedAtMs,
        summary,
      })
    );
    this.persistence.writeSessionSummary(summary);
    this.logConsole(summary);
  }
}

function runMonitorLoop(
  ctx: FuturesMonitorRuntime,
  reporter: FuturesMonitorReporter
): Promise<void> {
  const { feed } = ctx;
  const balanceEngine = new BalanceEngine({
    enabled: ctx.balanceTrackingEnabled,
    startingBalance: ctx.balanceStartingBalance,
    reserveBalance: ctx.balanceReserveBalance,
    fixedStakeUntilBalance: ctx.balanceFixedStakeUntilBalance,
    minBalanceToContinue: ctx.balanceMinBalanceToContinue,
    fixedStakeQuote: 100,
  });
  reporter.setBalanceConfig({
    startingBalance: ctx.balanceStartingBalance,
    reserveBalance: ctx.balanceReserveBalance,
    minBalanceToContinue: ctx.balanceMinBalanceToContinue,
    fixedStakeUntilBalance: ctx.balanceFixedStakeUntilBalance,
  });
  reporter.setBalanceSnapshot(balanceEngine.getSnapshot());
  reporter.recordBalanceInitialized(Date.now());
  const profitLockThresholdQuote =
    ctx.paper.getConfig().profitLockThresholdQuote ?? 1;
  const rt: FuturesStackRuntime = {
    instrumentId: feed.instrumentId,
    contract: feed.contract,
    risk: ctx.risk,
    paper: ctx.paper,
    priceBuffer: ctx.priceBuffer,
    minSamples: ctx.minSamples,
    signalInputBase: ctx.signalInputBase,
    feedStaleMaxAgeMs: ctx.feedStaleMaxAgeMs,
    blockEntriesOnExecutionFeedStale: ctx.blockEntriesOnExecutionFeedStale,
    entryConfirmationTicks: ctx.entryConfirmationTicks,
    entryRequireReversal: ctx.entryRequireReversal,
    pendingEntry: null,
  };

  let lastCooldownAnchorMs: number | null = null;
  let tradeSequence = 0;
  const progressIntervalMs = 5 * 60 * 1000;
  let requestShutdown: (() => void) | null = null;

  const writeProgressNow = (): void => {
    reporter.writeProgressSnapshot(Date.now());
  };

  writeProgressNow();

  const tick = (): void => {
    reporter.recordTick();
    const now = Date.now();
    const hadOpenTrade = reporter.hasActiveTrade();
    const book = feed.getExecutionBook();
    const markPrice = feed.getMarkPrice();
    const lastMessageAgeMs = feed.getLastMessageAgeMs(now);
    let closedTradePreviousBalanceSnapshot: BalanceSnapshotState = null;
    reporter.recordFeedSnapshot({
      lastMessageAgeMs,
      feedStale: ctx.feedStaleMaxAgeMs > 0 && lastMessageAgeMs > ctx.feedStaleMaxAgeMs,
      bookValid: isExecutableBook(book),
      markPrice,
    });
    if (ctx.balanceTrackingEnabled) {
      ctx.risk.setConfig({ baseStakeQuote: balanceEngine.activeStake });
    }
    tradeSequence += 1;
    const step = runFuturesStackStep(rt, {
      nowMs: now,
      tradeSequence,
      mid: feed.getSignalMid(),
      markPrice,
      book,
      lastMessageAgeMs: feed.getLastMessageAgeMs(now),
      lastCooldownAnchorMs,
      onClosedRoundtrip: (roundtrip) => {
        closedTradePreviousBalanceSnapshot = balanceEngine.getSnapshot();
        const snapshot = balanceEngine.applyRealizedNetPnlQuote(roundtrip.netPnlQuote);
        reporter.setBalanceSnapshot(snapshot);
        return snapshot.stopRequested;
      },
    });
    lastCooldownAnchorMs = step.lastCooldownAnchorMs;
    reporter.recordExitLifecycle(now, step.exitDecision, book);
    if (step.exitDecision?.kind === "closed" && step.exitDecision.trigger === "profit_lock") {
      reporter.recordProfitLockTriggered(
        now,
        now,
        step.exitDecision,
        profitLockThresholdQuote
      );
    } else if (
      step.exitDecision?.kind === "closed" &&
      step.exitDecision.trigger === "trailing_profit"
    ) {
      reporter.recordTrailingProfitTriggered(
        now,
        now,
        step.exitDecision,
        profitLockThresholdQuote
      );
    }
    reporter.recordMarginLifecycle(now, now, step.marginDecision);

    if (step.closedRoundtrip) {
      reporter.recordTradeClosed(now, step.closedRoundtrip);
      reporter.recordBalanceAfterTrade(now, closedTradePreviousBalanceSnapshot);
      writeProgressNow();
    }

    if (step.signalEvaluation) {
      reporter.recordSignal(now, step.signalEvaluation);
    }

    if (step.entryConfirmation) {
      reporter.recordEntryConfirmation(now, step.entryConfirmation);
    }

    if (step.riskEvaluationInput && step.riskEvaluation) {
      reporter.recordRisk(now, step.riskEvaluationInput, step.riskEvaluation);
      reporter.recordRiskBlockedIfNeeded(
        step.signalEvaluation?.actionable ?? false,
        step.riskEvaluation.allowed
      );
    }

    if (step.openAttempt?.ok && step.openSignalSnapshot) {
      reporter.recordOpenSuccess(now, step.openAttempt, now, step.openSignalSnapshot);
    } else if (step.openAttempt && !step.openAttempt.ok) {
      reporter.recordOpenRejected(now, step.openAttempt, step.openSignalSnapshot);
    } else if (envBool("FUTURES_VERBOSE", false) && step.riskEvaluation) {
      console.log(
        JSON.stringify({
          channel: "futures_monitor",
          type: "risk_debug",
          sessionId: reporter.getSessionId(),
          allowed: step.riskEvaluation.allowed,
          rejectionReasons: step.riskEvaluation.rejectionReasons,
        })
      );
    }

    if (hadOpenTrade && reporter.hasActiveTrade() && !step.closedRoundtrip) {
      if (book) {
        reporter.recordTradeUpdate(now, now, book.midPrice, markPrice ?? book.midPrice);
      }
    }

    const activeTrade = reporter.getActiveTrade();
    const currentMarkPrice = markPrice ?? book?.midPrice ?? null;
    if (activeTrade && currentMarkPrice !== null && Number.isFinite(currentMarkPrice)) {
      const unrealizedPnlQuote =
        activeTrade.side === "long"
          ? (currentMarkPrice - activeTrade.avgEntryPrice) * activeTrade.quantity * activeTrade.contractMultiplier
          : (activeTrade.avgEntryPrice - currentMarkPrice) * activeTrade.quantity * activeTrade.contractMultiplier;
      balanceEngine.setUnrealizedPnlQuote(unrealizedPnlQuote);
    } else {
      balanceEngine.setUnrealizedPnlQuote(0);
    }
    reporter.setBalanceSnapshot(balanceEngine.getSnapshot());

    if (balanceEngine.stopRequested && requestShutdown) {
      console.log(
        JSON.stringify({
          channel: "futures_monitor",
          type: "balance_stop_requested",
          sessionId: reporter.getSessionId(),
          balance: balanceEngine.getSnapshot(),
          reason: balanceEngine.stopReason,
        })
      );
      requestShutdown();
    }
  };

  return new Promise<void>((resolve) => {
    const id = setInterval(tick, ctx.tickIntervalMs);
    const progressId = setInterval(writeProgressNow, progressIntervalMs);
    requestShutdown = (): void => {
      clearInterval(id);
      clearInterval(progressId);
      writeProgressNow();
      try {
        feed.stop();
      } catch {
        /* ignore */
      }
      resolve();
    };
    const shutdown = (): void => {
      requestShutdown?.();
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}

async function main(): Promise<void> {
  const ctx = createFuturesMonitorRuntime();
  const { feed, tickIntervalMs } = ctx;
  const profitLockThresholdQuote =
    ctx.paper.getConfig().profitLockThresholdQuote ?? 1;
  const reporter = new FuturesMonitorReporter(
    feed.instrumentId,
    profitLockThresholdQuote
  );

  console.log(
    JSON.stringify({
      channel: "futures_monitor",
      type: "startup",
      sessionId: reporter.getSessionId(),
      instrumentId: feed.instrumentId,
      contract: feed.contract,
      venueKind: feed.venueKind,
      implementationKind: feed.implementationKind,
      capabilities: feed.capabilities,
      priceSources: feed.priceSources,
      entryConfirmationTicks: ctx.entryConfirmationTicks,
      entryRequireReversal: ctx.entryRequireReversal,
      balanceTrackingEnabled: ctx.balanceTrackingEnabled,
      tickIntervalMs,
      paperFeed: feed.implementationKind === "futures_native_paper",
      reportDir: reporter.getOutputDir(),
      progressReportPath: reporter.getProgressPath(),
      balanceHistoryPath: reporter.getHistoryPath(),
    })
  );

  const ok = await feed.bootstrapRest();
  if (!ok) {
    console.log(
      JSON.stringify({
        channel: "futures_monitor",
        type: "bootstrap_failed",
        sessionId: reporter.getSessionId(),
      })
    );
    reporter.writeProgressSnapshot(Date.now());
    reporter.finish(false, ctx.paper.getCumulativeRealizedPnlQuote());
    process.exitCode = 1;
    return;
  }
  reporter.setBootstrapRestOk(true);

  feed.start();
  await runMonitorLoop(ctx, reporter);
  reporter.finish(true, ctx.paper.getCumulativeRealizedPnlQuote());
  console.log(
    JSON.stringify({
      channel: "futures_monitor",
      type: "shutdown",
      sessionId: reporter.getSessionId(),
    })
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
