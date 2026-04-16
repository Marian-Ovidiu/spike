import type { EntryEvaluation } from "./entryConditions.js";
import type {
  BorderlineLifecycleRenderEvent,
} from "./strategyDecisionPipeline.js";
import type { PostMoveClassification } from "./borderlineCandidate.js";
import type { StableRangeQuality } from "./stableRangeQuality.js";
import { type MovementClassification, type WindowSpikeSource } from "./strategy.js";
import type {
  PipelineQualityModifier,
  StrategyDecision,
} from "./strategyDecisionPipeline.js";
import { normalizeBorderlineLifecycleRejection } from "./decisionReasonBuilder.js";
import {
  DEFAULT_TRADABLE_SPIKE_MIN_PERCENT,
  evaluatePreEntryQualityGate,
  type QualityGateDiagnostics,
  type QualityProfile,
} from "./preEntryQualityGate.js";

/** Direction of the BTC move on the spike candle (not the entry side). */
export type SpikeDirection = "UP" | "DOWN";

/**
 * Every stored row is a raw spike event (`detectWindowSpike`).
 * `valid` = strategy would enter; `rejected` = spike seen but entry disallowed.
 */
export type OpportunityStatus = "valid" | "rejected";
export type OpportunityType = "strong_spike" | "borderline";
export type OpportunityOutcome =
  | "entered_immediate"
  | "promoted_after_watch"
  | "cancelled"
  | "expired"
  | "rejected";

export type Opportunity = {
  timestamp: number;
  btcPrice: number;
  previousPrice: number;
  currentPrice: number;
  spikeDirection: SpikeDirection | null;
  /** Strongest window-spike relative move as a percent (e.g. 0.42 means 0.42%). */
  spikePercent: number;
  /** Which look-back comparison produced the strongest move. */
  spikeSource: WindowSpikeSource | null;
  /** Reference price that produced the strongest move. */
  spikeReferencePrice: number;
  /** Prior-window relative range (max−min)/min as a percent (chop context). */
  priorRangePercent: number;
  upSidePrice: number;
  downSidePrice: number;
  stableRangeDetected: boolean;
  stableRangeQuality: StableRangeQuality;
  /** Contextual spike (strong vs prior chop). */
  spikeDetected: boolean;
  movementClassification: MovementClassification;
  movementThresholdRatio: number;
  opportunityType: OpportunityType;
  opportunityOutcome: OpportunityOutcome;

  /** Optional enrichments; `thresholdRatio` is populated for all movement types. */
  thresholdRatio?: number;
  watchTicksConfigured?: number;
  watchTicksObserved?: number;
  postMoveClassification?: PostMoveClassification | null;
  promotionReason?: string;
  cancellationReason?: string;
  expirationReason?: string;

  /** Optional linkage to borderline candidate lifecycle. */
  borderlineCandidateId?: string;
  tradableSpikeMinPercent: number;
  qualityProfile: QualityProfile;
  /** Rule-trace from pre-entry gate; use with {@link pipelineQualityModifier}. */
  qualityGateDiagnostics?: QualityGateDiagnostics;
  pipelineQualityModifier?: PipelineQualityModifier;
  cooldownOverridden?: boolean;
  overrideReason?: string | null;
  entryAllowed: boolean;
  /** Same codes as {@link EntryEvaluation.reasons} when rejected. */
  entryRejectionReasons: readonly string[];
  status: OpportunityStatus;
};

export type RecordReadyTickInput = {
  timestamp: number;
  btcPrice: number;
  prices: readonly number[];
  previousPrice: number;
  currentPrice: number;
  sides: { upSidePrice: number; downSidePrice: number };
  entry: EntryEvaluation;
  tradableSpikeMinPercent?: number;
  maxPriorRangeForNormalEntry?: number;
  exceptionalSpikeMinPercent?: number;
  allowWeakQualityEntries?: boolean;
  allowWeakQualityOnlyForStrongSpikes?: boolean;
  decision?: Pick<
    StrategyDecision,
    | "action"
    | "reasons"
    | "qualityProfile"
    | "cooldownOverridden"
    | "overrideReason"
    | "qualityGateDiagnostics"
    | "pipelineQualityModifier"
  >;
};

function priorWindowRelativeRangePercent(
  prices: readonly number[]
): number {
  const priorWindow = prices.slice(0, -1);
  if (priorWindow.length < 2) return 0;
  const max = Math.max(...priorWindow);
  const min = Math.min(...priorWindow);
  if (!(min > 0 && Number.isFinite(min) && Number.isFinite(max))) {
    return 0;
  }
  return ((max - min) / min) * 100;
}

