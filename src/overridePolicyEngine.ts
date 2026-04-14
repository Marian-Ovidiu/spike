import type { EntryEvaluation } from "./entryConditions.js";
import type { QualityProfile } from "./preEntryQualityGate.js";

export function shouldOverrideCooldownForExceptional(input: {
  entry: EntryEvaluation;
  qualityProfile: QualityProfile;
  exceptionalSpikePercent: number;
  exceptionalSpikeOverridesCooldown: boolean;
}): boolean {
  if (!input.exceptionalSpikeOverridesCooldown) return false;
  if (input.qualityProfile !== "exceptional") return false;
  return input.entry.movement.strongestMovePercent >= input.exceptionalSpikePercent;
}

export function shouldOverrideCooldownForExceptionalCandidate(input: {
  candidateMovePercent: number;
  exceptionalSpikePercent: number;
  exceptionalSpikeOverridesCooldown: boolean;
}): boolean {
  if (!input.exceptionalSpikeOverridesCooldown) return false;
  return input.candidateMovePercent >= input.exceptionalSpikePercent * 100;
}
