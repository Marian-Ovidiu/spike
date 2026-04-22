import type { EntryDirection } from "../../entryConditions.js";
import type { BinaryOutcomePrices } from "../../market/types.js";

/** Binary venue book: block when spread exceeds configured hard maximum (bps). */
export function binarySpreadExceedsHardMax(
  spreadBps: number,
  hardMaxBps: number
): boolean {
  return (
    hardMaxBps > 0 &&
    (!Number.isFinite(spreadBps) || spreadBps > hardMaxBps)
  );
}

/** Shared with {@link SimulationEngine} binary entry path. */
export function binaryYesMidFailsExtremeBand(
  yesMid: number,
  filterEnabled: boolean,
  bandMin: number,
  bandMax: number
): boolean {
  if (!filterEnabled || !Number.isFinite(yesMid)) return false;
  const lo = Math.min(bandMin, bandMax);
  const hi = Math.max(bandMin, bandMax);
  return yesMid < lo || yesMid > hi;
}

/**
 * Raw pipeline / monitor reason codes for binary quote gates (before normalization).
 * @see normalizeRawReason in rejectionReasons.ts
 */
export type BinaryPaperQuoteBlockReason =
  | "opposite_side_price_too_high"
  | "market_quotes_too_neutral"
  | "neutral_quotes"
  | "entry_side_price_too_high"
  | "missing_binary_quotes"
  /** YES mid outside configured tradeable band (resolved / no edge). */
  | "binary_yes_mid_extreme";

/**
 * Validates YES/NO prices before a simulated binary entry (independent of spot spread).
 *
 * - **Opposite side**: UP buys YES → opposite is NO; DOWN buys NO → opposite is YES.
 *   Blocks when `opposite > min(entrySide, maxOppositeSideEntryPrice)` (same cap shape as legacy quote gate).
 * - **Entry side cap** (optional): when `maxEntrySidePrice > 0`, blocks if raw outcome price on the buy leg exceeds it.
 * - **Neutral band** (optional): when `neutralBandMax > neutralBandMin`, blocks if both YES and NO lie inside `[min,max]`.
 * - **YES mid band** (optional): when {@link yesMidExtremeFilterEnabled}, blocks if YES mid is outside `[yesMidBandMin, yesMidBandMax]` (near-resolved markets).
 */
export function evaluateBinaryPaperEntryQuotes(input: {
  binaryOutcomes: BinaryOutcomePrices | null | undefined;
  direction: EntryDirection;
  maxOppositeSideEntryPrice: number;
  /** `0` disables the entry-side cap. */
  maxEntrySidePrice: number;
  neutralBandMin: number;
  neutralBandMax: number;
  /** When true, apply YES mid inclusive band below. */
  yesMidExtremeFilterEnabled?: boolean;
  /** Inclusive; defaults should match config (e.g. 0.05). */
  yesMidBandMin?: number;
  yesMidBandMax?: number;
}): BinaryPaperQuoteBlockReason | null {
  const bo = input.binaryOutcomes;
  if (
    bo === null ||
    bo === undefined ||
    !Number.isFinite(bo.yesPrice) ||
    !Number.isFinite(bo.noPrice)
  ) {
    return "missing_binary_quotes";
  }

  const { yesPrice, noPrice } = bo;
  if (yesPrice <= 0 || noPrice <= 0) {
    return "missing_binary_quotes";
  }

  const bandMin = input.yesMidBandMin ?? 0.05;
  const bandMax = input.yesMidBandMax ?? 0.95;
  if (
    binaryYesMidFailsExtremeBand(
      yesPrice,
      input.yesMidExtremeFilterEnabled !== false,
      bandMin,
      bandMax
    )
  ) {
    return "binary_yes_mid_extreme";
  }

  const entrySide = input.direction === "UP" ? yesPrice : noPrice;
  const oppositeSide = input.direction === "UP" ? noPrice : yesPrice;

  const lo = Math.min(input.neutralBandMin, input.neutralBandMax);
  const hi = Math.max(input.neutralBandMin, input.neutralBandMax);
  if (hi > lo) {
    const bothNeutral =
      yesPrice >= lo && yesPrice <= hi && noPrice >= lo && noPrice <= hi;
    if (bothNeutral) return "market_quotes_too_neutral";
  }

  if (input.maxEntrySidePrice > 0 && entrySide > input.maxEntrySidePrice) {
    return "entry_side_price_too_high";
  }

  const maxAllowedOpposite = Math.min(
    entrySide,
    input.maxOppositeSideEntryPrice
  );
  if (oppositeSide > maxAllowedOpposite) {
    return "opposite_side_price_too_high";
  }

  return null;
}
