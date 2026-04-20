import type { EntryDirection } from "../../entryConditions.js";
import {
  binaryMarkHeldOutcome,
  binaryOutcomeBuyFillPrice,
  binarySideFromStrategyDirection,
  type BinarySideBought,
} from "./binaryPaperExecution.js";

/** YES/NO venue mids at one instant (Polymarket-style). */
export type BinaryVenueMidSnapshot = {
  yesMid: number;
  noMid: number;
};

/**
 * Live binary paper position: explicit outcome leg, sizing, and quote trail.
 * UP → buy YES; DOWN → buy NO (same as strategy contrarian leg).
 */
export type BinaryPaperLivePosition = {
  sideBought: BinarySideBought;
  /** USDT notional deployed at entry. */
  stakeUsdt: number;
  /** Outcome contracts = stake / entryOutcomePrice. */
  contracts: number;
  /** Fill price on the bought outcome (includes slippage). */
  entryOutcomePrice: number;
  /** Mark on the held outcome after the latest venue quote update. */
  heldOutcomeMark: number;
  yesMidAtEntry: number;
  noMidAtEntry: number;
  yesMidLast: number;
  noMidLast: number;
};

/**
 * Opens a paper binary leg from venue mids + strategy direction.
 * Does not mutate global simulation state — returns a snapshot you can store on the engine.
 */
export function openBinaryPaperPosition(input: {
  direction: EntryDirection;
  quote: BinaryVenueMidSnapshot;
  slippageBps: number;
  stakeUsdt: number;
}): BinaryPaperLivePosition {
  const sideBought = binarySideFromStrategyDirection(input.direction);
  const entryOutcomePrice = binaryOutcomeBuyFillPrice(
    sideBought,
    input.quote.yesMid,
    input.quote.noMid,
    input.slippageBps
  );
  const contracts = input.stakeUsdt / entryOutcomePrice;
  const heldOutcomeMark = binaryMarkHeldOutcome(
    sideBought,
    input.quote.yesMid,
    input.quote.noMid
  );
  return {
    sideBought,
    stakeUsdt: input.stakeUsdt,
    contracts,
    entryOutcomePrice,
    heldOutcomeMark,
    yesMidAtEntry: input.quote.yesMid,
    noMidAtEntry: input.quote.noMid,
    yesMidLast: input.quote.yesMid,
    noMidLast: input.quote.noMid,
  };
}

/** After each venue poll: refresh last mids, held-outcome mark, and return updated min/max mark trail. */
export function applyBinaryPaperVenueTick(
  pos: BinaryPaperLivePosition,
  quote: BinaryVenueMidSnapshot,
  holdMarkMin: number,
  holdMarkMax: number
): { holdMarkMin: number; holdMarkMax: number } {
  pos.yesMidLast = quote.yesMid;
  pos.noMidLast = quote.noMid;
  pos.heldOutcomeMark = binaryMarkHeldOutcome(
    pos.sideBought,
    quote.yesMid,
    quote.noMid
  );
  return {
    holdMarkMin: Math.min(holdMarkMin, pos.heldOutcomeMark),
    holdMarkMax: Math.max(holdMarkMax, pos.heldOutcomeMark),
  };
}

/** Gross P/L on the held outcome: contracts × (exitMid − entryFill) on that leg. */
export function binaryPaperGrossPnlUsdt(
  contracts: number,
  entryOutcomePrice: number,
  exitOutcomeMark: number
): number {
  return contracts * (exitOutcomeMark - entryOutcomePrice);
}

/** Round-trip fee in USDT (charged on notional stake). */
export function binaryPaperRoundTripFeeUsdt(
  stakeUsdt: number,
  paperFeeRoundTripBps: number
): number {
  return stakeUsdt * (paperFeeRoundTripBps / 10_000);
}

/** Unrealized P/L in USDT at a venue snapshot (same sign convention as closed trade). */
export function binaryPaperUnrealizedPnlUsdt(
  pos: BinaryPaperLivePosition,
  quote: BinaryVenueMidSnapshot
): number {
  const mark = binaryMarkHeldOutcome(
    pos.sideBought,
    quote.yesMid,
    quote.noMid
  );
  return binaryPaperGrossPnlUsdt(pos.contracts, pos.entryOutcomePrice, mark);
}
