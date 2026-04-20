import {
  DEFAULT_POLL_INTERVAL_MS,
} from "../binary/venue/binaryMarketFeed.js";
import {
  resolveBinaryMarketSelectorFromEnv,
  type BinaryMarketSelectorResolution,
} from "../binary/venue/binaryMarketSelector.js";
import type { BinarySignalSource, MarketMode } from "../market/types.js";
import {
  canonicalEnvKeyFor,
  type AppConfig,
  type ConfigSourceMeta,
} from "../config.js";

export const NORMALIZED_MONITOR_CONFIG_SCHEMA =
  "normalized_monitor_config_v2" as const;

export type SignalDetectionThresholdEntry = {
  effective: number | boolean;
  /** True when any env variable supplied this value (canonical or alias). */
  fromEnv: boolean;
  /** When set and different from the JSON key, names the env var that was read. */
  envSourceKey?: string;
};

/**
 * Effective movement/spike gates as interpreted at runtime, keyed by canonical env names.
 */
export type SignalDetectionThresholdsNormalized = {
  SPIKE_THRESHOLD: SignalDetectionThresholdEntry;
  TRADABLE_SPIKE_MIN_PERCENT: SignalDetectionThresholdEntry;
  EXCEPTIONAL_SPIKE_PERCENT: SignalDetectionThresholdEntry;
  RANGE_THRESHOLD: SignalDetectionThresholdEntry;
  MAX_PRIOR_RANGE_FOR_NORMAL_ENTRY: SignalDetectionThresholdEntry;
  SPIKE_MIN_RANGE_MULT: SignalDetectionThresholdEntry;
  STRONG_SPIKE_CONFIRMATION_TICKS: SignalDetectionThresholdEntry;
  ENABLE_BORDERLINE_MODE: SignalDetectionThresholdEntry;
};

const SIGNAL_DETECTION_SPEC = [
  { cfgKey: "spikeThreshold", jsonKey: "SPIKE_THRESHOLD" },
  { cfgKey: "tradableSpikeMinPercent", jsonKey: "TRADABLE_SPIKE_MIN_PERCENT" },
  { cfgKey: "exceptionalSpikePercent", jsonKey: "EXCEPTIONAL_SPIKE_PERCENT" },
  { cfgKey: "rangeThreshold", jsonKey: "RANGE_THRESHOLD" },
  { cfgKey: "maxPriorRangeForNormalEntry", jsonKey: "MAX_PRIOR_RANGE_FOR_NORMAL_ENTRY" },
  { cfgKey: "spikeMinRangeMultiple", jsonKey: "SPIKE_MIN_RANGE_MULT" },
  { cfgKey: "strongSpikeConfirmationTicks", jsonKey: "STRONG_SPIKE_CONFIRMATION_TICKS" },
  { cfgKey: "enableBorderlineMode", jsonKey: "ENABLE_BORDERLINE_MODE" },
] as const satisfies ReadonlyArray<{
  cfgKey: keyof AppConfig;
  jsonKey: keyof SignalDetectionThresholdsNormalized;
}>;

export type NormalizedMonitorConfigSummary = {
  schema: typeof NORMALIZED_MONITOR_CONFIG_SCHEMA;
  marketMode: MarketMode;
  signal: {
    source: BinarySignalSource;
    symbol: string;
  };
  executionVenue: {
    kind: "polymarket_gamma" | "synthetic_yes_no";
    selectorKind: BinaryMarketSelectorResolution["selectorKind"];
    selectorValue: string;
    /** Winning env key for Gamma selector, or empty for synthetic. */
    selectorSourceEnvKey: string;
  };
  effectiveExits: {
    takeProfit: number;
    takeProfitUnit: "bps" | "outcome_price_delta";
    stopLoss: number;
    stopLossUnit: "bps" | "outcome_price_delta";
    timeoutMs: number;
    timeoutAppliesTo: "spot_position" | "binary_outcome_leg";
  };
  staleFeeds: {
    blockEntriesOnStaleFeed: boolean;
    /** Shared: max age for Binance **signal** path (and legacy spot book) before entries blocked. */
    signalFeedStaleMaxAgeMs: number;
    /** Present when execution is Gamma — matches `BinaryMarketFeed` env tuning (post-alias). */
    gammaExecution?: {
      quoteStaleMaxMs: number;
      pollIntervalMs: number;
      pollSilenceMaxMs: number;
    };
  };
  /** Effective spike/range/borderline gates + provenance (canonical env names as keys). */
  signalDetection: SignalDetectionThresholdsNormalized;
};

