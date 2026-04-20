import type { BinaryQuoteSessionSnapshot } from "../binary/monitor/binaryMonitorQuoteStats.js";
import type { MarketMode } from "../market/types.js";

/** Minimum valid-quote ticks before calling the venue “sticky”. */
const VENUE_FLAT_MIN_VALID_QUOTES = 10;
/** Flat-quote share (%) at or above this ⇒ venue pair rarely changes tick-to-tick. */
const VENUE_FLAT_FLAT_QUOTE_PCT = 34;
/** At or below this flat % (with enough ticks) ⇒ frequent YES/NO pair transitions. */
const VENUE_ACTIVE_REPRICE_MAX_FLAT_PCT = 24;
const STALE_TICKS_OBSERVED = 28;
const STALE_MAX_VALID_QUOTE_TICKS = 4;

export type SessionInterpretationRuntimeSnapshot = {
  ticksObserved: number;
  noSignalMoves: number;
  borderlineMoves: number;
  strongSpikeMoves: number;
  validOpportunities: number;
  rejectedOpportunities: number;
  rejectedByWeakSpikeQuality: number;
  blockedByInvalidQuotes: number;
  blockedByExpensiveOppositeSide: number;
  blockedByNeutralQuotes: number;
  rejectedByPriorRangeTooWide: number;
  rejectedByHardUnstableContext: number;
  cooldownOverridesUsed: number;
  exceptionalSpikeEntries: number;
};

export type BuildSessionInterpretationInput = {
  marketMode: MarketMode;
  runtime: SessionInterpretationRuntimeSnapshot;
  /** Binary monitor only; omit or null in spot mode. */
  binaryQuote: BinaryQuoteSessionSnapshot | null;
};

function dominantNoSignal(r: SessionInterpretationRuntimeSnapshot): boolean {
  return r.noSignalMoves > r.borderlineMoves + r.strongSpikeMoves;
}

/** YES/NO rounded pair rarely changes between valid-quote ticks. */
export function isBinaryVenueGenuinelyFlat(
  q: BinaryQuoteSessionSnapshot | null
): boolean {
  if (q === null) return false;
  if (q.ticksWithValidQuote < VENUE_FLAT_MIN_VALID_QUOTES) return false;
  return q.flatQuotePercent >= VENUE_FLAT_FLAT_QUOTE_PCT;
}

/** Enough valid quotes and frequent pair transitions (not a sticky book). */
export function isBinaryVenueRepricingActively(
  q: BinaryQuoteSessionSnapshot | null
): boolean {
  if (q === null) return false;
  if (q.ticksWithValidQuote < 3) return false;
  return q.flatQuotePercent <= VENUE_ACTIVE_REPRICE_MAX_FLAT_PCT;
}

/** Many monitor ticks but almost no parseable binary quotes. */
export function isBinaryVenueLikelyStale(
  r: SessionInterpretationRuntimeSnapshot,
  q: BinaryQuoteSessionSnapshot | null
): boolean {
  if (q === null) return false;
  return (
    r.ticksObserved >= STALE_TICKS_OBSERVED &&
    q.ticksWithValidQuote <= STALE_MAX_VALID_QUOTE_TICKS
  );
}

/**
 * Short shutdown strings for `session-summary.json` and console.
 * In **binary** mode, “market too flat” refers to **venue** stickiness (quote pair),
 * not to “no spike” on the BTC signal path.
 */
export function buildSessionInterpretationLines(
  input: BuildSessionInterpretationInput
): string[] {
  const { marketMode, runtime: r, binaryQuote: q } = input;
  const lines: string[] = [];

  if (r.rejectedByWeakSpikeQuality > r.validOpportunities) {
    lines.push("too many weak spikes rejected");
  }
  const trendNoiseFiltered =
    r.rejectedByPriorRangeTooWide + r.rejectedByHardUnstableContext;
  if (trendNoiseFiltered >= r.validOpportunities) {
    lines.push("trend/noise filter removed most signals");
  }
  const blockedByBook =
    r.blockedByInvalidQuotes +
    r.blockedByExpensiveOppositeSide +
    r.blockedByNeutralQuotes;
  if (blockedByBook > 0 && blockedByBook >= r.validOpportunities) {
    lines.push("wide spread or invalid book blocked most entries");
  }

  if (marketMode === "binary" && isBinaryVenueLikelyStale(r, q)) {
    lines.push(
      "binary venue: few valid quote ticks vs monitor ticks (check stale venue or feed wiring)"
    );
  }

  const venueFlat = marketMode === "binary" && isBinaryVenueGenuinelyFlat(q);
  const venueActive = marketMode === "binary" && isBinaryVenueRepricingActively(q);

  if (venueFlat) {
    lines.push("market too flat");
  } else if (marketMode === "spot" && dominantNoSignal(r)) {
    lines.push("market too flat");
  }

  if (dominantNoSignal(r)) {
    if (marketMode === "binary" && !venueFlat) {
      if (isBinaryVenueLikelyStale(r, q)) {
        /* stale line already covers venue health */
      } else if (venueActive) {
        lines.push(
          "venue repriced often; underlying path stayed below spike/borderline thresholds"
        );
      } else if (q !== null && q.ticksWithValidQuote >= VENUE_FLAT_MIN_VALID_QUOTES) {
        lines.push(
          "movement detector: most ticks had no strong or borderline spike (moderate venue churn)"
        );
      } else {
        lines.push(
          "movement detector: most ticks had no strong or borderline spike (insufficient venue stats)"
        );
      }
    }
  }

  if (r.cooldownOverridesUsed > 0 && r.exceptionalSpikeEntries > 0) {
    lines.push("exceptional spikes bypassed cooldown successfully");
  }
  if (r.validOpportunities > 0 && r.validOpportunities < r.rejectedOpportunities) {
    lines.push("strategy now focuses on high-quality setups");
  }
  if (lines.length === 0) {
    lines.push("session mixed: monitor movement mix and blocker counters");
  }
  return lines;
}
