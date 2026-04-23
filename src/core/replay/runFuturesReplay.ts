/**
 * Offline replay / minimal backtest for the futures core stack.
 *
 * Dependencies on non-core code:
 * - `createFuturesMonitorRuntime` loads `src/config.ts` (app env + strategy knobs).
 * - WebSocket feed is constructed but never started during replay (lightweight paper feed if FUTURES_USE_PAPER_FEED=1).
 *
 * Does NOT use: `src/backtest.ts`, `simulationEngine`, `strategyDecisionPipeline`.
 */
import { writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";

import {
  loadFuturesReplayTicks,
  inferReplayFormat,
  type FuturesReplayFormat,
} from "./futuresReplaySeries.js";
import {
  createReplayFailureInjector,
  type ReplayFailureProfile,
  type ReplayMarketCondition,
} from "./futuresReplayDegradation.js";
import { createFuturesMonitorRuntime } from "../runtime/futuresBootstrap.js";
import {
  runFuturesStackStep,
  type FuturesEntryConfirmationUpdate,
  type FuturesStackOpenAttempt,
  type FuturesStackRuntime,
} from "../runtime/futuresStackStep.js";
import type { InstrumentId } from "../domain/instrument.js";
import type { TopOfBookL1 } from "../domain/book.js";
import type { PositionSide } from "../domain/sides.js";
import type { FuturesPaperExitDecision } from "../execution/futuresPaperTypes.js";
import type { FuturesPaperMarginDecision } from "../execution/futuresPaperTypes.js";
import type { SignalEvaluation } from "../signal/types.js";
import type { RiskEvaluationInput, RiskGateResult } from "../risk/riskTypes.js";
import type { FuturesPaperRoundtrip } from "../execution/futuresPaperTypes.js";
import type { FuturesJsonlEvent, FuturesSessionSummary } from "../reporting/futuresEventTypes.js";
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
  buildLiquidationRiskEvent,
  buildMarginWarningEvent,
  buildProfitLockTriggeredEvent,
  buildPaperCloseEvent,
  buildPaperLiquidationEvent,
  buildPaperOpenEvent,
  buildPaperOpenRejectedEvent,
  buildRiskEvaluatedEvent,
  buildSessionSummaryEvent,
  buildSignalEvaluatedEvent,
  buildSignalRejectedEvent,
  buildTradeUpdatedEvent,
} from "../reporting/index.js";

export const FUTURES_REPLAY_SUMMARY_SCHEMA = "futures_replay_summary_v1" as const;

export type FuturesReplaySummary = {
  readonly schema: typeof FUTURES_REPLAY_SUMMARY_SCHEMA;
  readonly inputPath: string;
  readonly format: FuturesReplayFormat;
  readonly tickCount: number;
  readonly closedTrades: number;
  readonly opens: number;
  /** Ticks past warmup where signal was actionable but risk denied entry. */
  readonly actionableBlockedByRisk: number;
  readonly wins: number;
  readonly losses: number;
  readonly breakeven: number;
  readonly realizedNetPnlQuote: number;
  readonly staleTicks: number;
  readonly maxLastMessageAgeMs: number;
  readonly tradeUpdates: number;
  readonly entryConfirmationPendingCount: number;
  readonly entryConfirmationCancelledCount: number;
  readonly entryConfirmationSatisfiedCount: number;
  readonly marginWarningCount: number;
  readonly liquidationRiskCount: number;
  readonly profitLockTriggeredCount: number;
  readonly paperLiquidationCount: number;
  readonly exitPendingCount: number;
  readonly exitRetryCount: number;
  readonly exitRetryFailedCount: number;
  readonly exitExecutionSkippedCount: number;
  readonly forcedCloseCount: number;
  readonly quantityRoundedCount: number;
  readonly invalidOrderQuantityCount: number;
  readonly notionalMismatchCount: number;
  readonly degradation: {
    readonly profile: ReplayFailureProfile;
    readonly seed: number;
    readonly degradedTicks: number;
    readonly missingBookOccurrences: number;
    readonly invalidBookOccurrences: number;
    readonly staleFeedOccurrences: number;
    readonly spreadWidenOccurrences: number;
    readonly gapOccurrences: number;
    readonly reconnectOccurrences: number;
    readonly forcedCloseFromDegradedConditions: number;
    readonly retryCountUnderDegradation: number;
    readonly retryFailedCountUnderDegradation: number;
  };
  readonly outputDirectory: string;
  readonly eventsPath: string;
  readonly sessionSummaryPath: string;
  readonly emittedEvents: {
    readonly signalEvaluated: number;
    readonly signalRejected: number;
    readonly riskEvaluated: number;
    readonly entryConfirmationPending: number;
    readonly entryConfirmationCancelled: number;
    readonly marginWarning: number;
    readonly liquidationRisk: number;
    readonly profitLockTriggered: number;
    readonly paperLiquidation: number;
    readonly paperOpen: number;
    readonly paperOpenRejected: number;
    readonly exitPending: number;
    readonly exitRetry: number;
    readonly exitRetryFailed: number;
    readonly exitExecutionSkipped: number;
    readonly forcedClose: number;
    readonly tradeUpdated: number;
    readonly paperClose: number;
    readonly orderQuantityRounded: number;
    readonly orderInvalidQuantity: number;
    readonly orderNotionalMismatch: number;
    readonly sessionSummary: number;
  };
};

