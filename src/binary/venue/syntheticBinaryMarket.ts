import type { NormalizedSpotBook } from "../../adapters/binanceSpotFeed.js";
import {
  binaryMarketDefaultsForProfile,
  parseSyntheticMarketProfileFromEnv,
} from "./syntheticMarketProfile.js";

/** Executable outcome prices and mids stay inside this band (inclusive). */
export const SYNTHETIC_PRICE_MIN = 0.01;
export const SYNTHETIC_PRICE_MAX = 0.99;

const MID_EPS = 1e-6;
const MAX_EXTRA_IMPACT_BPS = 500;

function clampPriceBand(x: number): number {
  if (!Number.isFinite(x)) return 0.5;
  return Math.min(SYNTHETIC_PRICE_MAX, Math.max(SYNTHETIC_PRICE_MIN, x));
}

function parseFiniteNumber(
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
      `[SyntheticBinaryMarket] ${k}="${raw}" is not a valid number for ${label}; using ${defaultValue}`
    );
  }
  return defaultValue;
}

function parseEnvBoolean(keys: readonly string[], defaultValue: boolean): boolean {
  for (const k of keys) {
    const raw = process.env[k]?.trim().toLowerCase();
    if (raw === undefined || raw === "") continue;
    if (raw === "1" || raw === "true" || raw === "yes") return true;
    if (raw === "0" || raw === "false" || raw === "no") return false;
  }
  return defaultValue;
}

export type SyntheticBinaryMarketOptions = {
  /**
   * Full bid–ask width on the 0–1 outcome scale: `spreadBps / 10_000` (e.g. 30 → 0.003).
   * YES: `yes_bid = mid − width/2`, `yes_ask = mid + width/2`; NO centered at `1 − mid`.
   * {@link setSpreadBps} may widen this at runtime from the initial baseline {@link getBaseSpreadBps}.
   */
  spreadBps: number;
  /** Upper cap for {@link setSpreadBps} (defaults well above baseline when env unset). */
  maxSpreadBps: number;
  /** Marginal price impact rate (bps) scaled by size vs liquidity. */
  slippageBps: number;
  /**
   * Reference depth for impact: extra bps = slippageBps × (shares / maxLiquidityPerTrade),
   * capped. If ≤ 0, uses shares / 1 (linear in share count).
   */
  maxLiquidityPerTrade: number;
  /**
   * EMA weight on **new** venue YES mid when calling {@link setExecutionVenueYesMid} (0–1).
   * `0` = no smoothing (use raw each tick). Default `0.3` → `mid = prev×0.7 + raw×0.3`.
   */
  midSmoothNewWeight: number;
  /** When true, log raw venue mid / smoothed mid / spread / bid–ask each {@link setExecutionVenueYesMid}. */
  syntheticQuoteLog: boolean;
};

export type SyntheticBinaryQuote = {
  yesMid: number;
  noMid: number;
  yesBid: number;
  yesAsk: number;
  noBid: number;
  noAsk: number;
  spreadBpsYes: number;
  spreadBpsNo: number;
};

export type SyntheticBinaryExecutionResult = {
  side: "YES" | "NO";
  shares: number;
  /** All-in price per share (ask + size impact). */
  fillPrice: number;
  /** Same as fill for single-level book; retained for future partial-depth VWAP. */
  effectiveEntryPrice: number;
  /** Notional = fillPrice × shares. */
  cost: number;
  /** Additional bps paid beyond the quoted ask (impact only). */
  impactBps: number;
};

function spreadBpsFromBidAsk(mid: number, bid: number, ask: number): number {
  if (!Number.isFinite(mid) || mid <= 0) return 0;
  return ((ask - bid) / mid) * 10_000;
}

function impactBpsForSize(
  shares: number,
  slippageBps: number,
  maxLiquidityPerTrade: number
): number {
  if (!(shares > 0) || !Number.isFinite(shares)) return 0;
  const slip = Math.max(0, slippageBps);
  const depth =
    maxLiquidityPerTrade > 0 && Number.isFinite(maxLiquidityPerTrade)
      ? maxLiquidityPerTrade
      : 1;
  const raw = slip * (shares / depth);
  return Math.min(MAX_EXTRA_IMPACT_BPS, Math.max(0, raw));
}

/**
 * Synthetic YES/NO book: mids from the **execution venue** path (optional EMA on the quoted YES mid),
 * absolute fractional spread `spreadBps/10_000`, bid/ask clamped to [0.01, 0.99], size-based slippage on buys.
 */
export class SyntheticBinaryMarket {
  private readonly baseSpreadBps: number;
  private readonly maxSpreadBps: number;
  private spreadBps: number;
  private slippageBps: number;
  private maxLiquidityPerTrade: number;
  private midSmoothNewWeight: number;
  private syntheticQuoteLog: boolean;
  private yesMid = 0.5;
  private noMid = 0.5;
  /** Last smoothed YES mid after {@link setExecutionVenueYesMid}; cleared by {@link setQuotedMids}. */
  private smoothedYesMid: number | null = null;

