import { getBTCPrice } from "./btcPriceService.js";
import type { AppConfig } from "./config.js";
import {
  evaluateEntryConditions,
  formatEntryReasonsForLog,
} from "./entryConditions.js";
import { logValidOpportunityBlock } from "./monitorConsole.js";
import type { EntryEvaluation } from "./entryConditions.js";
import {
  fetchPolymarketYesNoForBtc,
  isPolymarketGammaEnabled,
  polymarketToStrategySides,
} from "./polymarketGamma.js";
import type { OpportunityTracker } from "./opportunityTracker.js";
import { RollingPriceBuffer } from "./rollingPriceBuffer.js";
import type { SimulationEngine } from "./simulationEngine.js";

/** Live / backtest cadence (ms). */
export const BOT_TICK_INTERVAL_MS = 5_000;

/** Minimum buffer samples before strategy evaluation (stable window + spike context). */
export const MIN_SAMPLES_FOR_STRATEGY = 11;

export type BotContext = {
  priceBuffer: RollingPriceBuffer;
  simulation: SimulationEngine;
  config: AppConfig;
  opportunityTracker: OpportunityTracker;
};

async function resolveBinarySidePrices(
  btc: number
): Promise<{ upSidePrice: number; downSidePrice: number } | null> {
  if (!isPolymarketGammaEnabled()) {
    const rawUp = process.env.UP_SIDE_PRICE?.trim();
    const rawDown = process.env.DOWN_SIDE_PRICE?.trim();
    const up =
      rawUp !== undefined && rawUp !== "" ? Number(rawUp) : Number.NaN;
    const down =
      rawDown !== undefined && rawDown !== "" ? Number(rawDown) : Number.NaN;
    if (!Number.isFinite(up) || !Number.isFinite(down)) {
      console.error(
        "[bot] Set UP_SIDE_PRICE and DOWN_SIDE_PRICE when Polymarket Gamma is disabled (BINARY_MARKET_SOURCE=env), or enable Gamma."
      );
      return null;
    }
    return { upSidePrice: up, downSidePrice: down };
  }
  const pm = await fetchPolymarketYesNoForBtc(btc);
  if (!pm) return null;
  return polymarketToStrategySides(pm);
}

export type StrategyTickResult =
  | { kind: "no_btc" }
  | { kind: "warming"; btc: number; n: number; cap: number }
  | { kind: "no_sides"; btc: number; n: number; cap: number }
  | {
      kind: "ready";
      btc: number;
      n: number;
      cap: number;
      prev: number;
      last: number;
      prices: readonly number[];
      sides: { upSidePrice: number; downSidePrice: number };
      entry: EntryEvaluation;
    };

export async function runStrategyTick(
  ctx: BotContext
): Promise<StrategyTickResult> {
  const { priceBuffer, config } = ctx;
  const btc = await getBTCPrice();
  if (btc === null) {
    return { kind: "no_btc" };
  }

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

  const sides = await resolveBinarySidePrices(btc);
  if (sides === null) {
    return { kind: "no_sides", btc, n, cap };
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
    entryPrice: config.entryPrice,
    maxOppositeSideEntryPrice: config.maxOppositeSideEntryPrice,
    neutralQuoteBandMin: config.neutralQuoteBandMin,
    neutralQuoteBandMax: config.neutralQuoteBandMax,
    upSidePrice: sides.upSidePrice,
    downSidePrice: sides.downSidePrice,
  });

  return {
    kind: "ready",
    btc,
    n,
    cap,
    prev,
    last,
    prices,
    sides,
    entry,
  };
}

export async function runBotTick(ctx: BotContext): Promise<void> {
  const tick = await runStrategyTick(ctx);
  const now = Date.now();

  if (tick.kind === "no_btc") {
    console.log("[BOT] BTC fetch failed — skip tick");
    return;
  }

  if (tick.kind === "warming") {
    console.log(
      `[BOT] Warmup ${tick.n}/${MIN_SAMPLES_FOR_STRATEGY} | BTC $${tick.btc.toFixed(2)}`
    );
    return;
  }

  if (tick.kind === "no_sides") {
    console.log(
      `[BOT] No binary quotes | BTC $${tick.btc.toFixed(2)} | buf ${tick.n}/${tick.cap}`
    );
    return;
  }

  const { entry, sides } = tick;

  ctx.simulation.onTick({
    now,
    entry,
    sides,
    config: {
      exitPrice: ctx.config.exitPrice,
      stopLoss: ctx.config.stopLoss,
      exitTimeoutMs: ctx.config.exitTimeoutMs,
      entryCooldownMs: ctx.config.entryCooldownMs,
      riskPercentPerTrade: ctx.config.riskPercentPerTrade,
    },
  });

  const pos = ctx.simulation.getOpenPosition();
  const posStr = pos
    ? `open ${pos.direction}×${pos.contracts}@${pos.entryPrice.toFixed(4)}`
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
  });
  if (recorded?.entryAllowed) {
    logValidOpportunityBlock(recorded);
  }

  const why =
    entry.shouldEnter || entry.reasons.length === 0
      ? ""
      : ` | ${formatEntryReasonsForLog(entry)}`;

  console.log(
    `[BOT] BTC $${tick.btc.toFixed(2)} | YES ${sides.upSidePrice.toFixed(4)} NO ${sides.downSidePrice.toFixed(4)} | ${entry.direction ?? "—"} enter=${entry.shouldEnter}${why} | ${posStr}`
  );
}

export function startBotLoop(ctx: BotContext): void {
  console.log("[BOT] Starting loop…");
  void runBotTick(ctx);
  setInterval(() => {
    void runBotTick(ctx);
  }, BOT_TICK_INTERVAL_MS);
}
