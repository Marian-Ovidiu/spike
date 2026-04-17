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
import type { SpotMarketFeed } from "./adapters/binanceSpotFeed.js";
import type { SpotMicrostructure } from "./spotSpreadFilter.js";

/** Live / backtest cadence (ms). */
export const BOT_TICK_INTERVAL_MS = 5_000;

/** Minimum buffer samples before strategy evaluation (stable window + spike context). */
export const MIN_SAMPLES_FOR_STRATEGY = 11;

export type BotContext = {
  priceBuffer: RollingPriceBuffer;
  simulation: SimulationEngine;
  config: AppConfig;
  opportunityTracker: OpportunityTracker;
  /** Binance Spot WS feed (monitor) or {@link PaperBinanceFeed} for local runs. */
  marketFeed: SpotMarketFeed;
  /** e.g. BTCUSDT */
  tradeSymbol: string;
};

export type ReadyTickMarketData = {
  book: SpotMicrostructure;
  /** True when last WS message is older than config.feedStaleMaxAgeMs. */
  feedPossiblyStale: boolean;
};

async function resolveSpotBook(
  ctx: BotContext
): Promise<{ book: SpotMicrostructure; feedPossiblyStale: boolean } | null> {
  const b = ctx.marketFeed.getNormalizedBook();
  if (b === null) {
    return null;
  }
  const age = ctx.marketFeed.getLastMessageAgeMs();
  const feedPossiblyStale =
    Number.isFinite(age) && age > ctx.config.feedStaleMaxAgeMs;
  const book: SpotMicrostructure = {
    bestBid: b.bestBid,
    bestAsk: b.bestAsk,
    midPrice: b.midPrice,
    spreadBps: b.spreadBps,
  };
  return { book, feedPossiblyStale };
}

export type StrategyTickResult =
  | { kind: "no_btc" }
  | { kind: "warming"; btc: number; n: number; cap: number }
  | { kind: "no_book"; btc: number; n: number; cap: number }
  | {
      kind: "ready";
      btc: number;
      n: number;
      cap: number;
      prev: number;
      last: number;
      prices: readonly number[];
      sides: SpotMicrostructure;
      entry: EntryEvaluation;
      market: ReadyTickMarketData;
    };

export async function runStrategyTick(
  ctx: BotContext
): Promise<StrategyTickResult> {
  const { priceBuffer, config } = ctx;
  const resolved = await resolveSpotBook(ctx);
  if (resolved === null) {
    return { kind: "no_btc" };
  }
  const { book, feedPossiblyStale } = resolved;
  const btc = book.midPrice;

  priceBuffer.addPrice(btc);
  const prices = priceBuffer.getPrices();
  const n = prices.length;
  const cap = config.priceBufferSize;

  if (n < MIN_SAMPLES_FOR_STRATEGY) {
    return { kind: "warming", btc, n, cap };
  }

  const prev = priceBuffer.getPrevious();
  const last = priceBuffer.getLast();
  if (prev === undefined || last === undefined) {
    return { kind: "warming", btc, n, cap };
  }

  if (!Number.isFinite(book.spreadBps) || book.bestAsk < book.bestBid) {
    return { kind: "no_book", btc, n, cap };
  }

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
    maxEntrySpreadBps: config.maxEntrySpreadBps,
    bestBid: book.bestBid,
    bestAsk: book.bestAsk,
    midPrice: book.midPrice,
    spreadBps: book.spreadBps,
  });

  return {
    kind: "ready",
    btc,
    n,
    cap,
    prev,
    last,
    prices,
    sides: book,
    entry,
    market: { book, feedPossiblyStale },
  };
}

export async function runBotTick(ctx: BotContext): Promise<void> {
  const tick = await runStrategyTick(ctx);
  const now = Date.now();

  if (tick.kind === "no_btc") {
    console.log("[BOT] No spot book / feed — skip tick");
    return;
  }

  if (tick.kind === "warming") {
    console.log(
      `[BOT] Warmup ${tick.n}/${MIN_SAMPLES_FOR_STRATEGY} | mid $${tick.btc.toFixed(2)}`
    );
    return;
  }

  if (tick.kind === "no_book") {
    console.log(
      `[BOT] Invalid book | mid $${tick.btc.toFixed(2)} | buf ${tick.n}/${tick.cap}`
    );
    return;
  }

  const { entry, sides } = tick;

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
    ...(entryQualityProfile !== undefined
      ? { entryQualityProfile }
      : {}),
    sides,
    symbol: ctx.tradeSymbol,
    config: {
      takeProfitBps: ctx.config.takeProfitBps,
      stopLossBps: ctx.config.stopLossBps,
      paperSlippageBps: ctx.config.paperSlippageBps,
      paperFeeRoundTripBps: ctx.config.paperFeeRoundTripBps,
      exitTimeoutMs: ctx.config.exitTimeoutMs,
      entryCooldownMs: ctx.config.entryCooldownMs,
      stakePerTrade: ctx.config.stakePerTrade,
      allowWeakQualityEntries: ctx.config.allowWeakQualityEntries,
      weakQualitySizeMultiplier: ctx.config.weakQualitySizeMultiplier,
      strongQualitySizeMultiplier: ctx.config.strongQualitySizeMultiplier,
      exceptionalQualitySizeMultiplier:
        ctx.config.exceptionalQualitySizeMultiplier,
    },
  });

  const pos = ctx.simulation.getOpenPosition();
  const posStr = pos
    ? `open ${pos.direction} stake=${pos.stake.toFixed(2)} qty=${pos.shares.toFixed(6)}@${pos.entryPrice.toFixed(2)}`
    : "flat";

  const recorded = ctx.opportunityTracker.recordFromReadyTick({
    timestamp: now,
    btcPrice: tick.btc,
    prices: tick.prices,
    previousPrice: tick.prev,
    currentPrice: tick.last,
    sides,
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

  console.log(
    `[BOT] ${ctx.tradeSymbol} mid $${tick.btc.toFixed(2)} bid ${sides.bestBid.toFixed(2)} ask ${sides.bestAsk.toFixed(2)} spr ${sides.spreadBps.toFixed(2)}bps | ${entry.direction ?? "—"} enter=${entry.shouldEnter}${why} | ${posStr}`
  );
}

export function startBotLoop(ctx: BotContext): void {
  console.log("[BOT] Starting loop…");
  void runBotTick(ctx);
  setInterval(() => {
    void runBotTick(ctx);
  }, BOT_TICK_INTERVAL_MS);
}
