import type { AppConfig } from "./config.js";
import {
  evaluateEntryConditions,
  formatEntryReasonsForLog,
} from "./entryConditions.js";
import { logValidOpportunityBlock } from "./monitorConsole.js";
import type { EntryEvaluation } from "./entryConditions.js";
import type { OpportunityTracker } from "./opportunityTracker.js";
import { RollingPriceBuffer } from "./rollingPriceBuffer.js";
import type { SimulationEngine } from "./simulationEngine.js";
import { classifySpikeQuality } from "./spikeQualityClassifier.js";
import type {
  BinaryOutcomePrices,
  ExecutableTopOfBook,
  MarketDataFeed,
} from "./market/types.js";
import { toExecutableTopOfBook } from "./market/types.js";
import {
  estimateProbabilityUpFromPriceBuffer,
} from "./binary/signal/binaryProbabilityEngine.js";
import {
  BinarySyntheticFeed,
  type SyntheticExecutionVenueSnapshot,
} from "./binary/venue/binarySyntheticFeed.js";

/** Live / backtest cadence (ms). */
export const BOT_TICK_INTERVAL_MS = 5_000;

/** Minimum buffer samples before strategy evaluation (stable window + spike context). */
export const MIN_SAMPLES_FOR_STRATEGY = 11;

export type BotContext = {
  priceBuffer: RollingPriceBuffer;
  simulation: SimulationEngine;
  config: AppConfig;
  opportunityTracker: OpportunityTracker;
  /**
   * BTC spot (paper or Binance). Drives {@link RollingPriceBuffer} and spike / movement logic.
   * In spot mode this is the same concrete feed as {@link BotContext.executionFeed}.
   */
  signalFeed: MarketDataFeed;
  /**
   * Executable venue: Binance spot book, or binary synthetic / Polymarket feed for paper fills
   * and spread / quote gates.
   */
  executionFeed: MarketDataFeed;
  /** e.g. BTCUSDT or binary market id — always the execution venue symbol. */
  tradeSymbol: string;
};

export type ReadyTickMarketData = {
  book: ExecutableTopOfBook;
  /** Execution venue: binary quote-stale flag, or spot WebSocket age vs config. */
  feedPossiblyStale: boolean;
};

function feedPossiblyStaleForRole(
  config: AppConfig,
  feed: MarketDataFeed,
  role: "execution" | "signal"
): boolean {
  if (config.marketMode === "binary" && role === "execution") {
    return feed.getQuoteStale().stale;
  }
  const age = feed.getLastMessageAgeMs();
  return Number.isFinite(age) && age > config.feedStaleMaxAgeMs;
}

function resolveExecutableTop(
  feed: MarketDataFeed,
  config: AppConfig,
  staleRole: "execution" | "signal"
): { book: ExecutableTopOfBook; feedPossiblyStale: boolean } | null {
  const b = feed.getNormalizedBook();
  if (b === null) {
    return null;
  }
  return {
    book: toExecutableTopOfBook(b),
    feedPossiblyStale: feedPossiblyStaleForRole(config, feed, staleRole),
  };
}

export type StrategyTickResult =
  | { kind: "no_btc" }
  | { kind: "warming"; btc: number; n: number; cap: number }
  | { kind: "no_book"; btc: number; n: number; cap: number }
  | {
      kind: "ready";
      /** Alias for {@link underlyingSignalPrice} — BTC spot mid in binary mode. */
      btc: number;
      /** BTC spot mid used for buffer / spikes (same as `btc` in spot mode). */
      underlyingSignalPrice: number;
      n: number;
      cap: number;
      prev: number;
      last: number;
      prices: readonly number[];
      /**
       * Executable **venue** top-of-book (binary: tight synthetic book around YES/NO; spot: Binance).
       * Spike / range math uses {@link prices} from the signal feed only — never this mid as BTC.
       */
      executionBook: ExecutableTopOfBook;
      entry: EntryEvaluation;
      market: ReadyTickMarketData;
      /** Populated when `config.marketMode === "binary"` (Polymarket-style paper). */
      binaryOutcomes: BinaryOutcomePrices | null;
      /** Binary: model P(up) from signal buffer at this tick (borderline fast-promote / diagnostics). */
      estimatedProbabilityUp?: number;
      /**
       * Binary + synthetic execution only: strategy fair vs venue-priced YES mid / asks and naive edge.
       * Populated when {@link BinarySyntheticFeed.applySignalProbability} ran this tick.
       */
      syntheticVenuePricing?: SyntheticExecutionVenueSnapshot;
      /** Binary: signal (Binance) feed may be stale by WS age; diagnostic only. */
      signalFeedPossiblyStale?: boolean;
    };

