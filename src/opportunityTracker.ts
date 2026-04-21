import type { EntryDirection, EntryEvaluation } from "./entryConditions.js";
import type { BinaryOutcomePrices } from "./market/types.js";
import type { BorderlineLifecyclePersistedRenderEvent } from "./strategy/strategyDecisionPipeline.js";
import type { PostMoveClassification } from "./borderlineCandidate.js";
import type { StableRangeQuality } from "./stableRangeQuality.js";
import { type MovementClassification, type WindowSpikeSource } from "./strategy.js";
import type {
  PipelineQualityModifier,
  StrategyDecision,
} from "./strategy/strategyDecisionPipeline.js";
import {
  normalizeBorderlineLifecycleRejection,
  pickPrimaryRejectionBlocker,
  type NormalizedRejectionReason,
} from "./decisionReasonBuilder.js";
import {
  DEFAULT_TRADABLE_SPIKE_MIN_PERCENT,
  evaluatePreEntryQualityGate,
  type QualityGateDiagnostics,
  type QualityProfile,
} from "./preEntryQualityGate.js";
import {
  buildInvalidMarketPricesAuditRecord,
  logInvalidMarketPricesBinaryAudit,
  shouldAttachInvalidMarketPricesAudit,
  type InvalidMarketPricesAuditRecord,
} from "./binary/monitor/invalidMarketPricesAudit.js";

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

function entryOutcomeSideFromDirection(
  dir: EntryDirection | null
): "YES" | "NO" | null {
  if (dir === "UP") return "YES";
  if (dir === "DOWN") return "NO";
  return null;
}

export type Opportunity = {
  timestamp: number;
  /** BTC signal mid at decision time (rolling-buffer / spike layer); not venue YES/NO. */
  btcPrice: number;
  /** Binary: duplicate of `btcPrice` when both populated (signal = BTC spot). */
  underlyingSignalPrice?: number;
  previousPrice: number;
  currentPrice: number;
  spikeDirection: SpikeDirection | null;
  /** Strongest window-spike relative move as a percent (e.g. 0.42 means 0.42%). */
  spikePercent: number;
  /** Which look-back comparison produced the strongest move. */
  spikeSource: WindowSpikeSource | null;
  /** Reference price that produced the strongest move. */
  spikeReferencePrice: number;
  /** Prior-window relative range (max−min)/min as a fraction (chop context). */
  priorRangeFraction: number;
  /** Execution venue executable book (binary venue bid/ask; not BTC signal). */
  bestBid: number;
  bestAsk: number;
  midPrice: number;
  spreadBps: number;
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
  /**
   * Highest-priority normalized blocker among {@link entryRejectionReasons}
   * (see {@link pickPrimaryRejectionBlocker}); `null` when {@link entryAllowed}.
   */
  entryRejectionPrimaryBlocker: NormalizedRejectionReason | null;
  status: OpportunityStatus;
  /** Session universe; omitted on legacy rows (treated as spot). */
  marketMode?: "spot" | "binary";
  /** Binary: YES mid at tick. */
  yesPrice?: number;
  /** Binary: NO mid at tick. */
  noPrice?: number;
  binaryQuoteAgeMs?: number | null;
  binaryQuoteStale?: boolean;
  binaryMarketId?: string;
  binarySlug?: string;
  binaryQuestion?: string;
  binaryConditionId?: string | null;
  /** Outcome token that would be bought for this strategy direction (UP→YES, DOWN→NO). */
  entryOutcomeSide?: "YES" | "NO" | null;
  /** Binary: model P(up) at this observation (calibration). */
  estimatedProbabilityUp?: number;
  /** Binary: horizon used with realized BTC path for calibration labels. */
  probabilityTimeHorizonMs?: number;
  /**
   * Binary: structured audit when {@link entryRejectionReasons} includes
   * `invalid_market_prices` (spread / book / leg diagnostics).
   */
  invalidMarketPricesAudit?: InvalidMarketPricesAuditRecord;
};

export type RecordReadyTickInput = {
  timestamp: number;
  btcPrice: number;
  /** Binary: explicit BTC signal price (defaults to `btcPrice` if omitted). */
  underlyingSignalPrice?: number;
  prices: readonly number[];
  previousPrice: number;
  currentPrice: number;
  /** Executable venue top-of-book (binary venue bid/ask; not the BTC signal series). */
  executionBook: {
    bestBid: number;
    bestAsk: number;
    midPrice: number;
    spreadBps: number;
  };
  entry: EntryEvaluation;
  tradableSpikeMinPercent?: number;
  maxPriorRangeForNormalEntry?: number;
  exceptionalSpikeMinPercent?: number;
  allowWeakQualityEntries?: boolean;
  allowWeakQualityOnlyForStrongSpikes?: boolean;
  allowAcceptableQualityStrongSpikes?: boolean;
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
  marketMode?: "spot" | "binary";
  binaryOutcomes?: BinaryOutcomePrices | null;
  binaryQuoteMeta?: {
    quoteAgeMs: number | null;
    quoteStale: boolean;
    marketId?: string;
    slug?: string;
    question?: string;
    conditionId?: string | null;
  };
  estimatedProbabilityUp?: number;
  probabilityTimeHorizonMs?: number;
  /** Required for binary `invalid_market_prices` audit / subreason on opportunity rows. */
  maxEntrySpreadBps?: number;
  binaryPaperSlippageBps?: number;
};

