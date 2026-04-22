import type { EntryDirection, EntryEvaluation } from "../../entryConditions.js";
import type { QualityProfile } from "../../preEntryQualityGate.js";
import { logMonitorDebug } from "../../monitor/monitorDebugLog.js";
import {
  DEFAULT_BINARY_EDGE_STRATEGY_SEMANTICS,
  type BinaryEdgeStrategySemantics,
  binaryLegFromDirection,
  fairBuyLegProbabilityFromMomentumUp,
} from "../entry/edgeEntryDecision.js";

/** Prefix for grep / JSONL-style parsing alongside other monitor debug lines. */
export const BINARY_PRE_ENTRY_AUDIT_TAG = "[binary-pre-entry-audit]";

export const BINARY_PRE_ENTRY_REJECT_INVALID_OUTCOME_FILL =
  "invalid_outcome_fill" as const;
export const BINARY_PRE_ENTRY_REJECT_MAX_ENTRY_PRICE =
  "binary_max_entry_price_exceeded" as const;
/** YES mid outside tradeable band (near-resolved market). */
export const BINARY_PRE_ENTRY_REJECT_YES_MID_EXTREME =
  "binary_yes_mid_extreme" as const;
/** Venue book spread above configured `binaryHardMaxSpreadBps`. */
export const BINARY_PRE_ENTRY_REJECT_SPREAD_TOO_WIDE_HARD =
  "spread_too_wide_hard_block" as const;
export const BINARY_PRE_ENTRY_REJECT_STAKE_ZERO = "stake_size_zero" as const;

export type BinaryPreEntryAuditRecord = {
  spikeDirection: "UP" | "DOWN" | null;
  movementClassification: EntryEvaluation["movementClassification"];
  strategyDirection: EntryDirection;
  chosenSide: "YES" | "NO";
  /** Momentum-style P(BTC up) — same series as tick `estimatedProbabilityUp`. */
  momentumProbabilityUp: number | null;
  /**
   * Fair P on the bought token for edge, from `momentumProbabilityUp` + `edgeStrategySemantics`
   * (default contrarian: not raw momentum P on that token).
   */
  fairProbabilityBuyLeg: number | null;
  edgeStrategySemantics: BinaryEdgeStrategySemantics;
  venueYesMid: number;
  venueNoMid: number;
  resolvedYesAsk: number;
  resolvedNoAsk: number;
  entryModelEdge: number | null;
  minEdgeThreshold: number;
  qualityProfile: QualityProfile | null;
  action: "enter" | "reject";
  primaryRejectionReason: string | null;
};

function spikeDirectionFromEntry(
  entry: EntryEvaluation
): "UP" | "DOWN" | null {
  const d =
    entry.windowSpike?.strongestMoveDirection ??
    entry.movement.strongestMoveDirection;
  if (d === "UP" || d === "DOWN") return d;
  return null;
}

/**
 * Single structured record for binary paper: strategy vs momentum probability vs venue asks vs edge gates.
 * Use with {@link logBinaryPreEntryAuditDebug} (DEBUG_MONITOR only).
 */
export function buildBinaryPreEntryAuditRecord(input: {
  entry: EntryEvaluation;
  venueYesMid: number;
  venueNoMid: number;
  resolvedYesAsk: number;
  resolvedNoAsk: number;
  estimatedProbabilityUp: number | undefined;
  entryModelEdge: number;
  minEdgeThreshold: number;
  qualityProfile: QualityProfile | undefined;
  action: "enter" | "reject";
  primaryRejectionReason: string | null;
}): BinaryPreEntryAuditRecord {
  const direction = input.entry.direction!;
  const chosenSide = binaryLegFromDirection(direction);
  const pUp = input.estimatedProbabilityUp;
  const pUpOk = pUp !== undefined && Number.isFinite(pUp);
  const semantics = DEFAULT_BINARY_EDGE_STRATEGY_SEMANTICS;
  const fairBuy = pUpOk
    ? fairBuyLegProbabilityFromMomentumUp(pUp!, chosenSide, semantics)
    : null;

  return {
    spikeDirection: spikeDirectionFromEntry(input.entry),
    movementClassification: input.entry.movementClassification,
    strategyDirection: direction,
    chosenSide,
    momentumProbabilityUp: pUpOk ? pUp! : null,
    fairProbabilityBuyLeg: fairBuy,
    edgeStrategySemantics: semantics,
    venueYesMid: input.venueYesMid,
    venueNoMid: input.venueNoMid,
    resolvedYesAsk: input.resolvedYesAsk,
    resolvedNoAsk: input.resolvedNoAsk,
    entryModelEdge: Number.isFinite(input.entryModelEdge)
      ? input.entryModelEdge
      : null,
    minEdgeThreshold: input.minEdgeThreshold,
    qualityProfile: input.qualityProfile ?? null,
    action: input.action,
    primaryRejectionReason: input.primaryRejectionReason,
  };
}

/** Pretty, JSON-shaped block; only emitted when `DEBUG_MONITOR` is enabled (via `logMonitorDebug`). */
export function formatBinaryPreEntryAuditBlock(record: BinaryPreEntryAuditRecord): string {
  return `${BINARY_PRE_ENTRY_AUDIT_TAG}\n${JSON.stringify(record, null, 2)}`;
}

export function logBinaryPreEntryAuditDebug(record: BinaryPreEntryAuditRecord): void {
  logMonitorDebug(formatBinaryPreEntryAuditBlock(record));
}
