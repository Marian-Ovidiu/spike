import type { EntryEvaluation } from "./entryConditions.js";
import type { StrategyDecision } from "./strategy/strategyDecisionPipeline.js";

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
  | "quote_feed_stale"
  | "entry_side_price_too_high"
  | "missing_binary_quotes"
  | "negative_or_zero_model_edge"
  | "model_edge_below_min_threshold"
  /**
   * Legacy / rollup bucket — still emitted when raw string is already
   * `pipeline_quality_downgrade`, and used for backward-compatible totals.
   */
  | "pipeline_quality_downgrade"
  /** Strong-spike path: borderline mode off and gate profile is not strong/exceptional. */
  | "pipeline_profile_weak"
  /** Strong-spike path: acceptable profile requires delayed confirmation. */
  | "pipeline_delayed_confirmation_failed"
  /** Strong-spike confirmation tick classified as noisy / unclear. */
  | "pipeline_confirmation_noise"
  /** Strong-spike waiting for confirmation watch tick (non-exceptional profile). */
  | "pipeline_watch_path_blocked"
  /** Strong-spike confirm failed with invalid book/spread while invalid prices also apply. */
  | "pipeline_invalid_market_coupled_downgrade";

/** Sub-categories that replace the generic `pipeline_quality_downgrade` macro-reason. */
export const PIPELINE_QUALITY_DOWNGRADE_DETAIL_REASONS = [
  "pipeline_profile_weak",
  "pipeline_delayed_confirmation_failed",
  "pipeline_confirmation_noise",
  "pipeline_watch_path_blocked",
  "pipeline_invalid_market_coupled_downgrade",
] as const;

export type PipelineQualityDowngradeDetailReason =
  (typeof PIPELINE_QUALITY_DOWNGRADE_DETAIL_REASONS)[number];

const DETAIL_SET: ReadonlySet<string> = new Set(PIPELINE_QUALITY_DOWNGRADE_DETAIL_REASONS);

export function isPipelineQualityDowngradeDetail(
  r: string
): r is PipelineQualityDowngradeDetailReason {
  return DETAIL_SET.has(r);
}

/**
 * True when an opportunity row should count toward the legacy
 * `pipeline_quality_downgrade` funnel / rollup (any explicit detail or legacy token).
 */
export function opportunityHasLegacyPipelineQualityDowngrade(
  reasons: readonly string[]
): boolean {
  if (reasons.includes("pipeline_quality_downgrade")) return true;
  for (const d of PIPELINE_QUALITY_DOWNGRADE_DETAIL_REASONS) {
    if (reasons.includes(d)) return true;
  }
  return false;
}

/**
 * First matching reason wins (same semantics as strong-spike gate funnel).
 * Exported for session summary + opportunity primary blocker.
 */
export const PRIMARY_REJECTION_BLOCKER_PRIORITY: readonly NormalizedRejectionReason[] = [
  "missing_quote_data",
  "missing_binary_quotes",
  "quote_feed_stale",
  "invalid_market_prices",
  "market_quotes_too_neutral",
  "hard_reject_unstable_pre_spike_context",
  "prior_range_too_wide_for_mean_reversion",
  "pre_spike_range_too_noisy",
  "pipeline_invalid_market_coupled_downgrade",
  "pipeline_profile_weak",
  "pipeline_delayed_confirmation_failed",
  "pipeline_confirmation_noise",
  "pipeline_watch_path_blocked",
  "pipeline_quality_downgrade",
  "negative_or_zero_model_edge",
  "model_edge_below_min_threshold",
  "quality_gate_rejected",
  "opposite_side_price_too_high",
  "entry_side_price_too_high",
  "entry_cooldown_active",
  "active_position_open",
  "strong_spike_continuation",
  "borderline_cancelled_continuation",
  "borderline_watch_pending",
  "no_signal_below_borderline",
];

export function pickPrimaryRejectionBlocker(
  reasons: readonly NormalizedRejectionReason[]
): NormalizedRejectionReason | null {
  for (const p of PRIMARY_REJECTION_BLOCKER_PRIORITY) {
    if (reasons.includes(p)) return p;
  }
  return reasons.length > 0 ? reasons[0]! : null;
}

