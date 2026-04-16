import type { AppConfig } from "./config.js";
import type { QualityProfile } from "./preEntryQualityGate.js";

export type StakeSizingConfigSlice = Pick<
  AppConfig,
  | "allowWeakQualityEntries"
  | "weakQualitySizeMultiplier"
  | "strongQualitySizeMultiplier"
  | "exceptionalQualitySizeMultiplier"
>;

/**
 * Resolves stake multiplier from entry quality profile.
 * When {@link AppConfig.allowWeakQualityEntries} is false, always returns `1`
 * (unchanged behavior vs pre–quality-sizing builds).
 */
export function resolveQualityStakeMultiplier(
  profile: QualityProfile | undefined,
  config: StakeSizingConfigSlice
): number {
  if (!config.allowWeakQualityEntries) {
    return 1;
  }
  const clamp = (x: number) =>
    Number.isFinite(x) && x >= 0 ? x : 0;
  switch (profile) {
    case "weak":
      return clamp(config.weakQualitySizeMultiplier);
    case "strong":
    case "acceptable":
      return clamp(config.strongQualitySizeMultiplier);
    case "exceptional":
      return clamp(config.exceptionalQualitySizeMultiplier);
    default:
      return 1;
  }
}
