import { describe, expect, it } from "vitest";

import { config as defaultConfig } from "./config.js";
import {
  ENTRY_REASON_CODES,
  evaluateEntryConditions,
} from "./entryConditions.js";
import {
  buildOpportunityFromReadyTick,
  OpportunityTracker,
} from "./opportunityTracker.js";

const cfg = defaultConfig;

function makeStableThenSpikePrices(
  flat: number,
  nFlat: number,
  spikeTo: number
): number[] {
  const out: number[] = [];
  for (let i = 0; i < nFlat; i++) out.push(flat);
  out.push(spikeTo);
  return out;
}

describe("buildOpportunityFromReadyTick", () => {
  it("returns null when raw spike threshold is not exceeded", () => {
    const prices = makeStableThenSpikePrices(100_000, 10, 100_010);
    const prev = 100_000;
    const last = 100_010;
    const entry = evaluateEntryConditions({
      prices,
      rangeThreshold: cfg.rangeThreshold,
      previousPrice: prev,
      currentPrice: last,
      spikeThreshold: cfg.spikeThreshold,
      spikeMinRangeMultiple: cfg.spikeMinRangeMultiple,
      entryPrice: cfg.entryPrice,
      upSidePrice: 0.15,
      downSidePrice: 0.15,
    });
    const o = buildOpportunityFromReadyTick({
      timestamp: 0,
      btcPrice: last,
      prices,
      previousPrice: prev,
      currentPrice: last,
      sides: { upSidePrice: 0.15, downSidePrice: 0.15 },
      entry,
      config: cfg,
    });
    expect(o).toBeNull();
  });

  it("records rejected opportunity when prior range is not stable", () => {
    const prices: number[] = [];
    for (let i = 0; i < 10; i++) prices.push(100_000 + i * 500);
    prices.push(106_000);
    const prev = prices[prices.length - 2]!;
    const last = prices[prices.length - 1]!;
    const entry = evaluateEntryConditions({
      prices,
      rangeThreshold: cfg.rangeThreshold,
      previousPrice: prev,
      currentPrice: last,
      spikeThreshold: cfg.spikeThreshold,
      spikeMinRangeMultiple: cfg.spikeMinRangeMultiple,
      entryPrice: cfg.entryPrice,
      upSidePrice: 0.15,
      downSidePrice: 0.15,
    });
    const o = buildOpportunityFromReadyTick({
      timestamp: 1,
      btcPrice: last,
      prices,
      previousPrice: prev,
      currentPrice: last,
      sides: { upSidePrice: 0.15, downSidePrice: 0.15 },
      entry,
      config: cfg,
    });
    expect(o).not.toBeNull();
    expect(o!.status).toBe("rejected");
    expect(o!.entryRejectionReasons).toContain(
      ENTRY_REASON_CODES.MARKET_NOT_STABLE
    );
    expect(o!.entryAllowed).toBe(false);
  });

  it("records valid opportunity when gates pass and opposite leg is cheap", () => {
    const prev = 100_000;
    const last = 100_700;
    const prices = makeStableThenSpikePrices(prev, 10, last);
    const entry = evaluateEntryConditions({
      prices,
      rangeThreshold: cfg.rangeThreshold,
      previousPrice: prev,
      currentPrice: last,
      spikeThreshold: cfg.spikeThreshold,
      spikeMinRangeMultiple: cfg.spikeMinRangeMultiple,
      entryPrice: cfg.entryPrice,
      upSidePrice: 0.5,
      downSidePrice: 0.18,
    });
    const o = buildOpportunityFromReadyTick({
      timestamp: 2,
      btcPrice: last,
      prices,
      previousPrice: prev,
      currentPrice: last,
      sides: { upSidePrice: 0.5, downSidePrice: 0.18 },
      entry,
      config: cfg,
    });
    expect(o).not.toBeNull();
    expect(o!.status).toBe("valid");
    expect(o!.entryAllowed).toBe(true);
    expect(o!.entryRejectionReasons).toEqual([]);
    expect(o!.spikeDirection).toBe("UP");
  });
});

describe("OpportunityTracker", () => {
  it("stores opportunities and reports counts", () => {
    const tracker = new OpportunityTracker({ maxStored: 100 });
    const prev = 100_000;
    const last = 100_700;
    const prices = makeStableThenSpikePrices(prev, 10, last);
    const entry = evaluateEntryConditions({
      prices,
      rangeThreshold: cfg.rangeThreshold,
      previousPrice: prev,
      currentPrice: last,
      spikeThreshold: cfg.spikeThreshold,
      spikeMinRangeMultiple: cfg.spikeMinRangeMultiple,
      entryPrice: cfg.entryPrice,
      upSidePrice: 0.5,
      downSidePrice: 0.18,
    });
    const o = tracker.recordFromReadyTick({
      timestamp: 0,
      btcPrice: last,
      prices,
      previousPrice: prev,
      currentPrice: last,
      sides: { upSidePrice: 0.5, downSidePrice: 0.18 },
      entry,
      config: cfg,
    });
    expect(o?.status).toBe("valid");
    expect(tracker.getOpportunities()).toHaveLength(1);
    expect(tracker.counts).toEqual({
      rawSpikeEvents: 1,
      valid: 1,
      rejected: 0,
    });
  });
});