function parseArgs(argv: string[]): {
  filePath: string;
  format: "auto" | FuturesReplayFormat;
  stepMs: number;
  epochStartMs: number;
  defaultSpreadBps: number;
  failureProfile: ReplayFailureProfile;
  replaySeed: number;
  forceExitDisruption: boolean;
  reportOutDir: string | undefined;
  jsonOutPath: string | undefined;
} {
  let filePath = "";
  let format: "auto" | FuturesReplayFormat = "auto";
  let stepMs = 5_000;
  let epochStartMs = 0;
  let defaultSpreadBps = 3;
  let failureProfile: ReplayFailureProfile =
    (process.env.FUTURES_REPLAY_FAILURE_PROFILE?.trim() as ReplayFailureProfile) ||
    "off";
  let replaySeed = Number(process.env.FUTURES_REPLAY_SEED?.trim() || "1337");
  if (!Number.isFinite(replaySeed)) replaySeed = 1337;
  let forceExitDisruption =
    failureProfile === "stress" || failureProfile === "chaos";
  let reportOutDir: string | undefined;
  let jsonOutPath: string | undefined;

  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--format") {
      const v = argv[i + 1];
      if (!v || v.startsWith("-")) {
        console.error("--format requires csv | jsonl | auto");
        process.exit(1);
      }
      if (v !== "auto" && v !== "csv" && v !== "jsonl") {
        console.error("--format must be csv | jsonl | auto");
        process.exit(1);
      }
      format = v;
      i += 1;
      continue;
    }
    if (a === "--step-ms") {
      const v = Number(argv[i + 1]);
      if (!Number.isFinite(v) || v <= 0) {
        console.error("--step-ms requires a positive number");
        process.exit(1);
      }
      stepMs = v;
      i += 1;
      continue;
    }
    if (a === "--epoch-start") {
      const v = Number(argv[i + 1]);
      if (!Number.isFinite(v)) {
        console.error("--epoch-start requires a number (ms)");
        process.exit(1);
      }
      epochStartMs = v;
      i += 1;
      continue;
    }
    if (a === "--spread-bps") {
      const v = Number(argv[i + 1]);
      if (!Number.isFinite(v) || v < 0) {
        console.error("--spread-bps requires a non-negative number");
        process.exit(1);
      }
      defaultSpreadBps = v;
      i += 1;
      continue;
    }
    if (a === "--failure-profile") {
      const v = argv[i + 1]?.trim() as ReplayFailureProfile | undefined;
      if (!v || v.startsWith("-")) {
        console.error("--failure-profile requires off | mild | stress | chaos");
        process.exit(1);
      }
      if (v !== "off" && v !== "mild" && v !== "stress" && v !== "chaos") {
        console.error("--failure-profile requires off | mild | stress | chaos");
        process.exit(1);
      }
      failureProfile = v;
      i += 1;
      continue;
    }
    if (a === "--seed") {
      const v = Number(argv[i + 1]);
      if (!Number.isFinite(v)) {
        console.error("--seed requires a numeric value");
        process.exit(1);
      }
      replaySeed = v;
      i += 1;
      continue;
    }
    if (a === "--force-exit-disruption") {
      forceExitDisruption = true;
      continue;
    }
    if (a === "--json-out") {
      const next = argv[i + 1];
      if (!next || next.startsWith("-")) {
        console.error("--json-out requires a file path");
        process.exit(1);
      }
      jsonOutPath = next;
      i += 1;
      continue;
    }
    if (a === "--report-out") {
      const next = argv[i + 1];
      if (!next || next.startsWith("-")) {
        console.error("--report-out requires a directory path");
        process.exit(1);
      }
      reportOutDir = next;
      i += 1;
      continue;
    }
    if (a.startsWith("-")) {
      console.error(`Unknown flag: ${a}`);
      process.exit(1);
    }
    if (!filePath) filePath = a;
    else {
      console.error(`Unexpected argument: ${a}`);
      process.exit(1);
    }
  }

  if (!filePath) {
    console.error(
    "Usage: node runFuturesReplay.js <path> [--format csv|jsonl|auto] [--step-ms 5000] [--epoch-start 0] [--spread-bps 3] [--json-out path]\n" +
        "  [--failure-profile off|mild|stress|chaos] [--seed n] [--force-exit-disruption]\n" +
        "  [--report-out dir]\n" +
        "  CSV: header row with mid|price|close; optional time_ms / spread_bps. Single-column CSV uses step-ms between rows.\n" +
        "  JSONL: one JSON per line with mid, atMs (or time_ms | t), optional spread_bps.\n"
    );
    process.exit(1);
  }

  return {
    filePath,
    format,
    stepMs,
    epochStartMs,
    defaultSpreadBps,
    failureProfile,
    replaySeed,
    forceExitDisruption,
    reportOutDir,
    jsonOutPath,
  };
}

