import type { StrategyDecision } from "./strategy/strategyDecisionPipeline.js";

/**
 * Persisted on {@link SimulatedTrade.entryPath} / paper logs.
 * `borderline_delayed` is retained for backward compatibility with older sessions.
 */
export type PaperTradeEntryPath =
  | "strong_spike_immediate"
  | "strong_spike_confirmed"
  | "borderline_delayed"
  | "borderline_promoted";

/**
 * Maps pipeline decision → persisted entry path for monitor / JSONL / backtests.
 *
 * Strong-spike confirmation promote uses reasons like `strong_spike_confirmed_pause`
 * ({@link evaluateStrongSpikeWatchDecision}).
 */
export function resolvePaperTradeEntryPath(
  decision: Pick<StrategyDecision, "action" | "reason">
): PaperTradeEntryPath {
  if (decision.action === "promote_borderline_candidate") {
    return "borderline_promoted";
  }
  if (decision.action === "enter_immediate") {
    const r = decision.reason ?? "";
    if (r.startsWith("strong_spike_confirmed")) {
      return "strong_spike_confirmed";
    }
    return "strong_spike_immediate";
  }
  return "strong_spike_immediate";
}