function envIntPoly(key: string, fallback: number): number {
  const raw = process.env[key]?.trim();
  if (raw === undefined || raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

function oneSignalEntry(
  cfg: AppConfig,
  meta: ConfigSourceMeta,
  cfgKey: keyof AppConfig
): SignalDetectionThresholdEntry {
  const m = meta[cfgKey];
  const effective = cfg[cfgKey] as number | boolean;
  const canon = canonicalEnvKeyFor(cfgKey);
  return {
    effective,
    fromEnv: m.fromEnv,
    ...(m.fromEnv &&
    m.envSourceKey !== undefined &&
    m.envSourceKey !== canon
      ? { envSourceKey: m.envSourceKey }
      : {}),
  };
}

/** JSON fragment for `normalizedConfig.signalDetection`. */
export function buildSignalDetectionThresholdsNormalized(
  cfg: AppConfig,
  meta: ConfigSourceMeta
): SignalDetectionThresholdsNormalized {
  const out = {} as SignalDetectionThresholdsNormalized;
  for (const { cfgKey, jsonKey } of SIGNAL_DETECTION_SPEC) {
    out[jsonKey] = oneSignalEntry(cfg, meta, cfgKey);
  }
  return out;
}

function formatEffectiveValue(v: number | boolean): string {
  if (typeof v === "boolean") return v ? "true" : "false";
  if (Number.isInteger(v)) return String(v);
  const s = v.toString();
  return s.length > 14 ? v.toPrecision(6) : s;
}

function provenanceShort(
  m: ConfigSourceMeta[keyof AppConfig],
  canonical: string
): string {
  if (!m.fromEnv) return "default";
  const src = m.envSourceKey ?? canonical;
  if (src === canonical) return `from ${canonical}`;
  return `from ${src} (canonical ${canonical})`;
}

/** One line per threshold for {@link printLiveMonitorBanner}. */
export function formatSignalDetectionBannerLines(
  cfg: AppConfig,
  meta: ConfigSourceMeta
): string[] {
  return SIGNAL_DETECTION_SPEC.map(({ cfgKey, jsonKey }) => {
    const canon = jsonKey;
    const m = meta[cfgKey];
    const v = formatEffectiveValue(cfg[cfgKey] as number | boolean);
    return `${canon}=${v} (${provenanceShort(m, canon)})`;
  });
}

/**
 * JSON-safe snapshot of how the live monitor interprets env + `AppConfig`
 * (observability only — not a second source of truth for parsing).
 */
export function buildNormalizedMonitorConfigSummary(
  cfg: AppConfig,
  meta: ConfigSourceMeta
): NormalizedMonitorConfigSummary {
  const signalDetection = buildSignalDetectionThresholdsNormalized(cfg, meta);
  const sel = resolveBinaryMarketSelectorFromEnv();
  const gamma = sel.executionMode === "gamma";
  const pollMs = Math.max(
    2_000,
    envIntPoly("POLYMARKET_POLL_INTERVAL_MS", DEFAULT_POLL_INTERVAL_MS)
  );
  const maxQuoteAgeMs = Math.max(
    5_000,
    envIntPoly("POLYMARKET_QUOTE_STALE_MAX_MS", 120_000)
  );
  const maxPollSilenceMs = Math.max(
    pollMs * 2,
    envIntPoly("POLYMARKET_POLL_SILENCE_MAX_MS", Math.floor(pollMs * 2.5))
  );

  if (cfg.marketMode === "binary") {
    return {
      schema: NORMALIZED_MONITOR_CONFIG_SCHEMA,
      marketMode: "binary",
      signal: {
        source: cfg.binarySignalSource,
        symbol: cfg.binarySignalSymbol,
      },
      executionVenue: {
        kind: gamma ? "polymarket_gamma" : "synthetic_yes_no",
        selectorKind: sel.selectorKind,
        selectorValue: sel.selectorValue,
        selectorSourceEnvKey: sel.sourceEnvKey,
      },
      effectiveExits: {
        takeProfit: cfg.binaryTakeProfitPriceDelta,
        takeProfitUnit: "outcome_price_delta",
        stopLoss: cfg.binaryStopLossPriceDelta,
        stopLossUnit: "outcome_price_delta",
        timeoutMs: cfg.binaryExitTimeoutMs,
        timeoutAppliesTo: "binary_outcome_leg",
      },
      staleFeeds: {
        blockEntriesOnStaleFeed: cfg.blockEntriesOnStaleFeed,
        signalFeedStaleMaxAgeMs: cfg.feedStaleMaxAgeMs,
        ...(gamma
          ? {
              gammaExecution: {
                quoteStaleMaxMs: maxQuoteAgeMs,
                pollIntervalMs: pollMs,
                pollSilenceMaxMs: maxPollSilenceMs,
              },
            }
          : {}),
      },
      signalDetection,
    };
  }

  return {
    schema: NORMALIZED_MONITOR_CONFIG_SCHEMA,
    marketMode: "spot",
    signal: {
      source: cfg.binarySignalSource,
      symbol: cfg.binarySignalSymbol,
    },
    executionVenue: {
      kind: gamma ? "polymarket_gamma" : "synthetic_yes_no",
      selectorKind: sel.selectorKind,
      selectorValue: sel.selectorValue,
      selectorSourceEnvKey: sel.sourceEnvKey,
    },
    effectiveExits: {
      takeProfit: cfg.takeProfitBps,
      takeProfitUnit: "bps",
      stopLoss: cfg.stopLossBps,
      stopLossUnit: "bps",
      timeoutMs: cfg.exitTimeoutMs,
      timeoutAppliesTo: "spot_position",
    },
    staleFeeds: {
      blockEntriesOnStaleFeed: cfg.blockEntriesOnStaleFeed,
      signalFeedStaleMaxAgeMs: cfg.feedStaleMaxAgeMs,
    },
    signalDetection,
  };
}
