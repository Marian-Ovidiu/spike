import type { AppConfig } from "./config.js";
import type { EntryDirection, EntryEvaluation } from "./entryConditions.js";
import type { StrategyTickResult } from "./botLoop.js";
import { assessStableRangeQuality } from "./rangeQualityEvaluator.js";
import {
  analyzePostSpikeConfirmation,
  type PostSpikeConfirmationResult,
} from "./postSpikeConfirmationEngine.js";
import { evaluateSpotBookPipeline } from "./spotSpreadFilter.js";

export type BorderlineCandidateStatus =
  | "watching"
  | "promoted"
  | "expired"
  | "cancelled";

export type BorderlineCandidate = {
  id: string;
  createdAt: number;
  startTickNumber: number;
  symbol: string;
  btcPriceAtDetection: number;
  moveDirection: "UP" | "DOWN" | null;
  movePercent: number;
  moveAbsolute: number;
  thresholdPercent: number;
  thresholdRatio: number;
  sourceWindowLabel: string | null;
  suggestedContrarianDirection: EntryDirection | null;
  watchTicksConfigured: number;
  watchTicksRemaining: number;
  initialBestBid: number;
  initialBestAsk: number;
  stableRangeDetected: boolean;
  watchedPrices: number[];
  status: BorderlineCandidateStatus;
  cancellationReason?: string;
  promotionReason?: string;
  updatedAt: number;
};

export type BorderlineLifecycleEventType =
  | "created"
  | "tick"
  | "promoted"
  | "expired"
  | "cancelled"
  | "decision";

export type BorderlineLifecycleEvent = {
  type: BorderlineLifecycleEventType;
  candidate: BorderlineCandidate;
  message: string;
};

export type BorderlineWatchDecision =
  | {
      action: "promote";
      reason: string;
      direction: EntryDirection;
    }
  | {
      action: "cancel";
      reason: string;
    }
  | {
      action: "expire";
      reason: string;
    }
  | {
      action: "watch";
      reason: string;
    };

export type CreateBorderlineCandidateInput = {
  now: number;
  tickNumber: number;
  symbol: string;
  tick: Extract<StrategyTickResult, { kind: "ready" }>;
  stableRangeDetected: boolean;
  watchTicks: number;
};

export type EvaluateBorderlineWatchInput = {
  candidate: BorderlineCandidate;
  tick: Extract<StrategyTickResult, { kind: "ready" }>;
  config: Pick<
    AppConfig,
    | "rangeThreshold"
    | "stableRangeSoftToleranceRatio"
    | "spikeThreshold"
    | "maxEntrySpreadBps"
    | "borderlineRequirePause"
    | "borderlineRequireNoContinuation"
    | "borderlineContinuationThreshold"
    | "borderlineReversionThreshold"
    | "borderlinePauseBandPercent"
  >;
  cooldownBlocked: boolean;
};

export type PostMoveClassification =
  | "continuation"
  | "pause"
  | "reversion"
  | "noisy_unclear";

export type PostBorderlineMovementAnalysis = PostSpikeConfirmationResult;

function suggestedContrarianDirection(
  moveDirection: BorderlineCandidate["moveDirection"]
): EntryDirection | null {
  if (moveDirection === "UP") return "DOWN";
  if (moveDirection === "DOWN") return "UP";
  return null;
}

let candidateSeq = 0;
function nextCandidateId(now: number): string {
  candidateSeq += 1;
  return `bl-${now}-${candidateSeq}`;
}

export function createBorderlineCandidate(
  input: CreateBorderlineCandidateInput
): BorderlineCandidate {
  const ws = input.tick.entry.windowSpike;
  if (!ws) {
    throw new Error("createBorderlineCandidate: missing windowSpike payload");
  }
  return {
    id: nextCandidateId(input.now),
    createdAt: input.now,
    startTickNumber: input.tickNumber,
    symbol: input.symbol,
    btcPriceAtDetection: input.tick.btc,
    moveDirection: ws.strongestMoveDirection,
    movePercent: ws.strongestMovePercent * 100,
    moveAbsolute: ws.strongestMoveAbsolute,
    thresholdPercent: ws.thresholdPercent * 100,
    thresholdRatio: ws.thresholdRatio,
    sourceWindowLabel: ws.sourceWindowLabel,
    suggestedContrarianDirection: suggestedContrarianDirection(
      ws.strongestMoveDirection
    ),
    watchTicksConfigured: Math.max(0, Math.trunc(input.watchTicks)),
    watchTicksRemaining: Math.max(0, Math.trunc(input.watchTicks)),
    initialBestBid: input.tick.sides.bestBid,
    initialBestAsk: input.tick.sides.bestAsk,
    stableRangeDetected: input.stableRangeDetected,
    watchedPrices: [],
    status: "watching",
    updatedAt: input.now,
  };
}

