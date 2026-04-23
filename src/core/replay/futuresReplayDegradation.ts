import type { TopOfBookL1 } from "../domain/book.js";
import { syntheticBookFromMid } from "./futuresReplaySeries.js";

export type ReplayFailureProfile = "off" | "mild" | "stress" | "chaos";

export type ReplayFailureKind =
  | "missing_book"
  | "invalid_book"
  | "spread_widening"
  | "stale_feed"
  | "time_gap";

export type ReplayMarketCondition = {
  readonly atMs: number;
  readonly lastMessageAgeMs: number;
  readonly book: TopOfBookL1 | null;
  readonly kind: ReplayFailureKind | null;
  readonly reconnect: boolean;
  readonly degraded: boolean;
  readonly gapMs: number;
  readonly spreadMultiplier: number;
  readonly staleBoostMs: number;
  readonly reasons: readonly string[];
};

export type ReplayFailureConfig = {
  readonly profile: ReplayFailureProfile;
  readonly seed: number;
  readonly forceExitDisruption: boolean;
  readonly stepMs: number;
  readonly exitGracePeriodMs: number;
};

export type ReplayFailurePlanInput = {
  readonly atMs: number;
  readonly mid: number;
  readonly spreadBps: number;
  readonly previousMid: number | null;
  readonly feedStaleMaxAgeMs: number;
};

export type ReplayFailurePlan = {
  readonly condition: ReplayMarketCondition;
};

type ActiveStreak = {
  readonly kind: ReplayFailureKind;
  readonly remainingTicks: number;
  readonly spreadMultiplier: number;
  readonly staleBoostMs: number;
  readonly gapMs: number;
};

type ProfileWeights = Record<ReplayFailureKind, number>;

type ProfilePreset = {
  readonly weights: ProfileWeights;
  readonly minTicks: Record<ReplayFailureKind, number>;
  readonly maxTicks: Record<ReplayFailureKind, number>;
  readonly spreadMultiplierRange: [number, number];
  readonly staleBoostMsRange: [number, number];
  readonly gapMsRange: [number, number];
  readonly exitBurstTicks: number;
};

const PRESETS: Record<ReplayFailureProfile, ProfilePreset> = {
  off: {
    weights: {
      missing_book: 0,
      invalid_book: 0,
      spread_widening: 0,
      stale_feed: 0,
      time_gap: 0,
    },
    minTicks: {
      missing_book: 0,
      invalid_book: 0,
      spread_widening: 0,
      stale_feed: 0,
      time_gap: 0,
    },
    maxTicks: {
      missing_book: 0,
      invalid_book: 0,
      spread_widening: 0,
      stale_feed: 0,
      time_gap: 0,
    },
    spreadMultiplierRange: [1, 1],
    staleBoostMsRange: [0, 0],
    gapMsRange: [0, 0],
    exitBurstTicks: 0,
  },
  mild: {
    weights: {
      missing_book: 0.02,
      invalid_book: 0.02,
      spread_widening: 0.05,
      stale_feed: 0.04,
      time_gap: 0.03,
    },
    minTicks: {
      missing_book: 2,
      invalid_book: 2,
      spread_widening: 1,
      stale_feed: 1,
      time_gap: 1,
    },
    maxTicks: {
      missing_book: 3,
      invalid_book: 3,
      spread_widening: 2,
      stale_feed: 2,
      time_gap: 1,
    },
    spreadMultiplierRange: [2.5, 4],
    staleBoostMsRange: [5_000, 15_000],
    gapMsRange: [1_000, 6_000],
    exitBurstTicks: 2,
  },
  stress: {
    weights: {
      missing_book: 0.05,
      invalid_book: 0.05,
      spread_widening: 0.1,
      stale_feed: 0.08,
      time_gap: 0.05,
    },
    minTicks: {
      missing_book: 2,
      invalid_book: 2,
      spread_widening: 2,
      stale_feed: 2,
      time_gap: 1,
    },
    maxTicks: {
      missing_book: 4,
      invalid_book: 4,
      spread_widening: 3,
      stale_feed: 3,
      time_gap: 2,
    },
    spreadMultiplierRange: [4, 8],
    staleBoostMsRange: [10_000, 30_000],
    gapMsRange: [3_000, 12_000],
    exitBurstTicks: 3,
  },
  chaos: {
    weights: {
      missing_book: 0.1,
      invalid_book: 0.1,
      spread_widening: 0.15,
      stale_feed: 0.12,
      time_gap: 0.08,
    },
    minTicks: {
      missing_book: 3,
      invalid_book: 3,
      spread_widening: 2,
      stale_feed: 2,
      time_gap: 1,
    },
    maxTicks: {
      missing_book: 6,
      invalid_book: 6,
      spread_widening: 5,
      stale_feed: 5,
      time_gap: 3,
    },
    spreadMultiplierRange: [8, 15],
    staleBoostMsRange: [20_000, 60_000],
    gapMsRange: [6_000, 20_000],
    exitBurstTicks: 4,
  },
};

