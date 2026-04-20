import { describe, expect, it } from "vitest";
import { evaluateBinaryPaperEntryQuotes } from "./binaryQuoteEntryFilter.js";

describe("evaluateBinaryPaperEntryQuotes", () => {
  const base = {
    maxOppositeSideEntryPrice: 0.78,
    maxEntrySidePrice: 0,
    neutralBandMin: 0,
    neutralBandMax: 0,
  };

  it("blocks UP when opposite NO is too expensive vs capped edge", () => {
    const r = evaluateBinaryPaperEntryQuotes({
      binaryOutcomes: { yesPrice: 0.55, noPrice: 0.5 },
      direction: "UP",
      ...base,
      maxOppositeSideEntryPrice: 0.1,
    });
    expect(r).toBe("opposite_side_price_too_high");
  });

  it("blocks DOWN when opposite YES is too expensive", () => {
    const r = evaluateBinaryPaperEntryQuotes({
      binaryOutcomes: { yesPrice: 0.52, noPrice: 0.48 },
      direction: "DOWN",
      ...base,
      maxOppositeSideEntryPrice: 0.1,
    });
    expect(r).toBe("opposite_side_price_too_high");
  });

  it("allows UP when opposite is within cap", () => {
    expect(
      evaluateBinaryPaperEntryQuotes({
        binaryOutcomes: { yesPrice: 0.52, noPrice: 0.45 },
        direction: "UP",
        ...base,
        maxOppositeSideEntryPrice: 0.78,
      })
    ).toBeNull();
  });

  it("blocks when both legs sit in neutral band (optional)", () => {
    const r = evaluateBinaryPaperEntryQuotes({
      binaryOutcomes: { yesPrice: 0.48, noPrice: 0.49 },
      direction: "UP",
      maxOppositeSideEntryPrice: 0.99,
      maxEntrySidePrice: 0,
      neutralBandMin: 0.45,
      neutralBandMax: 0.55,
    });
    expect(r).toBe("market_quotes_too_neutral");
  });

  it("blocks when entry-side raw price exceeds max (optional)", () => {
    const r = evaluateBinaryPaperEntryQuotes({
      binaryOutcomes: { yesPrice: 0.92, noPrice: 0.08 },
      direction: "UP",
      maxOppositeSideEntryPrice: 0.99,
      maxEntrySidePrice: 0.9,
      neutralBandMin: 0,
      neutralBandMax: 0,
    });
    expect(r).toBe("entry_side_price_too_high");
  });

  it("returns missing_binary_quotes when outcomes absent", () => {
    expect(
      evaluateBinaryPaperEntryQuotes({
        binaryOutcomes: null,
        direction: "UP",
        ...base,
      })
    ).toBe("missing_binary_quotes");
  });
});