/**
 * Build an {@link Opportunity} for a ready tick when the window spike
 * detector fires (any look-back comparison exceeds threshold).
 * Returns `null` when no window comparison exceeds threshold.
 */
export function buildOpportunityFromReadyTick(
  input: RecordReadyTickInput
): Opportunity | null {
  const {
    timestamp,
    btcPrice,
    prices,
    previousPrice,
    currentPrice,
    sides,
    entry,
    decision,
  } = input;

  const movement = entry.movement;
  if (movement.classification !== "strong_spike") {
    return null;
  }

  const stableRangeDetected = entry.stableRangeDetected ?? false;
  const stableRangeQuality = entry.stableRangeQuality ?? "poor";
  const spikeDetected = entry.spikeDetected;
  const spikePercent = movement.strongestMovePercent * 100;
  const priorRangePercent = entry.priorRangePercent ?? priorWindowRelativeRangePercent(prices);
  const spikeDirection =
    movement.strongestMoveDirection === "UP"
      ? "UP"
      : movement.strongestMoveDirection === "DOWN"
        ? "DOWN"
        : null;
  const entryAllowed =
    decision !== undefined ? decision.action === "enter_immediate" : entry.shouldEnter;
  const entryRejectionReasons =
    entryAllowed ? [] : [...(decision?.reasons ?? entry.reasons)];
  const tradableSpikeMinPercent = Number.isFinite(input.tradableSpikeMinPercent)
    ? Math.max(0, input.tradableSpikeMinPercent ?? DEFAULT_TRADABLE_SPIKE_MIN_PERCENT)
    : DEFAULT_TRADABLE_SPIKE_MIN_PERCENT;
  const qualityGateOptions = {
    tradableSpikeMinPercent,
    ...(input.maxPriorRangeForNormalEntry !== undefined
      ? { maxPriorRangeForNormalEntry: input.maxPriorRangeForNormalEntry }
      : {}),
    ...(input.exceptionalSpikeMinPercent !== undefined
      ? { exceptionalSpikeMinPercent: input.exceptionalSpikeMinPercent }
      : {}),
    ...(input.allowWeakQualityEntries !== undefined
      ? { allowWeakQualityEntries: input.allowWeakQualityEntries }
      : {}),
    ...(input.allowWeakQualityOnlyForStrongSpikes !== undefined
      ? {
          allowWeakQualityOnlyForStrongSpikes:
            input.allowWeakQualityOnlyForStrongSpikes,
        }
      : {}),
  };
  const gateEval = evaluatePreEntryQualityGate(entry, qualityGateOptions);
  const qualityProfile =
    decision?.qualityProfile ?? gateEval.qualityProfile;
  const qualityGateDiagnostics =
    decision?.qualityGateDiagnostics ?? gateEval.diagnostics;
  const pipelineQualityModifier = decision?.pipelineQualityModifier;

  return {
    timestamp,
    btcPrice,
    previousPrice,
    currentPrice,
    spikeDirection,
    spikePercent,
    spikeSource: movement.sourceWindowLabel as WindowSpikeSource | null,
    spikeReferencePrice:
      movement.strongestMoveDirection === null
        ? currentPrice
        : movement.strongestMoveDirection === "UP"
          ? currentPrice - movement.strongestMoveAbsolute
          : currentPrice + movement.strongestMoveAbsolute,
    priorRangePercent,
    upSidePrice: sides.upSidePrice,
    downSidePrice: sides.downSidePrice,
    stableRangeDetected,
    stableRangeQuality,
    spikeDetected,
    movementClassification: movement.classification,
    movementThresholdRatio: movement.thresholdRatio,
    thresholdRatio: movement.thresholdRatio,
    opportunityType: "strong_spike",
    opportunityOutcome: entryAllowed ? "entered_immediate" : "rejected",
    tradableSpikeMinPercent,
    qualityProfile,
    qualityGateDiagnostics,
    ...(pipelineQualityModifier !== undefined
      ? { pipelineQualityModifier }
      : {}),
    cooldownOverridden: decision?.cooldownOverridden ?? false,
    overrideReason: decision?.overrideReason ?? null,
    entryAllowed,
    entryRejectionReasons,
    status: entryAllowed ? "valid" : "rejected",
  };
}

const DEFAULT_MAX_STORED = 10_000;

export class OpportunityTracker {
  private readonly maxStored: number;
  private readonly opportunities: Opportunity[] = [];

  constructor(options?: { maxStored?: number }) {
    const m = options?.maxStored;
    this.maxStored =
      m !== undefined && Number.isFinite(m) && m > 0
        ? Math.trunc(m)
        : DEFAULT_MAX_STORED;
  }

