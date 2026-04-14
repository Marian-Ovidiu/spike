import type { StrategyTickResult } from "./botLoop.js";
import type { AppConfig } from "./config.js";
import type { EntryEvaluation } from "./entryConditions.js";
import type { StableRangeQuality } from "./stableRangeQuality.js";
import type {
  BorderlineLifecycleEvent,
  PostMoveClassification,
} from "./borderlineCandidate.js";
import type { BorderlineCandidateStore } from "./borderlineCandidateStore.js";
import { analyzeBorderlinePostMove } from "./postMoveAnalyzer.js";
import {
  buildBorderlinePromotedEntry,
  decideBorderlineWatch,
} from "./borderlineWatcher.js";
import { StrongSpikeCandidateStore } from "./strongSpikeCandidateStore.js";
import {
  buildStrongSpikePromotedEntry,
  decideStrongSpikeWatch,
} from "./strongSpikeWatcher.js";
import type { SimulationEngine } from "./simulationEngine.js";
import {
  normalizeDecisionRejectionReasons,
  type NormalizedRejectionReason,
} from "./decisionReasonBuilder.js";
import {
  DEFAULT_MAX_PRIOR_RANGE_FOR_NORMAL_ENTRY,
  DEFAULT_TRADABLE_SPIKE_MIN_PERCENT,
  type QualityProfile,
} from "./preEntryQualityGate.js";
import { classifySpikeQuality } from "./spikeQualityClassifier.js";
import { evaluateHardRejectContext } from "./hardRejectEngine.js";
import {
  shouldOverrideCooldownForExceptional,
  shouldOverrideCooldownForExceptionalCandidate,
} from "./overridePolicyEngine.js";
import { evaluateQuoteQuality } from "./quoteQualityFilter.js";

export type StrategyAction =
  | "none"
  | "enter_immediate"
  | "create_borderline_candidate"
  | "promote_borderline_candidate"
  | "cancel_borderline_candidate"
  | "expire_borderline_candidate";

export type StrategyDecision = {
  action: StrategyAction;
  direction: "UP" | "DOWN" | null;
  stableRangeQuality: StableRangeQuality;
  movementClassification: "no_signal" | "borderline" | "strong_spike";
  qualityGatePassed?: boolean;
  qualityGateReasons?: string[];
  qualityProfile?: QualityProfile;
  hardRejectApplied?: boolean;
  hardRejectReason?: string | null;
  cooldownOverridden?: boolean;
  overrideReason?: string | null;
  spikeDetected: boolean;
  fastPathUsed: boolean;
  criticalBlockerUsed?: string | null;
  reason: string;
  reasons?: NormalizedRejectionReason[];
  borderlineCandidateId?: string;
};

export type StrategyDecisionPipelineResult = {
  decision: StrategyDecision;
  entryForSimulation?: EntryEvaluation;
  borderlineLifecycleEvents: BorderlineLifecycleRenderEvent[];
  strongSpikeLifecycleMessages?: string[];
};

function withNormalizedReasons(input: {
  decision: StrategyDecision;
  tick: StrategyTickResult;
  simulation: SimulationEngine;
  tradableSpikeMinPercent?: number;
}): StrategyDecision {
  const tradableSpikeMinPercent = Number.isFinite(input.tradableSpikeMinPercent)
    ? Math.max(
        0,
        input.tradableSpikeMinPercent ?? DEFAULT_TRADABLE_SPIKE_MIN_PERCENT
      )
    : DEFAULT_TRADABLE_SPIKE_MIN_PERCENT;
  const qualityGate =
    input.tick.kind === "ready"
      ? classifySpikeQuality(input.tick.entry, {
          tradableSpikeMinPercent,
          maxPriorRangeForNormalEntry: DEFAULT_MAX_PRIOR_RANGE_FOR_NORMAL_ENTRY,
        })
      : {
          qualityGatePassed: false,
          qualityGateReasons: ["missing_ready_tick_data"],
          qualityProfile: "weak" as const,
        };
  if (input.tick.kind !== "ready") {
    return {
      ...input.decision,
      qualityGatePassed:
        input.decision.qualityGatePassed ?? qualityGate.qualityGatePassed,
      qualityGateReasons:
        input.decision.qualityGateReasons ?? qualityGate.qualityGateReasons,
      qualityProfile: input.decision.qualityProfile ?? qualityGate.qualityProfile,
      hardRejectApplied: input.decision.hardRejectApplied ?? false,
      hardRejectReason: input.decision.hardRejectReason ?? null,
      cooldownOverridden: input.decision.cooldownOverridden ?? false,
      overrideReason: input.decision.overrideReason ?? null,
      reasons: normalizeDecisionRejectionReasons({
        decision: input.decision,
      }),
    };
  }
  return {
    ...input.decision,
    qualityGatePassed:
      input.decision.qualityGatePassed ?? qualityGate.qualityGatePassed,
    qualityGateReasons:
      input.decision.qualityGateReasons ?? qualityGate.qualityGateReasons,
    qualityProfile: input.decision.qualityProfile ?? qualityGate.qualityProfile,
    hardRejectApplied: input.decision.hardRejectApplied ?? false,
    hardRejectReason: input.decision.hardRejectReason ?? null,
    cooldownOverridden: input.decision.cooldownOverridden ?? false,
    overrideReason: input.decision.overrideReason ?? null,
    reasons: normalizeDecisionRejectionReasons({
      decision: input.decision,
      entry: {
        movementClassification: input.tick.entry.movementClassification,
        reasons: input.tick.entry.reasons,
      },
      hasOpenPosition: input.simulation.getOpenPosition() !== null,
    }),
  };
}