  constructor(options?: Partial<SyntheticBinaryMarketOptions>) {
    const base = SyntheticBinaryMarket.optionsFromEnv();
    const o = { ...base, ...options };
    this.baseSpreadBps = Math.max(0, o.spreadBps);
    this.maxSpreadBps = Math.max(this.baseSpreadBps, o.maxSpreadBps);
    this.spreadBps = this.baseSpreadBps;
    this.slippageBps = Math.max(0, o.slippageBps);
    this.maxLiquidityPerTrade = o.maxLiquidityPerTrade;
    const w = Number.isFinite(o.midSmoothNewWeight) ? o.midSmoothNewWeight : 0.3;
    this.midSmoothNewWeight = Math.min(1, Math.max(0, w));
    this.syntheticQuoteLog = o.syntheticQuoteLog;
  }

  static defaultOptions(): SyntheticBinaryMarketOptions {
    return {
      spreadBps: 30,
      maxSpreadBps: 280,
      slippageBps: 3,
      maxLiquidityPerTrade: 0,
      midSmoothNewWeight: 0.3,
      syntheticQuoteLog: false,
    };
  }

  /** Primary env: {@code SYNTHETIC_*}; spread falls back to {@code BINARY_SYNTHETIC_SPREAD_BPS}. */
  static optionsFromEnv(): SyntheticBinaryMarketOptions {
    const profile = parseSyntheticMarketProfileFromEnv();
    const profileDefaults = binaryMarketDefaultsForProfile(profile);
    const merged = { ...SyntheticBinaryMarket.defaultOptions(), ...profileDefaults };
    const spreadBps = parseFiniteNumber(
      ["SYNTHETIC_SPREAD_BPS", "BINARY_SYNTHETIC_SPREAD_BPS"],
      merged.spreadBps,
      "spread bps"
    );
    const maxDefault = Math.max(120, Math.round(spreadBps + 140));
    const maxSpreadBps = parseFiniteNumber(
      ["SYNTHETIC_MARKET_MAX_SPREAD_BPS"],
      maxDefault,
      "max spread bps"
    );
    return {
      spreadBps,
      maxSpreadBps: Math.max(spreadBps, maxSpreadBps),
      slippageBps: parseFiniteNumber(
        ["SYNTHETIC_SLIPPAGE_BPS"],
        merged.slippageBps,
        "slippage bps"
      ),
      maxLiquidityPerTrade: parseFiniteNumber(
        ["MAX_LIQUIDITY_PER_TRADE"],
        SyntheticBinaryMarket.defaultOptions().maxLiquidityPerTrade,
        "max liquidity per trade"
      ),
      midSmoothNewWeight: parseFiniteNumber(
        ["SYNTHETIC_MID_SMOOTH_NEW_WEIGHT"],
        merged.midSmoothNewWeight,
        "mid smooth new weight (0–1)"
      ),
      syntheticQuoteLog: parseEnvBoolean(
        ["SYNTHETIC_QUOTE_LOG"],
        SyntheticBinaryMarket.defaultOptions().syntheticQuoteLog
      ),
    };
  }

  static mergeOptions(
    base: SyntheticBinaryMarketOptions,
    patch?: Partial<SyntheticBinaryMarketOptions>
  ): SyntheticBinaryMarketOptions {
    return { ...base, ...patch };
  }

  getSpreadBps(): number {
    return this.spreadBps;
  }

  getBaseSpreadBps(): number {
    return this.baseSpreadBps;
  }

  getMaxSpreadBps(): number {
    return this.maxSpreadBps;
  }

  /**
   * Updates quoted half-spread width (bps), clamped to `[baseSpreadBps, maxSpreadBps]`.
   * Used by the synthetic feed when spread widens on fair volatility / instability.
   */
  setSpreadBps(bps: number): void {
    if (!Number.isFinite(bps)) return;
    const rounded = Math.round(bps);
    this.spreadBps = Math.min(this.maxSpreadBps, Math.max(this.baseSpreadBps, rounded));
  }

  getSlippageBps(): number {
    return this.slippageBps;
  }

  getMaxLiquidityPerTrade(): number {
    return this.maxLiquidityPerTrade;
  }

