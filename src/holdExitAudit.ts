import type { ExitReason } from "./exitConditions.js";
import type { EntryDirection } from "./entryConditions.js";

/**
 * Price distance (absolute) from best mark during hold to profit target — counts as
 * "target was realistically close" if {@link HoldExitAudit.minGapToProfitTarget} ≤ this.
 */
export const EXIT_AUDIT_NEAR_TARGET_PRICE = 0.02;

/**
 * Price distance (absolute) from worst mark to stop — counts as "stop was realistically close"
 * if {@link HoldExitAudit.minBufferAboveStop} ≤ this.
 */
export const EXIT_AUDIT_NEAR_STOP_PRICE = 0.02;

/** Per closed trade: how far the mark moved vs configured exit thresholds (long on held leg). */
export type HoldExitAudit = {
  configExitPrice: number;
  configStopLoss: number;
  entryPrice: number;
  exitMark: number;
  holdMarkMin: number;
  holdMarkMax: number;
  /** Long: max(mark) − entry (best mark path for P/L). */
  maxFavorableExcursion: number;
  /** Long: entry − min(mark) (worst mark drawdown). */
  maxAdverseExcursion: number;
  /**
   * Long: tightest gap to take-profit over the hold = exitPrice − max(mark).
   * ≤ 0 means target was reached or crossed at some point; large ⇒ target far above observed highs.
   */
  minGapToProfitTarget: number;
  /**
   * Long: tightest buffer above stop = min(mark) − stopLoss.
   * ≤ 0 means stop would have fired; large ⇒ mark never approached stop from above.
   */
  minBufferAboveStop: number;
  targetWithinNearPriceBand: boolean;
  stopWithinNearPriceBand: boolean;
  exitReason: ExitReason;
  /**
   * True when exit was timeout and neither target nor stop came within the near bands
   * (timeout was the only *practically reachable* exit path given observed excursions).
   */
  timeoutLikelyOnlyViableExit: boolean;
  nearTargetPriceThreshold: number;
  nearStopPriceThreshold: number;
};

export type HoldExitAuditSummary = {
  tradesAudited: number;
  closedByTimeout: number;
  /** Subset of timeouts: never came within near bands of target or stop. */
  timeoutsLikelyOnlyViableExit: number;
  /** `timeoutsLikelyOnlyViableExit / closedByTimeout` when timeouts > 0, else 0. */
  pctTimeoutsOnlyViableExit: number;
  /** `timeoutsLikelyOnlyViableExit / tradesAudited`. */
  pctAllTradesTimeoutOnlyViable: number;
  tradesEverNearTarget: number;
  tradesEverNearStop: number;
  /** Mean of minGapToProfitTarget across audited trades. */
  avgMinGapToProfitTarget: number;
  /** Mean of minBufferAboveStop. */
  avgMinBufferAboveStop: number;
  avgMaxFavorableExcursion: number;
  avgMaxAdverseExcursion: number;
  nearTargetPriceThreshold: number;
  nearStopPriceThreshold: number;
};

export type BuildHoldExitAuditInput = {
  /** LONG (UP) vs SHORT (DOWN) — affects MFE/MAE sign conventions. */
  direction?: EntryDirection;
  entryPrice: number;
  exitMark: number;
  holdMarkMin: number;
  holdMarkMax: number;
  configExitPrice: number;
  configStopLoss: number;
  exitReason: ExitReason;
  /** Defaults to {@link EXIT_AUDIT_NEAR_TARGET_PRICE}. */
  nearTargetPrice?: number;
  /** Defaults to {@link EXIT_AUDIT_NEAR_STOP_PRICE}. */
  nearStopPrice?: number;
};

/**
 * Summarizes hold-period excursions vs fixed long take-profit and stop (paper sim semantics).
 * Uses only min/max mark during the hold (exact min gap to target / min buffer above stop
 * would need tick-by-tick extrema; for monotone-ish quotes extrema at highs/lows are correct).
 */
