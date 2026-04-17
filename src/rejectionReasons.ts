import type { EntryEvaluation } from "./entryConditions.js";
import type { StrategyDecision } from "./strategyDecisionPipeline.js";

export type NormalizedRejectionReason =
  | "invalid_market_prices"
  | "missing_quote_data"
  | "active_position_open"
  | "entry_cooldown_active"
  | "quality_gate_rejected"
  | "hard_reject_unstable_pre_spike_context"
  | "prior_range_too_wide_for_mean_reversion"
  | "pre_spike_range_too_noisy"
  | "borderline_watch_pending"
  | "borderline_cancelled_continuation"
  | "strong_spike_continuation"
  | "opposite_side_price_too_high"
  | "market_quotes_too_neutral"
  | "no_signal_below_borderline"
  | "feed_stale"
  | "quote_feed_stale";

const ORDER: readonly NormalizedRejectionReason[] = [
  "missing_quote_data",
  "invalid_market_prices",
  "active_position_open",
  "entry_cooldown_active",
  "quality_gate_rejected",
  "hard_reject_unstable_pre_spike_context",
  "prior_range_too_wide_for_mean_reversion",
  "pre_spike_range_too_noisy",
  "borderline_cancelled_continuation",
  "strong_spike_continuation",
  "borderline_watch_pending",
  "opposite_side_price_too_high",
  "market_quotes_too_neutral",
  "no_signal_below_borderline",
  "feed_stale",
  "quote_feed_stale",
];

export const REJECTION_REASON_MESSAGES: Record<NormalizedRejectionReason, string> = {
  missing_quote_data: "missing quote data",
  invalid_market_prices: "invalid market prices",
  active_position_open: "active position already open",
  entry_cooldown_active: "entry cooldown still active",
  quality_gate_rejected: "pre-entry quality gate rejected opportunity",
  hard_reject_unstable_pre_spike_context:
    "hard reject: unstable pre-spike context",
  prior_range_too_wide_for_mean_reversion:
    "prior range too wide for mean reversion",
  pre_spike_range_too_noisy: "pre-spike range too noisy",
  borderline_watch_pending: "borderline watch pending",
  borderline_cancelled_continuation: "borderline cancelled: continuation detected",
  strong_spike_continuation: "strong spike cancelled: continuation detected",
  opposite_side_price_too_high: "opposite-side quote too high",
  market_quotes_too_neutral: "market quotes too neutral",
  no_signal_below_borderline: "no signal: movement below borderline threshold",
  feed_stale: "market data feed stale (no recent Binance book/trade updates)",
  quote_feed_stale:
    "legacy: binary quote feed stale (maps to feed_stale in new logs)",
};

function dedupeAndOrder(
  reasons: readonly NormalizedRejectionReason[]
): NormalizedRejectionReason[] {
  const uniq = new Set(reasons);
  return ORDER.filter((r) => uniq.has(r));
}

function normalizeRawReason(
  raw: string,
  movementClassification: EntryEvaluation["movementClassification"]
): NormalizedRejectionReason | null {
  if (raw === "invalid_market_prices") return "invalid_market_prices";
  if (raw === "opposite_side_price_too_high" || raw === "opposite_side_too_expensive") {
    return "opposite_side_price_too_high";
  }
  if (raw === "market_quotes_too_neutral") return "market_quotes_too_neutral";
  if (raw === "feed_stale") return "feed_stale";
  if (raw === "quote_feed_stale") return "quote_feed_stale";
  if (raw === "market_not_stable" || raw === "range_too_noisy_for_entry") {
    return "pre_spike_range_too_noisy";
  }
  if (
    raw === "continuation_same_direction" ||
    raw === "strong_spike_same_direction" ||
    raw === "overridden_by_strong_spike"
  ) {
    return "borderline_cancelled_continuation";
  }
  if (raw === "strong_spike_confirmation_continuation") {
    return "strong_spike_continuation";
  }
  if (raw === "cooldown_blocked") return "entry_cooldown_active";
  if (
    raw === "quality_gate_rejected" ||
    raw === "quality_gate_requires_delayed_confirmation"
  ) {
    return "quality_gate_rejected";
  }
  if (raw === "prior_range_too_wide_for_mean_reversion") {
    return "prior_range_too_wide_for_mean_reversion";
  }
  if (raw === "hard_reject_unstable_pre_spike_context") {
    return "hard_reject_unstable_pre_spike_context";
  }
  if (raw === "spike_not_strong_enough") {
    if (movementClassification === "borderline") return "borderline_watch_pending";
    if (movementClassification === "no_signal") return "no_signal_below_borderline";
    return null;
  }
  return null;
}

