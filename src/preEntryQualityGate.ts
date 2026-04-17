import type { EntryEvaluation } from "./entryConditions.js";

type InternalOpts = {
  tradableSpikeMinPercent: number;
  exceptionalSpikeMinPercent: number;
  maxPriorRangeForNormalEntry: number;
};

export type QualityProfile = "weak" | "acceptable" | "strong" | "exceptional";

export const DEFAULT_TRADABLE_SPIKE_MIN_PERCENT = 0.0015;
export const DEFAULT_MAX_PRIOR_RANGE_FOR_NORMAL_ENTRY = 0.0015;
const DEFAULT_EXCEPTIONAL_SPIKE_MIN_PERCENT = 0.0025;

/** Added to {@link PreEntryQualityGateResult.qualityGateReasons} when opt-in allows acceptable-profile strong spikes. */
export const ACCEPTABLE_QUALITY_STRONG_SPIKE_GATE_REASON =
  "acceptable_quality_strong_spike_allowed_by_config";

/** Structured trace for diagnostics; classification is rule-based (no numeric score). */
export type QualityGateRuleCheck = {
  ruleId: string;
  passed: boolean;
  detail?: string;
};

export type QualityGateDowngradeStep = {
  step: string;
  profileBefore: QualityProfile;
  profileAfter: QualityProfile;
  reasonCode: string;
};

export type QualityGateDiagnostics = {
  classification: "rule_based";
  effectiveThresholds: {
    tradableSpikeMinPercent: number;
    exceptionalSpikeMinPercent: number;
    maxPriorRangeForNormalEntry: number;
  };
  inputs: {
    movementClassification: EntryEvaluation["movementClassification"];
    strongestMovePercent: number;
    /** Same unit as opportunity `spikePercent` (percent points, e.g. 0.18 = 0.18%). */
    spikePercent: number;
    thresholdRatio: number;
    /** Prior-window (max−min)/min as a fraction; compare to maxPriorRangeForNormalEntry. */
    priorRangeFraction: number;
    stableRangeDetected: boolean;
    stableRangeQuality: EntryEvaluation["stableRangeQuality"];
    entryReasonCodes: readonly string[];
  };
  /** Profile from spike size tier only (before range / context / prior-range downgrades). */
  profileAfterSpikeSizeTier: QualityProfile;
  ruleChecks: QualityGateRuleCheck[];
  downgradeChain: QualityGateDowngradeStep[];
  finalProfile: QualityProfile;
  qualityGatePassed: boolean;
  /** Why the profile landed on `weak` (empty if not weak). */
  weakPrimaryReasons: string[];
  /** Present when weak-bypass options were evaluated. */
  weakQualityPolicy?: {
    allowWeakQualityEntries: boolean;
    allowWeakQualityOnlyForStrongSpikes: boolean;
    priorOrNoiseBlocksWeakBypass: boolean;
  };
  /** Opt-in pass for `acceptable` capped profile on `strong_spike` only. */
  acceptableStrongSpikePolicy?: {
    allowAcceptableQualityStrongSpikes: boolean;
    overrideApplied: boolean;
  };
  /** Set when pipeline merges unstable-context soft handling into this snapshot. */
  unstableContextHandling?: "none" | "hard_reject" | "soft_deferred";
  unstablePreSpikeContextMetrics?: {
    stableRangeDetected: boolean;
    priorRangeFraction: number;
    threshold: number;
  };
};

export type PreEntryQualityGateResult = {
  qualityGatePassed: boolean;
  qualityGateReasons: string[];
  qualityProfile: QualityProfile;
  diagnostics: QualityGateDiagnostics;
};

const QUALITY_RANK: Record<QualityProfile, number> = {
  weak: 0,
  acceptable: 1,
  strong: 2,
  exceptional: 3,
};

function downgradeProfile(
  profile: QualityProfile,
  toAtMost: QualityProfile
): QualityProfile {
  return QUALITY_RANK[profile] > QUALITY_RANK[toAtMost] ? toAtMost : profile;
}

/**
 * Explicit pre-entry quality gate used by the decision pipeline.
 * It separates movement detection from opportunity qualification.
 */