  /**
   * If the tick is a raw spike, append an {@link Opportunity} and return it.
   * Otherwise return `null`.
   */
  recordFromReadyTick(input: RecordReadyTickInput): Opportunity | null {
    const o = buildOpportunityFromReadyTick(input);
    if (!o) return null;
    this.opportunities.push(o);
    if (this.opportunities.length > this.maxStored) {
      const drop = this.opportunities.length - this.maxStored;
      this.opportunities.splice(0, drop);
    }
    return o;
  }

  /** In-memory history (oldest → newest, capped by `maxStored`). */
  getOpportunities(): readonly Opportunity[] {
    return this.opportunities;
  }

  get counts(): { rawSpikeEvents: number; valid: number; rejected: number } {
    let valid = 0;
    let rejected = 0;
    for (const o of this.opportunities) {
      if (o.status === "valid") valid += 1;
      else rejected += 1;
    }
    return {
      rawSpikeEvents: this.opportunities.length,
      valid,
      rejected,
    };
  }

  /**
   * Append a first-class opportunity row for borderline lifecycle events.
   * This keeps borderline detections and outcomes in the same monitored dataset.
   */
  recordBorderlineLifecycleEvent(input: {
    timestamp: number;
    event: BorderlineLifecycleRenderEvent;
    tradableSpikeMinPercent?: number;
    maxPriorRangeForNormalEntry?: number;
  }): Opportunity {
    const e = input.event;
    const derivedOutcome: OpportunityOutcome =
      e.type === "created"
        ? "rejected"
        : e.type === "promoted"
          ? "promoted_after_watch"
          : e.type === "cancelled"
            ? "cancelled"
            : e.type === "expired"
              ? "expired"
              : "rejected";
    const moveDir = e.moveDirection;
    const spikeDirection = moveDir === null ? null : moveDir;

    const tradableSpikeMinPercent = Number.isFinite(input.tradableSpikeMinPercent)
      ? Math.max(0, input.tradableSpikeMinPercent ?? DEFAULT_TRADABLE_SPIKE_MIN_PERCENT)
      : DEFAULT_TRADABLE_SPIKE_MIN_PERCENT;
    const o: Opportunity = {
      timestamp: input.timestamp,
      btcPrice: e.currentBtcPrice ?? 0,
      previousPrice: e.currentBtcPrice ?? 0,
      currentPrice: e.currentBtcPrice ?? 0,
      spikeDirection,
      spikePercent: e.movePercent,
      spikeSource: e.sourceWindowLabel as
        | "tick-1"
        | "tick-2"
        | "tick-3"
        | "window-oldest"
        | null,
      spikeReferencePrice: e.currentBtcPrice ?? 0,
      priorRangePercent: 0,
      upSidePrice: e.yesPrice ?? Number.NaN,
      downSidePrice: e.noPrice ?? Number.NaN,
      stableRangeDetected: true,
      stableRangeQuality: "good",
      spikeDetected: false,
      movementClassification: "borderline",
      movementThresholdRatio: e.thresholdRatio,
      opportunityType: "borderline",
      opportunityOutcome: derivedOutcome,
      thresholdRatio: e.thresholdRatio,
      watchTicksConfigured: e.watchTicksConfigured,
      watchTicksObserved: e.watchTicksObserved,
      postMoveClassification: e.postMoveClassification ?? null,
      tradableSpikeMinPercent,
      qualityProfile: derivedOutcome === "promoted_after_watch" ? "acceptable" : "weak",
      cooldownOverridden: false,
      overrideReason: null,
      entryAllowed: derivedOutcome === "promoted_after_watch",
      entryRejectionReasons:
        derivedOutcome === "promoted_after_watch"
          ? []
          : normalizeBorderlineLifecycleRejection({
              type: e.type === "promoted" ? "watch" : e.type,
              reason: e.reason,
            }),
      status: derivedOutcome === "promoted_after_watch" ? "valid" : "rejected",
    };
    if (derivedOutcome === "promoted_after_watch") {
      o.promotionReason = e.reason;
    }
    if (derivedOutcome === "cancelled") {
      o.cancellationReason = e.reason;
    }
    if (derivedOutcome === "expired") {
      o.expirationReason = e.reason;
    }
    o.borderlineCandidateId = e.candidateId;

    this.opportunities.push(o);
    if (this.opportunities.length > this.maxStored) {
      const drop = this.opportunities.length - this.maxStored;
      this.opportunities.splice(0, drop);
    }
    return o;
  }
}
