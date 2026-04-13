/** Default max hold time when `timeoutMs` is omitted (60 seconds). */
export const DEFAULT_EXIT_TIMEOUT_MS = 60_000;

export type ExitReason = "profit" | "stop" | "timeout";

export type ExitEvaluation = {
  shouldExit: boolean;
  reason: ExitReason | null;
};

export type EvaluateExitConditionsInput = {
  /** Mark price of the open position (e.g. contract quote). */
  currentPrice: number;
  /** Take profit when price has reached at least this level (long). */
  exitPrice: number;
  /** Stop loss when price is at or below this level (long). */
  stopLoss: number;
  /** Position open time (epoch ms). */
  openedAt: number;
  /** Max hold duration in ms (defaults to {@link DEFAULT_EXIT_TIMEOUT_MS}). */
  timeoutMs?: number;
  /** Clock for tests (defaults to `Date.now()`). */
  now?: number;
};

/**
 * Long-position exit rules: profit at or above `exitPrice`, stop at or below `stopLoss`,
 * or time in position ≥ `timeoutMs`. Evaluation order: profit → stop → timeout.
 */
export function evaluateExitConditions(
  input: EvaluateExitConditionsInput
): ExitEvaluation {
  const {
    currentPrice,
    exitPrice,
    stopLoss,
    openedAt,
    timeoutMs = DEFAULT_EXIT_TIMEOUT_MS,
    now = Date.now(),
  } = input;

  if (
    !Number.isFinite(currentPrice) ||
    !Number.isFinite(exitPrice) ||
    !Number.isFinite(stopLoss) ||
    !Number.isFinite(openedAt) ||
    !Number.isFinite(now) ||
    !Number.isFinite(timeoutMs) ||
    timeoutMs < 0
  ) {
    return { shouldExit: false, reason: null };
  }

  if (currentPrice >= exitPrice) {
    return { shouldExit: true, reason: "profit" };
  }

  if (currentPrice <= stopLoss) {
    return { shouldExit: true, reason: "stop" };
  }

  const elapsed = now - openedAt;
  if (elapsed >= timeoutMs) {
    return { shouldExit: true, reason: "timeout" };
  }

  return { shouldExit: false, reason: null };
}