const ORDER: readonly NormalizedRejectionReason[] = [
  "missing_quote_data",
  "invalid_market_prices",
  "active_position_open",
  "entry_cooldown_active",
  "hard_reject_unstable_pre_spike_context",
  "prior_range_too_wide_for_mean_reversion",
  "pre_spike_range_too_noisy",
  "pipeline_invalid_market_coupled_downgrade",
  "pipeline_profile_weak",
  "pipeline_delayed_confirmation_failed",
  "pipeline_confirmation_noise",
  "pipeline_watch_path_blocked",
  "pipeline_quality_downgrade",
  "quality_gate_rejected",
  "borderline_cancelled_continuation",
  "strong_spike_continuation",
  "borderline_watch_pending",
  "opposite_side_price_too_high",
  "market_quotes_too_neutral",
  "no_signal_below_borderline",
  "feed_stale",
  "quote_feed_stale",
  "entry_side_price_too_high",
  "missing_binary_quotes",
  "negative_or_zero_model_edge",
  "model_edge_below_min_threshold",
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
  quote_feed_stale: "binary / outcome quote feed stale",
  entry_side_price_too_high: "bought outcome leg too expensive (binary cap)",
  missing_binary_quotes: "YES/NO prices missing or invalid for binary entry",
  negative_or_zero_model_edge:
    "binary paper: model edge on bought leg is missing, NaN, or not positive",
  model_edge_below_min_threshold:
    "binary paper: model edge does not exceed MIN_EDGE_THRESHOLD",
  pipeline_quality_downgrade:
    "pipeline: quality/watch path blocked entry (legacy rollup)",
  pipeline_profile_weak:
    "pipeline: strong spike blocked — quality profile not strong/exceptional (borderline mode off)",
  pipeline_delayed_confirmation_failed:
    "pipeline: acceptable quality requires delayed confirmation (not satisfied)",
  pipeline_confirmation_noise:
    "pipeline: strong-spike confirmation tick noisy/unclear",
  pipeline_watch_path_blocked:
    "pipeline: strong spike waiting for confirmation watch (non-exceptional profile)",
  pipeline_invalid_market_coupled_downgrade:
    "pipeline: invalid execution book/spread during strong-spike confirmation",
};

function dedupeAndOrder(
  reasons: readonly NormalizedRejectionReason[]
): NormalizedRejectionReason[] {
  const uniq = new Set(reasons);
  return ORDER.filter((r) => uniq.has(r));
}

/** When any of these appear, drop generic `quality_gate_rejected` (downstream blocker is explicit). */
const SUPERSEDES_GENERIC_QUALITY_GATE: ReadonlySet<NormalizedRejectionReason> = new Set([
  "hard_reject_unstable_pre_spike_context",
  "prior_range_too_wide_for_mean_reversion",
  "pipeline_quality_downgrade",
  ...PIPELINE_QUALITY_DOWNGRADE_DETAIL_REASONS,
  "strong_spike_continuation",
  "opposite_side_price_too_high",
  "market_quotes_too_neutral",
  "entry_side_price_too_high",
  "missing_binary_quotes",
  "negative_or_zero_model_edge",
  "model_edge_below_min_threshold",
  "pre_spike_range_too_noisy",
  "entry_cooldown_active",
  "active_position_open",
  "invalid_market_prices",
  "missing_quote_data",
  "feed_stale",
  "quote_feed_stale",
]);

function dropRedundantGenericQualityGate(
  reasons: NormalizedRejectionReason[]
): NormalizedRejectionReason[] {
  if (!reasons.includes("quality_gate_rejected")) return reasons;
  const hasSpecific = reasons.some(
    (r) => r !== "quality_gate_rejected" && SUPERSEDES_GENERIC_QUALITY_GATE.has(r)
  );
  if (!hasSpecific) return reasons;
  return reasons.filter((r) => r !== "quality_gate_rejected");
}