export function withCandidateTick(
  candidate: BorderlineCandidate,
  now: number,
  watchedPrice?: number
): BorderlineCandidate {
  if (candidate.status !== "watching") return candidate;
  return {
    ...candidate,
    watchTicksRemaining: Math.max(0, candidate.watchTicksRemaining - 1),
    watchedPrices:
      watchedPrice !== undefined && Number.isFinite(watchedPrice)
        ? [...candidate.watchedPrices, watchedPrice]
        : candidate.watchedPrices,
    updatedAt: now,
  };
}

export function cancelBorderlineCandidate(
  candidate: BorderlineCandidate,
  reason: string,
  now: number
): BorderlineCandidate {
  return {
    ...candidate,
    status: "cancelled",
    cancellationReason: reason,
    updatedAt: now,
  };
}

export function expireBorderlineCandidate(
  candidate: BorderlineCandidate,
  reason: string,
  now: number
): BorderlineCandidate {
  return {
    ...candidate,
    status: "expired",
    cancellationReason: reason,
    updatedAt: now,
  };
}

export function promoteBorderlineCandidate(
  candidate: BorderlineCandidate,
  reason: string,
  now: number
): BorderlineCandidate {
  return {
    ...candidate,
    status: "promoted",
    promotionReason: reason,
    updatedAt: now,
  };
}

type ManagerOptions = {
  symbol: string;
  watchTicks: number;
};

export class BorderlineCandidateManager {
  private readonly symbol: string;
  private readonly watchTicks: number;
  private tickNumber = 0;
  private active: BorderlineCandidate | null = null;
  private readonly history: BorderlineCandidate[] = [];

  constructor(options: ManagerOptions) {
    this.symbol = options.symbol;
    this.watchTicks = Math.max(0, Math.trunc(options.watchTicks));
  }

  getTickNumber(): number {
    return this.tickNumber;
  }

  getActive(): BorderlineCandidate | null {
    return this.active;
  }

  getHistory(): readonly BorderlineCandidate[] {
    return this.history;
  }

  onTick(
    now: number,
    tick: StrategyTickResult
  ): BorderlineLifecycleEvent[] {
    this.tickNumber += 1;
    const events: BorderlineLifecycleEvent[] = [];

    if (this.active !== null && this.active.status === "watching") {
      const watchedPrice = tick.kind === "ready" ? tick.btc : undefined;
      this.active = withCandidateTick(this.active, now, watchedPrice);
      events.push({
        type: "tick",
        candidate: this.active,
        message: `[borderline] ${this.active.id} watching: ${this.active.watchTicksRemaining} ticks remaining`,
      });
      if (this.active.watchTicksRemaining <= 0) {
        const expired = expireBorderlineCandidate(
          this.active,
          "watch_window_elapsed",
          now
        );
        this.finalize(expired);
        events.push({
          type: "expired",
          candidate: expired,
          message: `[borderline] ${expired.id} expired: watch window elapsed`,
        });
      }
    }

    if (tick.kind !== "ready" || !tick.entry.windowSpike) {
      return events;
    }

    const ws = tick.entry.windowSpike;
    if (ws.classification === "strong_spike") {
      if (this.active?.status === "watching") {
        const sameDirection =
          this.active.moveDirection !== null &&
          ws.strongestMoveDirection === this.active.moveDirection;
        const cancelled = cancelBorderlineCandidate(
          this.active,
          sameDirection
            ? "strong_spike_same_direction"
            : "overridden_by_strong_spike",
          now
        );
        this.finalize(cancelled);
        events.push({
          type: "cancelled",
          candidate: cancelled,
          message: `[borderline] ${cancelled.id} cancelled: strong spike detected`,
        });
      }
      return events;
    }

    if (ws.classification !== "borderline") {
      return events;
    }

    if (this.active?.status === "watching") {
      // only one active per symbol: refresh by replacing old one
      const cancelled = cancelBorderlineCandidate(
        this.active,
        "replaced_by_new_borderline",
        now
      );
      this.finalize(cancelled);
      events.push({
        type: "cancelled",
        candidate: cancelled,
        message: `[borderline] ${cancelled.id} cancelled: replaced by newer borderline`,
      });
    }

    const stableRangeDetected = !tick.entry.reasons.includes("market_not_stable");
    const created = createBorderlineCandidate({
      now,
      tickNumber: this.tickNumber,
      symbol: this.symbol,
      tick,
      stableRangeDetected,
      watchTicks: this.watchTicks,
    });
    this.active = created;
    events.push({
      type: "created",
      candidate: created,
      message:
        `[borderline] ${created.id} created (${created.movePercent.toFixed(4)}%, ` +
        `${created.thresholdRatio.toFixed(2)}x, dir ${created.moveDirection ?? "—"})`,
    });
    return events;
  }

