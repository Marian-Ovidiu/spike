/**
 * **Core binary execution path** — synthetic YES/NO venue (no Polymarket).
 * Selected by {@link createBinaryExecutionFeed} when no Gamma market selector is configured.
 */
import type { BinanceFeedHealth, NormalizedSpotBook } from "../../adapters/binanceSpotFeed.js";
import type {
  MarketDataFeed,
  MarketFeedDiagnostics,
  QuoteStaleResult,
} from "../../market/types.js";
import {
  SyntheticBinaryMarket,
  type SyntheticBinaryMarketOptions,
} from "./syntheticBinaryMarket.js";
import {
  SyntheticVenuePricingEngine,
  type SyntheticVenuePricingOptions,
  type SyntheticVenuePricingSnapshot,
} from "./syntheticVenuePricing.js";
import {
  parseSyntheticMarketProfileFromEnv,
  parseWidenOnVolatilityFromEnv,
} from "./syntheticMarketProfile.js";
import {
  SyntheticVenueDiagnosticsCollector,
  type SyntheticPricingDiagnosticsSummary,
} from "./syntheticVenueDiagnostics.js";

function parseFiniteEnvNumber(
  keys: readonly string[],
  defaultValue: number,
  label: string
): number {
  for (const k of keys) {
    const raw = process.env[k]?.trim();
    if (raw === undefined || raw === "") continue;
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
    console.warn(
      `[binary-feed] ${k}="${raw}" is not a valid number for ${label}; using ${defaultValue}`
    );
  }
  return defaultValue;
}

function buildMarketOptions(ctor?: {
  syntheticSpreadBps?: number;
  syntheticSlippageBps?: number;
  maxLiquidityPerTrade?: number;
}): SyntheticBinaryMarketOptions {
  const env = SyntheticBinaryMarket.optionsFromEnv();
  return SyntheticBinaryMarket.mergeOptions(env, {
    ...(ctor?.syntheticSpreadBps !== undefined
      ? { spreadBps: ctor.syntheticSpreadBps }
      : {}),
    ...(ctor?.syntheticSlippageBps !== undefined
      ? { slippageBps: ctor.syntheticSlippageBps }
      : {}),
    ...(ctor?.maxLiquidityPerTrade !== undefined
      ? { maxLiquidityPerTrade: ctor.maxLiquidityPerTrade }
      : {}),
  });
}

/** Last tick’s venue path: strategy estimate vs synthetic book (for logs / diagnostics). */
export type SyntheticExecutionVenueSnapshot = SyntheticVenuePricingSnapshot & {
  /** Strategy P(up) — same number as `fairValueYes` until a separate fair layer exists. */
  strategyProbabilityUp: number;
  syntheticYesMid: number;
  syntheticYesAsk: number;
  syntheticNoAsk: number;
  /** `strategyProbabilityUp − yesAsk` (edge if buying YES at the venue). */
  edgeVsYesAsk: number;
  /** `(1 − strategyProbabilityUp) − noAsk` (edge if buying NO at the venue). */
  edgeVsNoAsk: number;
};

/**
 * Binary **execution venue** (dev): YES/NO mids from a **venue pricing** layer that follows
 * the strategy fair value with lag, noise, and partial adjustment — not a raw copy of P(up).
 * Does **not** supply the BTC signal series.
 */
export class BinarySyntheticFeed implements MarketDataFeed {
  private readonly symbolUpper: string;
  private readonly market: SyntheticBinaryMarket;
  private readonly venueEngine: SyntheticVenuePricingEngine;
  private readonly syntheticMarketProfile = parseSyntheticMarketProfileFromEnv();
  private readonly widenOnVolatility: number;
  private readonly pricingDiagnostics: SyntheticVenueDiagnosticsCollector;
  private lastTouchMs: number;
  private tickSeq = 0;
  private lastVenueStep: SyntheticVenuePricingSnapshot | null = null;
  private prevFairValueYes: number | null = null;
  private fairJumpEwm = 0;
  private instabilityEwm = 0;