  /**
   * Mid_YES = smoothed execution-venue input; mid_NO = 1 − mid_YES.
   * Smoothing: `mid = prev×(1−w)+raw×w` with `w = midSmoothNewWeight` (0 = jumpy off).
   * Call with the **venue-pricing** layer’s raw YES mid (see `syntheticVenuePricing.ts`), not the strategy P(up).
   */
  setExecutionVenueYesMid(venueYesMidRaw: number): void {
    const raw = clampPriceBand(venueYesMidRaw);
    let midYes: number;
    if (
      this.smoothedYesMid === null ||
      this.midSmoothNewWeight <= 0 ||
      this.midSmoothNewWeight >= 1
    ) {
      midYes = raw;
    } else {
      const prevW = 1 - this.midSmoothNewWeight;
      midYes = clampPriceBand(
        this.smoothedYesMid * prevW + raw * this.midSmoothNewWeight
      );
    }
    this.smoothedYesMid = midYes;
    this.yesMid = midYes;
    this.noMid = clampPriceBand(1 - midYes);

    if (this.syntheticQuoteLog) {
      const q = this.getQuoteSnapshot();
      const spreadFrac = this.spreadBps / 10_000;
      console.log(
        `[synthetic_quote] venue_raw=${raw.toFixed(4)} mid_yes=${q.yesMid.toFixed(4)} spread_abs=${spreadFrac.toFixed(6)} ` +
          `yes_bid=${q.yesBid.toFixed(4)} yes_ask=${q.yesAsk.toFixed(4)} no_bid=${q.noBid.toFixed(4)} no_ask=${q.noAsk.toFixed(4)}`
      );
    }
  }

  /** @deprecated Use {@link setExecutionVenueYesMid} — name retained for tests / callers that drive the book directly. */
  setProbabilityUp(probabilityUp: number): void {
    this.setExecutionVenueYesMid(probabilityUp);
  }

  /** Independent mids (e.g. legacy env); legs need not sum to 1. Resets probability EMA. */
  setQuotedMids(yesMid: number, noMid: number): void {
    this.smoothedYesMid = null;
    this.yesMid = clampPriceBand(yesMid);
    this.noMid = clampPriceBand(noMid);
  }

  getMids(): { yesMid: number; noMid: number } {
    return { yesMid: this.yesMid, noMid: this.noMid };
  }

  getQuoteSnapshot(): SyntheticBinaryQuote {
    const spreadAbs = this.spreadBps / 10_000;
    const half = spreadAbs / 2;

    let yesBid = clampPriceBand(this.yesMid - half);
    let yesAsk = clampPriceBand(this.yesMid + half);
    if (yesAsk <= yesBid) {
      yesAsk = clampPriceBand(Math.min(SYNTHETIC_PRICE_MAX, yesBid + MID_EPS));
    }

    const noCenter = this.noMid;
    let noBid = clampPriceBand(noCenter - half);
    let noAsk = clampPriceBand(noCenter + half);
    if (noAsk <= noBid) {
      noAsk = clampPriceBand(Math.min(SYNTHETIC_PRICE_MAX, noBid + MID_EPS));
    }

    return {
      yesMid: this.yesMid,
      noMid: this.noMid,
      yesBid,
      yesAsk,
      noBid,
      noAsk,
      spreadBpsYes: spreadBpsFromBidAsk(this.yesMid, yesBid, yesAsk),
      spreadBpsNo: spreadBpsFromBidAsk(this.noMid, noBid, noAsk),
    };
  }

  /**
   * Executable Binance-shaped book around the YES leg (strategy spread gate).
   */
  toNormalizedSpotBook(symbol: string, nowMs: number): NormalizedSpotBook | null {
    const q = this.getQuoteSnapshot();
    const mid = q.yesMid;
    if (!Number.isFinite(mid) || mid <= 0) return null;
    const bestBid = q.yesBid;
    const bestAsk = q.yesAsk;
    const spreadAbs = bestAsk - bestBid;
    const spreadBps = spreadBpsFromBidAsk(mid, bestBid, bestAsk);
    return {
      symbol,
      bestBid,
      bestAsk,
      bestBidQty: 0,
      bestAskQty: 0,
      midPrice: mid,
      lastTradePrice: mid,
      spreadAbs,
      spreadBps,
      eventTimeMs: nowMs,
      observedAtMs: nowMs,
    };
  }

  /** Aggressive buy YES: pay YES ask plus size impact. */
  executeBuyYes(shares: number): SyntheticBinaryExecutionResult {
    return this.executeBuy("YES", shares);
  }

  /** Aggressive buy NO: pay NO ask plus size impact. */
  executeBuyNo(shares: number): SyntheticBinaryExecutionResult {
    return this.executeBuy("NO", shares);
  }

  private executeBuy(
    side: "YES" | "NO",
    shares: number
  ): SyntheticBinaryExecutionResult {
    const q = this.getQuoteSnapshot();
    const baseAsk = side === "YES" ? q.yesAsk : q.noAsk;
    if (!(shares > 0) || !Number.isFinite(shares)) {
      return {
        side,
        shares: 0,
        fillPrice: baseAsk,
        effectiveEntryPrice: baseAsk,
        cost: 0,
        impactBps: 0,
      };
    }
    const impactBps = impactBpsForSize(
      shares,
      this.slippageBps,
      this.maxLiquidityPerTrade
    );
    const fillPrice = baseAsk * (1 + impactBps / 10_000);
    const capped = Math.min(SYNTHETIC_PRICE_MAX, Math.max(baseAsk, fillPrice));
    const cost = capped * shares;
    return {
      side,
      shares,
      fillPrice: capped,
      effectiveEntryPrice: capped,
      cost,
      impactBps,
    };
  }
}
