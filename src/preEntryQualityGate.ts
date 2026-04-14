import type { EntryEvaluation } from "./entryConditions.js";

export type QualityProfile = "weak" | "acceptable" | "strong" | "exceptional";

export const DEFAULT_TRADABLE_SPIKE_MIN_PERCENT = 0.0015;
export const DEFAULT_MAX_PRIOR_RANGE_FOR_NORMAL_ENTRY = 0.0015;
const DEFAULT_EXCEPTIONAL_SPIKE_MIN_PERCENT = 0.0025;

export type PreEntryQualityGateResult = {
  qualityGatePassed: boolean;
  qualityGateReasons: string[];
  qualityProfile: QualityProfile;
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
  const strongestMovePercent = entry.movement.strongestMovePercent;
  const thresholdRatio = entry.movement.thresholdRatio;

  let profile: QualityProfile = "weak";
  if (entry.movementClassification === "strong_spike") {
    if (strongestMovePercent >= exceptionalSpikeMinPercent) {
      profile = "exceptional";
    } else if (strongestMovePercent >= tradableSpikeMinPercent) {
      profile = "strong";
    } else {
      profile = "weak";
    }
  } else if (entry.movementClassification === "borderline") {
    profile =
      strongestMovePercent >= tradableSpikeMinPercent ? "acceptable" : "weak";
  }

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

  if (entry.stableRangeQuality === "poor") {
    const canOverridePoorRange = profile === "exceptional";
    if (canOverridePoorRange) {
      reasons.push("poor_range_overridden_by_exceptional_spike");
    } else {
      profile = downgradeProfile(profile, "weak");
      reasons.push("pre_spike_range_poor_quality");
    }
  } else if (entry.stableRangeQuality === "acceptable") {
    profile = downgradeProfile(profile, "acceptable");
    reasons.push("pre_spike_range_only_acceptable");
  } else {
    reasons.push("pre_spike_range_good_quality");
  }

  const noisyContext = entry.reasons.includes("range_too_noisy_for_entry");
  const unstableContext = entry.reasons.includes("market_not_stable");
  const weakSpikeContext = entry.reasons.includes("spike_not_strong_enough");

  if (noisyContext || unstableContext) {
    const canOverrideNoise = profile === "exceptional";
    if (canOverrideNoise) {
      reasons.push("trend_noise_rejection_overridden_by_exceptional_spike");
    } else {
      profile = downgradeProfile(profile, "weak");
      reasons.push("trend_noise_rejection");
    }
  }
  if (weakSpikeContext && entry.movementClassification !== "strong_spike") {
    profile = downgradeProfile(profile, "weak");
    reasons.push("spike_size_insufficient_for_quality_gate");
  }
  if (entry.priorRangePercent > maxPriorRangeForNormalEntry) {
    profile = downgradeProfile(profile, "weak");
    reasons.push("prior_range_too_wide_for_mean_reversion");
  }

  const qualityGatePassed = profile === "strong" || profile === "exceptional";
  return {
    qualityGatePassed,
    qualityGateReasons: [...new Set(reasons)],
    qualityProfile: profile,
  };
}

