import type { EntryDirection } from "../../entryConditions.js";
import type { ExecutableTopOfBook } from "../../market/types.js";
import {
  type BinaryEdgeStrategySemantics,
  fairBuyLegProbabilityFromMomentumUp,
} from "./binaryEdgeSemantics.js";

/** Binary paper: skip when MR model edge is NaN, missing, or not strictly positive. */
export const BINARY_ENTRY_REJECTION_NEGATIVE_OR_ZERO_MODEL_EDGE =
  "negative_or_zero_model_edge" as const;

/** Binary paper: edge > 0 but `(model − ask) ≤ MIN_EDGE_THRESHOLD` when that threshold > 0. */
export const BINARY_ENTRY_REJECTION_MODEL_EDGE_BELOW_MIN_THRESHOLD =
  "binary_model_edge_below_min_threshold" as const;

/**
 * Legacy knob for {@link fairBuyLegProbabilityFromMomentumUp} / {@link BinaryEdgeStrategySemantics}.
 * Prefer thinking in terms of strategy semantics (contrarian vs momentum) — see `binaryEdgeSemantics.ts`.
 *
 * - `momentum` → `momentum_continuation` (P(YES)=p_up, P(NO)=1−p_up).
 * - `mean_reversion` (default) → `contrarian_mean_reversion` (fade; allineato a `evaluateEntryConditions`).
 */
export type BinaryEdgeProbabilityModel = "momentum" | "mean_reversion";

const LEGACY_EDGE_MODEL_TO_STRATEGY: Record<
  BinaryEdgeProbabilityModel,
  BinaryEdgeStrategySemantics
> = {
  momentum: "momentum_continuation",
  mean_reversion: "contrarian_mean_reversion",
};

/** Default edge semantics for this spike bot (contrarian strategy on BTC mids). */
export const DEFAULT_BINARY_EDGE_STRATEGY_SEMANTICS: BinaryEdgeStrategySemantics =
  "contrarian_mean_reversion";

/**
 * Maps momentum `estimatedProbabilityUp` to model P(bought outcome) for edge = P − ask.
 * Prefer {@link fairBuyLegProbabilityFromMomentumUp} per naming esplicito.
 */
export function modelProbabilityOnBoughtLeg(
  estimatedProbabilityUp: number,
  side: "YES" | "NO",
  model: BinaryEdgeProbabilityModel
): number {
  return fairBuyLegProbabilityFromMomentumUp(
    estimatedProbabilityUp,
    side,
    LEGACY_EDGE_MODEL_TO_STRATEGY[model]
  );
}

export type { BinaryEdgeStrategySemantics, MomentumProbabilityUp } from "./binaryEdgeSemantics.js";
export { fairBuyLegProbabilityFromMomentumUp } from "./binaryEdgeSemantics.js";

/**
 * Edge gate: compare **fair P(buy leg)** (da momentum p_up + semantica strategia) al venue ask.
 * Default: contrarian / mean-reversion mapping; see `BinaryEdgeProbabilityModel`.
 */
export type EdgeEntryTradeContext = {
  /** Momentum-style P(up) dal motore BTC — non confondere con P(YES) token senza mapping. */
  estimatedProbabilityUp: number;
  marketPriceYesAsk: number;
  marketPriceNoAsk: number;
  minEdgeThreshold: number;
  /** Aggressive buy target (strategy UP → YES, DOWN → NO). */
  side: "YES" | "NO";
  /** @default "mean_reversion" */
  edgeProbabilityModel?: BinaryEdgeProbabilityModel;
};

export type EdgeEntryDecision = "enter" | "skip";

export type EdgeEntryTradeResult = {
  shouldEnter: boolean;
  decision: EdgeEntryDecision;
  /** Model probability for the chosen `side`. */
  probability: number;
  /** Ask paid on that side. */
  marketPrice: number;
  edge: number;
  side: "YES" | "NO";
  minEdgeThreshold: number;
};

/** UP → buy YES; DOWN → buy NO (same as paper binary). */
export function binaryLegFromDirection(direction: EntryDirection): "YES" | "NO" {
  return direction === "UP" ? "YES" : "NO";
}

