import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SignalEvaluation } from "../signal/types.js";

const evaluateSignalConditionsMock = vi.hoisted(() => vi.fn());

vi.mock("../signal/signalEvaluate.js", () => ({
  evaluateSignalConditions: evaluateSignalConditionsMock,
}));

import { FuturesPaperEngine } from "../execution/FuturesPaperEngine.js";
import type { Instrument } from "../domain/instrument.js";
import { RiskEngine } from "../risk/RiskEngine.js";
import { RollingPriceBuffer } from "../signal/rollingPriceBuffer.js";
import type { FuturesStackRuntime } from "./futuresStackStep.js";
import { runFuturesStackStep } from "./futuresStackStep.js";

function makeSignalEvaluation(
  actionable: boolean,
  impulseDirection: "up" | "down",
  contrarianDirection: "up" | "down"
): SignalEvaluation {
  return {
    actionable,
    impulseDirection,
    contrarianDirection,
    strength: actionable ? "strong" : "none",
    rejections: actionable ? [] : ["spike_below_threshold"],
    stableRangeDetected: true,
    priorRangeFraction: 0.01,
    stableRangeQuality: "good",
    rangeDecisionNote: "test",
    spikeDetected: actionable,
    movement: {
      strongestMoveFraction: 0.02,
      strongestMoveAbsolute: 2,
      impulseDirection,
      thresholdFraction: 0.01,
      thresholdRatio: 2,
      strength: actionable ? "strong" : "none",
      referenceWindowLabel: "test",
    },
    window: {
      strength: actionable ? "strong" : "none",
      strongestMoveFraction: 0.02,
      strongestMoveAbsolute: 2,
      impulseDirection,
      thresholdFraction: 0.01,
      thresholdRatio: 2,
      referenceWindowLabel: "test",
      borderlineMinRatio: 1,
      detectedStrongWindow: actionable,
      currentSample: 100,
      referencePrice: 98,
      comparisons: [],
    },
  };
}

function makeBook(mid: number) {
  return {
    bestBid: mid - 1,
    bestAsk: mid + 1,
    midPrice: mid,
    spreadBps: (2 / mid) * 10_000,
  };
}

function makeRuntime(): FuturesStackRuntime {
  const contract: Instrument = {
    id: "test:btcusdt",
    venueSymbol: { venue: "test", code: "BTCUSDT" },
    kind: "perpetual_swap",
    baseAsset: "BTC",
    quoteAsset: "USDT",
    tickSize: 1,
    lotSize: 1,
    minQuantity: 1,
    contractMultiplier: 1,
  };
  return {
    instrumentId: "test:btcusdt" as const,
    contract,
    risk: new RiskEngine({
      blockEntriesOnExecutionFeedStale: false,
      blockEntriesOnSignalFeedStale: false,
      maxEntrySpreadBps: 10_000,
      entryCooldownMs: 0,
      baseStakeQuote: 100,
      minTradeSizeQuote: 10,
      maxTradeSizeQuote: 0,
    }),
    paper: new FuturesPaperEngine({
      takeProfitBps: 1_000,
      stopLossBps: 1_000,
      exitTimeoutMs: 0,
      feeRoundTripBps: 0,
      slippageBps: 0,
      exitGracePeriodMs: 1_000,
      forcedExitPenaltyBps: 25,
    }),
    priceBuffer: new RollingPriceBuffer(32),
    minSamples: 11,
    signalInputBase: {
      rangeThreshold: 0.01,
      stableRangeSoftToleranceRatio: 0.5,
      strongSpikeHardRejectPoorRange: false,
      spikeThreshold: 0.01,
      spikeMinRangeMultiple: 1,
      borderlineMinRatio: 1,
      tradableSpikeMinPercent: 0.01,
    },
    feedStaleMaxAgeMs: 0,
    blockEntriesOnExecutionFeedStale: false,
    entryConfirmationTicks: 2,
    entryRequireReversal: true,
    pendingEntry: null,
  };
}

describe("runFuturesStackStep entry confirmation", () => {
  beforeEach(() => {
    evaluateSignalConditionsMock.mockReset();
  });

  it("delays entry until the spike stalls and reverses", () => {
    const rt = makeRuntime();
    const signal = makeSignalEvaluation(true, "up", "down");
    evaluateSignalConditionsMock.mockReturnValue(signal);

    for (let i = 0; i < 11; i += 1) {
      rt.priceBuffer.addPrice(100);
    }

    const step1 = runFuturesStackStep(rt, {
      nowMs: 1_000,
      tradeSequence: 1,
      mid: 100,
      markPrice: 100,
      book: makeBook(100),
      lastMessageAgeMs: 0,
      lastCooldownAnchorMs: null,
    });
    expect(step1.entryConfirmation?.kind).toBe("pending");
    expect(step1.openAttempt).toBeNull();

    const step2 = runFuturesStackStep(rt, {
      nowMs: 2_000,
      tradeSequence: 2,
      mid: 101,
      markPrice: 101,
      book: makeBook(101),
      lastMessageAgeMs: 0,
      lastCooldownAnchorMs: null,
    });
    expect(step2.entryConfirmation?.kind).toBe("pending");
    expect(step2.openAttempt).toBeNull();

    const step3 = runFuturesStackStep(rt, {
      nowMs: 3_000,
      tradeSequence: 3,
      mid: 100,
      markPrice: 100,
      book: makeBook(100),
      lastMessageAgeMs: 0,
      lastCooldownAnchorMs: null,
    });
    expect(step3.entryConfirmation).toBeNull();
    expect(step3.openAttempt?.ok).toBe(true);
    if (!step3.openAttempt?.ok) throw new Error("expected open");
    expect(step3.openAttempt.entryConfirmation?.satisfiedBy).toBe("reversal");
    expect(step3.openAttempt.entryConfirmation?.ticksObserved).toBeGreaterThanOrEqual(2);
  });

  it("cancels the pending entry when the signal disappears", () => {
    const rt = makeRuntime();
    for (let i = 0; i < 11; i += 1) {
      rt.priceBuffer.addPrice(100);
    }

    evaluateSignalConditionsMock.mockReturnValue(
      makeSignalEvaluation(true, "up", "down")
    );

    const step1 = runFuturesStackStep(rt, {
      nowMs: 1_000,
      tradeSequence: 1,
      mid: 100,
      markPrice: 100,
      book: makeBook(100),
      lastMessageAgeMs: 0,
      lastCooldownAnchorMs: null,
    });
    expect(step1.entryConfirmation?.kind).toBe("pending");

    evaluateSignalConditionsMock.mockReturnValue(
      makeSignalEvaluation(false, "up", "down")
    );

    const step2 = runFuturesStackStep(rt, {
      nowMs: 2_000,
      tradeSequence: 2,
      mid: 99,
      markPrice: 99,
      book: makeBook(99),
      lastMessageAgeMs: 0,
      lastCooldownAnchorMs: null,
    });
    expect(step2.entryConfirmation?.kind).toBe("cancelled");
    expect(step2.openAttempt).toBeNull();
  });
});