  constructor(
    options?: {
      symbol?: string;
      upPrice?: number;
      downPrice?: number;
      syntheticSpreadBps?: number;
      syntheticSlippageBps?: number;
      maxLiquidityPerTrade?: number;
      venuePricing?: Partial<SyntheticVenuePricingOptions>;
    }
  ) {
    this.symbolUpper = (options?.symbol ?? process.env.BINARY_SYMBOL ?? "DEMO-BINARY")
      .trim()
      .toUpperCase();
    const up =
      options?.upPrice ??
      parseFiniteEnvNumber(["BINARY_UP_PRICE", "UP_SIDE_PRICE"], 0.51, "UP price");
    const down =
      options?.downPrice ??
      parseFiniteEnvNumber(["BINARY_DOWN_PRICE", "DOWN_SIDE_PRICE"], 0.49, "DOWN price");
    this.market = new SyntheticBinaryMarket(buildMarketOptions(options));
    this.venueEngine = new SyntheticVenuePricingEngine({
      ...SyntheticVenuePricingEngine.optionsFromEnv(),
      ...options?.venuePricing,
    });
    this.widenOnVolatility = parseWidenOnVolatilityFromEnv();
    this.pricingDiagnostics = new SyntheticVenueDiagnosticsCollector({
      profile: this.syntheticMarketProfile,
      widenOnVolatility: this.widenOnVolatility,
      baseSpreadBps: this.market.getBaseSpreadBps(),
      maxSpreadBps: this.market.getMaxSpreadBps(),
    });
    this.market.setQuotedMids(up, down);
    /** Empty: first {@link applySignalProbability} seeds lag ring from live fairs only (avoids double-counting ctor mids when LAG_TICKS>0). */
    this.venueEngine.clearFairHistory();
    this.lastTouchMs = Date.now();
  }

  getSyntheticMarket(): SyntheticBinaryMarket {
    return this.market;
  }

  getVenuePricingEngine(): SyntheticVenuePricingEngine {
    return this.venueEngine;
  }

  /** Test / replay hook to move prices without env. Resets venue lag history. */
  setOutcomePrices(up: number, down: number): void {
    this.market.setQuotedMids(up, down);
    this.venueEngine.clearFairHistory();
    this.venueEngine.primeFairHistory(up);
    this.lastVenueStep = null;
    this.prevFairValueYes = null;
    this.fairJumpEwm = 0;
    this.instabilityEwm = 0;
    this.market.setSpreadBps(this.market.getBaseSpreadBps());
    this.pricingDiagnostics.reset();
    this.lastTouchMs = Date.now();
  }

  /**
   * Feed strategy **fair** P(up) (signal → probability engine). Updates the synthetic book via
   * {@link SyntheticVenuePricingEngine} so quoted mids need not equal `fairValueYes`.
   */
  applySignalProbability(fairValueYes: number, nowMs = Date.now()): void {
    this.tickSeq += 1;
    const published = this.market.getMids().yesMid;
    const prevFair = this.prevFairValueYes ?? fairValueYes;
    const fairJump = Math.abs(fairValueYes - prevFair);
    this.fairJumpEwm = 0.14 * fairJump + 0.86 * this.fairJumpEwm;

    const step = this.venueEngine.step(fairValueYes, this.tickSeq, published);
    this.lastVenueStep = step;
    const vsLagged = Math.abs(fairValueYes - step.laggedFairValueYes);
    const instabilityTick = 0.5 * this.fairJumpEwm + 0.5 * vsLagged;
    this.instabilityEwm = 0.18 * instabilityTick + 0.82 * this.instabilityEwm;

    const baseSpr = this.market.getBaseSpreadBps();
    const extraSpr =
      this.widenOnVolatility > 0
        ? this.widenOnVolatility * this.instabilityEwm * 720
        : 0;
    this.market.setSpreadBps(baseSpr + extraSpr);

    this.market.setExecutionVenueYesMid(step.rawVenueYesMid);
    const newMid = this.market.getMids().yesMid;
    this.pricingDiagnostics.recordTick({
      publishedYesMidBefore: published,
      newYesMidAfter: newMid,
      noisyTargetYes: step.noisyTargetYes,
      spreadBpsAfter: this.market.getSpreadBps(),
      fairJumpEwm: this.fairJumpEwm,
      instabilityEwm: this.instabilityEwm,
    });

    this.prevFairValueYes = fairValueYes;
    this.lastTouchMs = nowMs;
  }