function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let x = Math.imul(t ^ (t >>> 15), 1 | t);
    x ^= x + Math.imul(x ^ (x >>> 7), 61 | x);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function randRange(rng: () => number, min: number, max: number): number {
  if (max <= min) return min;
  return min + rng() * (max - min);
}

function pickWeighted(
  rng: () => number,
  weights: ProfileWeights
): ReplayFailureKind | null {
  const entries = Object.entries(weights) as Array<[ReplayFailureKind, number]>;
  const total = entries.reduce((sum, [, w]) => sum + Math.max(0, w), 0);
  if (total <= 0) return null;
  let roll = rng() * total;
  for (const [kind, weight] of entries) {
    const w = Math.max(0, weight);
    if (w <= 0) continue;
    if (roll < w) return kind;
    roll -= w;
  }
  return null;
}

function makeInvalidBook(mid: number, spreadBps: number): TopOfBookL1 {
  const drift = Math.max(1, mid * 0.01);
  return {
    bestBid: mid + drift,
    bestAsk: Math.max(0.0001, mid - drift),
    midPrice: mid,
    spreadBps: -Math.max(1, spreadBps),
    bestBidSize: 0,
    bestAskSize: 0,
  };
}

export class ReplayFailureInjector {
  private readonly rng: () => number;
  private readonly preset: ProfilePreset;
  private previousEffectiveAtMs: number | null = null;
  private previousWasDegraded = false;
  private active: ActiveStreak | null = null;
  private pendingForcedBurst: ActiveStreak | null = null;
  private timeOffsetMs = 0;

  constructor(private readonly config: ReplayFailureConfig) {
    this.rng = mulberry32(config.seed);
    this.preset = PRESETS[config.profile];
  }

  armExitDisruption(): void {
    if (!this.config.forceExitDisruption) return;
    if (this.active !== null || this.pendingForcedBurst !== null) return;
    const kind: ReplayFailureKind = this.rng() < 0.5 ? "missing_book" : "invalid_book";
    const burstTicks = Math.max(
      this.preset.exitBurstTicks,
      Math.ceil(this.config.exitGracePeriodMs / Math.max(1, this.config.stepMs)) + 1
    );
    this.pendingForcedBurst = {
      kind,
      remainingTicks: burstTicks,
      spreadMultiplier: randRange(
        this.rng,
        this.preset.spreadMultiplierRange[0],
        this.preset.spreadMultiplierRange[1]
      ),
      staleBoostMs: randRange(
        this.rng,
        this.preset.staleBoostMsRange[0],
        this.preset.staleBoostMsRange[1]
      ),
      gapMs: randRange(
        this.rng,
        this.preset.gapMsRange[0],
        this.preset.gapMsRange[1]
      ),
    };
  }