export function buildHoldExitAudit(input: BuildHoldExitAuditInput): HoldExitAudit {
  const {
    direction = "UP",
    entryPrice,
    exitMark,
    holdMarkMin,
    holdMarkMax,
    configExitPrice,
    configStopLoss,
    exitReason,
  } = input;
  const nearTargetPrice = input.nearTargetPrice ?? EXIT_AUDIT_NEAR_TARGET_PRICE;
  const nearStopPrice = input.nearStopPrice ?? EXIT_AUDIT_NEAR_STOP_PRICE;

  const long = direction === "UP";
  const maxFavorableExcursion = long
    ? holdMarkMax - entryPrice
    : entryPrice - holdMarkMin;
  const maxAdverseExcursion = long
    ? entryPrice - holdMarkMin
    : holdMarkMax - entryPrice;
  const minGapToProfitTarget = long
    ? configExitPrice - holdMarkMax
    : holdMarkMin - configExitPrice;
  const minBufferAboveStop = long
    ? holdMarkMin - configStopLoss
    : configStopLoss - holdMarkMax;

  const targetWithinNearPriceBand = minGapToProfitTarget <= nearTargetPrice;
  const stopWithinNearPriceBand = minBufferAboveStop <= nearStopPrice;

  const timeoutLikelyOnlyViableExit =
    exitReason === "timeout" &&
    !targetWithinNearPriceBand &&
    !stopWithinNearPriceBand;

  return {
    configExitPrice,
    configStopLoss,
    entryPrice,
    exitMark,
    holdMarkMin,
    holdMarkMax,
    maxFavorableExcursion,
    maxAdverseExcursion,
    minGapToProfitTarget,
    minBufferAboveStop,
    targetWithinNearPriceBand,
    stopWithinNearPriceBand,
    exitReason,
    timeoutLikelyOnlyViableExit,
    nearTargetPriceThreshold: nearTargetPrice,
    nearStopPriceThreshold: nearStopPrice,
  };
}

export function aggregateHoldExitAudits(
  trades: readonly { holdExitAudit?: HoldExitAudit; exitReason: ExitReason }[]
): HoldExitAuditSummary | null {
  const audits = trades
    .map((t) => t.holdExitAudit)
    .filter((a): a is HoldExitAudit => a !== undefined);
  if (audits.length === 0) return null;

  let closedByTimeout = 0;
  let timeoutsLikelyOnlyViableExit = 0;
  let tradesEverNearTarget = 0;
  let tradesEverNearStop = 0;
  let sumGapTarget = 0;
  let sumBufferStop = 0;
  let sumMfe = 0;
  let sumMae = 0;

  for (const a of audits) {
    if (a.exitReason === "timeout") closedByTimeout += 1;
    if (a.timeoutLikelyOnlyViableExit) timeoutsLikelyOnlyViableExit += 1;
    if (a.targetWithinNearPriceBand) tradesEverNearTarget += 1;
    if (a.stopWithinNearPriceBand) tradesEverNearStop += 1;
    sumGapTarget += a.minGapToProfitTarget;
    sumBufferStop += a.minBufferAboveStop;
    sumMfe += a.maxFavorableExcursion;
    sumMae += a.maxAdverseExcursion;
  }

  const n = audits.length;
  const nearT = audits[0]!.nearTargetPriceThreshold;
  const nearS = audits[0]!.nearStopPriceThreshold;

  return {
    tradesAudited: n,
    closedByTimeout,
    timeoutsLikelyOnlyViableExit,
    pctTimeoutsOnlyViableExit:
      closedByTimeout > 0 ? (100 * timeoutsLikelyOnlyViableExit) / closedByTimeout : 0,
    pctAllTradesTimeoutOnlyViable: (100 * timeoutsLikelyOnlyViableExit) / n,
    tradesEverNearTarget,
    tradesEverNearStop,
    avgMinGapToProfitTarget: sumGapTarget / n,
    avgMinBufferAboveStop: sumBufferStop / n,
    avgMaxFavorableExcursion: sumMfe / n,
    avgMaxAdverseExcursion: sumMae / n,
    nearTargetPriceThreshold: nearT,
    nearStopPriceThreshold: nearS,
  };
}
