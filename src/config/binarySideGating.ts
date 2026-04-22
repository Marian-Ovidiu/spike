import type { AppConfig } from "../config.js";

/** Sentinel for “inherit global MIN_EDGE_THRESHOLD / BINARY_MAX_ENTRY_PRICE”. */
export const BINARY_SIDE_OVERRIDE_INHERIT = -1;

/** Minimal config slice for YES/NO entry gates (sim tick config + full AppConfig both satisfy this). */
export type BinarySideGatingConfigSlice = Pick<
  AppConfig,
  | "minEdgeThreshold"
  | "binaryMaxEntryPrice"
  | "binaryEnableSideSpecificGating"
  | "binaryYesMinMispricingThreshold"
  | "binaryNoMinMispricingThreshold"
  | "binaryYesMaxEntryPrice"
  | "binaryNoMaxEntryPrice"
>;

/**
 * Effective mean-reversion edge floor for the bought outcome leg (binary paper entry).
 * When {@link AppConfig.binaryEnableSideSpecificGating} is false, returns {@link AppConfig.minEdgeThreshold}.
 */
export function effectiveBinaryMinMispricingThreshold(
  c: BinarySideGatingConfigSlice,
  sideBought: "YES" | "NO"
): number {
  const global = c.minEdgeThreshold;
  if (!c.binaryEnableSideSpecificGating) return global;
  const raw =
    sideBought === "YES"
      ? c.binaryYesMinMispricingThreshold
      : c.binaryNoMinMispricingThreshold;
  if (raw < 0 || raw === BINARY_SIDE_OVERRIDE_INHERIT) return global;
  return raw;
}

/**
 * Effective max aggressive fill on the bought leg (`BINARY_MAX_ENTRY_PRICE` semantics).
 */
export function effectiveBinaryMaxEntryPriceForSide(
  c: BinarySideGatingConfigSlice,
  sideBought: "YES" | "NO"
): number {
  const global = c.binaryMaxEntryPrice;
  if (!c.binaryEnableSideSpecificGating) return global;
  const raw =
    sideBought === "YES"
      ? c.binaryYesMaxEntryPrice
      : c.binaryNoMaxEntryPrice;
  if (raw < 0 || raw === BINARY_SIDE_OVERRIDE_INHERIT) return global;
  return raw;
}
