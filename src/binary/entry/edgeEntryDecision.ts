import type { EntryDirection } from "../../entryConditions.js";
import type { ExecutableTopOfBook } from "../../market/types.js";

/**
 * Edge gate: compare model probability on the buy leg to the venue ask.
 * YES leg uses `estimatedProbability_up`; NO leg uses `1 - estimatedProbability_up`.
 */
export type EdgeEntryTradeContext = {
  estimatedProbabilityUp: number;
  marketPriceYesAsk: number;
  marketPriceNoAsk: number;
  minEdgeThreshold: number;
  /** Aggressive buy target (strategy UP → YES, DOWN → NO). */
  side: "YES" | "NO";
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
 * If `minEdgeThreshold <= 0`, the gate is disabled (always enter from an edge perspective).
 */
export function shouldEnterTrade(context: EdgeEntryTradeContext): EdgeEntryTradeResult {
  const {
    estimatedProbabilityUp,
    marketPriceYesAsk,
    marketPriceNoAsk,
    minEdgeThreshold,
    side,
  } = context;

  const modelProb =
    side === "YES" ? estimatedProbabilityUp : 1 - estimatedProbabilityUp;
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

/** Probability minus ask on the leg implied by `direction` (for sizing / logs). */
export function computeBinaryEntryEdge(input: {
  estimatedProbabilityUp: number;
  direction: EntryDirection;
  yesAsk: number;
  noAsk: number;
}): number {
  const side = binaryLegFromDirection(input.direction);
  const model =
    side === "YES"
      ? input.estimatedProbabilityUp
      : 1 - input.estimatedProbabilityUp;
  const mkt = side === "YES" ? input.yesAsk : input.noAsk;
  return model - mkt;
}

export function formatEdgeEntryLogLine(r: EdgeEntryTradeResult): string {
  const p = Number.isFinite(r.probability) ? r.probability.toFixed(4) : "NaN";
  const m = Number.isFinite(r.marketPrice) ? r.marketPrice.toFixed(4) : "NaN";
  const e = Number.isFinite(r.edge) ? r.edge.toFixed(4) : "NaN";
  return `[edge-entry] side=${r.side} p=${p} mkt=${m} edge=${e} thr=${r.minEdgeThreshold.toFixed(4)} → ${r.decision}`;
}