export type BorderlineLifecycleRenderEvent = {
  type: "created" | "watch" | "promoted" | "cancelled" | "expired";
  candidateId: string;
  detectionTick: number;
  moveDirection: "UP" | "DOWN" | null;
  movePercent: number;
  thresholdPercent: number;
  thresholdRatio: number;
  sourceWindowLabel: string | null;
  suggestedContrarianDirection: "UP" | "DOWN" | null;
  watchTicksConfigured: number;
  watchTicksObserved: number;
  watchTicksRemaining: number;
  currentBtcPrice: number | null;
  yesPrice: number | null;
  noPrice: number | null;
  postMoveClassification: PostMoveClassification | null;
  reason: string;
};

type PipelineInput = {
  now: number;
  tick: StrategyTickResult;
  manager: BorderlineCandidateStore;
  strongSpikeManager?: StrongSpikeCandidateStore;
  simulation: SimulationEngine;
  config: Pick<
    AppConfig,
    | "rangeThreshold"
    | "stableRangeSoftToleranceRatio"
    | "spikeThreshold"
    | "tradableSpikeMinPercent"
    | "maxPriorRangeForNormalEntry"
    | "hardRejectPriorRangePercent"
    | "strongSpikeConfirmationTicks"
    | "exceptionalSpikePercent"
    | "exceptionalSpikeOverridesCooldown"
    | "entryPrice"
    | "maxOppositeSideEntryPrice"
    | "neutralQuoteBandMin"
    | "neutralQuoteBandMax"
    | "entryCooldownMs"
    | "borderlineRequirePause"
    | "borderlineRequireNoContinuation"
    | "borderlineContinuationThreshold"
    | "borderlineReversionThreshold"
    | "borderlinePauseBandPercent"
    | "strongSpikeHardRejectPoorRange"
  >;
};


function lifecycleToDecision(
  event: BorderlineLifecycleEvent
): StrategyDecision | null {
  const candidateQuality: StableRangeQuality = event.candidate.stableRangeDetected
    ? "good"
    : "acceptable";
  if (event.type === "created") {
    return {
      action: "create_borderline_candidate",
      direction: event.candidate.suggestedContrarianDirection,
      stableRangeQuality: candidateQuality,
      movementClassification: "borderline",
      spikeDetected: false,
      fastPathUsed: false,
      criticalBlockerUsed: null,
      reason: event.message,
      borderlineCandidateId: event.candidate.id,
    };
  }
  if (event.type === "cancelled") {
    return {
      action: "cancel_borderline_candidate",
      direction: null,
      stableRangeQuality: candidateQuality,
      movementClassification: "borderline",
      spikeDetected: false,
      fastPathUsed: false,
      criticalBlockerUsed: null,
      reason: event.candidate.cancellationReason ?? event.message,
      borderlineCandidateId: event.candidate.id,
    };
  }
  if (event.type === "expired") {
    return {
      action: "expire_borderline_candidate",
      direction: null,
      stableRangeQuality: candidateQuality,
      movementClassification: "borderline",
      spikeDetected: false,
      fastPathUsed: false,
      criticalBlockerUsed: null,
      reason: event.candidate.cancellationReason ?? event.message,
      borderlineCandidateId: event.candidate.id,
    };
  }
  if (event.type === "promoted") {
    return {
      action: "promote_borderline_candidate",
      direction: event.candidate.suggestedContrarianDirection,
      stableRangeQuality: candidateQuality,
      movementClassification: "borderline",
      spikeDetected: false,
      fastPathUsed: false,
      criticalBlockerUsed: null,
      reason: event.candidate.promotionReason ?? event.message,
      borderlineCandidateId: event.candidate.id,
    };
  }
  return null;
}

