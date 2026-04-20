import { describe, expect, it, beforeEach } from "vitest";

import { BinarySyntheticFeed } from "./binary/venue/binarySyntheticFeed.js";
import {
  SYNTHETIC_PRICE_MAX,
  SYNTHETIC_PRICE_MIN,
} from "./binary/venue/syntheticBinaryMarket.js";
import { PaperBinanceFeed } from "./adapters/binanceSpotFeed.js";
import {
  MIN_SAMPLES_FOR_STRATEGY,
  runStrategyTick,
  type BotContext,
} from "./botLoop.js";
import { config } from "./config.js";
import { createSignalAndExecutionFeeds } from "./market/marketFeedFactory.js";
import { opportunityToJsonlRecord } from "./monitorPersistence.js";
import { OpportunityTracker } from "./opportunityTracker.js";
import { RollingPriceBuffer } from "./rollingPriceBuffer.js";
import { SimulationEngine } from "./simulationEngine.js";

describe("signal vs execution feeds (binary mode)", () => {
  let signalFeed: PaperBinanceFeed;
  let executionFeed: BinarySyntheticFeed;
  let ctx: BotContext;

  beforeEach(() => {
    signalFeed = new PaperBinanceFeed({ mid: 100_000, spreadBps: 5 });
    executionFeed = new BinarySyntheticFeed({
      symbol: "TEST-BIN",
      upPrice: 0.52,
      downPrice: 0.48,
      syntheticSpreadBps: 30,
    });
    ctx = {
      priceBuffer: new RollingPriceBuffer(24),
      simulation: new SimulationEngine({ silent: true, initialEquity: 10_000 }),
      opportunityTracker: new OpportunityTracker(),
      config: { ...config, marketMode: "binary", priceBufferSize: 24 },
      signalFeed,
      executionFeed,
      tradeSymbol: executionFeed.getSymbol(),
    };
  });

  it("uses BTC spot for buffer/spike and binary book for execution quotes", async () => {
    for (let i = 0; i < MIN_SAMPLES_FOR_STRATEGY - 1; i += 1) {
      signalFeed.setMid(100_000);
      const t = await runStrategyTick(ctx);
      expect(t.kind === "warming" || t.kind === "ready").toBe(true);
    }
    signalFeed.setMid(102_000);
    const tick = await runStrategyTick(ctx);
    expect(tick.kind).toBe("ready");
    if (tick.kind !== "ready") return;

    expect(tick.underlyingSignalPrice).toBe(102_000);
    expect(tick.last).toBe(102_000);
    expect(tick.estimatedProbabilityUp).toBeDefined();
    if (tick.estimatedProbabilityUp === undefined) return;
    const clampedYes = Math.min(
      SYNTHETIC_PRICE_MAX,
      Math.max(SYNTHETIC_PRICE_MIN, tick.estimatedProbabilityUp)
    );
    expect(tick.executionBook.midPrice).toBeCloseTo(clampedYes, 5);
    expect(tick.binaryOutcomes?.yesPrice).toBeCloseTo(clampedYes, 5);
    expect(tick.binaryOutcomes?.noPrice).toBeCloseTo(
      Math.min(SYNTHETIC_PRICE_MAX, Math.max(SYNTHETIC_PRICE_MIN, 1 - clampedYes)),
      5
    );
    expect(tick.entry.movement.strongestMovePercent).toBeGreaterThan(0.015);

    const opp = ctx.opportunityTracker.recordFromReadyTick({
      timestamp: Date.now(),
      btcPrice: tick.underlyingSignalPrice,
      underlyingSignalPrice: tick.underlyingSignalPrice,
      prices: tick.prices,
      previousPrice: tick.prev,
      currentPrice: tick.last,
      executionBook: tick.executionBook,
      entry: tick.entry,
      marketMode: "binary",
      binaryOutcomes: tick.binaryOutcomes,
    });
    expect(opp).not.toBeNull();
    if (opp === null) return;
    expect(opp.underlyingSignalPrice).toBe(102_000);
    expect(opp.midPrice).toBeCloseTo(clampedYes, 5);
    const row = opportunityToJsonlRecord(opp);
    expect(row.underlyingSignalPrice).toBe(102_000);
    expect(row.yesPrice).toBeCloseTo(clampedYes, 5);
  });
});

describe("spot mode dual feed wiring", () => {
  it("reuses one feed instance for signal and execution", () => {
    const { signalFeed, executionFeed } = createSignalAndExecutionFeeds("spot", {
      paper: true,
    });
    expect(signalFeed).toBe(executionFeed);
  });
});

describe("binary signal symbol wiring", () => {
  it("passes BINARY_SIGNAL_SYMBOL into the Binance signal feed", () => {
    const { signalFeed, executionFeed } = createSignalAndExecutionFeeds("binary", {
      paper: true,
      binarySignalSource: "binance_spot",
      binarySignalSymbol: "ETHUSDT",
    });
    expect(signalFeed).not.toBe(executionFeed);
    expect(signalFeed.getSymbol()).toBe("ETHUSDT");
  });
});
