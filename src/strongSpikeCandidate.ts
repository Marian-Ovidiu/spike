import type { AppConfig } from "./config.js";
import type { StrategyTickResult } from "./botLoop.js";
import type { EntryDirection, EntryEvaluation } from "./entryConditions.js";
import {
  analyzePostSpikeConfirmation,
  type PostSpikeMoveClassification,
} from "./postSpikeConfirmationEngine.js";
import { evaluateSpotBookPipeline } from "./spotSpreadFilter.js";
export type StrongSpikePostMoveClassification = PostSpikeMoveClassification;

export type StrongSpikeCandidateStatus = "watching" | "promoted" | "cancelled" | "expired";

export type StrongSpikeCandidate = {
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
  watchedPrices: number[];
  status: StrongSpikeCandidateStatus;
  cancellationReason?: string;
  promotionReason?: string;
  updatedAt: number;
};

export type StrongSpikeLifecycleEventType =
  | "created"
  | "tick"
  | "promoted"
  | "cancelled"
  | "expired"
  | "decision";

export type StrongSpikeLifecycleEvent = {
  type: StrongSpikeLifecycleEventType;
  candidate: StrongSpikeCandidate;
  message: string;
};

export type StrongSpikeWatchDecision =
  | { action: "promote"; reason: string; direction: EntryDirection }
  | { action: "cancel"; reason: string }
  | { action: "expire"; reason: string }
  | { action: "watch"; reason: string };

function suggestedContrarianDirection(
  moveDirection: StrongSpikeCandidate["moveDirection"]
): EntryDirection | null {
  if (moveDirection === "UP") return "DOWN";
  if (moveDirection === "DOWN") return "UP";
  return null;
}

let candidateSeq = 0;
function nextCandidateId(now: number): string {
  candidateSeq += 1;
  return `ss-${now}-${candidateSeq}`;
}

type ManagerOptions = {
  symbol: string;
  watchTicks: number;
};

export class StrongSpikeCandidateManager {
  private readonly symbol: string;
  private readonly watchTicks: number;
  private tickNumber = 0;
  private active: StrongSpikeCandidate | null = null;
  private readonly history: StrongSpikeCandidate[] = [];

  constructor(options: ManagerOptions) {
    this.symbol = options.symbol;
    this.watchTicks = Math.max(0, Math.trunc(options.watchTicks));
  }

  getTickNumber(): number {
    return this.tickNumber;
  }

  getActive(): StrongSpikeCandidate | null {
    return this.active;
  }

  onTick(now: number, tick: StrategyTickResult): StrongSpikeLifecycleEvent[] {
    this.tickNumber += 1;
    const events: StrongSpikeLifecycleEvent[] = [];
    if (this.active?.status !== "watching") return events;
    const watchedPrice = tick.kind === "ready" ? tick.btc : undefined;
    this.active = {
      ...this.active,
      watchTicksRemaining: Math.max(0, this.active.watchTicksRemaining - 1),
      watchedPrices:
        watchedPrice !== undefined && Number.isFinite(watchedPrice)
          ? [...this.active.watchedPrices, watchedPrice]
          : this.active.watchedPrices,
      updatedAt: now,
    };
    events.push({
      type: "tick",
      candidate: this.active,
      message: `[strong-confirm] ${this.active.id} waiting confirmation tick (${this.active.watchTicksRemaining} left)`,
    });
    return events;
  }

  createFromTick(
    now: number,
    tick: Extract<StrategyTickResult, { kind: "ready" }>
  ): StrongSpikeLifecycleEvent[] {
    const ws = tick.entry.windowSpike;
    if (!ws || ws.classification !== "strong_spike") return [];
    const events: StrongSpikeLifecycleEvent[] = [];
    if (this.active?.status === "watching") {
      const cancelled = this.cancelActive(now, "replaced_by_new_strong_spike");
      if (cancelled !== null) events.push(cancelled);
    }
    const created: StrongSpikeCandidate = {
      id: nextCandidateId(now),
      createdAt: now,
      startTickNumber: this.tickNumber,
      symbol: this.symbol,
      btcPriceAtDetection: tick.btc,
      moveDirection: ws.strongestMoveDirection,
      movePercent: ws.strongestMovePercent * 100,
      moveAbsolute: ws.strongestMoveAbsolute,
      thresholdPercent: ws.thresholdPercent * 100,
      thresholdRatio: ws.thresholdRatio,
      sourceWindowLabel: ws.sourceWindowLabel,
      suggestedContrarianDirection: suggestedContrarianDirection(ws.strongestMoveDirection),
      watchTicksConfigured: this.watchTicks,
      watchTicksRemaining: this.watchTicks,
      watchedPrices: [],
      status: "watching",
      updatedAt: now,
    };
    this.active = created;
    events.push({
      type: "created",
      candidate: created,
      message:
        `[strong-confirm] ${created.id} detected (${created.movePercent.toFixed(4)}%, ` +
        `${created.thresholdRatio.toFixed(2)}x, dir ${created.moveDirection ?? "—"}) — ` +
        `waiting ${created.watchTicksConfigured} confirmation tick(s)`,
    });
    return events;
  }

