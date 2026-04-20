import type { SyntheticBinaryMarketOptions } from "./syntheticBinaryMarket.js";
import type { SyntheticVenuePricingOptions } from "./syntheticVenuePricing.js";

export type SyntheticMarketProfileName = "slow" | "balanced" | "reactive" | "noisy";

const PROFILES: Record<
  SyntheticMarketProfileName,
  {
    venue: Pick<
      SyntheticVenuePricingOptions,
      "lagTicks" | "reactionAlpha" | "noiseBps" | "biasBps"
    >;
    market: Pick<
      SyntheticBinaryMarketOptions,
      "spreadBps" | "slippageBps" | "midSmoothNewWeight"
    >;
  }
> = {
  slow: {
    venue: { lagTicks: 10, reactionAlpha: 0.1, noiseBps: 8, biasBps: 0 },
    market: { spreadBps: 32, slippageBps: 2, midSmoothNewWeight: 0.16 },
  },
  balanced: {
    venue: { lagTicks: 2, reactionAlpha: 0.42, noiseBps: 16, biasBps: 0 },
    market: { spreadBps: 30, slippageBps: 3, midSmoothNewWeight: 0.28 },
  },
  reactive: {
    venue: { lagTicks: 0, reactionAlpha: 0.88, noiseBps: 22, biasBps: 0 },
    market: { spreadBps: 24, slippageBps: 4, midSmoothNewWeight: 0.42 },
  },
  noisy: {
    venue: { lagTicks: 1, reactionAlpha: 0.52, noiseBps: 58, biasBps: 10 },
    market: { spreadBps: 48, slippageBps: 6, midSmoothNewWeight: 0.5 },
  },
};

function parseProfileRaw(raw: string | undefined): SyntheticMarketProfileName | null {
  if (raw === undefined || raw.trim() === "") return null;
  const k = raw.trim().toLowerCase() as SyntheticMarketProfileName;
  if (k in PROFILES) return k;
  console.warn(
    `[synthetic-market] SYNTHETIC_MARKET_PROFILE="${raw}" is unknown (use slow|balanced|reactive|noisy); ignoring profile`
  );
  return null;
}

/** When unset, no profile defaults are applied (legacy behaviour). */
export function parseSyntheticMarketProfileFromEnv(
  env: NodeJS.ProcessEnv = process.env
): SyntheticMarketProfileName | null {
  return parseProfileRaw(env.SYNTHETIC_MARKET_PROFILE);
}

export function venuePricingDefaultsForProfile(
  name: SyntheticMarketProfileName | null
): Partial<SyntheticVenuePricingOptions> {
  if (!name) return {};
  return { ...PROFILES[name].venue };
}

export function binaryMarketDefaultsForProfile(
  name: SyntheticMarketProfileName | null
): Partial<SyntheticBinaryMarketOptions> {
  if (!name) return {};
  return { ...PROFILES[name].market };
}

function parseFinite(keys: readonly string[], fallback: number, label: string): number {
  for (const k of keys) {
    const raw = process.env[k]?.trim();
    if (raw === undefined || raw === "") continue;
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
    console.warn(`[synthetic-market] ${k}="${raw}" invalid for ${label}; using ${fallback}`);
  }
  return fallback;
}

/**
 * Extra spread (bps) scales with this coefficient × instability EWM (0–1 scale).
 * `SYNTHETIC_MARKET_WIDEN_ON_VOLATILITY=0` disables widening.
 */
export function parseWidenOnVolatilityFromEnv(
  env: NodeJS.ProcessEnv = process.env
): number {
  const v = parseFinite(["SYNTHETIC_MARKET_WIDEN_ON_VOLATILITY"], 0, "widen on volatility");
  return Math.max(0, v);
}