export async function runStrategyTick(
  ctx: BotContext
): Promise<StrategyTickResult> {
  const { priceBuffer, config, signalFeed, executionFeed } = ctx;
  const signalResolved = resolveExecutableTop(signalFeed, config, "signal");
  if (signalResolved === null) {
    return { kind: "no_btc" };
  }
  const signalMid = signalResolved.book.midPrice;
  priceBuffer.addPrice(signalMid);
  const prices = priceBuffer.getPrices();
  const n = prices.length;
  const cap = config.priceBufferSize;

  if (n < MIN_SAMPLES_FOR_STRATEGY) {
    return { kind: "warming", btc: signalMid, n, cap };
  }

  const prev = priceBuffer.getPrevious();
  const last = priceBuffer.getLast();
  if (prev === undefined || last === undefined) {
    return { kind: "warming", btc: signalMid, n, cap };
  }

  const tickNowMs = Date.now();
  const strategyProbabilityUp =
    config.marketMode === "binary"
      ? estimateProbabilityUpFromPriceBuffer({
          prices,
          lastSampleTimeMs: tickNowMs,
          sampleIntervalMs: BOT_TICK_INTERVAL_MS,
          windowSize: config.probabilityWindowSize,
          timeHorizonMs: config.probabilityTimeHorizonMs,
          sigmoidK: config.probabilitySigmoidK,
        })
      : undefined;
  let syntheticVenuePricing: SyntheticExecutionVenueSnapshot | undefined;
  if (
    strategyProbabilityUp !== undefined &&
    config.marketMode === "binary" &&
    executionFeed instanceof BinarySyntheticFeed
  ) {
    executionFeed.applySignalProbability(strategyProbabilityUp, tickNowMs);
    syntheticVenuePricing =
      executionFeed.getSyntheticVenueSnapshot() ?? undefined;
  }

  const executionResolved = resolveExecutableTop(
    executionFeed,
    config,
    "execution"
  );
  if (executionResolved === null) {
    return { kind: "no_book", btc: signalMid, n, cap };
  }
  const { book, feedPossiblyStale } = executionResolved;

  if (!Number.isFinite(book.spreadBps) || book.bestAsk < book.bestBid) {
    return { kind: "no_book", btc: signalMid, n, cap };
  }

  const binaryOutcomes =
    config.marketMode === "binary"
      ? executionFeed.getBinaryOutcomePrices()
      : null;

  const entry = evaluateEntryConditions({
    prices,
    rangeThreshold: config.rangeThreshold,
    stableRangeSoftToleranceRatio: config.stableRangeSoftToleranceRatio,
    strongSpikeHardRejectPoorRange: config.strongSpikeHardRejectPoorRange,
    previousPrice: prev,
    currentPrice: last,
    spikeThreshold: config.spikeThreshold,
    spikeMinRangeMultiple: config.spikeMinRangeMultiple,
    borderlineMinRatio: config.borderlineMinRatio,
    tradableSpikeMinPercent: config.tradableSpikeMinPercent,
    maxEntrySpreadBps: config.maxEntrySpreadBps,
    /** Execution venue — spread gate only; movement uses `prices` / `prev` / `last` from signal. */
    bestBid: book.bestBid,
    bestAsk: book.bestAsk,
    midPrice: book.midPrice,
    spreadBps: book.spreadBps,
  });

  const signalFeedPossiblyStale =
    config.marketMode === "binary"
      ? feedPossiblyStaleForRole(config, signalFeed, "signal")
      : undefined;

  const estimatedProbabilityUp = strategyProbabilityUp;

  return {
    kind: "ready",
    btc: signalMid,
    underlyingSignalPrice: signalMid,
    n,
    cap,
    prev,
    last,
    prices,
    executionBook: book,
    entry,
    market: { book, feedPossiblyStale },
    binaryOutcomes,
    ...(estimatedProbabilityUp !== undefined
      ? { estimatedProbabilityUp }
      : {}),
    ...(syntheticVenuePricing !== undefined ? { syntheticVenuePricing } : {}),
    ...(signalFeedPossiblyStale !== undefined
      ? { signalFeedPossiblyStale }
      : {}),
  };
}