function normalizeStrongSpikeConfirmationTail(
  raw: string
): NormalizedRejectionReason | null {
  if (!raw.startsWith("strong_spike_confirmation_")) return null;
  if (raw === "strong_spike_confirmation_continuation") return null;
  const tail = raw.slice("strong_spike_confirmation_".length);
  if (tail === "noisy_unclear") return "pipeline_confirmation_noise";
  if (tail === "invalid_market_prices" || tail === "spread_too_wide") {
    return "pipeline_invalid_market_coupled_downgrade";
  }
  return "pipeline_confirmation_noise";
}

function normalizeRawReason(
  raw: string,
  movementClassification: EntryEvaluation["movementClassification"]
): NormalizedRejectionReason | null {
  if (raw === "pipeline_quality_downgrade") return "pipeline_quality_downgrade";
  if (raw === "invalid_market_prices") return "invalid_market_prices";
  if (raw === "opposite_side_price_too_high" || raw === "opposite_side_too_expensive") {
    return "opposite_side_price_too_high";
  }
  if (raw === "market_quotes_too_neutral") return "market_quotes_too_neutral";
  if (raw === "neutral_quotes") return "market_quotes_too_neutral";
  if (raw === "entry_side_price_too_high") return "entry_side_price_too_high";
  if (raw === "missing_binary_quotes") return "missing_binary_quotes";
  if (raw === "negative_or_zero_model_edge") return "negative_or_zero_model_edge";
  if (
    raw === "binary_model_edge_below_min_threshold" ||
    raw === "model_edge_below_min_threshold"
  ) {
    return "model_edge_below_min_threshold";
  }
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
  if (raw === "strong_spike_confirmation_noisy_unclear") {
    return "pipeline_confirmation_noise";
  }
  if (raw === "strong_spike_waiting_confirmation_tick") {
    return "pipeline_watch_path_blocked";
  }
  if (raw === "borderline_mode_off_strong_spike_requires_strong_or_exceptional_quality") {
    return "pipeline_profile_weak";
  }
  if (raw === "quality_gate_requires_delayed_confirmation") {
    return "pipeline_delayed_confirmation_failed";
  }
  if (raw === "spread_too_wide") return "invalid_market_prices";
  if (raw === "cooldown_blocked") return "entry_cooldown_active";
  if (raw === "quality_gate_rejected") {
    return "quality_gate_rejected";
  }
  if (raw === "prior_range_too_wide_for_mean_reversion") {
    return "prior_range_too_wide_for_mean_reversion";
  }
  if (raw === "hard_reject_unstable_pre_spike_context") {
    return "hard_reject_unstable_pre_spike_context";
  }
  const conf = normalizeStrongSpikeConfirmationTail(raw);
  if (conf !== null) return conf;
  if (raw === "spike_not_strong_enough") {
    if (movementClassification === "borderline") return "borderline_watch_pending";
    if (movementClassification === "no_signal") return "no_signal_below_borderline";
    return null;
  }
  return null;
}

function appendCoupledInvalidMarketPipeline(
  decision: Pick<
    StrategyDecision,
    "pipelineQualityModifier" | "criticalBlockerUsed"
  >,
  out: NormalizedRejectionReason[]
): void {
  if (out.includes("pipeline_invalid_market_coupled_downgrade")) return;
  if (!out.includes("invalid_market_prices")) return;
  const mod = decision.pipelineQualityModifier?.reason ?? "";
  if (
    mod.startsWith("strong_spike_confirmation_") &&
    mod !== "strong_spike_confirmation_continuation"
  ) {
    out.push("pipeline_invalid_market_coupled_downgrade");
  }
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
  } else if (decision.criticalBlockerUsed === "entry_side_price_too_high") {
    out.push("entry_side_price_too_high");
  } else if (decision.criticalBlockerUsed === "missing_binary_quotes") {
    out.push("missing_binary_quotes");
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

  const merged = dedupeAndOrder(dropRedundantGenericQualityGate(out));
  const withCoupled = [...merged];
  appendCoupledInvalidMarketPipeline(decision, withCoupled);
  return dedupeAndOrder(dropRedundantGenericQualityGate(withCoupled));
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
