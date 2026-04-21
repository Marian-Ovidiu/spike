import type { StrategyTickResult } from "../../botLoop.js";
import type { EntryDirection } from "../../entryConditions.js";
import type { ExecutableTopOfBook } from "../../market/types.js";
import { evaluateExecutionBookPipeline } from "../../executionSpreadFilter.js";
import {
  binaryLegFromDirection,
  binarySideFromStrategyDirection,
  computeBinaryEntryEdge,
  resolveBinaryVenueAsks,
} from "../entry/edgeEntryDecision.js";
import { binaryOutcomeBuyFillPrice } from "../paper/binaryPaperExecution.js";
import {
  SYNTHETIC_PRICE_MAX,
  SYNTHETIC_PRICE_MIN,
} from "../venue/syntheticBinaryMarket.js";

/** Exact subreason for `invalid_market_prices` (binary observability). */
export type InvalidMarketPricesSubreason =
  | "invalid_yes_no_bounds"
  | "invalid_executable_price"
  | "invalid_crossed_or_inverted_book"
  | "invalid_price_not_finite"
  | "invalid_market_price_extreme_reprice";

export type InvalidMarketPricesAuditRecord = {
  event: "invalid_market_prices_binary_audit";
  /** Where the audit was emitted (e.g. `strong_spike_watch`, `opportunity_row`). */
  context: string;
  subreason: InvalidMarketPricesSubreason;
  rawGateReason: "invalid_book" | "spread_too_wide" | null;
  yes: { bid: number | null; ask: number | null; mid: number | null };
  no: { bid: number | null; ask: number | null; mid: number | null };
  chosenSide: "YES" | "NO" | null;
  resolvedExecutablePrice: number | null;
  estimatedProbabilityUp: number | null;
  entryModelEdge: number | null;
  executionBook: {
    bestBid: number;
    bestAsk: number;
    midPrice: number;
    spreadBps: number;
  };
};

const SUM_EPS = 0.02;

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return Number.NaN;
  return Math.min(SYNTHETIC_PRICE_MAX, Math.max(SYNTHETIC_PRICE_MIN, x));
}

/** Half-width (absolute on 0–1 scale) matching {@link SyntheticBinaryMarket.getQuoteSnapshot}. */
function halfSpreadAbs(spreadBps: number): number {
  if (!Number.isFinite(spreadBps) || spreadBps < 0) return Number.NaN;
  return spreadBps / 10_000 / 2;
}

function estimateNoBidFromMid(noMid: number, spreadBps: number): number {
  const h = halfSpreadAbs(spreadBps);
  if (!Number.isFinite(noMid) || !Number.isFinite(h)) return Number.NaN;
  return clamp01(noMid - h);
}

/**
 * Classifies why the executable YES-shaped book is rejected by
 * {@link evaluateExecutionBookPipeline}, plus binary leg sanity when mids exist.
 */