  promoteActive(now: number, reason: string): BorderlineCandidate | null {
    if (this.active?.status !== "watching") return null;
    const promoted = promoteBorderlineCandidate(this.active, reason, now);
    this.finalize(promoted);
    return promoted;
  }

  cancelActive(now: number, reason: string): BorderlineCandidate | null {
    if (this.active?.status !== "watching") return null;
    const cancelled = cancelBorderlineCandidate(this.active, reason, now);
    this.finalize(cancelled);
    return cancelled;
  }

  applyDecision(
    now: number,
    decision: BorderlineWatchDecision
  ): BorderlineLifecycleEvent | null {
    if (this.active?.status !== "watching") return null;
    if (decision.action === "watch") {
      return {
        type: "decision",
        candidate: this.active,
        message: `[borderline] ${this.active.id} watch: ${decision.reason}`,
      };
    }
    if (decision.action === "promote") {
      const promoted = promoteBorderlineCandidate(this.active, decision.reason, now);
      this.finalize(promoted);
      return {
        type: "promoted",
        candidate: promoted,
        message:
          `[borderline] ${promoted.id} promoted -> ${decision.direction} (${decision.reason})`,
      };
    }
    if (decision.action === "cancel") {
      const cancelled = cancelBorderlineCandidate(this.active, decision.reason, now);
      this.finalize(cancelled);
      return {
        type: "cancelled",
        candidate: cancelled,
        message: `[borderline] ${cancelled.id} cancelled: ${decision.reason}`,
      };
    }
    const expired = expireBorderlineCandidate(this.active, decision.reason, now);
    this.finalize(expired);
    return {
      type: "expired",
      candidate: expired,
      message: `[borderline] ${expired.id} expired: ${decision.reason}`,
    };
  }

  private finalize(candidate: BorderlineCandidate): void {
    this.history.push(candidate);
    this.active = null;
  }
}

