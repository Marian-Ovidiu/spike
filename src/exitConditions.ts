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

/** Independent exit-rule booleans (for diagnostics; not evaluation order). */
export type ExitDiagnosticsFlags = {
  inputsValid: boolean;
  targetHit: boolean;
  stopHit: boolean;
  timeoutReached: boolean;
  elapsedMs: number;
};

function exitInputsInvalid(input: EvaluateExitConditionsInput): boolean {
  const {
    currentPrice,
    exitPrice,
    stopLoss,
    openedAt,
    timeoutMs = DEFAULT_EXIT_TIMEOUT_MS,
    now = Date.now(),
  } = input;
  return (
    !Number.isFinite(currentPrice) ||
    !Number.isFinite(exitPrice) ||
    !Number.isFinite(stopLoss) ||
    !Number.isFinite(openedAt) ||
    !Number.isFinite(now) ||
    !Number.isFinite(timeoutMs) ||
    timeoutMs < 0
  );
}

/**
 * Snapshot of which exit bands the current mark satisfies (profit / stop / timeout),
 * without applying evaluation precedence.
 */
export function computeExitDiagnosticsFlags(
  input: EvaluateExitConditionsInput
): ExitDiagnosticsFlags {
  const {
    currentPrice,
    exitPrice,
    stopLoss,
    openedAt,
    timeoutMs = DEFAULT_EXIT_TIMEOUT_MS,
    now = Date.now(),
  } = input;

  if (exitInputsInvalid(input)) {
    return {
      inputsValid: false,
      targetHit: false,
      stopHit: false,
      timeoutReached: false,
      elapsedMs: 0,
    };
  }

  const elapsedMs = now - openedAt;
  return {
    inputsValid: true,
    targetHit: currentPrice >= exitPrice,
    stopHit: currentPrice <= stopLoss,
    timeoutReached: elapsedMs >= timeoutMs,
    elapsedMs,
  };
}

/**
 * Long-position exit rules: profit at or above `exitPrice`, stop at or below `stopLoss`,
 * or time in position ≥ `timeoutMs`. Evaluation order: profit → stop → timeout.
 */
export function evaluateExitConditions(
  input: EvaluateExitConditionsInput
): ExitEvaluation {
  if (exitInputsInvalid(input)) {
    return { shouldExit: false, reason: null };
  }

  const {
    currentPrice,
    exitPrice,
    stopLoss,
    openedAt,
    timeoutMs = DEFAULT_EXIT_TIMEOUT_MS,
    now = Date.now(),
  } = input;

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
