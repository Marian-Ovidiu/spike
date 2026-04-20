import type { ExitReason } from "../../exitConditions.js";

export type BinaryExitEvaluation = {
  shouldExit: boolean;
  reason: ExitReason | null;
};

/**
 * Paper binary exits: absolute price movement on the held outcome (YES or NO) vs entry fill.
 * Profit when mark ≥ entry + takeProfitPriceDelta; stop when mark ≤ entry − stopLossPriceDelta.
 * Timeout when `timeoutMs > 0` and elapsed ≥ timeoutMs.
 */
export function evaluateBinaryExitConditions(input: {
  markPrice: number;
  entryFillPrice: number;
  takeProfitPriceDelta: number;
  stopLossPriceDelta: number;
  openedAt: number;
  timeoutMs: number;
  now?: number;
}): BinaryExitEvaluation {
  const now = input.now ?? Date.now();
  const {
    markPrice,
    entryFillPrice,
    takeProfitPriceDelta,
    stopLossPriceDelta,
    openedAt,
    timeoutMs,
  } = input;

  if (
    !Number.isFinite(markPrice) ||
    !Number.isFinite(entryFillPrice) ||
    entryFillPrice <= 0
  ) {
    return { shouldExit: false, reason: null };
  }

  if (
    takeProfitPriceDelta > 0 &&
    markPrice >= entryFillPrice + takeProfitPriceDelta
  ) {
    return { shouldExit: true, reason: "profit" };
  }

  if (
    stopLossPriceDelta > 0 &&
    markPrice <= entryFillPrice - stopLossPriceDelta
  ) {
    return { shouldExit: true, reason: "stop" };
  }

  if (timeoutMs > 0 && now - openedAt >= timeoutMs) {
    return { shouldExit: true, reason: "timeout" };
  }

  return { shouldExit: false, reason: null };
}

export function computeBinaryExitDiagnostics(input: {
  markPrice: number;
  entryFillPrice: number;
  takeProfitPriceDelta: number;
  stopLossPriceDelta: number;
  openedAt: number;
  timeoutMs: number;
  now?: number;
}): {
  inputsValid: boolean;
  targetHit: boolean;
  stopHit: boolean;
  timeoutReached: boolean;
  elapsedMs: number;
} {
  const now = input.now ?? Date.now();
  const elapsedMs = now - input.openedAt;
  const e = input.entryFillPrice;
  const m = input.markPrice;
  if (!Number.isFinite(m) || !Number.isFinite(e) || e <= 0) {
    return {
      inputsValid: false,
      targetHit: false,
      stopHit: false,
      timeoutReached: false,
      elapsedMs,
    };
  }
  const tpD = input.takeProfitPriceDelta;
  const slD = input.stopLossPriceDelta;
  const targetHit = tpD > 0 && m >= e + tpD;
  const stopHit = slD > 0 && m <= e - slD;
  const timeoutReached = input.timeoutMs > 0 && elapsedMs >= input.timeoutMs;
  return {
    inputsValid: true,
    targetHit,
    stopHit,
    timeoutReached,
    elapsedMs,
  };
}
