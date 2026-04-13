import { readFile } from "node:fs/promises";

import type { AppConfig } from "./config.js";
import { config as defaultConfig } from "./config.js";
import { evaluateEntryConditions } from "./entryConditions.js";
import { BOT_TICK_INTERVAL_MS, MIN_SAMPLES_FOR_STRATEGY } from "./botLoop.js";
import { RollingPriceBuffer } from "./rollingPriceBuffer.js";
import {
  type SimulatedTrade,
  SimulationEngine,
} from "./simulationEngine.js";

export type BacktestOptions = {
  config: AppConfig;
  /** Simulated ms between ticks (aligns simulated exit timeout with live cadence). */
  tickMs?: number;
  /** Epoch ms for first tick (only relative deltas matter for exit timeout). */
  epochStartMs?: number;
  /** Static binary leg quotes on every step (paper book). */
  sides?: { upSidePrice: number; downSidePrice: number };
};

export type BacktestResult = {
  winRate: number;
  totalProfit: number;
  maxDrawdown: number;
  totalTrades: number;
  wins: number;
  losses: number;
  trades: readonly SimulatedTrade[];
};

const DEFAULT_SIDES = { upSidePrice: 0.2, downSidePrice: 0.2 };

/**
 * Parse a CSV or one-column text file into BTC prices (oldest → newest).
 * Supports: one number per line, or CSV with a header containing `price`, `close`, or `btc`.
 */
export function parseHistoricalPriceText(content: string): number[] {
  const lines = content
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));
  if (lines.length === 0) return [];

  const sep = lines[0]!.includes(";") ? ";" : ",";
  const first = lines[0]!;
  const looksLikeHeader =
    /[a-zA-Z]/.test(first) &&
    /price|close|btc|open/i.test(first.toLowerCase());

  let rowStart = 0;
  let priceCol = 0;
  if (looksLikeHeader) {
    rowStart = 1;
    const cols = first.split(sep).map((c) => c.trim().toLowerCase());
    const named = cols.findIndex((c) =>
      /^(price|close|btc)$/.test(c)
    );
    priceCol = named >= 0 ? named : Math.max(0, cols.length - 1);
  }

  const out: number[] = [];
  for (let i = rowStart; i < lines.length; i++) {
    const parts = lines[i]!.split(sep).map((p) => p.trim());
    const raw =
      parts.length === 1 ? parts[0] : (parts[priceCol] ?? parts[parts.length - 1]);
    const n = Number(raw);
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

export async function loadHistoricalPricesFromFile(
  filePath: string
): Promise<number[]> {
  const raw = await readFile(filePath, "utf8");
  return parseHistoricalPriceText(raw);
}

/**
 * Max drawdown on cumulative P/L (peak-to-trough of running equity).
 */
export function maxDrawdownFromTrades(
  trades: readonly SimulatedTrade[]
): number {
  let equity = 0;
  let peak = 0;
  let maxDD = 0;
  for (const t of trades) {
    equity += t.profitLoss;
    peak = Math.max(peak, equity);
    maxDD = Math.max(maxDD, peak - equity);
  }
  return maxDD;
}

/**
 * Replay BTC series through the same buffer → entry → paper simulation path as the live bot.
 */
export function runBacktestReplay(
  btcPrices: readonly number[],
  options: BacktestOptions
): BacktestResult {
  const {
    config,
    tickMs = BOT_TICK_INTERVAL_MS,
    epochStartMs = 0,
    sides = DEFAULT_SIDES,
  } = options;

  const simulation = new SimulationEngine({
    silent: true,
    initialEquity: config.initialCapital,
  });
  const priceBuffer = new RollingPriceBuffer(config.priceBufferSize);

  for (let i = 0; i < btcPrices.length; i++) {
    const btc = btcPrices[i]!;
    const now = epochStartMs + i * tickMs;

    priceBuffer.addPrice(btc);

    if (priceBuffer.getPrices().length < MIN_SAMPLES_FOR_STRATEGY) {
      continue;
    }

    const prev = priceBuffer.getPrevious();
    const last = priceBuffer.getLast();
    if (prev === undefined || last === undefined) continue;

    const entry = evaluateEntryConditions({
      prices: priceBuffer.getPrices(),
      rangeThreshold: config.rangeThreshold,
      previousPrice: prev,
      currentPrice: last,
      spikeThreshold: config.spikeThreshold,
      spikeMinRangeMultiple: config.spikeMinRangeMultiple,
      entryPrice: config.entryPrice,
      upSidePrice: sides.upSidePrice,
      downSidePrice: sides.downSidePrice,
    });

    simulation.onTick({
      now,
      entry,
      sides,
      config: {
        exitPrice: config.exitPrice,
        stopLoss: config.stopLoss,
        exitTimeoutMs: config.exitTimeoutMs,
        entryCooldownMs: config.entryCooldownMs,
        riskPercentPerTrade: config.riskPercentPerTrade,
      },
    });
  }

  const trades = simulation.getTradeHistory();
  const stats = simulation.getPerformanceStats();

  return {
    winRate: stats.winRate,
    totalProfit: stats.totalProfit,
    maxDrawdown: stats.maxEquityDrawdown,
    totalTrades: stats.totalTrades,
    wins: stats.wins,
    losses: stats.losses,
    trades,
  };
}

export async function runBacktestFromFile(
  filePath: string,
  options?: Omit<BacktestOptions, "config"> & { config?: AppConfig }
): Promise<BacktestResult> {
  const prices = await loadHistoricalPricesFromFile(filePath);
  const replay: BacktestOptions = {
    config: options?.config ?? defaultConfig,
  };
  if (options?.tickMs !== undefined) replay.tickMs = options.tickMs;
  if (options?.epochStartMs !== undefined) replay.epochStartMs = options.epochStartMs;
  if (options?.sides !== undefined) replay.sides = options.sides;
  return runBacktestReplay(prices, replay);
}