export function evaluateBorderlineWatchDecision(
  input: EvaluateBorderlineWatchInput
): BorderlineWatchDecision {
  const { candidate, tick, config, cooldownBlocked } = input;
  const continuationThreshold = Number.isFinite(
    config.borderlineContinuationThreshold
  )
    ? Math.max(0, config.borderlineContinuationThreshold)
    : 0.25;
  const reversionThreshold = Number.isFinite(config.borderlineReversionThreshold)
    ? Math.max(0, config.borderlineReversionThreshold)
    : 0.2;
  const pauseBandPercent = Number.isFinite(config.borderlinePauseBandPercent)
    ? Math.max(0, config.borderlinePauseBandPercent)
    : 0.00015;
  const ws = tick.entry.windowSpike;
  if (!ws) {
    return { action: "cancel", reason: "missing_window_spike_payload" };
  }
  const bookGate = evaluateSpotBookPipeline(
    tick.sides,
    config.maxEntrySpreadBps
  );
  if (bookGate === "invalid_book") {
    return { action: "cancel", reason: "invalid_market_prices" };
  }
  if (bookGate === "spread_too_wide") {
    return { action: "cancel", reason: "spread_too_wide" };
  }

  if (
    candidate.moveDirection !== null &&
    ws.strongestMoveDirection === candidate.moveDirection &&
    ws.classification === "strong_spike"
  ) {
    return { action: "cancel", reason: "strong_spike_same_direction" };
  }

  const movement = analyzePostBorderlineMovement(candidate, candidate.watchedPrices, {
    continuationThreshold,
    reversionThreshold,
    pauseBandPercent,
  });

  if (
    config.borderlineRequireNoContinuation &&
    movement.postMoveClassification === "continuation"
  ) {
    return { action: "cancel", reason: "continuation_same_direction" };
  }

  if (candidate.suggestedContrarianDirection === null) {
    return { action: "expire", reason: "no_contrarian_direction" };
  }

  if (cooldownBlocked) {
    return { action: "cancel", reason: "cooldown_blocked" };
  }

  const rangeNow = assessStableRangeQuality({
    prices: tick.prices,
    rangeThreshold: config.rangeThreshold,
    stableRangeSoftToleranceRatio: Number.isFinite(
      config.stableRangeSoftToleranceRatio
    )
      ? config.stableRangeSoftToleranceRatio
      : 1.5,
  });
  const pausedOrReverting =
    movement.postMoveClassification === "pause" ||
    movement.postMoveClassification === "reversion";

  if (config.borderlineRequirePause && !pausedOrReverting) {
    if (candidate.watchTicksRemaining <= 0) {
      return { action: "expire", reason: "no_pause_or_reversion" };
    }
    return { action: "watch", reason: "waiting_for_pause_or_reversion" };
  }

  if (rangeNow.stableRangeQuality === "poor" && ws.classification !== "no_signal") {
    if (candidate.watchTicksRemaining <= 0) {
      return { action: "expire", reason: "range_too_noisy_for_entry" };
    }
    return { action: "watch", reason: "waiting_for_range_to_exit_poor_quality" };
  }

  // In acceptable (non-good) range, require stronger confirmation: explicit reversion.
  if (
    rangeNow.stableRangeQuality === "acceptable" &&
    movement.postMoveClassification !== "reversion"
  ) {
    if (candidate.watchTicksRemaining <= 0) {
      return { action: "expire", reason: "acceptable_range_needs_reversion_confirmation" };
    }
    return { action: "watch", reason: "waiting_for_reversion_in_acceptable_range" };
  }

  return {
    action: "promote",
    reason:
      `${movement.postMoveClassification}: ` +
      (pausedOrReverting
        ? "paused_or_reverting_with_affordable_opposite_side"
        : "acceptable_post_spike_stabilization"),
    direction: candidate.suggestedContrarianDirection,
  };
}

export function buildPromotedEntryEvaluation(
  candidate: BorderlineCandidate,
  baseEntry: EntryEvaluation
): EntryEvaluation {
  return {
    shouldEnter: true,
    direction: candidate.suggestedContrarianDirection,
    reasons: [],
    stableRangeDetected: baseEntry.stableRangeDetected,
    priorRangeFraction: baseEntry.priorRangeFraction,
    stableRangeQuality: baseEntry.stableRangeQuality,
    rangeDecisionNote: baseEntry.rangeDecisionNote,
    movementClassification: baseEntry.movementClassification,
    spikeDetected: baseEntry.spikeDetected,
    movement: baseEntry.movement,
    windowSpike: baseEntry.windowSpike,
  };
}

export function analyzePostBorderlineMovement(
  candidate: BorderlineCandidate,
  watchedTickPrices: readonly number[],
  thresholds: {
    continuationThreshold: number;
    reversionThreshold: number;
    pauseBandPercent: number;
  }
): PostBorderlineMovementAnalysis {
  return analyzePostSpikeConfirmation({
    originalDirection: candidate.moveDirection,
    detectionPrice: candidate.btcPriceAtDetection,
    originalAbsMove: candidate.moveAbsolute,
    watchedTickPrices,
    continuationThreshold: thresholds.continuationThreshold,
    reversionThreshold: thresholds.reversionThreshold,
    pauseBandPercent: thresholds.pauseBandPercent,
  });
}

