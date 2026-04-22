import type { PaperTradeEntryPath } from "./paperEntryPath.js";
import type { QualityProfile } from "./preEntryQualityGate.js";
import type {
  StrategyAction,
  StrategyDecision,
} from "./strategy/strategyDecisionPipeline.js";

/**
 * Frozen snapshot of why a paper trade opened — populated for binary pipeline-backed runs
 * ({@link buildTradeEntryOpenReason}); serialized as `entryOpenReason` on JSONL.
 */
export type TradeEntryOpenReason = {
  pipelineAction: StrategyAction;
  pipelineReason: string;
  entryPath: PaperTradeEntryPath;
  /**
   * True when the fill followed strong-spike confirmation ticks or a borderline candidate watch
   * (distinct from same-tick `strong_spike_immediate`).
   */
  passedWatchOrCandidate: boolean;
  exceptionalQuality: boolean;
  qualityProfile: QualityProfile | null;
  cooldownOverridden: boolean;
  overrideReason: string | null;
  pipelineFastPathUsed: boolean;
  routeKind:
    | "borderline_promote"
    | "strong_spike_confirmation"
    | "strong_spike_immediate";
  /** Stable labels for filtering (`cooldown_override`, `fast_path_entry`, …). */
  tags: readonly string[];
};

function routeKindFromEntryPath(path: PaperTradeEntryPath): TradeEntryOpenReason["routeKind"] {
  if (path === "borderline_promoted" || path === "borderline_delayed") {
    return "borderline_promote";
  }
  if (path === "strong_spike_confirmed") {
    return "strong_spike_confirmation";
  }
  return "strong_spike_immediate";
}

function passedWatchOrCandidate(path: PaperTradeEntryPath): boolean {
  return (
    path === "strong_spike_confirmed" ||
    path === "borderline_promoted" ||
    path === "borderline_delayed"
  );
}

function buildTags(
  decision: StrategyDecision,
  entryPath: PaperTradeEntryPath
): string[] {
  const reason = decision.reason ?? "";
  const tags = new Set<string>();

  if (decision.action === "promote_borderline_candidate") {
    tags.add("promote_borderline");
  }
  if (reason.startsWith("strong_spike_confirmed")) {
    tags.add("strong_spike_confirmation_watch");
  }
  if (reason === "strong_spike_immediate_entry_fast_path") {
    tags.add("fast_path_entry");
  }
  if (decision.fastPathUsed) {
    tags.add("pipeline_fast_path_tick");
  }
  if (decision.cooldownOverridden) {
    tags.add("cooldown_override");
  }
  const orr = decision.overrideReason;
  if (orr !== undefined && orr !== null && orr !== "") {
    tags.add("override");
    tags.add(`override:${orr}`);
  }
  if (orr === "exceptional_spike_cooldown_override") {
    tags.add("exceptional_spike_cooldown_override");
  }
  if (decision.qualityProfile === "exceptional") {
    tags.add("exceptional_quality");
  }

  if (entryPath === "strong_spike_confirmed") {
    tags.add("entry_path_strong_spike_confirmed");
  } else if (entryPath === "strong_spike_immediate") {
    tags.add("entry_path_strong_spike_immediate");
  } else if (entryPath === "borderline_promoted" || entryPath === "borderline_delayed") {
    tags.add("entry_path_borderline_watch");
  }

  return [...tags].sort();
}

/** Build persisted open-reason diagnostics from the strategy decision at entry. */
export function buildTradeEntryOpenReason(
  decision: StrategyDecision,
  entryPath: PaperTradeEntryPath
): TradeEntryOpenReason {
  const qualityProfile = decision.qualityProfile ?? null;
  return {
    pipelineAction: decision.action,
    pipelineReason: decision.reason ?? "",
    entryPath,
    passedWatchOrCandidate: passedWatchOrCandidate(entryPath),
    exceptionalQuality: qualityProfile === "exceptional",
    qualityProfile,
    cooldownOverridden: Boolean(decision.cooldownOverridden),
    overrideReason: decision.overrideReason ?? null,
    pipelineFastPathUsed: Boolean(decision.fastPathUsed),
    routeKind: routeKindFromEntryPath(entryPath),
    tags: buildTags(decision, entryPath),
  };
}
