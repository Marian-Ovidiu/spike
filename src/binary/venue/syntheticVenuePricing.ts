import {
  SYNTHETIC_PRICE_MAX,
  SYNTHETIC_PRICE_MIN,
} from "./syntheticBinaryMarket.js";
import {
  parseSyntheticMarketProfileFromEnv,
  venuePricingDefaultsForProfile,
} from "./syntheticMarketProfile.js";

function clampBand(x: number): number {
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
      `[SyntheticVenuePricing] ${k}="${raw}" is not a valid number for ${label}; using ${defaultValue}`
    );
  }
  return defaultValue;
}

function parseUint32(keys: readonly string[], defaultSeed: number): number {
  const d = defaultSeed >>> 0;
  for (const k of keys) {
    const raw = process.env[k]?.trim();
    if (raw === undefined || raw === "") continue;
    const n = Number(raw);
    if (Number.isFinite(n)) return Math.trunc(n) >>> 0;
    console.warn(
      `[SyntheticVenuePricing] ${k}="${raw}" is not a valid uint32 for noise seed; using ${d}`
    );
  }
  return d;
}

/**
 * Deterministic pseudo-random in [0, 1) from tick index and seed (stable across runs / engines).
 */
export function syntheticVenueNoiseUnit(tickIndex: number, seed: number): number {
  let x = Math.imul(tickIndex + 1, 0x85ebca6b) ^ Math.imul(seed | 0, 0xc2b2ae35);
  x >>>= 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d);
  x >>>= 0;
  x ^= x >>> 15;
  return (x >>> 0) / 0x1_0000_0000;
}

export type SyntheticVenuePricingOptions = {
  /** Fair value used when lag buffer is shorter than `lagTicks + 1` (warmup). */
  lagTicks: number;
  /**
   * One-step partial adjustment toward noisy target from the last **published** venue YES mid:
   * `mid += alpha * (target - mid)`. `alpha ∈ (0,1]` under-reacts; `alpha > 1` can overshoot before clamp.
   */
  reactionAlpha: number;
  /** Half-width of symmetric noise on the target, in bps of probability scale (0–1). */
  noiseBps: number;
  /** Constant shift added to lagged fair before reaction, in bps (signed). */
  biasBps: number;
  seed: number;
};

export type SyntheticVenuePricingSnapshot = {
  tickIndex: number;
  /** Strategy / model P(up) fed this tick (fair value input). */
  fairValueYes: number;
  /** Fair value after lag (same as fair when `lagTicks === 0`). */
  laggedFairValueYes: number;
  /** Lagged fair plus bias (before noise). */
  biasedFairValueYes: number;
  /** Noise offset on probability scale (half-width `noiseBps/10_000` in each direction from unit hash). */
  noiseOffsetFrac: number;
  /** Target YES probability after bias + noise (before reaction toward published mid). */
  noisyTargetYes: number;
  /** Raw mid passed into {@link SyntheticBinaryMarket.setExecutionVenueYesMid} (before that layer’s optional EMA). */
  rawVenueYesMid: number;
  /** Last published venue YES mid passed into {@link SyntheticVenuePricingEngine.step} (continuity for reaction). */
  venueYesMidPublishedBefore: number;
};

const MAX_LAG = 512;

/**
 * Execution-venue pricing: maps strategy **fair** P(up) into a tradable synthetic YES mid with lag,
 * bias, deterministic noise, and partial adjustment — intentionally **not** identical to the strategy estimate.
 */
export class SyntheticVenuePricingEngine {
  private readonly lagTicks: number;
  private readonly reactionAlpha: number;
  private readonly noiseBps: number;
  private readonly biasBps: number;
  private readonly seed: number;
  private readonly fairRing: number[] = [];