function toRenderEvent(
  event: BorderlineLifecycleEvent,
  tick: StrategyTickResult
): BorderlineLifecycleRenderEvent | null {
  const c = event.candidate;
  const currentBtcPrice = tick.kind === "ready" ? tick.btc : null;
  const yesPrice = tick.kind === "ready" ? tick.sides.upSidePrice : null;
  const noPrice = tick.kind === "ready" ? tick.sides.downSidePrice : null;

  if (event.type === "created") {
    return {
      type: "created",
      candidateId: c.id,
      detectionTick: c.startTickNumber,
      moveDirection: c.moveDirection,
      movePercent: c.movePercent,
      thresholdPercent: c.thresholdPercent,
      thresholdRatio: c.thresholdRatio,
      sourceWindowLabel: c.sourceWindowLabel,
      suggestedContrarianDirection: c.suggestedContrarianDirection,
      watchTicksConfigured: c.watchTicksConfigured,
      watchTicksObserved: Math.max(
        0,
        c.watchTicksConfigured - c.watchTicksRemaining
      ),
      watchTicksRemaining: c.watchTicksRemaining,
      currentBtcPrice,
      yesPrice,
      noPrice,
      postMoveClassification: null,
      reason: "borderline_detected_enter_watch_mode",
    };
  }
  if (event.type === "tick" || event.type === "decision") {
    return {
      type: "watch",
      candidateId: c.id,
      detectionTick: c.startTickNumber,
      moveDirection: c.moveDirection,
      movePercent: c.movePercent,
      thresholdPercent: c.thresholdPercent,
      thresholdRatio: c.thresholdRatio,
      sourceWindowLabel: c.sourceWindowLabel,
      suggestedContrarianDirection: c.suggestedContrarianDirection,
      watchTicksConfigured: c.watchTicksConfigured,
      watchTicksObserved: Math.max(
        0,
        c.watchTicksConfigured - c.watchTicksRemaining
      ),
      watchTicksRemaining: c.watchTicksRemaining,
      currentBtcPrice,
      yesPrice,
      noPrice,
      postMoveClassification: null,
      reason: event.message,
    };
  }
  if (event.type === "promoted") {
    return {
      type: "promoted",
      candidateId: c.id,
      detectionTick: c.startTickNumber,
      moveDirection: c.moveDirection,
      movePercent: c.movePercent,
      thresholdPercent: c.thresholdPercent,
      thresholdRatio: c.thresholdRatio,
      sourceWindowLabel: c.sourceWindowLabel,
      suggestedContrarianDirection: c.suggestedContrarianDirection,
      watchTicksConfigured: c.watchTicksConfigured,
      watchTicksObserved: Math.max(
        0,
        c.watchTicksConfigured - c.watchTicksRemaining
      ),
      watchTicksRemaining: c.watchTicksRemaining,
      currentBtcPrice,
      yesPrice,
      noPrice,
      postMoveClassification: null,
      reason: c.promotionReason ?? event.message,
    };
  }
  if (event.type === "cancelled") {
    return {
      type: "cancelled",
      candidateId: c.id,
      detectionTick: c.startTickNumber,
      moveDirection: c.moveDirection,
      movePercent: c.movePercent,
      thresholdPercent: c.thresholdPercent,
      thresholdRatio: c.thresholdRatio,
      sourceWindowLabel: c.sourceWindowLabel,
      suggestedContrarianDirection: c.suggestedContrarianDirection,
      watchTicksConfigured: c.watchTicksConfigured,
      watchTicksObserved: Math.max(
        0,
        c.watchTicksConfigured - c.watchTicksRemaining
      ),
      watchTicksRemaining: c.watchTicksRemaining,
      currentBtcPrice,
      yesPrice,
      noPrice,
      postMoveClassification: null,
      reason: c.cancellationReason ?? event.message,
    };
  }
  if (event.type === "expired") {
    return {
      type: "expired",
      candidateId: c.id,
      detectionTick: c.startTickNumber,
      moveDirection: c.moveDirection,
      movePercent: c.movePercent,
      thresholdPercent: c.thresholdPercent,
      thresholdRatio: c.thresholdRatio,
      sourceWindowLabel: c.sourceWindowLabel,
      suggestedContrarianDirection: c.suggestedContrarianDirection,
      watchTicksConfigured: c.watchTicksConfigured,
      watchTicksObserved: Math.max(
        0,
        c.watchTicksConfigured - c.watchTicksRemaining
      ),
      watchTicksRemaining: c.watchTicksRemaining,
      currentBtcPrice,
      yesPrice,
      noPrice,
      postMoveClassification: null,
      reason: c.cancellationReason ?? event.message,
    };
  }
  return null;
}

function fromLastMeaningfulLifecycle(
  events: readonly BorderlineLifecycleEvent[]
): StrategyDecision | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const d = lifecycleToDecision(events[i]!);
    if (d !== null) return d;
  }
  return null;
}

