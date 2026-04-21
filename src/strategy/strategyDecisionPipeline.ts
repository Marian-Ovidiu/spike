// Binary paper pre-entry audit (DEBUG_MONITOR): `binary/monitor/binaryPreEntryAudit.ts` + `SimulationEngine.onTickBinary`.
import type { StrategyTickResult } from "../botLoop.js";
import type { AppConfig } from "../config.js";
import type { EntryEvaluation } from "../entryConditions.js";
import type { StableRangeQuality } from "../stableRangeQuality.js";
import type {
  BorderlineEntryWeakRejection,
  BorderlineLifecycleEvent,
  PostMoveClassification,
} from "../borderlineCandidate.js";
import type { BorderlineCandidateStore } from "../borderlineCandidateStore.js";
import { analyzeBorderlinePostMove } from "../postMoveAnalyzer.js";
import {
  buildBorderlinePromotedEntry,
  decideBorderlineWatch,
} from "../borderlineWatcher.js";
import { StrongSpikeCandidateStore } from "../strongSpikeCandidateStore.js";
import {
  buildStrongSpikePromotedEntry,
  decideStrongSpikeWatch,
} from "../strongSpikeWatcher.js";
import type { SimulationEngine } from "../simulationEngine.js";
import {
  normalizeDecisionRejectionReasons,
  type NormalizedRejectionReason,
} from "../decisionReasonBuilder.js";
import {
  DEFAULT_MAX_PRIOR_RANGE_FOR_NORMAL_ENTRY,
  DEFAULT_TRADABLE_SPIKE_MIN_PERCENT,
  type PreEntryQualityGateResult,
  type QualityGateDiagnostics,
  type QualityProfile,
} from "../preEntryQualityGate.js";
import { classifySpikeQuality } from "../spikeQualityClassifier.js";
import {
  applyUnstableSoftOverlayOnQualityGate,
  evaluateHardRejectContext,
  type HardRejectResult,
} from "../hardRejectEngine.js";
import {
  shouldOverrideCooldownForExceptional,
  shouldOverrideCooldownForExceptionalCandidate,
} from "../overridePolicyEngine.js";
import { evaluateBinaryPaperEntryQuotes } from "../binary/entry/binaryQuoteEntryFilter.js";
import { evaluateExecutionBookPipeline } from "../executionSpreadFilter.js";

export type StrategyAction =
  | "none"
  | "enter_immediate"
  | "create_borderline_candidate"
  | "promote_borderline_candidate"
  | "cancel_borderline_candidate"
  | "expire_borderline_candidate";

export type PipelineQualityModifier = {
  /** Profile reflected on this decision (may differ from pre-entry gate alone). */
  effectiveQualityProfile: QualityProfile;
  reason: string;
  /** Gate profile before pipeline-specific overrides (e.g. hard reject). */
  preModifierGateProfile?: QualityProfile;
};

