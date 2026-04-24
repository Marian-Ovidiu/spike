/**
 * Wiring for the futures-oriented monitor: shared app config + core modules only.
 */
import "../../config/loadEnv.js";

import type { EvaluateSignalConditionsInput } from "../signal/signalEvaluate.js";
import type { FuturesPaperEngineConfig } from "../execution/futuresPaperTypes.js";
import { FuturesPaperEngine } from "../execution/FuturesPaperEngine.js";
import {
  RealisticPaperEngine,
  type RealisticPaperEngineConfig,
} from "../execution/RealisticPaperEngine.js";
import { RiskEngine } from "../risk/RiskEngine.js";
import type { RiskEngineConfig } from "../risk/riskConfig.js";
import { RollingPriceBuffer } from "../signal/rollingPriceBuffer.js";
import type { FuturesMarketFeed } from "../market/futuresFeed.js";
import { createDefaultFuturesMarketFeed } from "../market/futuresFeed.js";
import {
  readPaperSimulationConfig,
  readExchangeConfig,
  readLiveSafetyConfig,
  readRuntimeConfig,
} from "../../config/env.js";
import { assertCanUseLiveExecution } from "../../config/env.js";
import { config } from "../../config.js";
import type {
  ExchangeMarketData,
  MarketSnapshot as ExchangeMarketSnapshot,
  BookSnapshot as ExchangeBookSnapshot,
  TradeTick as ExchangeTradeTick,
} from "../../exchanges/shared/ExchangeMarketData.js";
import type {
  ExchangeMetadata,
  InstrumentMetadata,
} from "../../exchanges/shared/ExchangeMetadata.js";

/** Matches legacy `MIN_SAMPLES_FOR_STRATEGY` — spike math needs sufficient window. */
export const FUTURES_MIN_SAMPLES_FOR_SIGNAL = 11;

export type FuturesMonitorRuntime = {
  feed: FuturesMarketFeed;
  marketData: ExchangeMarketData;
  metadata: ExchangeMetadata;
  risk: RiskEngine;
  paper: FuturesPaperEngine;
  realisticPaperMode: boolean;
  priceBuffer: RollingPriceBuffer;
  feedStaleMaxAgeMs: number;
  tickIntervalMs: number;
  minSamples: number;
  signalInputBase: Omit<EvaluateSignalConditionsInput, "prices">;
  /** When true, risk treats execution feed age vs `feedStaleMaxAgeMs`. */
  blockEntriesOnExecutionFeedStale: boolean;
  entryConfirmationTicks: number;
  entryRequireReversal: boolean;
  balanceTrackingEnabled: boolean;
  balanceStartingBalance: number;
  balanceReserveBalance: number;
  balanceFixedStakeUntilBalance: number;
  balanceMinBalanceToContinue: number;
};

function buildPaperConfig(): FuturesPaperEngineConfig {
  const paper = readPaperSimulationConfig();
  return {
    takeProfitBps: paper.takeProfitBps,
    stopLossBps: paper.stopLossBps,
    exitTimeoutMs: paper.exitTimeoutMs,
    feeRoundTripBps: paper.feeRoundTripBps,
    slippageBps: paper.slippageBps,
    exitGracePeriodMs: paper.exitGracePeriodMs,
    forcedExitPenaltyBps: paper.forcedExitPenaltyBps,
    initialMarginRate: paper.initialMarginRate,
    maintenanceMarginRate: paper.maintenanceMarginRate,
    marginWarningRatio: paper.marginWarningRatio,
    liquidationRiskRatio: paper.liquidationRiskRatio,
    liquidationPenaltyBps: paper.liquidationPenaltyBps,
    profitLockEnabled: paper.profitLockEnabled,
    profitLockThresholdQuote: paper.profitLockThresholdQuote,
    trailingProfitEnabled: paper.trailingProfitEnabled,
    trailingProfitDropQuote: paper.trailingProfitDropQuote,
  };
}

function buildRiskConfig(): RiskEngineConfig {
  return {
    blockEntriesOnExecutionFeedStale: config.blockEntriesOnStaleFeed,
    blockEntriesOnSignalFeedStale: false,
    maxEntrySpreadBps: config.maxEntrySpreadBps,
    entryCooldownMs: config.entryCooldownMs,
    baseStakeQuote: config.stakePerTrade,
    minTradeSizeQuote: config.minTradeSize,
    maxTradeSizeQuote: config.maxTradeSize,
  };
}

function buildInstrumentMetadata(
  exchangeId: ExchangeMetadata["exchangeId"],
  feed: FuturesMarketFeed
): InstrumentMetadata {
  const instrumentRef = {
    exchangeId,
    symbol: feed.contract.venueSymbol.code,
    instrumentId: feed.instrumentId,
    venueSymbol: feed.contract.venueSymbol.venue,
  };
  const metadata: InstrumentMetadata = {
    exchangeId,
    instrumentRef,
    symbol: instrumentRef.symbol,
    kind: feed.contract.kind,
    baseAsset: feed.contract.baseAsset,
    quoteAsset: feed.contract.quoteAsset,
    settlementAsset: feed.contract.settlementAsset,
    tickSize: feed.contract.tickSize,
    lotSize: feed.contract.lotSize,
  };
  return {
    ...metadata,
    ...(feed.contract.minQuantity !== undefined
      ? { minQuantity: feed.contract.minQuantity }
      : {}),
    ...(feed.contract.contractMultiplier !== undefined
      ? { contractMultiplier: feed.contract.contractMultiplier }
      : {}),
  };
}