export function runStrategyDecisionPipeline(
  input: PipelineInput
): StrategyDecisionPipelineResult {
  const { now, tick, manager, simulation, config } = input;
  const strongSpikeManager =
    input.strongSpikeManager ??
    new StrongSpikeCandidateStore({
      symbol: "BTCUSD",
      watchTicks: config.strongSpikeConfirmationTicks,
    });
  const renderEvents: BorderlineLifecycleRenderEvent[] = [];
  const strongSpikeLifecycleMessages: string[] = [];
  const stableRangeQuality: StableRangeQuality =
    tick.kind === "ready" ? (tick.entry.stableRangeQuality ?? "poor") : "poor";
  const movementClassification =
    tick.kind === "ready" ? tick.entry.movementClassification : "no_signal";
  const spikeDetected = tick.kind === "ready" ? tick.entry.spikeDetected : false;
  strongSpikeLifecycleMessages.push(
    ...strongSpikeManager.onTick(now, tick).map((ev) => ev.message)
  );

  if (tick.kind !== "ready") {
    const cancelled = manager.cancelActive(
      now,
      "data_fetch_or_quote_invalidated_watch"
    );
    if (cancelled !== null) {
      return {
        decision: withNormalizedReasons({
          tick,
          simulation,
          tradableSpikeMinPercent: config.tradableSpikeMinPercent,
          decision: {
          action: "cancel_borderline_candidate",
          direction: null,
          stableRangeQuality,
          movementClassification,
          spikeDetected,
          fastPathUsed: false,
          criticalBlockerUsed: "missing_quote_data",
          reason: cancelled.cancellationReason ?? "data fetch invalidated watch",
          borderlineCandidateId: cancelled.id,
          },
        }),
        borderlineLifecycleEvents: [
          {
            type: "cancelled",
            candidateId: cancelled.id,
            detectionTick: cancelled.startTickNumber,
            moveDirection: cancelled.moveDirection,
            movePercent: cancelled.movePercent,
            thresholdPercent: cancelled.thresholdPercent,
            thresholdRatio: cancelled.thresholdRatio,
            sourceWindowLabel: cancelled.sourceWindowLabel,
            suggestedContrarianDirection: cancelled.suggestedContrarianDirection,
            watchTicksConfigured: cancelled.watchTicksConfigured,
            watchTicksObserved: Math.max(
              0,
              cancelled.watchTicksConfigured - cancelled.watchTicksRemaining
            ),
            watchTicksRemaining: cancelled.watchTicksRemaining,
            currentBtcPrice: null,
            yesPrice: null,
            noPrice: null,
            postMoveClassification: null,
            reason: cancelled.cancellationReason ?? "data fetch invalidated watch",
          },
        ],
        strongSpikeLifecycleMessages,
      };
    }
    const activeStrong = strongSpikeManager.getActive();
    if (activeStrong?.watchTicksRemaining === 0) {
      const cancelledStrong = strongSpikeManager.applyDecision(now, {
        action: "cancel",
        reason: "invalid_market_data_during_confirmation",
      });
      if (cancelledStrong !== null) {
        strongSpikeLifecycleMessages.push(cancelledStrong.message);
      }
    }
    return {
      decision: withNormalizedReasons({
        tick,
        simulation,
        tradableSpikeMinPercent: config.tradableSpikeMinPercent,
        decision: {
        action: "none",
        direction: null,
        stableRangeQuality,
        movementClassification,
        spikeDetected,
        fastPathUsed: false,
        criticalBlockerUsed: "missing_quote_data",
        reason: tick.kind,
        },
      }),
      borderlineLifecycleEvents: [],
      strongSpikeLifecycleMessages,
    };
  }

  const lifecycleEvents = manager.onTick(now, tick);
  for (const e of lifecycleEvents) {
    const r = toRenderEvent(e, tick);
    if (r !== null) renderEvents.push(r);
  }
  const lifecycleDecision = fromLastMeaningfulLifecycle(lifecycleEvents);
  const qualityGate = classifySpikeQuality(tick.entry, {
    tradableSpikeMinPercent: config.tradableSpikeMinPercent,
    exceptionalSpikeMinPercent: config.exceptionalSpikePercent,
    maxPriorRangeForNormalEntry: config.maxPriorRangeForNormalEntry,
  });
  const hardReject = evaluateHardRejectContext({
    entry: tick.entry,
    hardRejectPriorRangePercent: config.hardRejectPriorRangePercent,
  });

  if (hardReject.hardRejectApplied) {
    return {
      decision: withNormalizedReasons({
        tick,
        simulation,
        tradableSpikeMinPercent: config.tradableSpikeMinPercent,
        decision: {
          action: "none",
          direction: null,
          stableRangeQuality,
          movementClassification: tick.entry.movementClassification,
          qualityGatePassed: false,
          qualityGateReasons: [
            ...new Set([
              ...qualityGate.qualityGateReasons,
              "hard_reject_unstable_pre_spike_context",
            ]),
          ],
          qualityProfile: "weak",
          hardRejectApplied: true,
          hardRejectReason: hardReject.hardRejectReason,
          cooldownOverridden: false,
          overrideReason: null,
          spikeDetected: tick.entry.spikeDetected,
          fastPathUsed: tick.entry.movementClassification === "strong_spike",
          criticalBlockerUsed: "quality_gate_rejected",
          reason: "hard_reject_unstable_pre_spike_context",
        },
      }),
      entryForSimulation: tick.entry,
      borderlineLifecycleEvents: renderEvents,
      strongSpikeLifecycleMessages,
    };
  }

  const activeStrong = strongSpikeManager.getActive();
  if (
    activeStrong !== null &&
    activeStrong.watchTicksRemaining === 0 &&
    activeStrong.startTickNumber < strongSpikeManager.getTickNumber()
  ) {
    const cooldownBlocked = !simulation.canOpenNewPosition(now, config.entryCooldownMs);
    const exceptionalOverride = shouldOverrideCooldownForExceptionalCandidate({
      candidateMovePercent: activeStrong.movePercent,
      exceptionalSpikePercent: config.exceptionalSpikePercent,
      exceptionalSpikeOverridesCooldown: config.exceptionalSpikeOverridesCooldown,
    });
    const { decision: strongDecision, postMoveClassification } = decideStrongSpikeWatch({
      candidate: activeStrong,
      tick,
      config: {
        entryPrice: config.entryPrice,
        maxOppositeSideEntryPrice: config.maxOppositeSideEntryPrice,
        neutralQuoteBandMin: config.neutralQuoteBandMin,
        neutralQuoteBandMax: config.neutralQuoteBandMax,
        borderlineContinuationThreshold: config.borderlineContinuationThreshold,
        borderlineReversionThreshold: config.borderlineReversionThreshold,
        borderlinePauseBandPercent: config.borderlinePauseBandPercent,
      },
      cooldownBlocked: cooldownBlocked && !exceptionalOverride,
    });
    const applied = strongSpikeManager.applyDecision(now, strongDecision);
    if (applied !== null) strongSpikeLifecycleMessages.push(applied.message);
    if (cooldownBlocked && exceptionalOverride) {
      strongSpikeLifecycleMessages.push(
        `[strong-confirm] exceptional spike override activated | move=${(
          tick.entry.movement.strongestMovePercent * 100
        ).toFixed(4)}% | originalCooldownBlocked=true`
      );
    }
    strongSpikeLifecycleMessages.push(
      `[strong-confirm] classification=${postMoveClassification}`
    );
    if (strongDecision.action === "promote") {
      return {
        decision: withNormalizedReasons({
          tick,
          simulation,
          tradableSpikeMinPercent: config.tradableSpikeMinPercent,
          decision: {
            action: "enter_immediate",
            direction: strongDecision.direction,
            stableRangeQuality,
            movementClassification: "strong_spike",
            qualityGatePassed: true,
            qualityGateReasons: [`confirmation_${postMoveClassification}`],
            qualityProfile: "strong",
            hardRejectApplied: false,
            hardRejectReason: null,
            cooldownOverridden: cooldownBlocked && exceptionalOverride,
            overrideReason:
              cooldownBlocked && exceptionalOverride
                ? "exceptional_spike_cooldown_override"
                : null,
            spikeDetected: tick.entry.spikeDetected,
            fastPathUsed: true,
            criticalBlockerUsed: null,
            reason: strongDecision.reason,
          },
        }),
        entryForSimulation: buildStrongSpikePromotedEntry(activeStrong, tick.entry),
        borderlineLifecycleEvents: renderEvents,
        strongSpikeLifecycleMessages,
      };
    }
    return {
      decision: withNormalizedReasons({
        tick,
        simulation,
        tradableSpikeMinPercent: config.tradableSpikeMinPercent,
        decision: {
          action: "none",
          direction: null,
          stableRangeQuality,
          movementClassification: "strong_spike",
          qualityGatePassed: false,
          qualityGateReasons: [`confirmation_${postMoveClassification}`],
          qualityProfile: "weak",
          hardRejectApplied: false,
          hardRejectReason: null,
          cooldownOverridden: false,
          overrideReason: null,
          spikeDetected: tick.entry.spikeDetected,
          fastPathUsed: true,
          criticalBlockerUsed:
            strongDecision.reason === "invalid_market_prices"
              ? "invalid_market_prices"
              : strongDecision.reason === "cooldown_blocked"
              ? "active_position_or_cooldown"
              : "quality_gate_rejected",
          reason: strongDecision.reason,
        },
      }),
      entryForSimulation: tick.entry,
      borderlineLifecycleEvents: renderEvents,
      strongSpikeLifecycleMessages,
    };
  }

  // Priority: strong spike fast path before secondary watch/borderline logic.
  if (tick.entry.movementClassification === "strong_spike") {
    if (!tick.entry.spikeDetected) {
      throw new Error("Invariant: strong_spike must have spikeDetected=true");
    }
    if (!qualityGate.qualityGatePassed) {
      return {
        decision: withNormalizedReasons({
          tick,
          simulation,
          tradableSpikeMinPercent: config.tradableSpikeMinPercent,
          decision: {
            action: "none",
            direction: null,
            stableRangeQuality,
            movementClassification: tick.entry.movementClassification,
            qualityGatePassed: qualityGate.qualityGatePassed,
            qualityGateReasons: qualityGate.qualityGateReasons,
            qualityProfile: qualityGate.qualityProfile,
            hardRejectApplied: false,
            hardRejectReason: null,
            cooldownOverridden: false,
            overrideReason: null,
            spikeDetected: tick.entry.spikeDetected,
            fastPathUsed: true,
            criticalBlockerUsed: "quality_gate_rejected",
            reason:
              qualityGate.qualityGateReasons.includes(
                "prior_range_too_wide_for_mean_reversion"
              )
                ? "prior_range_too_wide_for_mean_reversion"
                : qualityGate.qualityProfile === "acceptable"
                ? "quality_gate_requires_delayed_confirmation"
                : "quality_gate_rejected",
          },
        }),
        entryForSimulation: tick.entry,
        borderlineLifecycleEvents: renderEvents,
        strongSpikeLifecycleMessages,
      };
    }
    const isExceptionalStrongSpike = qualityGate.qualityProfile === "exceptional";
    if (!isExceptionalStrongSpike) {
      strongSpikeLifecycleMessages.push(
        ...strongSpikeManager.createFromTick(now, tick).map((ev) => ev.message)
      );
      return {
        decision: withNormalizedReasons({
          tick,
          simulation,
          tradableSpikeMinPercent: config.tradableSpikeMinPercent,
          decision: {
            action: "none",
            direction: null,
            stableRangeQuality,
            movementClassification: "strong_spike",
            qualityGatePassed: false,
            qualityGateReasons: ["strong_spike_waiting_confirmation_tick"],
            qualityProfile: qualityGate.qualityProfile,
            hardRejectApplied: false,
            hardRejectReason: null,
            spikeDetected: tick.entry.spikeDetected,
            fastPathUsed: true,
            criticalBlockerUsed: "quality_gate_rejected",
            reason: "strong_spike_waiting_confirmation_tick",
          },
        }),
        entryForSimulation: tick.entry,
        borderlineLifecycleEvents: renderEvents,
        strongSpikeLifecycleMessages,
      };
    }
    if (!Number.isFinite(tick.sides.upSidePrice) || !Number.isFinite(tick.sides.downSidePrice)) {
      return {
        decision: withNormalizedReasons({
          tick,
          simulation,
          tradableSpikeMinPercent: config.tradableSpikeMinPercent,
          decision: {
          action: "none",
          direction: null,
          stableRangeQuality,
          movementClassification: tick.entry.movementClassification,
            qualityGatePassed: qualityGate.qualityGatePassed,
            qualityGateReasons: qualityGate.qualityGateReasons,
            qualityProfile: qualityGate.qualityProfile,
            hardRejectApplied: false,
            hardRejectReason: null,
            cooldownOverridden: false,
            overrideReason: null,
          spikeDetected: tick.entry.spikeDetected,
          fastPathUsed: true,
          criticalBlockerUsed: "invalid_market_prices",
          reason: "strong spike detected but blocked by invalid quote data",
          },
        }),
        entryForSimulation: tick.entry,
        borderlineLifecycleEvents: renderEvents,
        strongSpikeLifecycleMessages,
      };
    }
    const pricingBlocker = evaluateQuoteQuality({
      upSidePrice: tick.sides.upSidePrice,
      downSidePrice: tick.sides.downSidePrice,
      direction: tick.entry.direction,
      entryPrice: config.entryPrice,
      maxOppositeSideEntryPrice: config.maxOppositeSideEntryPrice,
      neutralQuoteBandMin: config.neutralQuoteBandMin,
      neutralQuoteBandMax: config.neutralQuoteBandMax,
    });
    if (pricingBlocker !== null) {
      strongSpikeLifecycleMessages.push(
        `[strategy] quote pricing blocker=${pricingBlocker} | opposite=${(
          tick.entry.direction === "UP" ? tick.sides.upSidePrice : tick.sides.downSidePrice
        ).toFixed(4)} | maxOpp=${Math.min(
          config.entryPrice,
          config.maxOppositeSideEntryPrice
        ).toFixed(4)} | neutralBand=[${Math.min(
          config.neutralQuoteBandMin,
          config.neutralQuoteBandMax
        ).toFixed(4)}, ${Math.max(config.neutralQuoteBandMin, config.neutralQuoteBandMax).toFixed(
          4
        )}]`
      );
      return {
        decision: withNormalizedReasons({
          tick,
          simulation,
          tradableSpikeMinPercent: config.tradableSpikeMinPercent,
          decision: {
            action: "none",
            direction: null,
            stableRangeQuality,
            movementClassification: tick.entry.movementClassification,
            qualityGatePassed: qualityGate.qualityGatePassed,
            qualityGateReasons: qualityGate.qualityGateReasons,
            qualityProfile: qualityGate.qualityProfile,
            hardRejectApplied: false,
            hardRejectReason: null,
            cooldownOverridden: false,
            overrideReason: null,
            spikeDetected: tick.entry.spikeDetected,
            fastPathUsed: true,
            criticalBlockerUsed: "quality_gate_rejected",
            reason: pricingBlocker,
          },
        }),
        entryForSimulation: tick.entry,
        borderlineLifecycleEvents: renderEvents,
        strongSpikeLifecycleMessages,
      };
    }
    const hasOpenPosition = simulation.getOpenPosition() !== null;
    const canOpenNewPosition = simulation.canOpenNewPosition(now, config.entryCooldownMs);
    const cooldownOnlyBlocked = !canOpenNewPosition && !hasOpenPosition;
    const exceptionalCooldownOverride =
      cooldownOnlyBlocked &&
      shouldOverrideCooldownForExceptional({
        entry: tick.entry,
        qualityProfile: qualityGate.qualityProfile,
        exceptionalSpikePercent: config.exceptionalSpikePercent,
        exceptionalSpikeOverridesCooldown: config.exceptionalSpikeOverridesCooldown,
      });
    if (!canOpenNewPosition && !exceptionalCooldownOverride) {
      return {
        decision: withNormalizedReasons({
          tick,
          simulation,
          tradableSpikeMinPercent: config.tradableSpikeMinPercent,
          decision: {
          action: "none",
          direction: null,
          stableRangeQuality,
          movementClassification: tick.entry.movementClassification,
            qualityGatePassed: qualityGate.qualityGatePassed,
            qualityGateReasons: qualityGate.qualityGateReasons,
            qualityProfile: qualityGate.qualityProfile,
            hardRejectApplied: false,
            hardRejectReason: null,
            cooldownOverridden: false,
            overrideReason: null,
          spikeDetected: tick.entry.spikeDetected,
          fastPathUsed: true,
          criticalBlockerUsed: "active_position_or_cooldown",
          reason: "strong spike detected but blocked by active position or cooldown",
          },
        }),
        entryForSimulation: tick.entry,
        borderlineLifecycleEvents: renderEvents,
        strongSpikeLifecycleMessages,
      };
    }
    if (exceptionalCooldownOverride) {
      strongSpikeLifecycleMessages.push(
        `[strategy] exceptional spike override activated | move=${(
          tick.entry.movement.strongestMovePercent * 100
        ).toFixed(4)}% | originalCooldownBlocked=true`
      );
    }
    if (
      config.strongSpikeHardRejectPoorRange &&
      tick.entry.stableRangeQuality === "poor" &&
      qualityGate.qualityProfile !== "exceptional"
    ) {
      return {
        decision: withNormalizedReasons({
          tick,
          simulation,
          tradableSpikeMinPercent: config.tradableSpikeMinPercent,
          decision: {
          action: "none",
          direction: null,
          stableRangeQuality,
          movementClassification: tick.entry.movementClassification,
            qualityGatePassed: qualityGate.qualityGatePassed,
            qualityGateReasons: qualityGate.qualityGateReasons,
            qualityProfile: qualityGate.qualityProfile,
            hardRejectApplied: false,
            hardRejectReason: null,
            cooldownOverridden: false,
            overrideReason: null,
          spikeDetected: tick.entry.spikeDetected,
          fastPathUsed: true,
          criticalBlockerUsed: "poor_range_hard_reject",
          reason: "strong spike detected but blocked by poor-range hard reject",
          },
        }),
        entryForSimulation: tick.entry,
        borderlineLifecycleEvents: renderEvents,
        strongSpikeLifecycleMessages,
      };
    }
    if (tick.entry.direction !== null && tick.entry.shouldEnter) {
      return {
        decision: withNormalizedReasons({
          tick,
          simulation,
          tradableSpikeMinPercent: config.tradableSpikeMinPercent,
          decision: {
          action: "enter_immediate",
          direction: tick.entry.direction,
          stableRangeQuality,
          movementClassification: tick.entry.movementClassification,
            qualityGatePassed: qualityGate.qualityGatePassed,
            qualityGateReasons: qualityGate.qualityGateReasons,
            qualityProfile: qualityGate.qualityProfile,
            hardRejectApplied: false,
            hardRejectReason: null,
            cooldownOverridden: exceptionalCooldownOverride,
            overrideReason: exceptionalCooldownOverride
              ? "exceptional_spike_cooldown_override"
              : null,
          spikeDetected: tick.entry.spikeDetected,
          fastPathUsed: true,
          criticalBlockerUsed: null,
          reason: "strong_spike_immediate_entry_fast_path",
          },
        }),
        entryForSimulation: tick.entry,
        borderlineLifecycleEvents: renderEvents,
        strongSpikeLifecycleMessages,
      };
    }
  }

  const active = manager.getActive();
  const currentTickNumber = manager.getTickNumber();
  if (active !== null && active.startTickNumber < currentTickNumber) {
    const watchDecision = decideBorderlineWatch({
      candidate: active,
      tick,
      config: {
        rangeThreshold: config.rangeThreshold,
        stableRangeSoftToleranceRatio: config.stableRangeSoftToleranceRatio,
        spikeThreshold: config.spikeThreshold,
        entryPrice: config.entryPrice,
        maxOppositeSideEntryPrice: config.maxOppositeSideEntryPrice,
        neutralQuoteBandMin: config.neutralQuoteBandMin,
        neutralQuoteBandMax: config.neutralQuoteBandMax,
        borderlineRequirePause: config.borderlineRequirePause,
        borderlineRequireNoContinuation: config.borderlineRequireNoContinuation,
        borderlineContinuationThreshold: config.borderlineContinuationThreshold,
        borderlineReversionThreshold: config.borderlineReversionThreshold,
        borderlinePauseBandPercent: config.borderlinePauseBandPercent,
      },
      cooldownBlocked: !simulation.canOpenNewPosition(now, config.entryCooldownMs),
    });
    const movement = analyzeBorderlinePostMove({
      candidate: active,
      watchedTickPrices: active.watchedPrices,
      continuationThreshold: config.borderlineContinuationThreshold,
      reversionThreshold: config.borderlineReversionThreshold,
      pauseBandPercent: config.borderlinePauseBandPercent,
    });

    const applied = manager.applyDecision(now, watchDecision);
    if (applied !== null) {
      const rr = toRenderEvent(applied, tick);
      if (rr !== null) {
        rr.postMoveClassification = movement.postMoveClassification;
        renderEvents.push(rr);
      }
    }
    if (watchDecision.action === "promote") {
      if (!qualityGate.qualityGatePassed) {
        return {
          decision: withNormalizedReasons({
            tick,
            simulation,
            tradableSpikeMinPercent: config.tradableSpikeMinPercent,
            decision: {
              action: "cancel_borderline_candidate",
              direction: null,
              stableRangeQuality,
              movementClassification: tick.entry.movementClassification,
              qualityGatePassed: qualityGate.qualityGatePassed,
              qualityGateReasons: qualityGate.qualityGateReasons,
              qualityProfile: qualityGate.qualityProfile,
              hardRejectApplied: false,
              hardRejectReason: null,
            cooldownOverridden: false,
            overrideReason: null,
              spikeDetected: tick.entry.spikeDetected,
              fastPathUsed: false,
              criticalBlockerUsed: "quality_gate_rejected",
              reason: qualityGate.qualityGateReasons.includes(
                "prior_range_too_wide_for_mean_reversion"
              )
                ? "prior_range_too_wide_for_mean_reversion"
                : "quality_gate_rejected",
              borderlineCandidateId: active.id,
            },
          }),
          borderlineLifecycleEvents: renderEvents,
        };
      }
      return {
        decision: withNormalizedReasons({
          tick,
          simulation,
          tradableSpikeMinPercent: config.tradableSpikeMinPercent,
          decision: {
          action: "promote_borderline_candidate",
          direction: watchDecision.direction,
          stableRangeQuality,
          movementClassification: tick.entry.movementClassification,
          qualityGatePassed: qualityGate.qualityGatePassed,
          qualityGateReasons: qualityGate.qualityGateReasons,
          qualityProfile: qualityGate.qualityProfile,
          hardRejectApplied: false,
          hardRejectReason: null,
            cooldownOverridden: false,
            overrideReason: null,
          spikeDetected: tick.entry.spikeDetected,
          fastPathUsed: false,
          criticalBlockerUsed: null,
          reason: watchDecision.reason,
          borderlineCandidateId: active.id,
          },
        }),
        entryForSimulation: buildBorderlinePromotedEntry(active, tick.entry),
        borderlineLifecycleEvents: renderEvents,
      };
    }
    if (watchDecision.action === "cancel") {
      return {
        decision: withNormalizedReasons({
          tick,
          simulation,
          tradableSpikeMinPercent: config.tradableSpikeMinPercent,
          decision: {
          action: "cancel_borderline_candidate",
          direction: null,
          stableRangeQuality,
          movementClassification: tick.entry.movementClassification,
          qualityGatePassed: qualityGate.qualityGatePassed,
          qualityGateReasons: qualityGate.qualityGateReasons,
          qualityProfile: qualityGate.qualityProfile,
          hardRejectApplied: false,
          hardRejectReason: null,
          spikeDetected: tick.entry.spikeDetected,
          fastPathUsed: false,
          criticalBlockerUsed: null,
          reason: watchDecision.reason,
          borderlineCandidateId: active.id,
          },
        }),
        borderlineLifecycleEvents: renderEvents,
      };
    }
    if (watchDecision.action === "expire") {
      return {
        decision: withNormalizedReasons({
          tick,
          simulation,
          tradableSpikeMinPercent: config.tradableSpikeMinPercent,
          decision: {
          action: "expire_borderline_candidate",
          direction: null,
          stableRangeQuality,
          movementClassification: tick.entry.movementClassification,
          qualityGatePassed: qualityGate.qualityGatePassed,
          qualityGateReasons: qualityGate.qualityGateReasons,
          qualityProfile: qualityGate.qualityProfile,
          hardRejectApplied: false,
          hardRejectReason: null,
          spikeDetected: tick.entry.spikeDetected,
          fastPathUsed: false,
          criticalBlockerUsed: null,
          reason: watchDecision.reason,
          borderlineCandidateId: active.id,
          },
        }),
        borderlineLifecycleEvents: renderEvents,
      };
    }
    if (applied !== null && lifecycleDecision === null) {
      const d = lifecycleToDecision(applied);
      if (d !== null) {
        return {
          decision: withNormalizedReasons({ decision: d, tick, simulation, tradableSpikeMinPercent: config.tradableSpikeMinPercent }),
          borderlineLifecycleEvents: renderEvents,
          strongSpikeLifecycleMessages,
        };
      }
    }
  }

  if (
    tick.entry.shouldEnter &&
    tick.entry.direction !== null &&
    tick.entry.movementClassification === "strong_spike" &&
    qualityGate.qualityGatePassed
  ) {
    if (simulation.canOpenNewPosition(now, config.entryCooldownMs)) {
      return {
        decision: withNormalizedReasons({
          tick,
          simulation,
          decision: {
          action: "enter_immediate",
          direction: tick.entry.direction,
          stableRangeQuality,
          movementClassification: tick.entry.movementClassification,
          qualityGatePassed: qualityGate.qualityGatePassed,
          qualityGateReasons: qualityGate.qualityGateReasons,
          qualityProfile: qualityGate.qualityProfile,
          hardRejectApplied: false,
          hardRejectReason: null,
          spikeDetected: tick.entry.spikeDetected,
          fastPathUsed: false,
          criticalBlockerUsed: null,
          reason: "strong_spike_immediate_entry",
          },
        }),
        entryForSimulation: tick.entry,
        borderlineLifecycleEvents: renderEvents,
        strongSpikeLifecycleMessages,
      };
    }
    return {
      decision: withNormalizedReasons({
        tick,
        simulation,
        tradableSpikeMinPercent: config.tradableSpikeMinPercent,
        decision: {
        action: "none",
        direction: null,
        stableRangeQuality,
        movementClassification: tick.entry.movementClassification,
        qualityGatePassed: qualityGate.qualityGatePassed,
        qualityGateReasons: qualityGate.qualityGateReasons,
        qualityProfile: qualityGate.qualityProfile,
        hardRejectApplied: false,
        hardRejectReason: null,
        spikeDetected: tick.entry.spikeDetected,
        fastPathUsed: false,
        criticalBlockerUsed: "active_position_or_cooldown",
        reason: "immediate_entry_blocked_by_position_or_cooldown",
        },
      }),
      entryForSimulation: tick.entry,
      borderlineLifecycleEvents: renderEvents,
      strongSpikeLifecycleMessages,
    };
  }

  if (lifecycleDecision !== null) {
    return {
      decision: withNormalizedReasons({
        decision: lifecycleDecision,
        tick,
        simulation,
        tradableSpikeMinPercent: config.tradableSpikeMinPercent,
      }),
      entryForSimulation: tick.entry,
      borderlineLifecycleEvents: renderEvents,
      strongSpikeLifecycleMessages,
    };
  }

  return {
    decision: withNormalizedReasons({
      tick,
      simulation,
      tradableSpikeMinPercent: config.tradableSpikeMinPercent,
      decision: {
      action: "none",
      direction: null,
      stableRangeQuality,
      movementClassification: tick.entry.movementClassification,
      qualityGatePassed: qualityGate.qualityGatePassed,
      qualityGateReasons: qualityGate.qualityGateReasons,
      qualityProfile: qualityGate.qualityProfile,
      hardRejectApplied: false,
      hardRejectReason: null,
      spikeDetected: tick.entry.spikeDetected,
      fastPathUsed: false,
      criticalBlockerUsed: null,
      reason: "no_actionable_signal",
      },
    }),
    entryForSimulation: tick.entry,
    borderlineLifecycleEvents: renderEvents,
    strongSpikeLifecycleMessages,
  };
}