  cancelActive(now: number, reason: string): StrongSpikeLifecycleEvent | null {
    if (this.active?.status !== "watching") return null;
    const cancelled: StrongSpikeCandidate = {
      ...this.active,
      status: "cancelled",
      cancellationReason: reason,
      updatedAt: now,
    };
    this.finalize(cancelled);
    return {
      type: "cancelled",
      candidate: cancelled,
      message: `[strong-confirm] ${cancelled.id} cancelled: ${reason}`,
    };
  }

  applyDecision(now: number, decision: StrongSpikeWatchDecision): StrongSpikeLifecycleEvent | null {
    if (this.active?.status !== "watching") return null;
    if (decision.action === "watch") {
      return {
        type: "decision",
        candidate: this.active,
        message: `[strong-confirm] ${this.active.id} watch: ${decision.reason}`,
      };
    }
    if (decision.action === "promote") {
      const promoted: StrongSpikeCandidate = {
        ...this.active,
        status: "promoted",
        promotionReason: decision.reason,
        updatedAt: now,
      };
      this.finalize(promoted);
      return {
        type: "promoted",
        candidate: promoted,
        message: `[strong-confirm] ${promoted.id} promoted -> ${decision.direction} (${decision.reason})`,
      };
    }
    if (decision.action === "cancel") {
      return this.cancelActive(now, decision.reason);
    }
    const expired: StrongSpikeCandidate = {
      ...this.active,
      status: "expired",
      cancellationReason: decision.reason,
      updatedAt: now,
    };
    this.finalize(expired);
    return {
      type: "expired",
      candidate: expired,
      message: `[strong-confirm] ${expired.id} expired: ${decision.reason}`,
    };
  }

  private finalize(candidate: StrongSpikeCandidate): void {
    this.history.push(candidate);
    this.active = null;
  }
}

export function evaluateStrongSpikeWatchDecision(input: {
  candidate: StrongSpikeCandidate;
  tick: Extract<StrategyTickResult, { kind: "ready" }>;
  config: Pick<
    AppConfig,
    | "maxEntrySpreadBps"
    | "borderlineContinuationThreshold"
    | "borderlineReversionThreshold"
    | "borderlinePauseBandPercent"
  >;
  cooldownBlocked: boolean;
}):
  | { decision: StrongSpikeWatchDecision; postMoveClassification: StrongSpikePostMoveClassification } {
  const continuationThreshold = Number.isFinite(input.config.borderlineContinuationThreshold)
    ? Math.max(0, input.config.borderlineContinuationThreshold)
    : 0.25;
  const reversionThreshold = Number.isFinite(input.config.borderlineReversionThreshold)
    ? Math.max(0, input.config.borderlineReversionThreshold)
    : 0.2;
  const pauseBandPercent = Number.isFinite(input.config.borderlinePauseBandPercent)
    ? Math.max(0, input.config.borderlinePauseBandPercent)
    : 0.00015;
  const bookGate = evaluateSpotBookPipeline(
    input.tick.sides,
    input.config.maxEntrySpreadBps
  );
  if (bookGate === "invalid_book") {
    return {
      decision: { action: "cancel", reason: "invalid_market_prices" },
      postMoveClassification: "noisy_unclear",
    };
  }
  if (bookGate === "spread_too_wide") {
    return {
      decision: { action: "cancel", reason: "spread_too_wide" },
      postMoveClassification: "noisy_unclear",
    };
  }
  if (input.candidate.suggestedContrarianDirection === null) {
    return {
      decision: { action: "cancel", reason: "no_contrarian_direction" },
      postMoveClassification: "noisy_unclear",
    };
  }
  const analysis = analyzePostSpikeConfirmation({
    originalDirection: input.candidate.moveDirection,
    detectionPrice: input.candidate.btcPriceAtDetection,
    originalAbsMove: input.candidate.moveAbsolute,
    watchedTickPrices: [input.tick.btc],
    continuationThreshold,
    reversionThreshold,
    pauseBandPercent,
  });
  const postMoveClassification = analysis.postMoveClassification;
  if (postMoveClassification === "continuation") {
    return {
      decision: { action: "cancel", reason: "strong_spike_confirmation_continuation" },
      postMoveClassification,
    };
  }
  if (postMoveClassification === "noisy_unclear") {
    return {
      decision: { action: "cancel", reason: "strong_spike_confirmation_noisy_unclear" },
      postMoveClassification,
    };
  }
  if (input.cooldownBlocked) {
    return {
      decision: { action: "cancel", reason: "cooldown_blocked" },
      postMoveClassification,
    };
  }
  return {
    decision: {
      action: "promote",
      reason: `strong_spike_confirmed_${postMoveClassification}`,
      direction: input.candidate.suggestedContrarianDirection,
    },
    postMoveClassification,
  };
}

export function buildPromotedStrongSpikeEntryEvaluation(
  candidate: StrongSpikeCandidate,
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
    movementClassification: "strong_spike",
    spikeDetected: baseEntry.spikeDetected,
    movement: baseEntry.movement,
    windowSpike: baseEntry.windowSpike,
  };
}

