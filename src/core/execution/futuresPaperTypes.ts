import type { InstrumentId } from "../domain/instrument.js";
import type { PositionSide } from "../domain/sides.js";

/** Why the simulated position was flattened. */
export type FuturesPaperCloseReason =
  | "take_profit"
  | "stop_loss"
  | "exit_timeout"
  | "profit_lock"
  | "manual"
  | "forced_exit"
  | "paper_liquidation";

export type FuturesPaperExitTrigger =
  | "take_profit"
  | "stop_loss"
  | "exit_timeout"
  | "profit_lock";

export type FuturesPaperExitPendingReason =
  | "trigger_reached_book_invalid"
  | "trigger_reached_book_missing"
  | "retry_failed";

export type FuturesPaperExitDecision =
  | {
      readonly kind: "closed";
      readonly trigger: FuturesPaperExitTrigger;
      readonly forced: boolean;
      readonly estimatedNetPnlAtExitQuote: number;
      readonly roundtrip: FuturesPaperRoundtrip;
    }
  | {
      readonly kind: "pending";
      readonly trigger: FuturesPaperExitTrigger;
      readonly pendingReason: FuturesPaperExitPendingReason;
      readonly firstTriggeredAtMs: number;
      readonly lastAttemptAtMs: number;
      readonly graceDeadlineAtMs: number;
    };

/**
 * Simulation knobs. Amounts are linear perp-style (quote P/L per 1 base unit move).
 * `leverage` is stored for future margin math — not applied to P/L yet.
 */
export type FuturesPaperEngineConfig = {
  /** Distance from entry to take-profit trigger (bps on price). */
  takeProfitBps: number;
  /** Distance from entry to stop trigger (bps on price). */
  stopLossBps: number;
  /** Max hold; `0` disables time exit. */
  exitTimeoutMs: number;
  /** Total fees as bps of notional, split evenly across open + close legs. */
  feeRoundTripBps: number;
  /** Adverse execution: widens away from mid on each market fill (bps). */
  slippageBps: number;
  /** Grace window before a stale/missing-book exit is force-closed (ms). */
  exitGracePeriodMs: number;
  /** Adverse fallback when forced without an executable book (bps on entry-based fallback). */
  forcedExitPenaltyBps: number;
  /** Initial margin as a fraction of notional; falls back to leverage if set. */
  initialMarginRate?: number;
  /** Maintenance margin as a fraction of notional. */
  maintenanceMarginRate?: number;
  /** Emit margin warnings once equity/maintenance falls below this ratio. */
  marginWarningRatio?: number;
  /** Emit liquidation-risk alerts once equity/maintenance falls below this ratio. */
  liquidationRiskRatio?: number;
  /** Extra adverse execution used only for paper liquidation. */
  liquidationPenaltyBps?: number;
  /** Enable early close when estimated net PnL at executable exit is above threshold. */
  profitLockEnabled?: boolean;
  /** Minimum estimated net PnL at exit, in quote currency, to trigger profit lock. */
  profitLockThresholdQuote?: number;
  /** Deprecated fallback, used only when explicit rates are absent. */
  leverage?: number;
};

export type FuturesPaperRoundtrip = {
  readonly instrumentId: InstrumentId;
  readonly side: PositionSide;
  readonly quantity: number;
  readonly entryPrice: number;
  readonly exitPrice: number;
  readonly grossPnlQuote: number;
  readonly feesQuote: number;
  readonly netPnlQuote: number;
  readonly openedAtMs: number;
  readonly closedAtMs: number;
  readonly closeReason: FuturesPaperCloseReason;
};

export type FuturesPaperOpenOk = {
  ok: true;
  avgEntryPrice: number;
  feesOpenQuote: number;
};

export type FuturesPaperOpenReject = {
  ok: false;
  reason: string;
};

export type FuturesPaperOpenResult = FuturesPaperOpenOk | FuturesPaperOpenReject;

export type FuturesPaperMarginSnapshot = {
  readonly markPrice: number;
  readonly entryPrice: number;
  readonly side: PositionSide;
  readonly quantity: number;
  readonly contractMultiplier: number;
  readonly positionNotionalQuote: number;
  readonly initialMarginQuote: number;
  readonly maintenanceMarginQuote: number;
  readonly marginBalanceQuote: number;
  readonly unrealizedPnlQuote: number;
  readonly marginRatio: number;
  readonly liquidationPriceEstimate: number;
};

export type FuturesPaperMarginDecision =
  | {
      readonly kind: "ok";
      readonly snapshot: FuturesPaperMarginSnapshot;
    }
  | {
      readonly kind: "margin_warning";
      readonly snapshot: FuturesPaperMarginSnapshot;
      readonly warningRatio: number;
    }
  | {
      readonly kind: "liquidation_risk";
      readonly snapshot: FuturesPaperMarginSnapshot;
      readonly riskRatio: number;
    }
  | {
      readonly kind: "liquidated";
      readonly snapshot: FuturesPaperMarginSnapshot;
      readonly liquidationReason: "maintenance_breach" | "threshold_breach";
      readonly roundtrip: FuturesPaperRoundtrip;
    };
