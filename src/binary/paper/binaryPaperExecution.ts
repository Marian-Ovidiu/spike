import type { EntryDirection } from "../../entryConditions.js";

/** Outcome token held in paper binary mode. */
export type BinarySideBought = "YES" | "NO";

/** Strategy direction UP → buy YES token; DOWN → buy NO (maps spike fade to outcome side). */
export function binarySideFromStrategyDirection(
  direction: EntryDirection
): BinarySideBought {
  return direction === "UP" ? "YES" : "NO";
}

/** Aggressive buy fill on the chosen outcome (pay ask-side slip as fraction of price). */
export function binaryOutcomeBuyFillPrice(
  side: BinarySideBought,
  yesPrice: number,
  noPrice: number,
  slippageBps: number
): number {
  const raw = side === "YES" ? yesPrice : noPrice;
  const slip = slippageBps / 10_000;
  return raw * (1 + slip);
}

/** Mark-to-market on the held outcome token. */
export function binaryMarkHeldOutcome(
  side: BinarySideBought,
  yesPrice: number,
  noPrice: number
): number {
  return side === "YES" ? yesPrice : noPrice;
}

/** Long-outcome P/L: contracts × (exit − entry) on the same side. */
export function binaryLongOutcomeGrossPnl(
  shares: number,
  entrySidePrice: number,
  exitSidePrice: number
): number {
  return shares * (exitSidePrice - entrySidePrice);
}