export type StrategyDecision = {
  action: StrategyAction;
  direction: "UP" | "DOWN" | null;
  stableRangeQuality: StableRangeQuality;
  movementClassification: "no_signal" | "borderline" | "strong_spike";
  qualityGatePassed?: boolean;
  qualityGateReasons?: string[];
  qualityProfile?: QualityProfile;
  /** Rule-trace from {@link evaluatePreEntryQualityGate} (same tick as ready entry). */
  qualityGateDiagnostics?: QualityGateDiagnostics;
  /** When set, explains why `qualityProfile` differs from gate-only evaluation. */
  pipelineQualityModifier?: PipelineQualityModifier;
  hardRejectApplied?: boolean;
  hardRejectReason?: string | null;
  unstablePreSpikeContextDetected?: boolean;
  unstableContextHandling?: HardRejectResult["unstableContextHandling"];
  unstablePreSpikeContextMetrics?: HardRejectResult["unstablePreSpikeContextMetrics"];
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

/** Appended to {@link EntryEvaluation.reasons} when the pipeline blocks a raw `shouldEnter` tick. */
export const PIPELINE_BLOCKED_ENTRY_REASON = "pipeline_blocked_entry";

/**
 * Paper execution must mirror the strategy pipeline: raw {@link EntryEvaluation}
 * can still have `shouldEnter: true` while {@link StrategyDecision.action} is `none`
 * (quality gate, confirmation watch, cooldown, quotes, etc.). The simulator only
 * consumes this object — clear the entry flag unless the pipeline approved an open.
 */
export function entryEvaluationForPipelinePaperExecution(
  decision: Pick<StrategyDecision, "action">,
  entryForSimulation: EntryEvaluation
): EntryEvaluation {
  if (
    decision.action === "enter_immediate" ||
    decision.action === "promote_borderline_candidate"
  ) {
    return entryForSimulation;
  }
  if (!entryForSimulation.shouldEnter) {
    return entryForSimulation;
  }
  const reasons = entryForSimulation.reasons.includes(PIPELINE_BLOCKED_ENTRY_REASON)
    ? entryForSimulation.reasons
    : [...entryForSimulation.reasons, PIPELINE_BLOCKED_ENTRY_REASON];
  return {
    ...entryForSimulation,
    shouldEnter: false,
    direction: null,
    reasons,
  };
}

function withNormalizedReasons(input: {
  decision: StrategyDecision;
  tick: StrategyTickResult;
  simulation: SimulationEngine;
  tradableSpikeMinPercent?: number;
  /** Full gate from {@link runStrategyDecisionPipeline} config (preferred over recomputing). */
  pipelineQualityGate?: PreEntryQualityGateResult;
  /** When set (ready-tick path), attaches unstable-context diagnostics to the decision. */
  hardRejectContext?: HardRejectResult;
}): StrategyDecision {
  const tradableSpikeMinPercent = Number.isFinite(input.tradableSpikeMinPercent)
    ? Math.max(
        0,
        input.tradableSpikeMinPercent ?? DEFAULT_TRADABLE_SPIKE_MIN_PERCENT
      )
    : DEFAULT_TRADABLE_SPIKE_MIN_PERCENT;
  const fallbackGate =
    input.tick.kind === "ready"
      ? classifySpikeQuality(input.tick.entry, {
          tradableSpikeMinPercent,
          maxPriorRangeForNormalEntry: DEFAULT_MAX_PRIOR_RANGE_FOR_NORMAL_ENTRY,
        })
      : {
          qualityGatePassed: false,
          qualityGateReasons: ["missing_ready_tick_data"],
          qualityProfile: "weak" as const,
          diagnostics: {
            classification: "rule_based" as const,
            effectiveThresholds: {
              tradableSpikeMinPercent,
              exceptionalSpikeMinPercent: 0,
              maxPriorRangeForNormalEntry: DEFAULT_MAX_PRIOR_RANGE_FOR_NORMAL_ENTRY,
            },
            inputs: {
              movementClassification: "no_signal" as const,
              strongestMovePercent: 0,
              spikePercent: 0,
              thresholdRatio: 0,
              priorRangeFraction: 0,
              stableRangeDetected: false,
              stableRangeQuality: "poor" as const,
              entryReasonCodes: [],
            },
            profileAfterSpikeSizeTier: "weak" as const,
            ruleChecks: [],
            downgradeChain: [],
            finalProfile: "weak" as const,
            qualityGatePassed: false,
            weakPrimaryReasons: ["missing_ready_tick_data"],
          },
        };
  const qualityGate = input.pipelineQualityGate ?? fallbackGate;
  const qualityGateDiagnostics: QualityGateDiagnostics | undefined =
    input.decision.qualityGateDiagnostics ??
    (input.tick.kind === "ready" ? qualityGate.diagnostics : undefined);
  const diagSpread =
    qualityGateDiagnostics !== undefined
      ? { qualityGateDiagnostics }
      : {};
  const hr = input.hardRejectContext;
  const unstableSpread =
    hr?.unstablePreSpikeContextDetected === true
      ? {
          unstablePreSpikeContextDetected: true as const,
          unstableContextHandling: hr.unstableContextHandling,
          ...(hr.unstablePreSpikeContextMetrics !== undefined
            ? { unstablePreSpikeContextMetrics: hr.unstablePreSpikeContextMetrics }
            : {}),
        }
      : {};
  if (input.tick.kind !== "ready") {
    return {
      ...input.decision,
      qualityGatePassed:
        input.decision.qualityGatePassed ?? qualityGate.qualityGatePassed,
      qualityGateReasons:
        input.decision.qualityGateReasons ?? qualityGate.qualityGateReasons,
      qualityProfile: input.decision.qualityProfile ?? qualityGate.qualityProfile,
      ...diagSpread,
      hardRejectApplied: input.decision.hardRejectApplied ?? false,
      hardRejectReason: input.decision.hardRejectReason ?? null,
      cooldownOverridden: input.decision.cooldownOverridden ?? false,
      overrideReason: input.decision.overrideReason ?? null,
      ...unstableSpread,
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
    ...diagSpread,
    hardRejectApplied: input.decision.hardRejectApplied ?? false,
    hardRejectReason: input.decision.hardRejectReason ?? null,
    cooldownOverridden: input.decision.cooldownOverridden ?? false,
    overrideReason: input.decision.overrideReason ?? null,
    ...unstableSpread,
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
  type:
    | "created"
    | "watch"
    | "promoted"
    | "cancelled"
    | "expired"
    | "entry_rejected_weak";
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
  bestBid: number | null;
  bestAsk: number | null;
  midPrice: number | null;
  spreadBps: number | null;
  postMoveClassification: PostMoveClassification | null;
  reason: string;
};

/** Rows recorded in opportunities.jsonl (excludes synthetic entry-gate metrics). */
export type BorderlineLifecyclePersistedRenderEvent = Omit<
  BorderlineLifecycleRenderEvent,
  "type"
> & {
  type: "created" | "watch" | "promoted" | "cancelled" | "expired";
};

export function isPersistedBorderlineLifecycleEvent(
  ev: BorderlineLifecycleRenderEvent
): ev is BorderlineLifecyclePersistedRenderEvent {
  return ev.type !== "entry_rejected_weak";
}

export function buildBorderlineEntryRejectedWeakRenderEvent(
  tick: Extract<StrategyTickResult, { kind: "ready" }>,
  r: BorderlineEntryWeakRejection
): BorderlineLifecycleRenderEvent {
  const ws = tick.entry.windowSpike;
  return {
    type: "entry_rejected_weak",
    candidateId: "entry-gate",
    detectionTick: 0,
    moveDirection: r.moveDirection,
    movePercent: r.movePercent,
    thresholdPercent: ws ? ws.thresholdPercent * 100 : 0,
    thresholdRatio: r.thresholdRatio,
    sourceWindowLabel: r.sourceWindowLabel,
    suggestedContrarianDirection: null,
    watchTicksConfigured: 0,
    watchTicksObserved: 0,
    watchTicksRemaining: 0,
    currentBtcPrice: tick.btc,
    bestBid: tick.executionBook.bestBid,
    bestAsk: tick.executionBook.bestAsk,
    midPrice: tick.executionBook.midPrice,
    spreadBps: tick.executionBook.spreadBps,
    postMoveClassification: null,
    reason: r.reason,
  };
}

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
    | "maxEntrySpreadBps"
    | "entryCooldownMs"
    | "borderlineRequirePause"
    | "borderlineRequireNoContinuation"
    | "borderlineContinuationThreshold"
    | "borderlineReversionThreshold"
    | "borderlinePauseBandPercent"
    | "borderlineMaxLifetimeMs"
    | "borderlineFastPromoteDeltaBps"
    | "borderlineFastPromoteProbDelta"
    | "borderlineFastRejectSameDirectionBps"
    | "enableBorderlineMode"
    | "strongSpikeHardRejectPoorRange"
    | "allowWeakQualityEntries"
    | "allowWeakQualityOnlyForStrongSpikes"
    | "allowAcceptableQualityStrongSpikes"
    | "unstableContextMode"
    | "marketMode"
    | "binaryMaxOppositeSideEntryPrice"
    | "binaryMaxEntrySidePrice"
    | "binaryNeutralQuoteBandMin"
    | "binaryNeutralQuoteBandMax"
  >;
};

function appendWeakQualityGateLogLines(
  messages: string[],
  gate: { qualityGateReasons: readonly string[] }
): void {
  const r = gate.qualityGateReasons;
  if (r.includes("weak_quality_entry_allowed_by_config")) {
    messages.push(
      "[quality-gate] ALLOW_WEAK_QUALITY_ENTRIES: weak profile PASSED the pre-entry gate (controlled testing)"
    );
  }
  if (r.includes("weak_quality_entries_disabled_by_config")) {
    messages.push(
      "[quality-gate] ALLOW_WEAK_QUALITY_ENTRIES=false: weak profile rejected at pre-entry gate"
    );
  }
  if (r.includes("weak_quality_borderline_blocked_by_config")) {
    messages.push(
      "[quality-gate] weak borderline rejected (ALLOW_WEAK_QUALITY_ONLY_FOR_STRONG_SPIKES=true)"
    );
  }
  if (r.includes("weak_quality_blocked_prior_or_unstable_context")) {
    messages.push(
      "[quality-gate] weak bypass blocked: prior range wide or unstable/noisy context (unchanged)"
    );
  }
  if (r.includes("weak_quality_no_signal_blocked_by_config")) {
    messages.push(
      "[quality-gate] weak no_signal rejected (allow-weak applies only to strong_spike/borderline when configured)"
    );
  }
  if (r.includes("acceptable_quality_strong_spike_allowed_by_config")) {
    messages.push(
      "[quality-gate] ALLOW_ACCEPTABLE_QUALITY_STRONG_SPIKES: acceptable pre-spike range + strong_spike — pre-entry gate PASS (experimental)"
    );
  }
}

function appendUnstableContextLogs(
  messages: string[],
  hardReject: HardRejectResult,
  mode: "hard" | "soft"
): void {
  if (hardReject.unstableContextHandling === "hard_reject") {
    const m = hardReject.unstablePreSpikeContextMetrics;
    messages.push(
      `[unstable-context] mode=${mode} unstable pre-spike context matched; hard_reject applied reason=${hardReject.hardRejectReason ?? "hard_reject_unstable_pre_spike_context"}` +
        (m
          ? ` | priorRangeFrac=${m.priorRangeFraction} threshold=${m.threshold} stableRangeDetected=${m.stableRangeDetected}`
          : "")
    );
    return;
  }
  if (hardReject.unstableContextHandling === "soft_deferred") {
    const m = hardReject.unstablePreSpikeContextMetrics;
    messages.push(
      `[unstable-context] mode=${mode} unstable pre-spike context matched; downgraded to soft handling (downstream gates decide)` +
        (m
          ? ` | priorRangeFrac=${m.priorRangeFraction} threshold=${m.threshold} stableRangeDetected=${m.stableRangeDetected}`
          : "")
    );
  }
}

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
  const bestBid = tick.kind === "ready" ? tick.executionBook.bestBid : null;
  const bestAsk = tick.kind === "ready" ? tick.executionBook.bestAsk : null;
  const midPrice = tick.kind === "ready" ? tick.executionBook.midPrice : null;
  const spreadBps = tick.kind === "ready" ? tick.executionBook.spreadBps : null;

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
      bestBid,
      bestAsk,
      midPrice,
      spreadBps,
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
      bestBid,
      bestAsk,
      midPrice,
      spreadBps,
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
      bestBid,
      bestAsk,
      midPrice,
      spreadBps,
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
      bestBid,
      bestAsk,
      midPrice,
      spreadBps,
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
      bestBid,
      bestAsk,
      midPrice,
      spreadBps,
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
            bestBid: null,
            bestAsk: null,
            midPrice: null,
            spreadBps: null,
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
  if (tick.kind === "ready") {
    for (const wr of manager.drainBorderlineEntryWeakRejections()) {
      renderEvents.push(buildBorderlineEntryRejectedWeakRenderEvent(tick, wr));
    }
  }
  const lifecycleDecision = fromLastMeaningfulLifecycle(lifecycleEvents);
  const qualityGateBase = classifySpikeQuality(tick.entry, {
    tradableSpikeMinPercent: config.tradableSpikeMinPercent,
    exceptionalSpikeMinPercent: config.exceptionalSpikePercent,
    maxPriorRangeForNormalEntry: config.maxPriorRangeForNormalEntry,
    allowWeakQualityEntries: config.allowWeakQualityEntries,
    allowWeakQualityOnlyForStrongSpikes:
      config.allowWeakQualityOnlyForStrongSpikes,
    allowAcceptableQualityStrongSpikes:
      config.allowAcceptableQualityStrongSpikes,
  });
  appendWeakQualityGateLogLines(strongSpikeLifecycleMessages, qualityGateBase);
  const hardReject = evaluateHardRejectContext({
    entry: tick.entry,
    hardRejectPriorRangePercent: config.hardRejectPriorRangePercent,
    unstableContextMode: config.unstableContextMode,
  });
  appendUnstableContextLogs(
    strongSpikeLifecycleMessages,
    hardReject,
    config.unstableContextMode
  );
  const nrm = (
    args: Omit<Parameters<typeof withNormalizedReasons>[0], "hardRejectContext">
  ) => withNormalizedReasons({ ...args, hardRejectContext: hardReject });

  if (hardReject.hardRejectApplied) {
    return {
      decision: nrm({
        tick,
        simulation,
        tradableSpikeMinPercent: config.tradableSpikeMinPercent,
        pipelineQualityGate: qualityGateBase,
        decision: {
          action: "none",
          direction: null,
          stableRangeQuality,
          movementClassification: tick.entry.movementClassification,
          qualityGatePassed: false,
          qualityGateReasons: [
            ...new Set([
              ...qualityGateBase.qualityGateReasons,
              "hard_reject_unstable_pre_spike_context",
            ]),
          ],
          qualityProfile: "weak",
          pipelineQualityModifier: {
            effectiveQualityProfile: "weak",
            reason: "hard_reject_unstable_pre_spike_context",
            preModifierGateProfile: qualityGateBase.qualityProfile,
          },
          hardRejectApplied: true,
          hardRejectReason: hardReject.hardRejectReason,
          cooldownOverridden: false,
          overrideReason: null,
          spikeDetected: tick.entry.spikeDetected,
          fastPathUsed: tick.entry.movementClassification === "strong_spike",
          criticalBlockerUsed: "hard_reject_unstable_pre_spike_context",
          reason: "hard_reject_unstable_pre_spike_context",
        },
      }),
      entryForSimulation: tick.entry,
      borderlineLifecycleEvents: renderEvents,
      strongSpikeLifecycleMessages,
    };
  }

  const qualityGate = applyUnstableSoftOverlayOnQualityGate(
    qualityGateBase,
    hardReject
  );

  const tryBinaryPaperQuoteGateBlock = (
    direction: "UP" | "DOWN",
    fastPathUsed: boolean,
    movementCls: StrategyDecision["movementClassification"]
  ): StrategyDecisionPipelineResult | null => {
    if (config.marketMode !== "binary") return null;
    const br = evaluateBinaryPaperEntryQuotes({
      binaryOutcomes: tick.binaryOutcomes,
      direction,
      maxOppositeSideEntryPrice: config.binaryMaxOppositeSideEntryPrice,
      maxEntrySidePrice: config.binaryMaxEntrySidePrice,
      neutralBandMin: config.binaryNeutralQuoteBandMin,
      neutralBandMax: config.binaryNeutralQuoteBandMax,
    });
    if (br === null) return null;
    strongSpikeLifecycleMessages.push(
      `[strategy] binary_quote_gate:${br} | dir=${direction}`
    );
    return {
      decision: nrm({
        tick,
        simulation,
        tradableSpikeMinPercent: config.tradableSpikeMinPercent,
        pipelineQualityGate: qualityGate,
        decision: {
          action: "none",
          direction: null,
          stableRangeQuality,
          movementClassification: movementCls,
          qualityGatePassed: qualityGate.qualityGatePassed,
          qualityGateReasons: qualityGate.qualityGateReasons,
          qualityProfile: qualityGate.qualityProfile,
          hardRejectApplied: false,
          hardRejectReason: null,
          cooldownOverridden: false,
          overrideReason: null,
          spikeDetected: tick.entry.spikeDetected,
          fastPathUsed,
          criticalBlockerUsed: null,
          reason: br,
        },
      }),
      entryForSimulation: tick.entry,
      borderlineLifecycleEvents: renderEvents,
      strongSpikeLifecycleMessages,
    };
  };

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
        maxEntrySpreadBps: config.maxEntrySpreadBps,
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
      const binBlockStrong = tryBinaryPaperQuoteGateBlock(
        strongDecision.direction,
        true,
        "strong_spike"
      );
      if (binBlockStrong !== null) return binBlockStrong;
      return {
        decision: nrm({
          tick,
          simulation,
          tradableSpikeMinPercent: config.tradableSpikeMinPercent,
          pipelineQualityGate: qualityGate,
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
      decision: nrm({
        tick,
        simulation,
        tradableSpikeMinPercent: config.tradableSpikeMinPercent,
        pipelineQualityGate: qualityGate,
        decision: {
          action: "none",
          direction: null,
          stableRangeQuality,
          movementClassification: "strong_spike",
          qualityGatePassed: false,
          qualityGateReasons: [`confirmation_${postMoveClassification}`],
          qualityProfile: "weak",
          pipelineQualityModifier: {
            effectiveQualityProfile: "weak",
            reason: `strong_spike_confirmation_${strongDecision.reason}`,
            preModifierGateProfile: qualityGate.qualityProfile,
          },
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
    if (
      !config.enableBorderlineMode &&
      qualityGate.qualityProfile !== "strong" &&
      qualityGate.qualityProfile !== "exceptional"
    ) {
      return {
        decision: nrm({
          tick,
          simulation,
          tradableSpikeMinPercent: config.tradableSpikeMinPercent,
          pipelineQualityGate: qualityGate,
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
              "borderline_mode_off_strong_spike_requires_strong_or_exceptional_quality",
          },
        }),
        entryForSimulation: tick.entry,
        borderlineLifecycleEvents: renderEvents,
        strongSpikeLifecycleMessages,
      };
    }
    if (!qualityGate.qualityGatePassed) {
      return {
        decision: nrm({
          tick,
          simulation,
          tradableSpikeMinPercent: config.tradableSpikeMinPercent,
          pipelineQualityGate: qualityGate,
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
        decision: nrm({
          tick,
          simulation,
          tradableSpikeMinPercent: config.tradableSpikeMinPercent,
          pipelineQualityGate: qualityGate,
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
    if (config.marketMode === "binary") {
      if (tick.entry.direction !== null) {
        const binBlock = tryBinaryPaperQuoteGateBlock(
          tick.entry.direction,
          true,
          tick.entry.movementClassification
        );
        if (binBlock !== null) return binBlock;
      }
    } else {
      const bookGate = evaluateExecutionBookPipeline(
        tick.executionBook,
        config.maxEntrySpreadBps
      );
      if (bookGate !== null) {
        if (bookGate === "invalid_book") {
          strongSpikeLifecycleMessages.push(
            "[strategy] spot book invalid (bid/ask) — blocking immediate entry"
          );
        } else {
          strongSpikeLifecycleMessages.push(
            `[strategy] spread_too_wide | spr=${tick.executionBook.spreadBps.toFixed(2)}bps max=${config.maxEntrySpreadBps}`
          );
        }
        return {
          decision: nrm({
            tick,
            simulation,
            tradableSpikeMinPercent: config.tradableSpikeMinPercent,
            pipelineQualityGate: qualityGate,
            decision: {
              action: "none",
              direction: null,
              stableRangeQuality,
              movementClassification: tick.entry.movementClassification,
              qualityGatePassed: qualityGate.qualityGatePassed,
              qualityGateReasons: qualityGate.qualityGateReasons,
              qualityProfile: qualityGate.qualityProfile,
              pipelineQualityModifier: {
                effectiveQualityProfile: qualityGate.qualityProfile,
                reason: `post_gate_spot_book:${bookGate}`,
                preModifierGateProfile: qualityGate.qualityProfile,
              },
              hardRejectApplied: false,
              hardRejectReason: null,
              cooldownOverridden: false,
              overrideReason: null,
              spikeDetected: tick.entry.spikeDetected,
              fastPathUsed: true,
              criticalBlockerUsed:
                bookGate === "invalid_book" ? "invalid_market_prices" : "quality_gate_rejected",
              reason:
                bookGate === "invalid_book"
                  ? "strong spike detected but blocked by invalid spot book"
                  : "strong spike detected but blocked by wide spread",
            },
          }),
          entryForSimulation: tick.entry,
          borderlineLifecycleEvents: renderEvents,
          strongSpikeLifecycleMessages,
        };
      }
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
        decision: nrm({
          tick,
          simulation,
          tradableSpikeMinPercent: config.tradableSpikeMinPercent,
          pipelineQualityGate: qualityGate,
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
        decision: nrm({
          tick,
          simulation,
          tradableSpikeMinPercent: config.tradableSpikeMinPercent,
          pipelineQualityGate: qualityGate,
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
      const binBlockFast = tryBinaryPaperQuoteGateBlock(
        tick.entry.direction,
        true,
        tick.entry.movementClassification
      );
      if (binBlockFast !== null) return binBlockFast;
      return {
        decision: nrm({
          tick,
          simulation,
          tradableSpikeMinPercent: config.tradableSpikeMinPercent,
          pipelineQualityGate: qualityGate,
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
        maxEntrySpreadBps: config.maxEntrySpreadBps,
        borderlineRequirePause: config.borderlineRequirePause,
        borderlineRequireNoContinuation: config.borderlineRequireNoContinuation,
        borderlineContinuationThreshold: config.borderlineContinuationThreshold,
        borderlineReversionThreshold: config.borderlineReversionThreshold,
        borderlinePauseBandPercent: config.borderlinePauseBandPercent,
        borderlineFastPromoteDeltaBps: config.borderlineFastPromoteDeltaBps,
        borderlineFastPromoteProbDelta: config.borderlineFastPromoteProbDelta,
        borderlineFastRejectSameDirectionBps:
          config.borderlineFastRejectSameDirectionBps,
        binaryPaperSlippageBps: config.binaryPaperSlippageBps,
      },
      cooldownBlocked: !simulation.canOpenNewPosition(now, config.entryCooldownMs),
      ...(tick.estimatedProbabilityUp !== undefined
        ? { estimatedProbabilityUp: tick.estimatedProbabilityUp }
        : {}),
    });
    const movement = analyzeBorderlinePostMove({
      candidate: active,
      watchedTickPrices: active.watchedPrices,
      continuationThreshold: config.borderlineContinuationThreshold,
      reversionThreshold: config.borderlineReversionThreshold,
      pauseBandPercent: config.borderlinePauseBandPercent,
    });

    let effectiveWatch = watchDecision;
    if (
      watchDecision.action === "promote" &&
      watchDecision.direction !== null &&
      config.marketMode === "binary"
    ) {
      const br = evaluateBinaryPaperEntryQuotes({
        binaryOutcomes: tick.binaryOutcomes,
        direction: watchDecision.direction,
        maxOppositeSideEntryPrice: config.binaryMaxOppositeSideEntryPrice,
        maxEntrySidePrice: config.binaryMaxEntrySidePrice,
        neutralBandMin: config.binaryNeutralQuoteBandMin,
        neutralBandMax: config.binaryNeutralQuoteBandMax,
      });
      if (br !== null) {
        effectiveWatch = {
          action: "cancel",
          reason: br,
        };
        strongSpikeLifecycleMessages.push(
          `[strategy] borderline promote cancelled by binary_quote_gate:${br}`
        );
      }
    }

    const applied = manager.applyDecision(now, effectiveWatch);
    if (applied !== null) {
      const rr = toRenderEvent(applied, tick);
      if (rr !== null) {
        rr.postMoveClassification = movement.postMoveClassification;
        renderEvents.push(rr);
      }
    }
    if (watchDecision.action === "promote") {
      if (
        effectiveWatch.action === "cancel" &&
        config.marketMode === "binary" &&
        watchDecision.direction !== null
      ) {
        const bbr = tryBinaryPaperQuoteGateBlock(
          watchDecision.direction,
          false,
          tick.entry.movementClassification
        );
        if (bbr !== null) return bbr;
      }
      if (!qualityGate.qualityGatePassed) {
        return {
          decision: nrm({
            tick,
            simulation,
            tradableSpikeMinPercent: config.tradableSpikeMinPercent,
            pipelineQualityGate: qualityGate,
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
        decision: nrm({
          tick,
          simulation,
          tradableSpikeMinPercent: config.tradableSpikeMinPercent,
          pipelineQualityGate: qualityGate,
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
        decision: nrm({
          tick,
          simulation,
          tradableSpikeMinPercent: config.tradableSpikeMinPercent,
          pipelineQualityGate: qualityGate,
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
        decision: nrm({
          tick,
          simulation,
          tradableSpikeMinPercent: config.tradableSpikeMinPercent,
          pipelineQualityGate: qualityGate,
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
          decision: nrm({
            decision: d,
            tick,
            simulation,
            tradableSpikeMinPercent: config.tradableSpikeMinPercent,
            pipelineQualityGate: qualityGate,
          }),
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
      if (tick.entry.direction !== null) {
        const binBlockSlow = tryBinaryPaperQuoteGateBlock(
          tick.entry.direction,
          false,
          tick.entry.movementClassification
        );
        if (binBlockSlow !== null) return binBlockSlow;
      }
      return {
        decision: nrm({
          tick,
          simulation,
          tradableSpikeMinPercent: config.tradableSpikeMinPercent,
          pipelineQualityGate: qualityGate,
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
      decision: nrm({
        tick,
        simulation,
        tradableSpikeMinPercent: config.tradableSpikeMinPercent,
        pipelineQualityGate: qualityGate,
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
      decision: nrm({
        decision: lifecycleDecision,
        tick,
        simulation,
        tradableSpikeMinPercent: config.tradableSpikeMinPercent,
        pipelineQualityGate: qualityGate,
      }),
      entryForSimulation: tick.entry,
      borderlineLifecycleEvents: renderEvents,
      strongSpikeLifecycleMessages,
    };
  }

  return {
    decision: nrm({
      tick,
      simulation,
      tradableSpikeMinPercent: config.tradableSpikeMinPercent,
      pipelineQualityGate: qualityGate,
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

/**
 * After {@link runStrategyDecisionPipeline}, blocks opening when the Binance feed
 * is stale (no recent WS messages). Does not close positions.
 */
export function applyFeedStaleEntryBlock(
  result: StrategyDecisionPipelineResult,
  input: {
    tick: StrategyTickResult;
    simulation: SimulationEngine;
    config: Pick<
      AppConfig,
      "blockEntriesOnStaleFeed" | "tradableSpikeMinPercent"
    > & { marketMode?: AppConfig["marketMode"] };
    feedStale: boolean;
  }
): StrategyDecisionPipelineResult {
  if (input.tick.kind !== "ready") return result;
  if (!input.config.blockEntriesOnStaleFeed || !input.feedStale) {
    return result;
  }
  const act = result.decision.action;
  if (act !== "enter_immediate" && act !== "promote_borderline_candidate") {
    return result;
  }
  const d = result.decision;
  const mode = input.config.marketMode ?? "binary";
  const staleReason = mode === "binary" ? "quote_feed_stale" : "feed_stale";
  const blocked: StrategyDecision = {
    ...d,
    action: "none",
    direction: null,
    criticalBlockerUsed: mode === "binary" ? "quote_feed_stale" : "feed_stale",
    reason: staleReason,
  };
  return {
    ...result,
    decision: withNormalizedReasons({
      decision: blocked,
      tick: input.tick,
      simulation: input.simulation,
      tradableSpikeMinPercent: input.config.tradableSpikeMinPercent,
    }),
    entryForSimulation: input.tick.entry,
  };
}

/**
 * Legacy name for {@link applyFeedStaleEntryBlock}. Accepts `quoteFeedStale` /
 * `blockEntriesOnStaleQuotes` for older call sites.
 */
export function applyQuoteStaleEntryBlock(
  result: StrategyDecisionPipelineResult,
  input: {
    tick: StrategyTickResult;
    simulation: SimulationEngine;
    config: {
      tradableSpikeMinPercent: number;
      blockEntriesOnStaleFeed?: boolean;
      blockEntriesOnStaleQuotes?: boolean;
      marketMode?: AppConfig["marketMode"];
    };
    feedStale?: boolean;
    quoteFeedStale?: boolean;
  }
): StrategyDecisionPipelineResult {
  const stale = input.feedStale ?? input.quoteFeedStale ?? false;
  const block =
    input.config.blockEntriesOnStaleFeed ??
    input.config.blockEntriesOnStaleQuotes ??
    false;
  return applyFeedStaleEntryBlock(result, {
    tick: input.tick,
    simulation: input.simulation,
    config: {
      tradableSpikeMinPercent: input.config.tradableSpikeMinPercent,
      blockEntriesOnStaleFeed: block,
      marketMode: input.config.marketMode ?? "binary",
    },
    feedStale: stale,
  });
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
  const unstableCtx =
    decision.unstablePreSpikeContextDetected === true
      ? ` | unstableCtx=${decision.unstableContextHandling ?? "?"}`
      : "";
  const qGateExtra =
    decision.qualityGateReasons && decision.qualityGateReasons.length > 0
      ? ` | qgate=${decision.qualityGateReasons.join("+")}`
      : "";
  return `[strategy] action=${decision.action}${id} | dir=${dir} | cls=${decision.movementClassification} | gate=${qGate}/${qProfile}${hardReject}${unstableCtx}${override}${qGateExtra} | spike=${decision.spikeDetected} | fast=${decision.fastPathUsed} | range=${decision.stableRangeQuality}${blocker} | ${decision.reason}${extra}`;
}