export async function runBotTick(ctx: BotContext): Promise<void> {
  const tick = await runStrategyTick(ctx);
  const now = Date.now();

  if (tick.kind === "no_btc") {
    console.log("[BOT] No signal feed book / feed — skip tick");
    return;
  }

  if (tick.kind === "warming") {
    console.log(
      `[BOT] Warmup ${tick.n}/${MIN_SAMPLES_FOR_STRATEGY} | BTC signal $${tick.btc.toFixed(2)}`
    );
    return;
  }

  if (tick.kind === "no_book") {
    console.log(
      `[BOT] Invalid or missing execution book | BTC signal $${tick.btc.toFixed(2)} | buf ${tick.n}/${tick.cap}`
    );
    return;
  }

  const { entry, executionBook } = tick;

  const entryQualityProfile = ctx.config.allowWeakQualityEntries
    ? classifySpikeQuality(entry, {
        tradableSpikeMinPercent: ctx.config.tradableSpikeMinPercent,
        exceptionalSpikeMinPercent: ctx.config.exceptionalSpikePercent,
        maxPriorRangeForNormalEntry: ctx.config.maxPriorRangeForNormalEntry,
        allowWeakQualityEntries: ctx.config.allowWeakQualityEntries,
        allowWeakQualityOnlyForStrongSpikes:
          ctx.config.allowWeakQualityOnlyForStrongSpikes,
      }).qualityProfile
    : undefined;

  ctx.simulation.onTick({
    now,
    entry,
    marketMode: ctx.config.marketMode,
    binaryOutcomes: tick.binaryOutcomes,
    underlyingSignalPrice: tick.underlyingSignalPrice,
    ...(ctx.config.marketMode === "binary" &&
    tick.estimatedProbabilityUp !== undefined
      ? { estimatedProbabilityUp: tick.estimatedProbabilityUp }
      : {}),
    ...(entryQualityProfile !== undefined
      ? { entryQualityProfile }
      : {}),
    executionBook,
    symbol: ctx.tradeSymbol,
    config: {
      takeProfitBps: ctx.config.takeProfitBps,
      stopLossBps: ctx.config.stopLossBps,
      binaryPaperSlippageBps: ctx.config.binaryPaperSlippageBps,
      paperFeeRoundTripBps: ctx.config.paperFeeRoundTripBps,
      exitTimeoutMs: ctx.config.exitTimeoutMs,
      binaryTakeProfitPriceDelta: ctx.config.binaryTakeProfitPriceDelta,
      binaryStopLossPriceDelta: ctx.config.binaryStopLossPriceDelta,
      binaryExitTimeoutMs: ctx.config.binaryExitTimeoutMs,
      binaryMaxEntryPrice: ctx.config.binaryMaxEntryPrice,
      entryCooldownMs: ctx.config.entryCooldownMs,
      stakePerTrade: ctx.config.stakePerTrade,
      allowWeakQualityEntries: ctx.config.allowWeakQualityEntries,
      weakQualitySizeMultiplier: ctx.config.weakQualitySizeMultiplier,
      strongQualitySizeMultiplier: ctx.config.strongQualitySizeMultiplier,
      exceptionalQualitySizeMultiplier:
        ctx.config.exceptionalQualitySizeMultiplier,
      minEdgeThreshold: ctx.config.minEdgeThreshold,
      riskPercentPerTrade: ctx.config.riskPercentPerTrade,
      maxTradeSize: ctx.config.maxTradeSize,
      minTradeSize: ctx.config.minTradeSize,
      probabilityTimeHorizonMs: ctx.config.probabilityTimeHorizonMs,
    },
  });

  const pos = ctx.simulation.getOpenPosition();
  const posStr = pos
    ? pos.sideBought !== undefined
      ? `open ${pos.direction} ${pos.sideBought} stake=${pos.stake.toFixed(2)} contracts=${pos.shares.toFixed(4)}@${pos.entryPrice.toFixed(4)}`
      : `open ${pos.direction} stake=${pos.stake.toFixed(2)} qty=${pos.shares.toFixed(6)}@${pos.entryPrice.toFixed(2)}`
    : "flat";

  const recorded = ctx.opportunityTracker.recordFromReadyTick({
    timestamp: now,
    btcPrice: tick.underlyingSignalPrice,
    underlyingSignalPrice: tick.underlyingSignalPrice,
    prices: tick.prices,
    previousPrice: tick.prev,
    currentPrice: tick.last,
    executionBook,
    entry,
    tradableSpikeMinPercent: ctx.config.tradableSpikeMinPercent,
    maxPriorRangeForNormalEntry: ctx.config.maxPriorRangeForNormalEntry,
    exceptionalSpikeMinPercent: ctx.config.exceptionalSpikePercent,
    allowWeakQualityEntries: ctx.config.allowWeakQualityEntries,
    allowWeakQualityOnlyForStrongSpikes:
      ctx.config.allowWeakQualityOnlyForStrongSpikes,
    allowAcceptableQualityStrongSpikes:
      ctx.config.allowAcceptableQualityStrongSpikes,
  });
  if (recorded?.entryAllowed) {
    logValidOpportunityBlock(recorded);
  }

  const why =
    entry.shouldEnter || entry.reasons.length === 0
      ? ""
      : ` | ${formatEntryReasonsForLog(entry)}`;

  const execBook =
    ctx.config.marketMode === "binary"
      ? `signal BTC $${tick.underlyingSignalPrice.toFixed(2)} │ venue ${ctx.tradeSymbol} bid ${executionBook.bestBid.toFixed(4)} ask ${executionBook.bestAsk.toFixed(4)} spr ${executionBook.spreadBps.toFixed(2)}bps`
      : `${ctx.tradeSymbol} mid $${tick.underlyingSignalPrice.toFixed(2)} bid ${executionBook.bestBid.toFixed(2)} ask ${executionBook.bestAsk.toFixed(2)} spr ${executionBook.spreadBps.toFixed(2)}bps`;

  console.log(
    `[BOT] ${execBook} | ${entry.direction ?? "—"} enter=${entry.shouldEnter}${why} | ${posStr}`
  );
}

export function startBotLoop(ctx: BotContext): void {
  console.log("[BOT] Starting loop…");
  void runBotTick(ctx);
  setInterval(() => {
    void runBotTick(ctx);
  }, BOT_TICK_INTERVAL_MS);
}