function priorWindowRelativeRangeFraction(
  prices: readonly number[]
): number {
  const priorWindow = prices.slice(0, -1);
  if (priorWindow.length < 2) return 0;
  const max = Math.max(...priorWindow);
  const min = Math.min(...priorWindow);
  if (!(min > 0 && Number.isFinite(min) && Number.isFinite(max))) {
    return 0;
  }
  return (max - min) / min;
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
    underlyingSignalPrice: underlyingSignalPriceInput,
    prices,
    previousPrice,
    currentPrice,
    executionBook,
    entry,
    decision,
    marketMode,
    binaryOutcomes,
    binaryQuoteMeta,
    estimatedProbabilityUp: pUpInput,
    probabilityTimeHorizonMs: horizonInput,
  } = input;

  const underlyingSignalPrice =
    underlyingSignalPriceInput !== undefined &&
    Number.isFinite(underlyingSignalPriceInput)
      ? underlyingSignalPriceInput
      : btcPrice;

  const movement = entry.movement;
  if (movement.classification !== "strong_spike") {
    return null;
  }

  const stableRangeDetected = entry.stableRangeDetected ?? false;
  const stableRangeQuality = entry.stableRangeQuality ?? "poor";
  const spikeDetected = entry.spikeDetected;
  const spikePercent = movement.strongestMovePercent * 100;
  const priorRangeFraction =
    entry.priorRangeFraction ?? priorWindowRelativeRangeFraction(prices);
  const spikeDirection =
    movement.strongestMoveDirection === "UP"
      ? "UP"
      : movement.strongestMoveDirection === "DOWN"
        ? "DOWN"
        : null;
  const entryAllowed =
    decision !== undefined
      ? decision.action === "enter_immediate" ||
        decision.action === "promote_borderline_candidate"
      : entry.shouldEnter;
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
    ...(input.allowAcceptableQualityStrongSpikes !== undefined
      ? {
          allowAcceptableQualityStrongSpikes:
            input.allowAcceptableQualityStrongSpikes,
        }
      : {}),
  };
  const gateEval = evaluatePreEntryQualityGate(entry, qualityGateOptions);
  const qualityProfile =
    decision?.qualityProfile ?? gateEval.qualityProfile;
  const qualityGateDiagnostics =
    decision?.qualityGateDiagnostics ?? gateEval.diagnostics;
  const pipelineQualityModifier = decision?.pipelineQualityModifier;

  const bo =
    marketMode === "binary" &&
    binaryOutcomes !== null &&
    binaryOutcomes !== undefined &&
    Number.isFinite(binaryOutcomes.yesPrice) &&
    Number.isFinite(binaryOutcomes.noPrice)
      ? binaryOutcomes
      : null;

  return {
    timestamp,
    btcPrice: underlyingSignalPrice,
    ...(marketMode === "binary"
      ? { underlyingSignalPrice }
      : {}),
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
    priorRangeFraction,
    bestBid: executionBook.bestBid,
    bestAsk: executionBook.bestAsk,
    midPrice: executionBook.midPrice,
    spreadBps: executionBook.spreadBps,
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
    entryRejectionPrimaryBlocker: entryAllowed
      ? null
      : pickPrimaryRejectionBlocker(entryRejectionReasons as NormalizedRejectionReason[]),
    status: entryAllowed ? "valid" : "rejected",
    ...(marketMode === "binary"
      ? {
          marketMode: "binary" as const,
          entryOutcomeSide: entryOutcomeSideFromDirection(entry.direction),
          ...(bo !== null
            ? { yesPrice: bo.yesPrice, noPrice: bo.noPrice }
            : {}),
          ...(binaryQuoteMeta !== undefined
            ? {
                binaryQuoteAgeMs: binaryQuoteMeta.quoteAgeMs,
                binaryQuoteStale: binaryQuoteMeta.quoteStale,
                ...(binaryQuoteMeta.marketId !== undefined
                  ? { binaryMarketId: binaryQuoteMeta.marketId }
                  : {}),
                ...(binaryQuoteMeta.slug !== undefined
                  ? { binarySlug: binaryQuoteMeta.slug }
                  : {}),
                ...(binaryQuoteMeta.question !== undefined
                  ? { binaryQuestion: binaryQuoteMeta.question }
                  : {}),
                ...(binaryQuoteMeta.conditionId !== undefined
                  ? { binaryConditionId: binaryQuoteMeta.conditionId }
                  : {}),
              }
            : {}),
          ...(pUpInput !== undefined && Number.isFinite(pUpInput)
            ? { estimatedProbabilityUp: pUpInput }
            : {}),
          ...(horizonInput !== undefined && Number.isFinite(horizonInput)
            ? { probabilityTimeHorizonMs: Math.trunc(horizonInput) }
            : {}),
          ...(shouldAttachInvalidMarketPricesAudit({
            marketMode: "binary",
            entryRejectionReasons,
          })
            ? {
                invalidMarketPricesAudit: buildInvalidMarketPricesAuditRecord({
                  context: "strong_spike_opportunity_row",
                  book: executionBook,
                  maxEntrySpreadBps: input.maxEntrySpreadBps ?? 50,
                  binaryPaperSlippageBps: input.binaryPaperSlippageBps ?? 3,
                  yesMid: bo?.yesPrice,
                  noMid: bo?.noPrice,
                  direction: entry.direction,
                  estimatedProbabilityUp: pUpInput,
                }),
              }
            : {}),
        }
      : {}),
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
    if (o.invalidMarketPricesAudit !== undefined) {
      logInvalidMarketPricesBinaryAudit(o.invalidMarketPricesAudit);
    }
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
    event: BorderlineLifecyclePersistedRenderEvent;
    tradableSpikeMinPercent?: number;
    maxPriorRangeForNormalEntry?: number;
    marketMode?: "spot" | "binary";
    binaryOutcomes?: BinaryOutcomePrices | null;
    binaryQuoteMeta?: {
      quoteAgeMs: number | null;
      quoteStale: boolean;
      marketId?: string;
      slug?: string;
      question?: string;
      conditionId?: string | null;
    };
    estimatedProbabilityUp?: number;
    probabilityTimeHorizonMs?: number;
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
    const bo =
      input.marketMode === "binary" &&
      input.binaryOutcomes !== null &&
      input.binaryOutcomes !== undefined &&
      Number.isFinite(input.binaryOutcomes.yesPrice) &&
      Number.isFinite(input.binaryOutcomes.noPrice)
        ? input.binaryOutcomes
        : null;
    const contrarian = e.suggestedContrarianDirection ?? null;

    const u = e.currentBtcPrice ?? 0;
    const entryRejectionReasonsBorderline =
      derivedOutcome === "promoted_after_watch"
        ? []
        : normalizeBorderlineLifecycleRejection({
            type: e.type === "promoted" ? "watch" : e.type,
            reason: e.reason,
          });
    const o: Opportunity = {
      timestamp: input.timestamp,
      btcPrice: u,
      ...(input.marketMode === "binary" ? { underlyingSignalPrice: u } : {}),
      previousPrice: u,
      currentPrice: u,
      spikeDirection,
      spikePercent: e.movePercent,
      spikeSource: e.sourceWindowLabel as
        | "tick-1"
        | "tick-2"
        | "tick-3"
        | "window-oldest"
        | null,
      spikeReferencePrice: e.currentBtcPrice ?? 0,
      priorRangeFraction: 0,
      bestBid: e.bestBid ?? Number.NaN,
      bestAsk: e.bestAsk ?? Number.NaN,
      midPrice: e.midPrice ?? Number.NaN,
      spreadBps: e.spreadBps ?? Number.NaN,
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
      entryRejectionReasons: entryRejectionReasonsBorderline,
      entryRejectionPrimaryBlocker:
        derivedOutcome === "promoted_after_watch"
          ? null
          : pickPrimaryRejectionBlocker(
              entryRejectionReasonsBorderline as NormalizedRejectionReason[]
            ),
      status: derivedOutcome === "promoted_after_watch" ? "valid" : "rejected",
      ...(input.marketMode === "binary"
        ? {
            marketMode: "binary" as const,
            entryOutcomeSide: entryOutcomeSideFromDirection(contrarian),
            ...(bo !== null ? { yesPrice: bo.yesPrice, noPrice: bo.noPrice } : {}),
            ...(input.binaryQuoteMeta !== undefined
              ? {
                  binaryQuoteAgeMs: input.binaryQuoteMeta.quoteAgeMs,
                  binaryQuoteStale: input.binaryQuoteMeta.quoteStale,
                  ...(input.binaryQuoteMeta.marketId !== undefined
                    ? { binaryMarketId: input.binaryQuoteMeta.marketId }
                    : {}),
                  ...(input.binaryQuoteMeta.slug !== undefined
                    ? { binarySlug: input.binaryQuoteMeta.slug }
                    : {}),
                  ...(input.binaryQuoteMeta.question !== undefined
                    ? { binaryQuestion: input.binaryQuoteMeta.question }
                    : {}),
                  ...(input.binaryQuoteMeta.conditionId !== undefined
                    ? { binaryConditionId: input.binaryQuoteMeta.conditionId }
                    : {}),
                }
              : {}),
          ...(input.estimatedProbabilityUp !== undefined &&
          Number.isFinite(input.estimatedProbabilityUp)
            ? { estimatedProbabilityUp: input.estimatedProbabilityUp }
            : {}),
          ...(input.probabilityTimeHorizonMs !== undefined &&
          Number.isFinite(input.probabilityTimeHorizonMs)
            ? {
                probabilityTimeHorizonMs: Math.trunc(
                  input.probabilityTimeHorizonMs
                ),
              }
            : {}),
          }
        : {}),
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
