import type { EntryEvaluation } from "./entryConditions.js";

export type HardRejectResult = {
  hardRejectApplied: boolean;
  hardRejectReason: string | null;
};

export function evaluateHardRejectContext(input: {
  entry: EntryEvaluation;
  hardRejectPriorRangePercent: number;
}): HardRejectResult {
  const threshold = Number.isFinite(input.hardRejectPriorRangePercent)
    ? Math.max(0, input.hardRejectPriorRangePercent)
    : 0.002;
  if (!input.entry.stableRangeDetected && input.entry.priorRangePercent > threshold) {
    return {
      hardRejectApplied: true,
      hardRejectReason: "hard_reject_unstable_pre_spike_context",
    };
  }
  return { hardRejectApplied: false, hardRejectReason: null };
}