export function classifyInvalidMarketPricesSubreason(input: {
  book: ExecutableTopOfBook;
  maxEntrySpreadBps: number;
  yesMid: number | null | undefined;
  noMid: number | null | undefined;
  direction: EntryDirection | null | undefined;
  slippageBps: number;
  estimatedProbabilityUp: number | null | undefined;
}): {
  subreason: InvalidMarketPricesSubreason;
  rawGateReason: "invalid_book" | "spread_too_wide" | null;
} {
  const { book, maxEntrySpreadBps } = input;
  const gate = evaluateExecutionBookPipeline(book, maxEntrySpreadBps);

  if (!Number.isFinite(book.bestBid) || !Number.isFinite(book.bestAsk)) {
    return { subreason: "invalid_price_not_finite", rawGateReason: "invalid_book" };
  }
  if (!Number.isFinite(book.midPrice)) {
    return { subreason: "invalid_price_not_finite", rawGateReason: "invalid_book" };
  }
  if (book.bestAsk < book.bestBid) {
    return { subreason: "invalid_crossed_or_inverted_book", rawGateReason: "invalid_book" };
  }
  if (!Number.isFinite(book.spreadBps)) {
    return { subreason: "invalid_price_not_finite", rawGateReason: "spread_too_wide" };
  }

  if (gate === "spread_too_wide") {
    return {
      subreason: "invalid_market_price_extreme_reprice",
      rawGateReason: "spread_too_wide",
    };
  }

  const yesM = input.yesMid;
  const noM = input.noMid;
  if (
    yesM !== undefined &&
    yesM !== null &&
    noM !== undefined &&
    noM !== null &&
    Number.isFinite(yesM) &&
    Number.isFinite(noM)
  ) {
    if (yesM <= 0 || noM <= 0 || yesM > 1 || noM > 1) {
      return { subreason: "invalid_yes_no_bounds", rawGateReason: gate };
    }
    if (Math.abs(yesM + noM - 1) > SUM_EPS) {
      return { subreason: "invalid_yes_no_bounds", rawGateReason: gate };
    }
  }

  const dir = input.direction ?? null;
  if (
    dir !== null &&
    yesM !== undefined &&
    yesM !== null &&
    noM !== undefined &&
    noM !== null &&
    Number.isFinite(yesM) &&
    Number.isFinite(noM)
  ) {
    const asks = resolveBinaryVenueAsks({
      executionBook: book,
      yesMid: yesM,
      noMid: noM,
    });
    const pUp = input.estimatedProbabilityUp;
    const edge =
      pUp !== undefined && pUp !== null && Number.isFinite(pUp)
        ? computeBinaryEntryEdge({
            estimatedProbabilityUp: pUp,
            direction: dir,
            yesAsk: asks.yesAsk,
            noAsk: asks.noAsk,
          })
        : Number.NaN;
    const side = binarySideFromStrategyDirection(dir);
    const fill = binaryOutcomeBuyFillPrice(side, yesM, noM, input.slippageBps);
    if (!Number.isFinite(fill) || fill <= 0 || fill > 1) {
      return { subreason: "invalid_executable_price", rawGateReason: gate };
    }
    if (Number.isFinite(edge)) {
      const fair = edge + (side === "YES" ? asks.yesAsk : asks.noAsk);
      const mkt = side === "YES" ? asks.yesAsk : asks.noAsk;
      if (Number.isFinite(fair) && Number.isFinite(mkt) && Math.abs(fair - mkt) > 0.35) {
        return { subreason: "invalid_market_price_extreme_reprice", rawGateReason: gate };
      }
    }
  }

  if (gate === "invalid_book") {
    return { subreason: "invalid_price_not_finite", rawGateReason: "invalid_book" };
  }

  return { subreason: "invalid_market_price_extreme_reprice", rawGateReason: gate };
}

