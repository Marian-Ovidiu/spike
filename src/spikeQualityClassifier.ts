import type { EntryEvaluation } from "./entryConditions.js";
import {
  evaluatePreEntryQualityGate,
  type PreEntryQualityGateResult,
} from "./preEntryQualityGate.js";

export function classifySpikeQuality(
  entry: EntryEvaluation,
  options?: {
    tradableSpikeMinPercent?: number;
    exceptionalSpikeMinPercent?: number;
    maxPriorRangeForNormalEntry?: number;
    allowWeakQualityEntries?: boolean;
    allowWeakQualityOnlyForStrongSpikes?: boolean;
  }
): PreEntryQualityGateResult {
  return evaluatePreEntryQualityGate(entry, options);
}