export function evaluatePreEntryQualityGate(
  entry: EntryEvaluation,
  options?: {
    tradableSpikeMinPercent?: number;
    exceptionalSpikeMinPercent?: number;
    maxPriorRangeForNormalEntry?: number;
    /** When true, `weak` profile may pass if other policy rules allow (testing). */
    allowWeakQualityEntries?: boolean;
    /**
     * When true (default), weak bypass applies only to `strong_spike` classification.
     * When false, `borderline` with weak profile may also pass (still subject to prior/noise blocks).
     */
    allowWeakQualityOnlyForStrongSpikes?: boolean;
    /**
     * When true, `strong_spike` with capped profile `acceptable` may pass the gate (experimental).
     */
    allowAcceptableQualityStrongSpikes?: boolean;
  }
): PreEntryQualityGateResult {
  const reasons: string[] = [];
  const tradableSpikeMinPercent = Number.isFinite(options?.tradableSpikeMinPercent)
    ? Math.max(0, options?.tradableSpikeMinPercent ?? DEFAULT_TRADABLE_SPIKE_MIN_PERCENT)
    : DEFAULT_TRADABLE_SPIKE_MIN_PERCENT;
  const exceptionalSpikeMinPercent = Number.isFinite(
    options?.exceptionalSpikeMinPercent
  )
    ? Math.max(
        tradableSpikeMinPercent,
        options?.exceptionalSpikeMinPercent ?? DEFAULT_EXCEPTIONAL_SPIKE_MIN_PERCENT
      )
    : Math.max(tradableSpikeMinPercent, DEFAULT_EXCEPTIONAL_SPIKE_MIN_PERCENT);
  const maxPriorRangeForNormalEntry = Number.isFinite(
    options?.maxPriorRangeForNormalEntry
  )
    ? Math.max(
        0,
        options?.maxPriorRangeForNormalEntry ??
          DEFAULT_MAX_PRIOR_RANGE_FOR_NORMAL_ENTRY
      )
    : DEFAULT_MAX_PRIOR_RANGE_FOR_NORMAL_ENTRY;

  const thresholds: InternalOpts = {
    tradableSpikeMinPercent,
    exceptionalSpikeMinPercent,
    maxPriorRangeForNormalEntry,
  };

  const strongestMovePercent = entry.movement.strongestMovePercent;
  const thresholdRatio = entry.movement.thresholdRatio;
  const spikePercent = strongestMovePercent * 100;

  const ruleChecks: QualityGateRuleCheck[] = [];
  const downgradeChain: QualityGateDowngradeStep[] = [];

  let profile: QualityProfile = "weak";
  if (entry.movementClassification === "strong_spike") {
    ruleChecks.push({
      ruleId: "movement_class_strong_spike",
      passed: true,
      detail: "classification is strong_spike",
    });
    if (strongestMovePercent >= exceptionalSpikeMinPercent) {
      profile = "exceptional";
      ruleChecks.push({
        ruleId: "spike_size_tier",
        passed: true,
        detail: `strongestMovePercent ${strongestMovePercent} >= exceptionalMin ${exceptionalSpikeMinPercent} → exceptional`,
      });
    } else if (strongestMovePercent >= tradableSpikeMinPercent) {
      profile = "strong";
      ruleChecks.push({
        ruleId: "spike_size_tier",
        passed: true,
        detail: `strongestMovePercent ${strongestMovePercent} >= tradableMin ${tradableSpikeMinPercent} → strong`,
      });
    } else {
      profile = "weak";
      ruleChecks.push({
        ruleId: "spike_size_tier",
        passed: false,
        detail: `strongestMovePercent ${strongestMovePercent} < tradableMin ${tradableSpikeMinPercent} → weak`,
      });
    }
  } else if (entry.movementClassification === "borderline") {
    ruleChecks.push({
      ruleId: "movement_class_borderline",
      passed: true,
      detail: "classification is borderline",
    });
    profile =
      strongestMovePercent >= tradableSpikeMinPercent ? "acceptable" : "weak";
    ruleChecks.push({
      ruleId: "spike_size_tier_borderline",
      passed: strongestMovePercent >= tradableSpikeMinPercent,
      detail:
        strongestMovePercent >= tradableSpikeMinPercent
          ? `>= tradableMin ${tradableSpikeMinPercent} → acceptable`
          : `< tradableMin → weak`,
    });
  } else {
    ruleChecks.push({
      ruleId: "movement_class_signal",
      passed: false,
      detail: `classification is ${entry.movementClassification}`,
    });
  }

  const profileAfterSpikeSizeTier: QualityProfile = profile;

  if (entry.movementClassification === "no_signal") {
    reasons.push("movement_below_borderline_threshold");
  } else if (entry.movementClassification === "borderline") {
    reasons.push("borderline_move_requires_confirmation");
  } else if (strongestMovePercent < tradableSpikeMinPercent) {
    reasons.push("spike_below_tradable_min_percent");
  } else if (thresholdRatio < 1.2) {
    reasons.push("spike_strength_only_minimal");
  } else if (profile === "exceptional") {
    reasons.push("exceptional_spike_strength");
  }

  ruleChecks.push({
    ruleId: "threshold_ratio_informative",
    passed: thresholdRatio >= 1.2,
    detail: `thresholdRatio=${thresholdRatio} (informative; <1.2 adds note spike_strength_only_minimal when spike is tradable+)`,
  });

  if (entry.stableRangeQuality === "poor") {
    const canOverridePoorRange = profile === "exceptional";
    ruleChecks.push({
      ruleId: "pre_spike_stable_range_quality",
      passed: canOverridePoorRange,
      detail: `stableRangeQuality=poor; override only if profile===exceptional (currently ${profile})`,
    });
    if (canOverridePoorRange) {
      reasons.push("poor_range_overridden_by_exceptional_spike");
    } else {
      const before = profile;
      profile = downgradeProfile(profile, "weak");
      if (before !== profile) {
        downgradeChain.push({
          step: "poor_pre_spike_range",
          profileBefore: before,
          profileAfter: profile,
          reasonCode: "pre_spike_range_poor_quality",
        });
      }
      reasons.push("pre_spike_range_poor_quality");
    }
  } else if (entry.stableRangeQuality === "acceptable") {
    ruleChecks.push({
      ruleId: "pre_spike_stable_range_quality",
      passed: true,
      detail: "acceptable → cap profile at acceptable",
    });
    const before = profile;
    profile = downgradeProfile(profile, "acceptable");
    if (before !== profile) {
      downgradeChain.push({
        step: "acceptable_pre_spike_range",
        profileBefore: before,
        profileAfter: profile,
        reasonCode: "pre_spike_range_only_acceptable",
      });
    }
    reasons.push("pre_spike_range_only_acceptable");
  } else {
    ruleChecks.push({
      ruleId: "pre_spike_stable_range_quality",
      passed: true,
      detail: "good → no downgrade from range quality",
    });
    reasons.push("pre_spike_range_good_quality");
  }

  const noisyContext = entry.reasons.includes("range_too_noisy_for_entry");
  const unstableContext = entry.reasons.includes("market_not_stable");
  const weakSpikeContext = entry.reasons.includes("spike_not_strong_enough");

  ruleChecks.push({
    ruleId: "context_noisy_or_unstable",
    passed: !(noisyContext || unstableContext) || profile === "exceptional",
    detail: `range_too_noisy=${noisyContext} market_not_stable=${unstableContext}`,
  });

  if (noisyContext || unstableContext) {
    const canOverrideNoise = profile === "exceptional";
    if (canOverrideNoise) {
      reasons.push("trend_noise_rejection_overridden_by_exceptional_spike");
    } else {
      const before = profile;
      profile = downgradeProfile(profile, "weak");
      if (before !== profile) {
        downgradeChain.push({
          step: "trend_noise_unstable_context",
          profileBefore: before,
          profileAfter: profile,
          reasonCode: "trend_noise_rejection",
        });
      }
      reasons.push("trend_noise_rejection");
    }
  }
  if (weakSpikeContext && entry.movementClassification !== "strong_spike") {
    ruleChecks.push({
      ruleId: "weak_spike_context_non_strong_class",
      passed: false,
      detail: "spike_not_strong_enough in reasons and class≠strong_spike",
    });
    const before = profile;
    profile = downgradeProfile(profile, "weak");
    if (before !== profile) {
      downgradeChain.push({
        step: "weak_spike_context",
        profileBefore: before,
        profileAfter: profile,
        reasonCode: "spike_size_insufficient_for_quality_gate",
      });
    }
    reasons.push("spike_size_insufficient_for_quality_gate");
  } else {
    ruleChecks.push({
      ruleId: "weak_spike_context_non_strong_class",
      passed: true,
      detail: "N/A (strong_spike or no spike_not_strong_enough)",
    });
  }

  ruleChecks.push({
    ruleId: "prior_range_vs_max_for_normal_entry",
    passed: entry.priorRangeFraction <= maxPriorRangeForNormalEntry,
    detail: `priorRangeFraction=${entry.priorRangeFraction} max=${maxPriorRangeForNormalEntry}`,
  });

  if (entry.priorRangeFraction > maxPriorRangeForNormalEntry) {
    const before = profile;
    profile = downgradeProfile(profile, "weak");
    if (before !== profile) {
      downgradeChain.push({
        step: "prior_range_too_wide",
        profileBefore: before,
        profileAfter: profile,
        reasonCode: "prior_range_too_wide_for_mean_reversion",
      });
    }
    reasons.push("prior_range_too_wide_for_mean_reversion");
  }

  const weakBypassDisqualified =
    reasons.includes("prior_range_too_wide_for_mean_reversion") ||
    reasons.includes("trend_noise_rejection");

  let qualityGatePassed = profile === "strong" || profile === "exceptional";
  const allowAcceptableStrong =
    options?.allowAcceptableQualityStrongSpikes === true;
  const acceptableStrongSpikeCase =
    profile === "acceptable" && entry.movementClassification === "strong_spike";

  if (
    !qualityGatePassed &&
    allowAcceptableStrong &&
    acceptableStrongSpikeCase
  ) {
    qualityGatePassed = true;
    reasons.push(ACCEPTABLE_QUALITY_STRONG_SPIKE_GATE_REASON);
  }

  ruleChecks.push({
    ruleId: "acceptable_quality_strong_spike_policy",
    passed: !acceptableStrongSpikeCase || qualityGatePassed,
    detail: `allowAcceptableStrong=${allowAcceptableStrong} profile=${profile} movementClass=${entry.movementClassification} finalPass=${qualityGatePassed}`,
  });

  const allowWeakOpt = options?.allowWeakQualityEntries === true;
  const onlyStrongOpt = options?.allowWeakQualityOnlyForStrongSpikes !== false;

  if (!qualityGatePassed && profile === "weak") {
    if (allowWeakOpt && !weakBypassDisqualified) {
      if (onlyStrongOpt) {
        if (entry.movementClassification === "strong_spike") {
          qualityGatePassed = true;
          reasons.push("weak_quality_entry_allowed_by_config");
        } else {
          reasons.push("weak_quality_borderline_blocked_by_config");
        }
      } else if (
        entry.movementClassification === "strong_spike" ||
        entry.movementClassification === "borderline"
      ) {
        qualityGatePassed = true;
        reasons.push("weak_quality_entry_allowed_by_config");
      } else {
        reasons.push("weak_quality_no_signal_blocked_by_config");
      }
    } else if (!allowWeakOpt) {
      reasons.push("weak_quality_entries_disabled_by_config");
    } else if (allowWeakOpt && weakBypassDisqualified) {
      reasons.push("weak_quality_blocked_prior_or_unstable_context");
    }
  }

  ruleChecks.push({
    ruleId: "weak_quality_bypass_policy",
    passed: profile !== "weak" || qualityGatePassed,
    detail: `allowWeak=${allowWeakOpt} onlyStrongSpikes=${onlyStrongOpt} priorOrNoiseBlock=${weakBypassDisqualified} finalPass=${qualityGatePassed}`,
  });

  const weakPrimaryReasons: string[] = [];
  if (profile === "weak") {
    for (const d of downgradeChain) {
      weakPrimaryReasons.push(d.reasonCode);
    }
    const reasonSet = new Set(reasons);
    if (
      reasonSet.has("pre_spike_range_poor_quality") &&
      !weakPrimaryReasons.includes("pre_spike_range_poor_quality")
    ) {
      weakPrimaryReasons.push("pre_spike_range_poor_quality");
    }
    if (
      reasonSet.has("trend_noise_rejection") &&
      !weakPrimaryReasons.includes("trend_noise_rejection")
    ) {
      weakPrimaryReasons.push("trend_noise_rejection");
    }
    if (
      entry.movementClassification === "strong_spike" &&
      strongestMovePercent < tradableSpikeMinPercent
    ) {
      if (!weakPrimaryReasons.includes("spike_below_tradable_min_percent")) {
        weakPrimaryReasons.push("spike_below_tradable_min_percent");
      }
    }
    if (weakPrimaryReasons.length === 0) {
      weakPrimaryReasons.push("see_qualityGateReasons_and_ruleChecks");
    }
  }

  const diagnostics: QualityGateDiagnostics = {
    classification: "rule_based",
    effectiveThresholds: {
      tradableSpikeMinPercent: thresholds.tradableSpikeMinPercent,
      exceptionalSpikeMinPercent: thresholds.exceptionalSpikeMinPercent,
      maxPriorRangeForNormalEntry: thresholds.maxPriorRangeForNormalEntry,
    },
    inputs: {
      movementClassification: entry.movementClassification,
      strongestMovePercent,
      spikePercent,
      thresholdRatio,
      priorRangeFraction: entry.priorRangeFraction,
      stableRangeDetected: entry.stableRangeDetected,
      stableRangeQuality: entry.stableRangeQuality,
      entryReasonCodes: [...entry.reasons],
    },
    profileAfterSpikeSizeTier,
    ruleChecks,
    downgradeChain,
    finalProfile: profile,
    qualityGatePassed,
    weakPrimaryReasons,
    weakQualityPolicy: {
      allowWeakQualityEntries: allowWeakOpt,
      allowWeakQualityOnlyForStrongSpikes: onlyStrongOpt,
      priorOrNoiseBlocksWeakBypass: weakBypassDisqualified,
    },
    acceptableStrongSpikePolicy: {
      allowAcceptableQualityStrongSpikes: allowAcceptableStrong,
      overrideApplied: reasons.includes(
        ACCEPTABLE_QUALITY_STRONG_SPIKE_GATE_REASON
      ),
    },
  };

  return {
    qualityGatePassed,
    qualityGateReasons: [...new Set(reasons)],
    qualityProfile: profile,
    diagnostics,
  };
}