export function buildInvalidMarketPricesAuditRecord(input: {
  context: string;
  book: ExecutableTopOfBook;
  maxEntrySpreadBps: number;
  binaryPaperSlippageBps: number;
  yesMid: number | null | undefined;
  noMid: number | null | undefined;
  direction: EntryDirection | null | undefined;
  estimatedProbabilityUp: number | null | undefined;
}): InvalidMarketPricesAuditRecord {
  const { book } = input;
  const yesM =
    input.yesMid !== undefined && input.yesMid !== null && Number.isFinite(input.yesMid)
      ? input.yesMid
      : null;
  const noM =
    input.noMid !== undefined && input.noMid !== null && Number.isFinite(input.noMid)
      ? input.noMid
      : null;

  const yesBid = Number.isFinite(book.bestBid) ? book.bestBid : null;
  const yesAsk = Number.isFinite(book.bestAsk) ? book.bestAsk : null;
  const spreadBps = book.spreadBps;
  const noBid =
    noM !== null && Number.isFinite(spreadBps)
      ? estimateNoBidFromMid(noM, spreadBps)
      : null;
  let noAsk: number | null = null;
  if (noM !== null && Number.isFinite(spreadBps) && Number.isFinite(book.bestAsk)) {
    const asks = resolveBinaryVenueAsks({
      executionBook: book,
      yesMid: yesM ?? book.midPrice,
      noMid: noM,
    });
    noAsk = Number.isFinite(asks.noAsk) ? asks.noAsk : null;
  }

  const dir = input.direction ?? null;
  const chosenSide = dir !== null ? binaryLegFromDirection(dir) : null;
  let resolvedExecutablePrice: number | null = null;
  let entryModelEdge: number | null = null;
  const pUp = input.estimatedProbabilityUp;
  const pUpOk = pUp !== undefined && pUp !== null && Number.isFinite(pUp);

  if (dir !== null && yesM !== null && noM !== null) {
    const asks = resolveBinaryVenueAsks({
      executionBook: book,
      yesMid: yesM,
      noMid: noM,
    });
    if (pUpOk) {
      entryModelEdge = computeBinaryEntryEdge({
        estimatedProbabilityUp: pUp!,
        direction: dir,
        yesAsk: asks.yesAsk,
        noAsk: asks.noAsk,
      });
      if (!Number.isFinite(entryModelEdge)) entryModelEdge = null;
    }
    const side = binarySideFromStrategyDirection(dir);
    const fill = binaryOutcomeBuyFillPrice(
      side,
      yesM,
      noM,
      input.binaryPaperSlippageBps
    );
    resolvedExecutablePrice = Number.isFinite(fill) ? fill : null;
  }

  const { subreason, rawGateReason } = classifyInvalidMarketPricesSubreason({
    book,
    maxEntrySpreadBps: input.maxEntrySpreadBps,
    yesMid: yesM ?? undefined,
    noMid: noM ?? undefined,
    direction: dir ?? undefined,
    slippageBps: input.binaryPaperSlippageBps,
    estimatedProbabilityUp: pUpOk ? pUp! : undefined,
  });

  return {
    event: "invalid_market_prices_binary_audit",
    context: input.context,
    subreason,
    rawGateReason,
    yes: { bid: yesBid, ask: yesAsk, mid: yesM },
    no: {
      bid: noBid !== null && Number.isFinite(noBid) ? noBid : null,
      ask: noAsk,
      mid: noM,
    },
    chosenSide,
    resolvedExecutablePrice,
    estimatedProbabilityUp: pUpOk ? pUp! : null,
    entryModelEdge,
    executionBook: {
      bestBid: book.bestBid,
      bestAsk: book.bestAsk,
      midPrice: book.midPrice,
      spreadBps: book.spreadBps,
    },
  };
}

const AUDIT_TAG = "[invalid-market-prices-audit]";

/** One JSON line per rejection (not gated by DEBUG_MONITOR). */
export function logInvalidMarketPricesBinaryAudit(record: InvalidMarketPricesAuditRecord): void {
  console.log(`${AUDIT_TAG} ${JSON.stringify(record)}`);
}

export function shouldAttachInvalidMarketPricesAudit(input: {
  marketMode: "binary" | "spot" | undefined;
  entryRejectionReasons: readonly string[];
}): boolean {
  if (input.marketMode !== "binary") return false;
  return input.entryRejectionReasons.includes("invalid_market_prices");
}

export function logInvalidMarketPricesBinaryAuditFromReadyTick(input: {
  tick: Extract<StrategyTickResult, { kind: "ready" }>;
  maxEntrySpreadBps: number;
  binaryPaperSlippageBps: number;
  context: string;
  direction: EntryDirection | null | undefined;
}): void {
  const record = buildInvalidMarketPricesAuditRecord({
    context: input.context,
    book: input.tick.executionBook,
    maxEntrySpreadBps: input.maxEntrySpreadBps,
    binaryPaperSlippageBps: input.binaryPaperSlippageBps,
    yesMid: input.tick.binaryOutcomes?.yesPrice,
    noMid: input.tick.binaryOutcomes?.noPrice,
    direction: input.direction,
    estimatedProbabilityUp: input.tick.estimatedProbabilityUp,
  });
  logInvalidMarketPricesBinaryAudit(record);
}