type ActiveTradeState = {
  tradeId: string;
  side: PositionSide;
  quantity: number;
  avgEntryPrice: number;
  openedAtMs: number;
  contractMultiplier: number;
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

class FuturesReplayReporter {
  private readonly persistence: FuturesReportingPersistence;
  private readonly sessionId = `futures-replay-${Date.now()}-${randomUUID().slice(0, 8)}`;
  private readonly startedAtMs = Date.now();
  private readonly startedAtIso = new Date(this.startedAtMs).toISOString();
  private activeTrade: ActiveTradeState | null = null;
  private finalized = false;

  private ticks = 0;
  private signalsEvaluated = 0;
  private signalsRejected = 0;
  private riskEvaluated = 0;
  private tradesOpened = 0;
  private openRejected = 0;
  private tradesClosed = 0;
  private tradeUpdates = 0;
  private entryConfirmationPendingCount = 0;
  private entryConfirmationCancelledCount = 0;
  private entryConfirmationSatisfiedCount = 0;
  private marginWarningCount = 0;
  private liquidationRiskCount = 0;
  private profitLockTriggeredCount = 0;
  private paperLiquidationCount = 0;
  private riskBlockedEntries = 0;
  private exitPendingCount = 0;
  private exitRetryCount = 0;
  private exitRetryFailedCount = 0;
  private exitExecutionSkippedCount = 0;
  private forcedCloseCount = 0;
  private quantityRoundedCount = 0;
  private invalidOrderQuantityCount = 0;
  private notionalMismatchCount = 0;
  private degradedTicks = 0;
  private missingBookOccurrences = 0;
  private invalidBookOccurrences = 0;
  private staleFeedOccurrences = 0;
  private spreadWidenOccurrences = 0;
  private gapOccurrences = 0;
  private reconnectOccurrences = 0;
  private forcedCloseFromDegradedConditions = 0;
  private retryCountUnderDegradation = 0;
  private retryFailedCountUnderDegradation = 0;
  private staleTicks = 0;
  private maxLastMessageAgeMs = 0;
  private closedWinCount = 0;
  private closedLossCount = 0;
  private closedBreakevenCount = 0;
  private activeExit: ActiveExitState | null = null;
  private activeMarginLevel: "warning" | "risk" | null = null;
  private currentCondition: ReplayMarketCondition | null = null;

  constructor(
    private readonly instrumentId: InstrumentId,
    private readonly failureProfile: ReplayFailureProfile,
    private readonly replaySeed: number,
    private readonly profitLockThresholdQuote: number,
    outputDir?: string
  ) {
    const resolvedOutputDir =
      outputDir ??
      (process.env.FUTURES_REPLAY_REPORT_OUTPUT_DIR?.trim() ||
        "output/futures-replay");
    this.persistence = new FuturesReportingPersistence(resolvedOutputDir);
  }

  getSessionId(): string {
    return this.sessionId;
  }

  getOutputDir(): string {
    return this.persistence.getOutputDir();
  }

  getEventsPath(): string {
    return this.persistence.getEventsPath();
  }

  getSessionSummaryPath(): string {
    return this.persistence.getSessionSummaryPath();
  }

  hasActiveTrade(): boolean {
    return this.activeTrade !== null;
  }

  private logConsole(record: Record<string, unknown>): void {
    console.log(JSON.stringify({ channel: "futures_replay", ...record }));
  }

  private append(event: FuturesJsonlEvent): void {
    this.persistence.appendEvent(event);
    this.logConsole(event);
  }

  recordMarketCondition(condition: ReplayMarketCondition): void {
    this.currentCondition = condition;
    if (!condition.degraded) return;
    this.degradedTicks += 1;
    if (condition.kind === "missing_book") this.missingBookOccurrences += 1;
    if (condition.kind === "invalid_book") this.invalidBookOccurrences += 1;
    if (condition.kind === "stale_feed") this.staleFeedOccurrences += 1;
    if (condition.kind === "spread_widening") this.spreadWidenOccurrences += 1;
    if (condition.kind === "time_gap") this.gapOccurrences += 1;
    if (condition.reconnect) this.reconnectOccurrences += 1;
    this.logConsole({
      type: "market_condition",
      sessionId: this.sessionId,
      atMs: condition.atMs,
      kind: condition.kind,
      degraded: condition.degraded,
      reconnect: condition.reconnect,
      gapMs: condition.gapMs,
      spreadMultiplier: condition.spreadMultiplier,
      staleBoostMs: condition.staleBoostMs,
      reasons: condition.reasons,
    });
  }

  recordTick(lastMessageAgeMs: number, feedStaleMaxAgeMs: number): void {
    this.ticks += 1;
    if (lastMessageAgeMs > this.maxLastMessageAgeMs) {
      this.maxLastMessageAgeMs = lastMessageAgeMs;
    }
    if (feedStaleMaxAgeMs > 0 && lastMessageAgeMs > feedStaleMaxAgeMs) {
      this.staleTicks += 1;
    }
  }

  recordSignal(recordedAtMs: number, evaluation: SignalEvaluation): void {
    this.signalsEvaluated += 1;
    if (!evaluation.actionable) this.signalsRejected += 1;
    this.append(
      buildSignalEvaluatedEvent({
        sessionId: this.sessionId,
        recordedAtMs,
        instrumentId: this.instrumentId,
        evaluation,
      })
    );
    if (!evaluation.actionable) {
      const rejected = buildSignalRejectedEvent({
        sessionId: this.sessionId,
        recordedAtMs,
        instrumentId: this.instrumentId,
        evaluation,
      });
      if (rejected) this.append(rejected);
    }
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
    this.riskEvaluated += 1;
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
    const degraded = this.currentCondition?.degraded ?? false;

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
        if (degraded) this.retryCountUnderDegradation += 1;
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
      if (degraded) this.retryCountUnderDegradation += 1;
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
        if (degraded) this.retryFailedCountUnderDegradation += 1;
        this.forcedCloseCount += 1;
        if (degraded) {
          this.forcedCloseFromDegradedConditions += 1;
        }
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
      if (degraded) {
        this.forcedCloseFromDegradedConditions += 1;
      }
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

  recordTradeClosed(recordedAtMs: number, roundtrip: FuturesPaperRoundtrip): void {
    const tradeId = this.activeTrade?.tradeId ?? `${this.sessionId}:trade:orphan`;
    this.tradesClosed += 1;
    this.closedWinCount += roundtrip.netPnlQuote > 0 ? 1 : 0;
    this.closedLossCount += roundtrip.netPnlQuote < 0 ? 1 : 0;
    this.closedBreakevenCount += roundtrip.netPnlQuote === 0 ? 1 : 0;
    this.activeTrade = null;
    this.activeExit = null;
    this.currentCondition = null;
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
    this.tradeUpdates += 1;
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

  recordOpenSuccess(
    recordedAtMs: number,
    attempt: Extract<FuturesStackOpenAttempt, { ok: true }>,
    openedAtMs: number,
    snapshot?: { impulseDirection: string; contrarianDirection: string; strength: string }
  ): void {
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
        ...(snapshot?.impulseDirection !== undefined
          ? { impulseDirection: snapshot.impulseDirection }
          : {}),
        ...(snapshot?.contrarianDirection !== undefined
          ? { contrarianDirection: snapshot.contrarianDirection }
          : {}),
        ...(snapshot?.strength !== undefined ? { strength: snapshot.strength } : {}),
      })
    );
  }

  recordOpenRejected(
    recordedAtMs: number,
    attempt: Extract<FuturesStackOpenAttempt, { ok: false }>,
    snapshot?: { impulseDirection: string; contrarianDirection: string; strength: string }
  ): void {
    const telemetry = attempt.telemetry;
    this.openRejected += 1;
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
        ...(snapshot?.impulseDirection !== undefined
          ? { impulseDirection: snapshot.impulseDirection }
          : {}),
        ...(snapshot?.contrarianDirection !== undefined
          ? { contrarianDirection: snapshot.contrarianDirection }
          : {}),
        ...(snapshot?.strength !== undefined ? { strength: snapshot.strength } : {}),
      })
    );
  }

  recordRiskBlockedIfNeeded(signalActionable: boolean, riskAllowed: boolean): void {
    if (signalActionable && !riskAllowed) {
      this.riskBlockedEntries += 1;
    }
  }

  finish(realizedNetPnlQuote: number): void {
    if (this.finalized) {
      throw new Error("Replay reporter already finalized");
    }
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
      feed: {
        bootstrapRestOk: true,
        messagesApprox: this.ticks,
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

  buildSummary(
    inputPath: string,
    format: FuturesReplayFormat,
    realizedNetPnlQuote: number
  ): FuturesReplaySummary {
    return {
      schema: FUTURES_REPLAY_SUMMARY_SCHEMA,
      inputPath,
      format,
      tickCount: this.ticks,
      closedTrades: this.tradesClosed,
      opens: this.tradesOpened,
      actionableBlockedByRisk: this.riskBlockedEntries,
      wins: this.closedWinCount,
      losses: this.closedLossCount,
      breakeven: this.closedBreakevenCount,
      realizedNetPnlQuote,
      staleTicks: this.staleTicks,
      maxLastMessageAgeMs: this.maxLastMessageAgeMs,
      tradeUpdates: this.tradeUpdates,
      entryConfirmationPendingCount: this.entryConfirmationPendingCount,
      entryConfirmationCancelledCount: this.entryConfirmationCancelledCount,
      entryConfirmationSatisfiedCount: this.entryConfirmationSatisfiedCount,
      marginWarningCount: this.marginWarningCount,
      liquidationRiskCount: this.liquidationRiskCount,
      profitLockTriggeredCount: this.profitLockTriggeredCount,
      paperLiquidationCount: this.paperLiquidationCount,
      exitPendingCount: this.exitPendingCount,
      exitRetryCount: this.exitRetryCount,
      exitRetryFailedCount: this.exitRetryFailedCount,
      exitExecutionSkippedCount: this.exitExecutionSkippedCount,
      forcedCloseCount: this.forcedCloseCount,
      quantityRoundedCount: this.quantityRoundedCount,
      invalidOrderQuantityCount: this.invalidOrderQuantityCount,
      notionalMismatchCount: this.notionalMismatchCount,
      degradation: {
        profile: this.failureProfile,
        seed: this.replaySeed,
        degradedTicks: this.degradedTicks,
        missingBookOccurrences: this.missingBookOccurrences,
        invalidBookOccurrences: this.invalidBookOccurrences,
        staleFeedOccurrences: this.staleFeedOccurrences,
        spreadWidenOccurrences: this.spreadWidenOccurrences,
        gapOccurrences: this.gapOccurrences,
        reconnectOccurrences: this.reconnectOccurrences,
        forcedCloseFromDegradedConditions: this.forcedCloseFromDegradedConditions,
        retryCountUnderDegradation: this.retryCountUnderDegradation,
        retryFailedCountUnderDegradation: this.retryFailedCountUnderDegradation,
      },
      outputDirectory: this.persistence.getOutputDir(),
      eventsPath: this.persistence.getEventsPath(),
      sessionSummaryPath: this.persistence.getSessionSummaryPath(),
      emittedEvents: {
        signalEvaluated: this.signalsEvaluated,
        signalRejected: this.signalsRejected,
        riskEvaluated: this.riskEvaluated,
        entryConfirmationPending: this.entryConfirmationPendingCount,
        entryConfirmationCancelled: this.entryConfirmationCancelledCount,
        marginWarning: this.marginWarningCount,
        liquidationRisk: this.liquidationRiskCount,
        profitLockTriggered: this.profitLockTriggeredCount,
        paperLiquidation: this.paperLiquidationCount,
        paperOpen: this.tradesOpened,
        paperOpenRejected: this.openRejected,
        exitPending: this.exitPendingCount,
        exitRetry: this.exitRetryCount,
        exitRetryFailed: this.exitRetryFailedCount,
        exitExecutionSkipped: this.exitExecutionSkippedCount,
        forcedClose: this.forcedCloseCount,
        tradeUpdated: this.tradeUpdates,
        paperClose: this.tradesClosed,
        orderQuantityRounded: this.quantityRoundedCount,
        orderInvalidQuantity: this.invalidOrderQuantityCount,
        orderNotionalMismatch: this.notionalMismatchCount,
        sessionSummary: 1,
      },
    };
  }
}

export async function runFuturesReplayFromPath(
  filePath: string,
  options: {
    format: "auto" | FuturesReplayFormat;
    stepMs: number;
    epochStartMs: number;
    defaultSpreadBps: number;
    failureProfile: ReplayFailureProfile;
    replaySeed: number;
    forceExitDisruption: boolean;
    reportOutDir?: string;
  }
): Promise<FuturesReplaySummary> {
  const resolvedFormat = inferReplayFormat(filePath, options.format);

  const ticks = await loadFuturesReplayTicks(filePath, resolvedFormat, {
    stepMs: options.stepMs,
    epochStartMs: options.epochStartMs,
    defaultSpreadBps: options.defaultSpreadBps,
  });

  const ctx = createFuturesMonitorRuntime();
  const { feed } = ctx;
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

  const failureInjector = createReplayFailureInjector({
    profile: options.failureProfile,
    seed: options.replaySeed,
    forceExitDisruption: options.forceExitDisruption,
    stepMs: options.stepMs,
    exitGracePeriodMs: ctx.paper.getConfig().exitGracePeriodMs,
  });

  const reporter = new FuturesReplayReporter(
    feed.instrumentId,
    options.failureProfile,
    options.replaySeed,
    profitLockThresholdQuote,
    options.reportOutDir
  );

  console.log(
    JSON.stringify({
      channel: "futures_replay",
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
      tickCount: ticks.length,
      failureProfile: options.failureProfile,
      replaySeed: options.replaySeed,
      forceExitDisruption: options.forceExitDisruption,
      reportDir: reporter.getOutputDir(),
      eventsPath: reporter.getEventsPath(),
      sessionSummaryPath: reporter.getSessionSummaryPath(),
    })
  );

  let lastCooldownAnchorMs: number | null = null;
  let previousMid: number | null = null;
  let tradeSequence = 0;

  for (const row of ticks) {
    const plan = failureInjector.planTick({
      atMs: row.atMs,
      mid: row.mid,
      spreadBps: row.spreadBps,
      previousMid,
      feedStaleMaxAgeMs: ctx.feedStaleMaxAgeMs,
    });
    reporter.recordMarketCondition(plan.condition);
    reporter.recordTick(plan.condition.lastMessageAgeMs, ctx.feedStaleMaxAgeMs);
    const hadOpenTrade = reporter.hasActiveTrade();
    tradeSequence += 1;
    const step = runFuturesStackStep(rt, {
      nowMs: plan.condition.atMs,
      tradeSequence,
      mid: row.mid,
      markPrice: row.mid,
      book: plan.condition.book,
      lastMessageAgeMs: plan.condition.lastMessageAgeMs,
      lastCooldownAnchorMs,
    });
    lastCooldownAnchorMs = step.lastCooldownAnchorMs;
    reporter.recordExitLifecycle(plan.condition.atMs, step.exitDecision, plan.condition.book);
    if (step.exitDecision?.kind === "closed" && step.exitDecision.trigger === "profit_lock") {
      reporter.recordProfitLockTriggered(
        plan.condition.atMs,
        plan.condition.atMs,
        step.exitDecision,
        profitLockThresholdQuote
      );
    }
    reporter.recordMarginLifecycle(plan.condition.atMs, plan.condition.atMs, step.marginDecision);
    if (step.closedRoundtrip) {
      reporter.recordTradeClosed(plan.condition.atMs, step.closedRoundtrip);
    }
    if (step.signalEvaluation) {
      reporter.recordSignal(plan.condition.atMs, step.signalEvaluation);
    }
    if (step.entryConfirmation) {
      reporter.recordEntryConfirmation(plan.condition.atMs, step.entryConfirmation);
    }
    if (step.riskEvaluationInput && step.riskEvaluation) {
      reporter.recordRisk(plan.condition.atMs, step.riskEvaluationInput, step.riskEvaluation);
      reporter.recordRiskBlockedIfNeeded(
        step.signalEvaluation?.actionable ?? false,
        step.riskEvaluation.allowed
      );
    }
    if (step.openAttempt?.ok && step.openSignalSnapshot) {
      reporter.recordOpenSuccess(plan.condition.atMs, step.openAttempt, plan.condition.atMs, step.openSignalSnapshot);
      failureInjector.armExitDisruption();
    } else if (step.openAttempt && !step.openAttempt.ok) {
      reporter.recordOpenRejected(plan.condition.atMs, step.openAttempt, step.openSignalSnapshot);
    }
    if (hadOpenTrade && reporter.hasActiveTrade() && !step.closedRoundtrip) {
      reporter.recordTradeUpdate(plan.condition.atMs, plan.condition.atMs, row.mid, row.mid);
    }
    previousMid = row.mid;
  }

  const realizedNetPnlQuote = ctx.paper.getCumulativeRealizedPnlQuote();
  reporter.finish(realizedNetPnlQuote);
  return reporter.buildSummary(filePath, resolvedFormat, realizedNetPnlQuote);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const summary = await runFuturesReplayFromPath(args.filePath, {
    format: args.format,
    stepMs: args.stepMs,
    epochStartMs: args.epochStartMs,
    defaultSpreadBps: args.defaultSpreadBps,
    failureProfile: args.failureProfile,
    replaySeed: args.replaySeed,
    forceExitDisruption: args.forceExitDisruption,
    ...(args.reportOutDir !== undefined ? { reportOutDir: args.reportOutDir } : {}),
  });

  console.log(JSON.stringify(summary, null, 2));

  if (args.jsonOutPath) {
    await writeFile(args.jsonOutPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
