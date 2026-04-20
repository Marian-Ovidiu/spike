import type { EntryDirection } from "../../entryConditions.js";
import type { ExitReason } from "../../exitConditions.js";

export type SpotExitEvaluation = {
  shouldExit: boolean;
  reason: ExitReason | null;
};

/**
 * Take-profit / stop-loss vs entry fill, in basis points (legacy **spot paper** position).
 * LONG: profit when bid >= entry*(1+tpBps), stop when bid <= entry*(1-slBps)
 * SHORT: profit when ask <= entry*(1-tpBps), stop when ask >= entry*(1+slBps)
 */
export function evaluateSpotExitConditions(input: {
  direction: EntryDirection;
  /** Mark: bid for long, ask for short */
  markPrice: number;
  entryFillPrice: number;
  takeProfitBps: number;
  stopLossBps: number;
  openedAt: number;
  timeoutMs: number;
  now?: number;
}): SpotExitEvaluation {
  const now = input.now ?? Date.now();
  const {
    direction,
    markPrice,
    entryFillPrice,
    takeProfitBps,
    stopLossBps,
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

  const tp = takeProfitBps / 10_000;
  const sl = stopLossBps / 10_000;

  if (direction === "UP") {
    const tpPx = entryFillPrice * (1 + tp);
    const slPx = entryFillPrice * (1 - sl);
    if (markPrice >= tpPx) return { shouldExit: true, reason: "profit" };
    if (markPrice <= slPx) return { shouldExit: true, reason: "stop" };
  } else {
    const tpPx = entryFillPrice * (1 - tp);
    const slPx = entryFillPrice * (1 + sl);
    if (markPrice <= tpPx) return { shouldExit: true, reason: "profit" };
    if (markPrice >= slPx) return { shouldExit: true, reason: "stop" };
  }

  if (now - openedAt >= timeoutMs) {
    return { shouldExit: true, reason: "timeout" };
  }

  return { shouldExit: false, reason: null };
}

export function computeSpotExitDiagnostics(input: {
  direction: EntryDirection;
  markPrice: number;
  entryFillPrice: number;
  takeProfitBps: number;
  stopLossBps: number;
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
  if (
    !Number.isFinite(input.markPrice) ||
    !Number.isFinite(input.entryFillPrice) ||
    input.entryFillPrice <= 0
  ) {
    return {
      inputsValid: false,
      targetHit: false,
      stopHit: false,
      timeoutReached: false,
      elapsedMs,
    };
  }
  const tp = input.takeProfitBps / 10_000;
  const sl = input.stopLossBps / 10_000;
  const e = input.entryFillPrice;
  const m = input.markPrice;
  let targetHit = false;
  let stopHit = false;
  if (input.direction === "UP") {
    targetHit = m >= e * (1 + tp);
    stopHit = m <= e * (1 - sl);
  } else {
    targetHit = m <= e * (1 - tp);
    stopHit = m >= e * (1 + sl);
  }
  return {
    inputsValid: true,
    targetHit,
    stopHit,
    timeoutReached: elapsedMs >= input.timeoutMs,
    elapsedMs,
  };
}