export function normalizeEntryReasons(
  entry: Pick<EntryEvaluation, "movementClassification" | "reasons">
): NormalizedRejectionReason[] {
  const reasons: NormalizedRejectionReason[] = [];
  for (const r of entry.reasons) {
    const n = normalizeRawReason(r, entry.movementClassification);
    if (n !== null) reasons.push(n);
  }
  if (reasons.length === 0) {
    if (entry.movementClassification === "borderline") {
      reasons.push("borderline_watch_pending");
    } else if (entry.movementClassification === "no_signal") {
      reasons.push("no_signal_below_borderline");
    }
  }
  return dedupeAndOrder(reasons);
}

/**
 * Normalize raw rejection strings (e.g. from {@link Opportunity.entryRejectionReasons})
 * using the same mapping as decision/entry normalization.
 */
export function normalizeOpportunityRejectionReasons(input: {
  rawReasons: readonly string[];
  movementClassification: EntryEvaluation["movementClassification"];
}): NormalizedRejectionReason[] {
  const reasons: NormalizedRejectionReason[] = [];
  for (const r of input.rawReasons) {
    const n = normalizeRawReason(r, input.movementClassification);
    if (n !== null) reasons.push(n);
  }
  return dedupeAndOrder(reasons);
}

export function normalizeDecisionRejectionReasons(input: {
  decision: StrategyDecision;
  entry?: Pick<EntryEvaluation, "movementClassification" | "reasons">;
  hasOpenPosition?: boolean;
}): NormalizedRejectionReason[] {
  const { decision, entry, hasOpenPosition = false } = input;
  const out: NormalizedRejectionReason[] = [];

  if (
    decision.action === "enter_immediate" ||
    decision.action === "promote_borderline_candidate"
  ) {
    return [];
  }
  if (decision.action === "create_borderline_candidate") {
    return ["borderline_watch_pending"];
  }

  if (decision.criticalBlockerUsed === "missing_quote_data") {
    out.push("missing_quote_data");
  } else if (decision.criticalBlockerUsed === "invalid_market_prices") {
    out.push("invalid_market_prices");
  } else if (decision.criticalBlockerUsed === "active_position_or_cooldown") {
    out.push(hasOpenPosition ? "active_position_open" : "entry_cooldown_active");
  } else if (decision.criticalBlockerUsed === "quality_gate_rejected") {
    out.push("quality_gate_rejected");
  } else if (
    decision.criticalBlockerUsed === "hard_reject_unstable_pre_spike_context"
  ) {
    out.push("hard_reject_unstable_pre_spike_context");
  } else if (decision.criticalBlockerUsed === "feed_stale") {
    out.push("feed_stale");
  } else if (decision.criticalBlockerUsed === "quote_feed_stale") {
    out.push("quote_feed_stale");
  } else if (decision.criticalBlockerUsed === "poor_range_hard_reject") {
    out.push("pre_spike_range_too_noisy");
  }

  const decisionReason = normalizeRawReason(
    decision.reason,
    decision.movementClassification
  );
  if (decisionReason !== null) out.push(decisionReason);

  if (entry !== undefined) {
    out.push(...normalizeEntryReasons(entry));
  }

  if (out.length === 0) {
    if (decision.movementClassification === "borderline") {
      out.push("borderline_watch_pending");
    } else if (decision.movementClassification === "no_signal") {
      out.push("no_signal_below_borderline");
    }
  }

  return dedupeAndOrder(out);
}

export function normalizeBorderlineLifecycleRejection(input: {
  type: "created" | "watch" | "cancelled" | "expired";
  reason: string;
}): NormalizedRejectionReason[] {
  if (input.type === "created" || input.type === "watch") {
    return ["borderline_watch_pending"];
  }
  const normalized = normalizeRawReason(input.reason, "borderline");
  if (normalized !== null) return [normalized];
  return ["borderline_watch_pending"];
}