function toBookSnapshot(
  book: NonNullable<ReturnType<FuturesMarketFeed["getTopOfBookL1"]>>
): ExchangeBookSnapshot {
  return {
    bestBid: book.bestBid,
    bestAsk: book.bestAsk,
    midPrice: book.midPrice,
    spreadBps: book.spreadBps,
    ...(book.bestBidSize !== undefined ? { bestBidSize: book.bestBidSize } : {}),
    ...(book.bestAskSize !== undefined ? { bestAskSize: book.bestAskSize } : {}),
  };
}

function buildMarketDataAdapter(
  exchangeId: ExchangeMetadata["exchangeId"],
  feed: FuturesMarketFeed
): ExchangeMarketData {
  const instrument = buildInstrumentMetadata(exchangeId, feed).instrumentRef;
  return {
    exchangeId,
    instrument,
    getBook(nowMs = Date.now()): ExchangeBookSnapshot | null {
      const book = feed.getTopOfBookL1?.();
      return book ? toBookSnapshot(book) : null;
    },
    getTradeTick(nowMs = Date.now()): ExchangeTradeTick | null {
      const snapshot = feed.getMarketSnapshot(nowMs);
      const price =
        snapshot?.signalMid ??
        snapshot?.lastTradePrice ??
        feed.getSignalMid() ??
        feed.getMarkPrice() ??
        null;
      if (price === null) return null;
      return {
        exchangeId,
        instrument,
        observedAtMs: nowMs,
        price,
        sequence: snapshot?.sequence ?? feed.getSequence?.(),
      };
    },
    getMarketSnapshot(nowMs = Date.now()): ExchangeMarketSnapshot | null {
      const snapshot = feed.getMarketSnapshot(nowMs);
      if (!snapshot) return null;
      return {
        exchangeId,
        instrument,
        observedAtMs: snapshot.observedAtMs,
        signalMid: snapshot.signalMid,
        lastTradePrice: snapshot.lastTradePrice,
        book: snapshot.book ? toBookSnapshot(snapshot.book) : null,
        staleness: snapshot.staleness,
        markPrice: snapshot.markPrice,
        indexPrice: snapshot.indexPrice,
        sequence: snapshot.sequence,
      };
    },
  };
}

export function createFuturesMonitorRuntime(): FuturesMonitorRuntime {
  const runtime = readRuntimeConfig();
  const futuresContractSymbol = runtime.futuresContractSymbol;
  const paper = readPaperSimulationConfig();
  const exchangeId = runtime.futuresExchange;
  if (runtime.tradingMode !== "public_paper") {
    readExchangeConfig();
  }
  if (runtime.tradingMode === "live") {
    assertCanUseLiveExecution({
      runtime,
      exchange: readExchangeConfig(),
      liveSafety: readLiveSafetyConfig(),
    });
  }
  const feed = createDefaultFuturesMarketFeed({
    symbol: futuresContractSymbol,
    initialSignalMid: paper.initialSignalMid,
    initialSpreadBps: paper.initialSpreadBps,
    syntheticUpdateMs: paper.syntheticUpdateMs,
    oscillationBps: paper.oscillationBps,
    markBasisBps: paper.markBasisBps,
    indexBasisBps: paper.indexBasisBps,
    fundingBiasBps: paper.fundingBiasBps,
    spotProxyFallback: paper.useSpotProxyFallback,
  });

  const feedStaleMaxAgeMs = paper.feedStaleMaxAgeMs;
  const tickIntervalMs = paper.tickIntervalMs;

  const riskCfg = buildRiskConfig();
  const paperConfig = {
    ...buildPaperConfig(),
    ...paper,
  } as RealisticPaperEngineConfig;
  const paperEngine = paper.realisticMode
    ? new RealisticPaperEngine(paperConfig)
    : new FuturesPaperEngine(paperConfig);

  const signalInputBase: Omit<EvaluateSignalConditionsInput, "prices"> = {
    rangeThreshold: config.rangeThreshold,
    stableRangeSoftToleranceRatio: config.stableRangeSoftToleranceRatio,
    strongSpikeHardRejectPoorRange: config.strongSpikeHardRejectPoorRange,
    spikeThreshold: config.spikeThreshold,
    spikeMinRangeMultiple: config.spikeMinRangeMultiple,
    borderlineMinRatio: config.borderlineMinRatio,
    tradableSpikeMinPercent: config.tradableSpikeMinPercent,
  };

  return {
    feed,
    marketData: buildMarketDataAdapter(exchangeId, feed),
    metadata: {
      exchangeId,
      instrument: buildInstrumentMetadata(exchangeId, feed),
      feeSchedule: { makerFeeBps: 0, takerFeeBps: 0 },
      venueLabel: runtime.futuresExchange,
    },
    risk: new RiskEngine(riskCfg),
    paper: paperEngine,
    realisticPaperMode: paper.realisticMode,
    priceBuffer: new RollingPriceBuffer(config.priceBufferSize),
    feedStaleMaxAgeMs,
    tickIntervalMs,
    minSamples: FUTURES_MIN_SAMPLES_FOR_SIGNAL,
    signalInputBase,
    blockEntriesOnExecutionFeedStale:
      riskCfg.blockEntriesOnExecutionFeedStale,
    entryConfirmationTicks: paper.entryConfirmationTicks,
    entryRequireReversal: paper.entryRequireReversal,
    balanceTrackingEnabled: paper.balanceTrackingEnabled,
    balanceStartingBalance: paper.balanceStartingBalance,
    balanceReserveBalance: paper.balanceReserveBalance,
    balanceFixedStakeUntilBalance: paper.balanceFixedStakeUntilBalance,
    balanceMinBalanceToContinue: paper.balanceMinBalanceToContinue,
  };
}