  constructor(options?: Partial<SyntheticVenuePricingOptions>) {
    const base = SyntheticVenuePricingEngine.optionsFromEnv();
    const o = { ...base, ...options };
    this.lagTicks = Math.max(0, Math.min(MAX_LAG, Math.trunc(o.lagTicks)));
    this.reactionAlpha = Number.isFinite(o.reactionAlpha) ? o.reactionAlpha : 1;
    this.noiseBps = Math.max(0, o.noiseBps);
    this.biasBps = Number.isFinite(o.biasBps) ? o.biasBps : 0;
    this.seed = o.seed >>> 0;
  }

  static defaultOptions(): SyntheticVenuePricingOptions {
    return {
      lagTicks: 0,
      reactionAlpha: 1,
      noiseBps: 0,
      biasBps: 0,
      seed: 0x9e3779b9,
    };
  }

  static optionsFromEnv(): SyntheticVenuePricingOptions {
    const profile = parseSyntheticMarketProfileFromEnv();
    const profileDefaults = venuePricingDefaultsForProfile(profile);
    const merged = {
      ...SyntheticVenuePricingEngine.defaultOptions(),
      ...profileDefaults,
    };
    return {
      lagTicks: Math.trunc(
        parseFiniteNumber(["SYNTHETIC_MARKET_LAG_TICKS"], merged.lagTicks, "venue lag ticks")
      ),
      reactionAlpha: parseFiniteNumber(
        ["SYNTHETIC_MARKET_REACTION_ALPHA"],
        merged.reactionAlpha,
        "venue reaction alpha"
      ),
      noiseBps: Math.max(
        0,
        parseFiniteNumber(["SYNTHETIC_MARKET_NOISE_BPS"], merged.noiseBps, "venue noise bps")
      ),
      biasBps: parseFiniteNumber(["SYNTHETIC_MARKET_BIAS_BPS"], merged.biasBps, "venue bias bps"),
      seed: parseUint32(["SYNTHETIC_MARKET_NOISE_SEED"], merged.seed),
    };
  }

  /** Drop lag history (e.g. after manual `setOutcomePrices`). */
  clearFairHistory(): void {
    this.fairRing.length = 0;
  }

  /** Seed lag ring with a single fair sample (constructor / manual price sync). */
  primeFairHistory(fairValueYes: number): void {
    this.clearFairHistory();
    this.fairRing.push(clampBand(fairValueYes));
  }

  private laggedFair(): number {
    if (this.fairRing.length === 0) return 0.5;
    const idx = this.fairRing.length - 1 - this.lagTicks;
    const pick = idx >= 0 ? this.fairRing[idx]! : this.fairRing[0]!;
    return pick;
  }

  /**
   * @param fairValueYes — strategy fair P(up) this tick (same series as `estimatedProbabilityUp`).
   * @param venueYesMidPublished — YES mid currently on the book **before** this update (reaction anchor).
   */
  step(
    fairValueYes: number,
    tickIndex: number,
    venueYesMidPublished: number
  ): SyntheticVenuePricingSnapshot {
    const fair = clampBand(fairValueYes);
    this.fairRing.push(fair);
    const maxKept = Math.min(MAX_LAG, Math.max(this.lagTicks + 64, 32));
    while (this.fairRing.length > maxKept) {
      this.fairRing.shift();
    }

    const laggedFair = this.laggedFair();
    const biasFrac = this.biasBps / 10_000;
    const biasedFair = clampBand(laggedFair + biasFrac);
    const u = syntheticVenueNoiseUnit(tickIndex, this.seed);
    const half = this.noiseBps / 10_000;
    const noiseOffset = half > 0 ? (2 * u - 1) * half : 0;
    const noisyTarget = clampBand(biasedFair + noiseOffset);

    const mid0 = clampBand(venueYesMidPublished);
    const alpha = this.reactionAlpha;
    const rawVenueYesMid = clampBand(
      mid0 + alpha * (noisyTarget - mid0)
    );

    return {
      tickIndex,
      fairValueYes: fair,
      laggedFairValueYes: laggedFair,
      biasedFairValueYes: biasedFair,
      noiseOffsetFrac: noiseOffset,
      noisyTargetYes: noisyTarget,
      rawVenueYesMid,
      venueYesMidPublishedBefore: mid0,
    };
  }
}