  /** Session aggregates for `synthetic-pricing-diagnostics.json` (null before first tick). */
  getSyntheticPricingDiagnosticsSummary(): SyntheticPricingDiagnosticsSummary | null {
    const s = this.pricingDiagnostics.snapshot();
    return s.ticksObserved > 0 ? s : null;
  }

  /**
   * Snapshot after the latest {@link applySignalProbability} on this tick (else `null`).
   * Includes strategy vs venue mids and naive edge vs asks.
   */
  getSyntheticVenueSnapshot(): SyntheticExecutionVenueSnapshot | null {
    if (this.lastVenueStep === null) return null;
    const s = this.lastVenueStep;
    const q = this.market.getQuoteSnapshot();
    const strategyProbabilityUp = s.fairValueYes;
    const edgeVsYesAsk = strategyProbabilityUp - q.yesAsk;
    const edgeVsNoAsk = 1 - strategyProbabilityUp - q.noAsk;
    return {
      ...s,
      strategyProbabilityUp,
      syntheticYesMid: q.yesMid,
      syntheticYesAsk: q.yesAsk,
      syntheticNoAsk: q.noAsk,
      edgeVsYesAsk,
      edgeVsNoAsk,
    };
  }

  getSymbol(): string {
    return this.symbolUpper;
  }

  getBinaryOutcomePrices(): { yesPrice: number; noPrice: number } {
    const m = this.market.getMids();
    return { yesPrice: m.yesMid, noPrice: m.noMid };
  }

  getUpDown(): { up: number; down: number } {
    const m = this.market.getMids();
    return { up: m.yesMid, down: m.noMid };
  }

  getSyntheticSpreadBps(): number {
    return this.market.getSpreadBps();
  }

  describeDataSource(): string {
    const prof =
      this.syntheticMarketProfile === null
        ? "profile=legacy"
        : `profile=${this.syntheticMarketProfile}`;
    return `Binary synthetic ${this.symbolUpper} (${prof}, widen=${this.widenOnVolatility.toFixed(2)}, venue mids from fair P(up), ${this.market.getSpreadBps()}bps spread, ${this.market.getSlippageBps()}bps slip, liq=${this.market.getMaxLiquidityPerTrade()})`;
  }

  getShutdownDiagnostics(): MarketFeedDiagnostics {
    const m = this.market.getMids();
    return {
      mode: "binary",
      source: "synthetic_env",
      symbol: this.symbolUpper,
      upPrice: m.yesMid,
      downPrice: m.noMid,
      syntheticSpreadBps: this.market.getSpreadBps(),
      syntheticBaseSpreadBps: this.market.getBaseSpreadBps(),
      syntheticMaxSpreadBps: this.market.getMaxSpreadBps(),
      syntheticSlippageBps: this.market.getSlippageBps(),
      maxLiquidityPerTrade: this.market.getMaxLiquidityPerTrade(),
      lastUpdateAtMs: this.lastTouchMs,
      syntheticMarketProfile: this.syntheticMarketProfile,
      widenOnVolatility: this.widenOnVolatility,
      syntheticPricingDiagnostics: this.getSyntheticPricingDiagnosticsSummary(),
    };
  }

  getHealth(): BinanceFeedHealth {
    return {
      connected: true,
      connectCount: 1,
      disconnectCount: 0,
      lastMessageAtMs: this.lastTouchMs,
      messagesTotal: 1,
      reconnectScheduled: false,
      lastError: null,
    };
  }

  getLastMessageAgeMs(now = Date.now()): number {
    return Math.max(0, now - this.lastTouchMs);
  }

  getQuoteStale(now = Date.now()): QuoteStaleResult {
    void now;
    return { stale: false, reason: null };
  }

  getNormalizedBook(): NormalizedSpotBook | null {
    this.lastTouchMs = Date.now();
    return this.market.toNormalizedSpotBook(this.symbolUpper, this.lastTouchMs);
  }

  async bootstrapRest(): Promise<boolean> {
    this.lastTouchMs = Date.now();
    return true;
  }

  start(): void {
    this.lastTouchMs = Date.now();
  }

  stop(): void {
    /* no-op */
  }
}
