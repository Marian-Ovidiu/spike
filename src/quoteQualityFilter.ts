import type { EntryDirection } from "./entryConditions.js";

export type QuoteQualityInput = {
  upSidePrice: number;
  downSidePrice: number;
  direction: EntryDirection | null;
  entryPrice: number;
  maxOppositeSideEntryPrice: number;
  neutralQuoteBandMin: number;
  neutralQuoteBandMax: number;
};

export type QuoteQualityBlocker =
  | "market_quotes_too_neutral"
  | "opposite_side_price_too_high";

export function evaluateQuoteQuality(
  input: QuoteQualityInput
): QuoteQualityBlocker | null {
  if (input.direction === null) return null;
  const neutralBandMin = Math.min(input.neutralQuoteBandMin, input.neutralQuoteBandMax);
  const neutralBandMax = Math.max(input.neutralQuoteBandMin, input.neutralQuoteBandMax);
  const marketQuotesTooNeutral =
    input.upSidePrice >= neutralBandMin &&
    input.upSidePrice <= neutralBandMax &&
    input.downSidePrice >= neutralBandMin &&
    input.downSidePrice <= neutralBandMax;
  if (marketQuotesTooNeutral) return "market_quotes_too_neutral";
  const oppositeSidePrice =
    input.direction === "UP" ? input.upSidePrice : input.downSidePrice;
  const maxAllowedOpposite = Math.min(
    input.entryPrice,
    input.maxOppositeSideEntryPrice
  );
  return oppositeSidePrice > maxAllowedOpposite
    ? "opposite_side_price_too_high"
    : null;
}