export function formatStrategyDecisionLog(decision: StrategyDecision): string {
  const dir = decision.direction ?? "—";
  const id = decision.borderlineCandidateId
    ? ` #${decision.borderlineCandidateId}`
    : "";
  const extra =
    decision.reasons && decision.reasons.length > 0
      ? ` | reasons: ${decision.reasons.join(", ")}`
      : "";
  const blocker =
    decision.criticalBlockerUsed !== undefined && decision.criticalBlockerUsed !== null
      ? ` | blocker=${decision.criticalBlockerUsed}`
      : "";
  const qGate = decision.qualityGatePassed === true ? "pass" : "fail";
  const qProfile = decision.qualityProfile ?? "weak";
  const override =
    decision.cooldownOverridden === true
      ? ` | override=${decision.overrideReason ?? "exceptional_spike_cooldown_override"}`
      : "";
  const hardReject =
    decision.hardRejectApplied === true
      ? ` | HARD_REJECT=${decision.hardRejectReason ?? "hard_reject_unstable_pre_spike_context"}`
      : "";
  const qGateExtra =
    decision.qualityGateReasons && decision.qualityGateReasons.length > 0
      ? ` | qgate=${decision.qualityGateReasons.join("+")}`
      : "";
  return `[strategy] action=${decision.action}${id} | dir=${dir} | cls=${decision.movementClassification} | gate=${qGate}/${qProfile}${hardReject}${override}${qGateExtra} | spike=${decision.spikeDetected} | fast=${decision.fastPathUsed} | range=${decision.stableRangeQuality}${blocker} | ${decision.reason}${extra}`;
}