  planTick(input: ReplayFailurePlanInput): ReplayFailurePlan {
    if (this.pendingForcedBurst !== null && this.active === null) {
      this.active = this.pendingForcedBurst;
      this.pendingForcedBurst = null;
    }
    const current = this.active;
    const kind = current?.kind ?? null;

    let effectiveAtMs = input.atMs + this.timeOffsetMs;
    let gapMs = 0;
    let spreadMultiplier = 1;
    let staleBoostMs = 0;
    let book: TopOfBookL1 | null = null;
    const reasons: string[] = [];

    if (kind === "missing_book") {
      book = null;
      reasons.push("missing_book");
    } else if (kind === "invalid_book") {
      book = makeInvalidBook(input.mid, input.spreadBps);
      reasons.push("invalid_book");
    } else {
      const spread = input.spreadBps;
      const effectiveSpread =
        kind === "spread_widening" && current
          ? spread * current.spreadMultiplier
          : spread;
      if (kind === "spread_widening") {
        spreadMultiplier = current?.spreadMultiplier ?? 1;
        reasons.push("spread_widening");
      }
      if (kind === "stale_feed") {
        staleBoostMs = current?.staleBoostMs ?? 0;
        reasons.push("stale_feed");
      }
      if (kind === "time_gap") {
        gapMs = current?.gapMs ?? 0;
        effectiveAtMs += gapMs;
        this.timeOffsetMs += gapMs;
        reasons.push("time_gap");
      }
      const ageForBook = this.previousEffectiveAtMs === null
        ? 0
        : Math.max(0, effectiveAtMs - this.previousEffectiveAtMs) + staleBoostMs;
      book = syntheticBookFromMid(input.mid, effectiveSpread, {
        previousMid: input.previousMid,
        lastMessageAgeMs: ageForBook,
      });
    }

    const lastMessageAgeMs =
      this.previousEffectiveAtMs === null
        ? 0
        : Math.max(0, effectiveAtMs - this.previousEffectiveAtMs) + staleBoostMs;

    const degraded = kind !== null;
    const reconnect = this.previousWasDegraded && !degraded;

    this.previousEffectiveAtMs = effectiveAtMs;
    this.previousWasDegraded = degraded;

    if (current) {
      this.tickActiveStreak();
    } else {
      this.maybeStartStreak();
    }

    return {
      condition: {
        atMs: effectiveAtMs,
        lastMessageAgeMs,
        book,
        kind,
        reconnect,
        degraded,
        gapMs,
        spreadMultiplier,
        staleBoostMs,
        reasons,
      },
    };
  }

  private tickActiveStreak(): void {
    if (!this.active) return;
    const remaining = this.active.remainingTicks - 1;
    this.active =
      remaining > 0
        ? { ...this.active, remainingTicks: remaining }
        : null;
  }

  private maybeStartStreak(): void {
    if (this.config.profile === "off" || this.active) return;
    const kind = pickWeighted(this.rng, this.preset.weights);
    if (kind === null) return;

    const min = this.preset.minTicks[kind];
    const max = this.preset.maxTicks[kind];
    const length = clampInt(randRange(this.rng, min, max + 1), min, Math.max(min, max));
    const spreadMultiplier = randRange(
      this.rng,
      this.preset.spreadMultiplierRange[0],
      this.preset.spreadMultiplierRange[1]
    );
    const staleBoostMs = randRange(
      this.rng,
      this.preset.staleBoostMsRange[0],
      this.preset.staleBoostMsRange[1]
    );
    const gapMs = randRange(
      this.rng,
      this.preset.gapMsRange[0],
      this.preset.gapMsRange[1]
    );

    this.active = {
      kind,
      remainingTicks: length,
      spreadMultiplier,
      staleBoostMs,
      gapMs,
    };
  }
}

export function createReplayFailureInjector(
  config: ReplayFailureConfig
): ReplayFailureInjector {
  return new ReplayFailureInjector(config);
}
