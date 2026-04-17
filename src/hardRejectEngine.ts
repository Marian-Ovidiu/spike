import type { EntryEvaluation } from "./entryConditions.js";
import type { PreEntryQualityGateResult } from "./preEntryQualityGate.js";

export type UnstableContextMode = "hard" | "soft";

export type UnstablePreSpikeContextMetrics = {
  stableRangeDetected: boolean;
  priorRangeFraction: number;
  threshold: number;
};

export type HardRejectResult = {
  hardRejectApplied: boolean;
  hardRejectReason: string | null;
  /** True when the same detector that drives hard reject matched (both modes). */
  unstablePreSpikeContextDetected: boolean;
  /** How unstable pre-spike context was handled for this evaluation. */
  unstableContextHandling: "none" | "hard_reject" | "soft_deferred";
  unstablePreSpikeContextMetrics?: UnstablePreSpikeContextMetrics;
};

function unstableConditionMet(
  entry: EntryEvaluation,
  threshold: number
): boolean {
  return !entry.stableRangeDetected && entry.priorRangeFraction > threshold;
}

/**
 * Unstable pre-spike context: wide prior range without strict stable-range detection.
 * In {@link UnstableContextMode} `hard`, this blocks immediately (legacy behavior).
 * In `soft`, the signal is recorded and passed through for downstream gates.
 */
export function evaluateHardRejectContext(input: {
  entry: EntryEvaluation;
  hardRejectPriorRangePercent: number;
  unstableContextMode: UnstableContextMode;
}): HardRejectResult {
  const threshold = Number.isFinite(input.hardRejectPriorRangePercent)
    ? Math.max(0, input.hardRejectPriorRangePercent)
    : 0.002;

  if (!unstableConditionMet(input.entry, threshold)) {
    return {
      hardRejectApplied: false,
      hardRejectReason: null,
      unstablePreSpikeContextDetected: false,
      unstableContextHandling: "none",
    };
  }

  const metrics: UnstablePreSpikeContextMetrics = {
    stableRangeDetected: input.entry.stableRangeDetected,
    priorRangeFraction: input.entry.priorRangeFraction,
    threshold,
  };

  if (input.unstableContextMode === "soft") {
    return {
      hardRejectApplied: false,
      hardRejectReason: null,
      unstablePreSpikeContextDetected: true,
      unstableContextHandling: "soft_deferred",
      unstablePreSpikeContextMetrics: metrics,
    };
  }

  return {
    hardRejectApplied: true,
    hardRejectReason: "hard_reject_unstable_pre_spike_context",
    unstablePreSpikeContextDetected: true,
    unstableContextHandling: "hard_reject",
    unstablePreSpikeContextMetrics: metrics,
  };
}

/**
 * When soft mode defers hard reject, merge visible reasons/diagnostics into the quality gate snapshot.
 */
export function applyUnstableSoftOverlayOnQualityGate(
  gate: PreEntryQualityGateResult,
  hardReject: HardRejectResult
): PreEntryQualityGateResult {
  if (hardReject.unstableContextHandling !== "soft_deferred") {
    return gate;
  }
  const m = hardReject.unstablePreSpikeContextMetrics;
  const extra = [
    "unstable_pre_spike_context_soft_handling",
    ...(m
      ? [
          `unstable_context_prior_gt_threshold:priorFrac=${m.priorRangeFraction}_thr=${m.threshold}_stableDetected=${m.stableRangeDetected}`,
        ]
      : []),
  ];
  return {
    ...gate,
    qualityGateReasons: [...new Set([...gate.qualityGateReasons, ...extra])],
    diagnostics: {
      ...gate.diagnostics,
      unstableContextHandling: "soft_deferred",
      ...(m ? { unstablePreSpikeContextMetrics: m } : {}),
    },
  };
}