/** Ask from mid with half-spread in bps (matches synthetic / fallback venue books). */
export function estimateOutcomeAskFromMid(mid: number, spreadBps: number): number {
  if (!Number.isFinite(mid) || mid <= 0) return Number.NaN;
  const s = Math.max(0, spreadBps);
  const half = (mid * s) / 10_000 / 2;
  return Math.min(1 - 1e-6, mid + half);
}

/** YES ask from venue book; NO ask approximated from NO mid + same bps half-spread as YES book. */
export function resolveBinaryVenueAsks(input: {
  executionBook: ExecutableTopOfBook;
  yesMid: number;
  noMid: number;
}): { yesAsk: number; noAsk: number } {
  return {
    yesAsk: input.executionBook.bestAsk,
    noAsk: estimateOutcomeAskFromMid(input.noMid, input.executionBook.spreadBps),
  };
}

/**
 * `edge = probability_model − market_ask` on the buy leg; enter only if `edge > minEdgeThreshold`.
 * If `minEdgeThreshold <= 0`, this function does not apply a minimum-edge filter (always “enter” here).
 * `SimulationEngine` binary mode still requires strictly positive `computeBinaryEntryEdge` first.
 */
export function shouldEnterTrade(context: EdgeEntryTradeContext): EdgeEntryTradeResult {
  const {
    estimatedProbabilityUp,
    marketPriceYesAsk,
    marketPriceNoAsk,
    minEdgeThreshold,
    side,
    edgeProbabilityModel = "mean_reversion",
  } = context;

  const modelProb = modelProbabilityOnBoughtLeg(
    estimatedProbabilityUp,
    side,
    edgeProbabilityModel
  );
  const marketPrice = side === "YES" ? marketPriceYesAsk : marketPriceNoAsk;
  const edge = modelProb - marketPrice;

  if (minEdgeThreshold <= 0) {
    return {
      shouldEnter: true,
      decision: "enter",
      probability: modelProb,
      marketPrice,
      edge,
      side,
      minEdgeThreshold,
    };
  }

  if (
    !Number.isFinite(estimatedProbabilityUp) ||
    !Number.isFinite(marketPriceYesAsk) ||
    !Number.isFinite(marketPriceNoAsk) ||
    !Number.isFinite(minEdgeThreshold)
  ) {
    return {
      shouldEnter: false,
      decision: "skip",
      probability: Number.isFinite(modelProb) ? modelProb : Number.NaN,
      marketPrice: Number.isFinite(marketPrice) ? marketPrice : Number.NaN,
      edge: Number.NaN,
      side,
      minEdgeThreshold,
    };
  }

  const shouldEnter = edge > minEdgeThreshold;
  return {
    shouldEnter,
    decision: shouldEnter ? "enter" : "skip",
    probability: modelProb,
    marketPrice,
    edge,
    side,
    minEdgeThreshold,
  };
}

/**
 * Fair P(buy leg) − ask sul lato scelto da `direction` (UP→YES, DOWN→NO strategia spike).
 * `estimatedProbabilityUp` è sempre momentum; il default applica semantica contrarian per l’edge.
 */
export function computeBinaryEntryEdge(input: {
  estimatedProbabilityUp: number;
  direction: EntryDirection;
  yesAsk: number;
  noAsk: number;
  /** @default "mean_reversion" (= contrarian fair da p_up momentum) */
  edgeProbabilityModel?: BinaryEdgeProbabilityModel;
}): number {
  const side = binaryLegFromDirection(input.direction);
  const model = modelProbabilityOnBoughtLeg(
    input.estimatedProbabilityUp,
    side,
    input.edgeProbabilityModel ?? "mean_reversion"
  );
  const mkt = side === "YES" ? input.yesAsk : input.noAsk;
  return model - mkt;
}

export function formatEdgeEntryLogLine(r: EdgeEntryTradeResult): string {
  const p = Number.isFinite(r.probability) ? r.probability.toFixed(4) : "NaN";
  const m = Number.isFinite(r.marketPrice) ? r.marketPrice.toFixed(4) : "NaN";
  const e = Number.isFinite(r.edge) ? r.edge.toFixed(4) : "NaN";
  return `[edge-entry] side=${r.side} p=${p} mkt=${m} edge=${e} thr=${r.minEdgeThreshold.toFixed(4)} → ${r.decision}`;
}
