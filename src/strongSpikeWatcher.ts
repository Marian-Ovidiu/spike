import {
  buildPromotedStrongSpikeEntryEvaluation,
  evaluateStrongSpikeWatchDecision,
  type StrongSpikeCandidate,
} from "./strongSpikeCandidate.js";
import type { EntryEvaluation } from "./entryConditions.js";

export function decideStrongSpikeWatch(
  ...args: Parameters<typeof evaluateStrongSpikeWatchDecision>
) {
  return evaluateStrongSpikeWatchDecision(...args);
}

export function buildStrongSpikePromotedEntry(
  candidate: StrongSpikeCandidate,
  baseEntry: EntryEvaluation
) {
  return buildPromotedStrongSpikeEntryEvaluation(candidate, baseEntry);
}

