import dotenv from "dotenv";

import type { BinarySignalSource, MarketMode } from "./market/types.js";
import {
  formatBinaryExecutionVenueBannerLine,
  resolveBinaryMarketSelectorFromEnv,
} from "./binary/venue/binaryMarketSelector.js";

dotenv.config();

/**
 * First-class `BINARY_*` names for Gamma; copied into `POLYMARKET_*` only when the
 * legacy variable is unset (so explicit `POLYMARKET_*` still wins).
 * @see binary/venue/binaryMarketFeed
 */
function hydrateBinaryGammaEnvAliases(): void {
  const copyIfTargetEmpty = (target: string, source: string): void => {
    const t = process.env[target]?.trim();
    const s = process.env[source]?.trim();
    if ((!t || t.length === 0) && s && s.length > 0) {
      process.env[target] = s;
    }
  };
  copyIfTargetEmpty("POLYMARKET_MARKET_SLUG", "BINARY_MARKET_SLUG");
  copyIfTargetEmpty("POLYMARKET_MARKET_ID", "BINARY_MARKET_ID");
  copyIfTargetEmpty("POLYMARKET_CONDITION_ID", "BINARY_CONDITION_ID");
  copyIfTargetEmpty("POLYMARKET_GAMMA_API_BASE", "BINARY_GAMMA_API_BASE");
  copyIfTargetEmpty("POLYMARKET_POLL_INTERVAL_MS", "BINARY_POLL_INTERVAL_MS");
  copyIfTargetEmpty("POLYMARKET_QUOTE_STALE_MAX_MS", "BINARY_QUOTE_STALE_MAX_MS");
  copyIfTargetEmpty("POLYMARKET_POLL_SILENCE_MAX_MS", "BINARY_POLL_SILENCE_MAX_MS");
  copyIfTargetEmpty("POLYMARKET_SYNTHETIC_SPREAD_BPS", "BINARY_GAMMA_BOOK_SPREAD_BPS");
}

/** Prefer BINARY_* in new configs; warn when only POLYMARKET_* is set for a tier. */
function warnLegacyPolymarketGammaSelectors(): void {
  const tiers: [string, string][] = [
    ["BINARY_MARKET_ID", "POLYMARKET_MARKET_ID"],
    ["BINARY_MARKET_SLUG", "POLYMARKET_MARKET_SLUG"],
    ["BINARY_CONDITION_ID", "POLYMARKET_CONDITION_ID"],
  ];
  for (const [canonical, legacy] of tiers) {
    if (!process.env[canonical]?.trim() && process.env[legacy]?.trim()) {
      console.warn(
        `[config] ${legacy} is set without ${canonical}; prefer ${canonical} (canonical Gamma selector).`
      );
    }
  }
}

function collectFromEnvKeys(
  meta: ConfigSourceMeta,
  group: ConfigKeyGroup
): string[] {
  const out: string[] = [];
  for (const k of Object.keys(CONFIG_KEY_GROUP) as (keyof AppConfig)[]) {
    if (CONFIG_KEY_GROUP[k] !== group) continue;
    const m = meta[k];
    if (!m.fromEnv) continue;
    out.push(m.envSourceKey ?? m.resolvedFrom ?? ENV_KEYS[k]);
  }
  return out;
}

/**
 * Cross-mode env hygiene: spot vs binary keys are parsed for a clean mode switch,
 * but some combinations are misleading — warn once at startup.
 */
function warnCrossModeEnvAmbiguities(
  cfg: AppConfig,
  meta: ConfigSourceMeta
): void {
  const venue = resolveBinaryMarketSelectorFromEnv();

  if (cfg.marketMode === "spot") {
    if (venue.executionMode === "gamma") {
      console.warn(
        "[config] MARKET_MODE=spot but a Gamma market selector is set (BINARY_MARKET_* / POLYMARKET_MARKET_* / *_CONDITION_ID). Those are ignored until MARKET_MODE=binary."
      );
    }
    const binaryFromEnv = collectFromEnvKeys(meta, "binary");
    if (binaryFromEnv.length > 0) {
      console.warn(
        `[config] MARKET_MODE=spot: binary-only settings were read from env and are ignored (${binaryFromEnv.join(", ")}). Remove or comment them to avoid confusion.`
      );
    }
    return;
  }

  // MARKET_MODE=binary
  const spotTpSl: string[] = [];
  if (meta.takeProfitBps.fromEnv) spotTpSl.push(ENV_KEYS.takeProfitBps);
  if (meta.stopLossBps.fromEnv) spotTpSl.push(ENV_KEYS.stopLossBps);
  if (spotTpSl.length > 0) {
    console.warn(
      `[config] MARKET_MODE=binary: ${spotTpSl.join(" and ")} ${spotTpSl.length > 1 ? "are" : "is"} spot paper exit settings only. Binary paper uses ${ENV_KEYS.binaryTakeProfitPriceDelta} and ${ENV_KEYS.binaryStopLossPriceDelta} (absolute price Δ on the held YES/NO leg).`
    );
  }
  if (meta.exitTimeoutMs.fromEnv) {
    console.warn(
      `[config] MARKET_MODE=binary: ${ENV_KEYS.exitTimeoutMs} is the spot position timeout only. Outcome-leg timeout is ${ENV_KEYS.binaryExitTimeoutMs}.`
    );
  }
  if (
    !process.env.BINARY_SIGNAL_SYMBOL?.trim() &&
    process.env.BINANCE_SYMBOL?.trim()
  ) {
    console.warn(
      `[config] MARKET_MODE=binary: ${ENV_KEYS.binarySignalSymbol} unset; using BINANCE_SYMBOL for the signal pair. Prefer ${ENV_KEYS.binarySignalSymbol}=… (BINANCE_SYMBOL is the legacy spot execution symbol).`
    );
  }
  if (venue.executionMode === "gamma") {
    const synthKeys = [
      "BINARY_UP_PRICE",
      "UP_SIDE_PRICE",
      "BINARY_DOWN_PRICE",
      "DOWN_SIDE_PRICE",
      "BINARY_SYNTHETIC_SPREAD_BPS",
    ].filter((k) => Boolean(process.env[k]?.trim()));
    if (synthKeys.length > 0) {
      console.warn(
        `[config] MARKET_MODE=binary with Polymarket Gamma: ${synthKeys.join(", ")} only affect the synthetic execution feed and are ignored for live YES/NO quotes. Remove them to avoid confusion.`
      );
    }
  }
}

const DEPRECATED_POLYMARKET_ENV_KEYS = [
  "POLYMARKET_DISCOVERY_QUERY",
  "POLYMARKET_DISCOVERY_MIN_CONFIDENCE",
] as const;

/** Legacy env names still read by `loadConfig`; prefer `BINARY_*` equivalents. */
export const DEPRECATED_CONFIG_ENV_ALIASES: Readonly<
  Record<string, { prefer: string; note?: string }>
> = {
  MAX_OPPOSITE_SIDE_ENTRY_PRICE: {
    prefer: "BINARY_MAX_OPPOSITE_SIDE_ENTRY_PRICE",
  },
  MAX_ENTRY_SIDE_PRICE: { prefer: "BINARY_MAX_ENTRY_SIDE_PRICE" },
  NEUTRAL_QUOTE_BAND_MIN: { prefer: "BINARY_NEUTRAL_QUOTE_BAND_MIN" },
  NEUTRAL_QUOTE_BAND_MAX: { prefer: "BINARY_NEUTRAL_QUOTE_BAND_MAX" },
  SIGNAL_MODE: { prefer: "BINARY_SIGNAL_SOURCE", note: "binary signal source only" },
  PAPER_SLIPPAGE_BPS: { prefer: "BINARY_PAPER_SLIPPAGE_BPS" },
};

function warnDeprecatedPolymarketEnv(): void {
  for (const k of DEPRECATED_POLYMARKET_ENV_KEYS) {
    const v = process.env[k]?.trim();
    if (v) {
      console.warn(
        `[config] ${k} is deprecated (discovery not wired). Value ignored — use BINARY_MARKET_SLUG or BINARY_MARKET_ID (or legacy POLYMARKET_MARKET_*); see .env.example.`
      );
    }
  }
}

function warnLegacyBinaryEnvAliasesInUse(mode: MarketMode): void {
  if (mode !== "binary") return;
  for (const legacy of Object.keys(DEPRECATED_CONFIG_ENV_ALIASES)) {
    const v = process.env[legacy]?.trim();
    if (!v) continue;
    const { prefer, note } = DEPRECATED_CONFIG_ENV_ALIASES[legacy]!;
    const primarySet = Boolean(process.env[prefer]?.trim());
    if (primarySet) continue;
    const extra = note ? ` (${note})` : "";
    console.warn(
      `[config] ${legacy} is a deprecated env name${extra}; prefer ${prefer}=…`
    );
  }
}

/**
 * Built-in defaults when an env var is missing or invalid.
 *
 * **Layout:** {@link CONFIG_KEY_GROUP} tags each `AppConfig` field as
 * `shared` (strategy + paper commons), `binary` (YES/NO paper + signal routing),
 * or `spot` (Binance book paper + bps exits). In `MARKET_MODE=binary`, spot-only
 * numbers are kept for a clean switch back to spot but are not applied to exits.
 * Legacy env aliases that still populate values are listed in
 * {@link DEPRECATED_CONFIG_ENV_ALIASES}.
 */
export const configDefaults = {
  /** Minimum relative 1-tick move (fraction) to count as a spike. */
  spikeThreshold: 0.005,
  /** Minimum practical move quality for direct tradability (0.0015 = 0.15%). */
  tradableSpikeMinPercent: 0.0015,
  /** Max prior-window chop (excl. latest tick) for a “stable” regime. */
  rangeThreshold: 0.0012,
  /** Soft tolerance over rangeThreshold to classify pre-spike range as acceptable. */
  stableRangeSoftToleranceRatio: 1.5,
  /** Max prior-window relative range as a fraction (0.0015 = 0.15%). */
  maxPriorRangeForNormalEntry: 0.0015,
  /**
   * Hard reject threshold for unstable pre-spike context (fraction of min price):
   * if stableRangeDetected=false and prior range fraction exceeds this value.
   */
  hardRejectPriorRangePercent: 0.002,
  /** Optional hard reject for strong spikes when pre-range quality is poor. */
  strongSpikeHardRejectPoorRange: false,
  /** Number of ticks to wait for normal strong-spike confirmation. */
  strongSpikeConfirmationTicks: 1,
  /** Min spike percent to consider a move exceptional (0.0025 = 0.25%). */
  exceptionalSpikePercent: 0.0025,
  /**
   * Strong-spike profile (not yet exceptional): skip confirmation ticks when
   * `strongestMovePercent >= this × max(TRADABLE_SPIKE_MIN_PERCENT, EXCEPTIONAL_SPIKE_PERCENT)`.
   * `0` disables (always wait for confirmation when quality profile is not exceptional).
   */
  strongSpikeEarlyEntryExceptionalFraction: 0.7,
  /** If true, exceptional spikes can bypass cooldown-only blockers. */
  exceptionalSpikeOverridesCooldown: true,
  /** Max bid/ask spread (basis points) to allow a paper entry. */
  maxEntrySpreadBps: 40,
  /** Spike move must be ≥ this × prior-window relative range (filters weak spikes). */
  spikeMinRangeMultiple: 2.2,
  /** Borderline lower bound as ratio of SPIKE_THRESHOLD (e.g. 0.85 = 85%). */
  borderlineMinRatio: 0.85,
  /** Ticks to observe after a borderline move before delayed decision. */
  borderlineWatchTicks: 2,
  /** Require momentum pause during borderline watch window. */
  borderlineRequirePause: true,
  /** Block delayed entry if same-direction continuation stays strong. */
  borderlineRequireNoContinuation: true,
  /** Extra same-direction extension needed (fraction of original move) to call continuation. */
  borderlineContinuationThreshold: 0.25,
  /** Opposite-direction retrace needed (fraction of original move) to call reversion. */
  borderlineReversionThreshold: 0.2,
  /** Narrow band around detection price to classify as pause (fraction; 0.00015 = 0.015%). */
  borderlinePauseBandPercent: 0.00015,
  /**
   * Max time a borderline candidate may stay in `watching` (ms); then force-expire.
   * `0` disables the wall-clock cap (tick budget still applies).
   */
  borderlineMaxLifetimeMs: 8_000,
  /**
   * During borderline watch: same-direction BTC extension vs detection price (bps)
   * triggers immediate promote when ≥ this (e.g. 4 = 0.04%).
   */
  borderlineFastPromoteDeltaBps: 4,
  /**
   * During borderline watch (binary): promote when `P(up)` rises by at least this vs detection tick.
   * `0` disables the probability fast path.
   */
  borderlineFastPromoteProbDelta: 0.04,
  /**
   * When false (default), borderline watch is disabled: no borderline candidates,
   * strong spikes require strong or exceptional pre-entry quality (acceptable/weak blocked).
   * Set true to allow the delayed borderline path with stricter entry gates below.
   */
  enableBorderlineMode: false,
  /**
   * Minimum window spike `thresholdRatio` to start borderline watch when
   * {@link enableBorderlineMode} is true. `0` disables this extra ratio gate.
   */
  borderlineEntryMinThresholdRatio: 0.94,
  /**
   * When true and borderline mode is on, a borderline move must have stable range
   * detected before entering watch.
   */
  borderlineEntryRequiresStableRange: true,
  /**
   * During borderline watch: same-direction BTC extension vs detection (bps) cancels
   * the watch as a fast “continuation” reject. `0` disables.
   */
  borderlineFastRejectSameDirectionBps: 0,
  /** Take profit vs entry fill, in basis points (spot). */
  takeProfitBps: 35,
  /** Stop loss vs entry fill, in basis points (spot). */
  stopLossBps: 25,
  /**
   * Extra slippage (bps) on aggressive paper entry fills.
   * Binary: YES/NO buy slip; legacy spot paper: same knob on spot sim fills.
   * Env: `BINARY_PAPER_SLIPPAGE_BPS` (preferred) or `PAPER_SLIPPAGE_BPS` (alias).
   */
  binaryPaperSlippageBps: 3,
  /** Round-trip fee estimate as fraction of notional (bps), deducted from P/L. */
  paperFeeRoundTripBps: 8,
  /** Starting paper equity (same units as contract P/L). */
  initialCapital: 10_000,
  /** Max fraction of **current** equity at planned stop per trade (1 = 1%). */
  riskPercentPerTrade: 1,
  /** Fixed USDC notional deployed per simulated trade (paper sizing). */
  stakePerTrade: 30,
  /** Max hold time for a position before time-exit (ms). */
  exitTimeoutMs: 90_000,
  /** Binary paper: take-profit when held outcome mark ≥ entry fill + this (price points, e.g. 0.05). */
  binaryTakeProfitPriceDelta: 0.05,
  /** Binary paper: stop when held outcome mark ≤ entry fill − this (price points). */
  binaryStopLossPriceDelta: 0.05,
  /** Binary paper: max hold before time-exit (ms). `0` disables timeout for binary only. */
  binaryExitTimeoutMs: 90_000,
  /** Binary paper: skip entry when outcome fill price exceeds this (set high, e.g. 2, to effectively disable). */
  binaryMaxEntryPrice: 0.99,
  /**
   * Binary pipeline: max price on the **opposite** outcome (NO when buying YES, YES when buying NO).
   * Block uses `min(entrySideRaw, this)` as the cap on the opposite leg (see binary/entry/binaryQuoteEntryFilter).
   * Env: `MAX_OPPOSITE_SIDE_ENTRY_PRICE` or `BINARY_MAX_OPPOSITE_SIDE_ENTRY_PRICE` (latter wins if set).
   */
  binaryMaxOppositeSideEntryPrice: 0.78,
  /**
   * Binary pipeline: max raw price on the bought leg (YES for UP, NO for DOWN). `0` = disabled.
   */
  binaryMaxEntrySidePrice: 0,
  /** With {@link binaryNeutralQuoteBandMax}: if max > min, block when both YES and NO fall inside [min,max]. `0,0` disables. */
  binaryNeutralQuoteBandMin: 0,
  binaryNeutralQuoteBandMax: 0,
  /**
   * When true, YES/NO use separate mispricing floors and max entry prices when set (≥ 0).
   * `-1` on a side override means inherit {@link minEdgeThreshold} / {@link binaryMaxEntryPrice}.
   */
  binaryEnableSideSpecificGating: false,
  /** Override {@link minEdgeThreshold} for YES-only entries. `-1` = inherit global. */
  binaryYesMinMispricingThreshold: -1,
  /** Override {@link minEdgeThreshold} for NO-only entries. `-1` = inherit global. */
  binaryNoMinMispricingThreshold: -1,
  /** Override {@link binaryMaxEntryPrice} for YES-only entries. `-1` = inherit global. */
  binaryYesMaxEntryPrice: -1,
  /** Override {@link binaryMaxEntryPrice} for NO-only entries. `-1` = inherit global. */
  binaryNoMaxEntryPrice: -1,
  /**
   * Block binary entries when venue YES mid is outside `[binaryYesMidBandMin, binaryYesMidBandMax]`
   * (near-resolved token, little edge). Set false to disable.
   */
  binaryYesMidExtremeFilterEnabled: true,
  /** Inclusive lower bound on YES mid (0–1). */
  binaryYesMidBandMin: 0.05,
  /** Inclusive upper bound on YES mid (0–1). */
  binaryYesMidBandMax: 0.95,
  /**
   * Binary: reject entries when venue `spreadBps` exceeds this (hard cap).
   * `0` disables. Independent of {@link maxEntrySpreadBps} (strategy soft gate).
   */
  binaryHardMaxSpreadBps: 20,
  /** Min ms after a simulated exit before another entry (reduces churn). */
  entryCooldownMs: 120_000,
  /** Max number of recent prices to retain in the rolling buffer. */
  priceBufferSize: 20,
  /** Trailing spot mids used by {@link getBinaryProbability} (min 2, capped in loader). */
  probabilityWindowSize: 12,
  /** Horizon (ms) for BTC short-move probability — longer flattens toward 0.5. */
  probabilityTimeHorizonMs: 30_000,
  /** Sigmoid steepness on the normalized BTC probability score. */
  probabilitySigmoidK: 4,
  /**
   * Binary paper: extra floor on mean-reversion edge — require `(model P − ask) > minEdgeThreshold`.
   * `0` disables this extra floor only; binary `SimulationEngine` still requires strictly positive edge.
   */
  minEdgeThreshold: 0,
  /** Binary paper: max USDT stake from risk sizing; `0` = cap with `stakePerTrade` instead. */
  maxTradeSize: 0,
  /** Binary paper: floor USDT stake from risk-based sizing. */
  minTradeSize: 1,
  /**
   * When true, `weak` pre-entry quality profiles may pass the quality gate (for testing).
   * Downstream filters (quotes, cooldown, etc.) unchanged.
   */
  allowWeakQualityEntries: false,
  /**
   * When true (default), weak-quality bypass applies only to `strong_spike` moves,
   * not to `borderline` moves with a weak profile.
   */
  allowWeakQualityOnlyForStrongSpikes: true,
  /**
   * When true, strong_spike moves whose capped profile is only `acceptable` (e.g. pre-spike range
   * quality acceptable) may pass the pre-entry quality gate — same downstream rules as `strong`
   * (confirmation tick, quotes, etc.). Default false preserves legacy gate behavior.
   */
  allowAcceptableQualityStrongSpikes: false,
  /** Stake multiplier when quality is weak (only used if allowWeakQualityEntries). */
  weakQualitySizeMultiplier: 0.5,
  /** Stake multiplier for strong / acceptable quality when weak entries are enabled. */
  strongQualitySizeMultiplier: 1,
  /** Stake multiplier for exceptional quality when weak entries are enabled. */
  exceptionalQualitySizeMultiplier: 1,
  /**
   * `hard`: unstable pre-spike context triggers immediate pipeline hard reject (default).
   * `soft`: same detection is logged and annotated on the gate, but later gates may still run.
   */
  unstableContextMode: "hard" as "hard" | "soft",
  /**
   * When true, applies an explicit diagnostic preset (weak strong-spike entries, labeled logs).
   * Does not change defaults unless TEST_MODE=true — see loadConfig preset logic.
   */
  testMode: false,
  /**
   * When true, live monitor paper sim prints `[PAPER-MTM]` JSON for each open position:
   * quote snapshot at open, per-tick mark / distances / exit flags, and close snapshot.
   */
  paperPositionMtmDebug: false,
  /**
   * Block new entries when Binance bookTicker data is older than this (ms).
   */
  feedStaleMaxAgeMs: 15_000,
  /**
   * When true, stale WebSocket feed blocks entries (monitor paper pipeline).
   */
  blockEntriesOnStaleFeed: true,
  /**
   * Binary only: when true, never open with persisted entry path `strong_spike_immediate`
   * (blocks same-tick strong-spike fill; confirmation + borderline promote unchanged).
   */
  binaryDisableImmediateStrongSpike: false,
  /** `MARKET_MODE` — default binary on this branch. */
  marketMode: "binary" as MarketMode,
  /**
   * Binary only: where the rolling buffer / spike detector reads prices from.
   * `binance_spot` → Binance public spot for `binarySignalSymbol` (WS + REST bootstrap).
   */
  binarySignalSource: "binance_spot" as BinarySignalSource,
  /**
   * Binary only: Binance spot symbol for the signal feed (e.g. BTCUSDT).
   * Ignored when `MARKET_MODE=spot` (spot uses BINANCE_SYMBOL on the single feed).
   */
  binarySignalSymbol: "BTCUSDT",
} as const;

type ConfigKey = keyof typeof configDefaults;
type NonNumericConfigKey =
  | "unstableContextMode"
  | "marketMode"
  | "binarySignalSource"
  | "binarySignalSymbol";
type NumericOrBoolConfigKey = Exclude<ConfigKey, NonNumericConfigKey>;

export type AppConfig = {
  [K in NumericOrBoolConfigKey]: (typeof configDefaults)[K] extends boolean
    ? boolean
    : number;
} & {
  unstableContextMode: "hard" | "soft";
  marketMode: MarketMode;
  binarySignalSource: BinarySignalSource;
  binarySignalSymbol: string;
};

/**
 * Which startup config section a key belongs to (for grouped logging).
 * `"spot"` = legacy **spot execution** keys (bps TP/SL, spot timeout) — not the binary signal feed.
 */
export type ConfigKeyGroup = "shared" | "binary" | "spot";

/**
 * Maps each {@link AppConfig} key to shared / binary-only / spot-only for console output.
 * Keep in sync when adding env-backed settings.
 */
export const CONFIG_KEY_GROUP: { [K in keyof AppConfig]: ConfigKeyGroup } = {
  marketMode: "shared",
  spikeThreshold: "shared",
  tradableSpikeMinPercent: "shared",
  rangeThreshold: "shared",
  stableRangeSoftToleranceRatio: "shared",
  maxPriorRangeForNormalEntry: "shared",
  hardRejectPriorRangePercent: "shared",
  strongSpikeHardRejectPoorRange: "shared",
  strongSpikeConfirmationTicks: "shared",
  exceptionalSpikePercent: "shared",
  strongSpikeEarlyEntryExceptionalFraction: "shared",
  exceptionalSpikeOverridesCooldown: "shared",
  maxEntrySpreadBps: "shared",
  spikeMinRangeMultiple: "shared",
  borderlineMinRatio: "shared",
  borderlineWatchTicks: "shared",
  borderlineRequirePause: "shared",
  borderlineRequireNoContinuation: "shared",
  borderlineContinuationThreshold: "shared",
  borderlineReversionThreshold: "shared",
  borderlinePauseBandPercent: "shared",
  borderlineMaxLifetimeMs: "shared",
  borderlineFastPromoteDeltaBps: "shared",
  borderlineFastPromoteProbDelta: "shared",
  enableBorderlineMode: "shared",
  borderlineEntryMinThresholdRatio: "shared",
  borderlineEntryRequiresStableRange: "shared",
  borderlineFastRejectSameDirectionBps: "shared",
  initialCapital: "shared",
  riskPercentPerTrade: "shared",
  stakePerTrade: "shared",
  entryCooldownMs: "shared",
  priceBufferSize: "shared",
  probabilityWindowSize: "shared",
  probabilityTimeHorizonMs: "shared",
  probabilitySigmoidK: "shared",
  minEdgeThreshold: "binary",
  maxTradeSize: "binary",
  minTradeSize: "binary",
  allowWeakQualityEntries: "shared",
  allowWeakQualityOnlyForStrongSpikes: "shared",
  allowAcceptableQualityStrongSpikes: "shared",
  weakQualitySizeMultiplier: "shared",
  strongQualitySizeMultiplier: "shared",
  exceptionalQualitySizeMultiplier: "shared",
  unstableContextMode: "shared",
  testMode: "shared",
  paperPositionMtmDebug: "shared",
  blockEntriesOnStaleFeed: "shared",
  binaryPaperSlippageBps: "shared",
  paperFeeRoundTripBps: "shared",
  takeProfitBps: "spot",
  stopLossBps: "spot",
  exitTimeoutMs: "spot",
  /** Binance **signal** feed age (binary) and legacy spot book age — not Gamma quote staleness. */
  feedStaleMaxAgeMs: "shared",
  binaryTakeProfitPriceDelta: "binary",
  binaryStopLossPriceDelta: "binary",
  binaryExitTimeoutMs: "binary",
  binaryMaxEntryPrice: "binary",
  binaryMaxOppositeSideEntryPrice: "binary",
  binaryMaxEntrySidePrice: "binary",
  binaryNeutralQuoteBandMin: "binary",
  binaryNeutralQuoteBandMax: "binary",
  binaryEnableSideSpecificGating: "binary",
  binaryYesMinMispricingThreshold: "binary",
  binaryNoMinMispricingThreshold: "binary",
  binaryYesMaxEntryPrice: "binary",
  binaryNoMaxEntryPrice: "binary",
  binaryYesMidExtremeFilterEnabled: "binary",
  binaryYesMidBandMin: "binary",
  binaryYesMidBandMax: "binary",
  binaryHardMaxSpreadBps: "binary",
  binaryDisableImmediateStrongSpike: "binary",
  binarySignalSource: "binary",
  binarySignalSymbol: "binary",
};

/**
 * Per-key provenance for startup logging.
 * - `ENV_KEYS[k]` is always the **canonical** env name for documentation.
 * - `envSourceKey` is the variable that actually supplied the value when it differs
 *   from the canonical name (legacy alias) or for explicit provenance.
 */
export type ConfigSourceMeta = {
  [K in keyof AppConfig]: {
    fromEnv: boolean;
    envSourceKey?: string;
    resolvedFrom?: string;
  };
};

const ENV_KEYS: { [K in keyof AppConfig]: string } = {
  spikeThreshold: "SPIKE_THRESHOLD",
  tradableSpikeMinPercent: "TRADABLE_SPIKE_MIN_PERCENT",
  rangeThreshold: "RANGE_THRESHOLD",
  stableRangeSoftToleranceRatio: "STABLE_RANGE_SOFT_TOLERANCE_RATIO",
  maxPriorRangeForNormalEntry: "MAX_PRIOR_RANGE_FOR_NORMAL_ENTRY",
  hardRejectPriorRangePercent: "HARD_REJECT_PRIOR_RANGE_PERCENT",
  strongSpikeHardRejectPoorRange: "STRONG_SPIKE_HARD_REJECT_POOR_RANGE",
  strongSpikeConfirmationTicks: "STRONG_SPIKE_CONFIRMATION_TICKS",
  exceptionalSpikePercent: "EXCEPTIONAL_SPIKE_PERCENT",
  strongSpikeEarlyEntryExceptionalFraction:
    "STRONG_SPIKE_EARLY_ENTRY_EXCEPTIONAL_FRACTION",
  exceptionalSpikeOverridesCooldown: "EXCEPTIONAL_SPIKE_OVERRIDES_COOLDOWN",
  maxEntrySpreadBps: "MAX_ENTRY_SPREAD_BPS",
  spikeMinRangeMultiple: "SPIKE_MIN_RANGE_MULT",
  borderlineMinRatio: "BORDERLINE_MIN_RATIO",
  borderlineWatchTicks: "BORDERLINE_WATCH_TICKS",
  borderlineRequirePause: "BORDERLINE_REQUIRE_PAUSE",
  borderlineRequireNoContinuation: "BORDERLINE_REQUIRE_NO_CONTINUATION",
  borderlineContinuationThreshold: "BORDERLINE_CONTINUATION_THRESHOLD",
  borderlineReversionThreshold: "BORDERLINE_REVERSION_THRESHOLD",
  borderlinePauseBandPercent: "BORDERLINE_PAUSE_BAND_PERCENT",
  borderlineMaxLifetimeMs: "BORDERLINE_MAX_LIFETIME_MS",
  borderlineFastPromoteDeltaBps: "BORDERLINE_FAST_PROMOTE_DELTA_BPS",
  borderlineFastPromoteProbDelta: "BORDERLINE_FAST_PROMOTE_PROB_DELTA",
  enableBorderlineMode: "ENABLE_BORDERLINE_MODE",
  borderlineEntryMinThresholdRatio: "BORDERLINE_ENTRY_MIN_THRESHOLD_RATIO",
  borderlineEntryRequiresStableRange: "BORDERLINE_ENTRY_REQUIRES_STABLE_RANGE",
  borderlineFastRejectSameDirectionBps: "BORDERLINE_FAST_REJECT_SAME_DIRECTION_BPS",
  takeProfitBps: "TAKE_PROFIT_BPS",
  stopLossBps: "STOP_LOSS_BPS",
  binaryPaperSlippageBps: "BINARY_PAPER_SLIPPAGE_BPS",
  paperFeeRoundTripBps: "PAPER_FEE_ROUND_TRIP_BPS",
  initialCapital: "INITIAL_CAPITAL",
  riskPercentPerTrade: "RISK_PERCENT_PER_TRADE",
  stakePerTrade: "STAKE_PER_TRADE",
  exitTimeoutMs: "EXIT_TIMEOUT_MS",
  binaryTakeProfitPriceDelta: "BINARY_TAKE_PROFIT_PRICE_DELTA",
  binaryStopLossPriceDelta: "BINARY_STOP_LOSS_PRICE_DELTA",
  binaryExitTimeoutMs: "BINARY_EXIT_TIMEOUT_MS",
  binaryMaxEntryPrice: "BINARY_MAX_ENTRY_PRICE",
  binaryMaxOppositeSideEntryPrice: "BINARY_MAX_OPPOSITE_SIDE_ENTRY_PRICE",
  binaryMaxEntrySidePrice: "BINARY_MAX_ENTRY_SIDE_PRICE",
  binaryNeutralQuoteBandMin: "BINARY_NEUTRAL_QUOTE_BAND_MIN",
  binaryNeutralQuoteBandMax: "BINARY_NEUTRAL_QUOTE_BAND_MAX",
  binaryEnableSideSpecificGating: "BINARY_ENABLE_SIDE_SPECIFIC_GATING",
  binaryYesMinMispricingThreshold: "BINARY_YES_MIN_MISPRICING_THRESHOLD",
  binaryNoMinMispricingThreshold: "BINARY_NO_MIN_MISPRICING_THRESHOLD",
  binaryYesMaxEntryPrice: "BINARY_YES_MAX_ENTRY_PRICE",
  binaryNoMaxEntryPrice: "BINARY_NO_MAX_ENTRY_PRICE",
  binaryYesMidExtremeFilterEnabled: "BINARY_YES_MID_EXTREME_FILTER_ENABLED",
  binaryYesMidBandMin: "BINARY_YES_MID_BAND_MIN",
  binaryYesMidBandMax: "BINARY_YES_MID_BAND_MAX",
  binaryHardMaxSpreadBps: "BINARY_HARD_MAX_SPREAD_BPS",
  binaryDisableImmediateStrongSpike: "BINARY_DISABLE_IMMEDIATE_STRONG_SPIKE",
  entryCooldownMs: "ENTRY_COOLDOWN_MS",
  priceBufferSize: "PRICE_BUFFER_SIZE",
  probabilityWindowSize: "PROBABILITY_WINDOW_SIZE",
  probabilityTimeHorizonMs: "PROBABILITY_TIME_HORIZON_MS",
  probabilitySigmoidK: "PROBABILITY_SIGMOID_K",
  minEdgeThreshold: "MIN_EDGE_THRESHOLD",
  maxTradeSize: "MAX_TRADE_SIZE",
  minTradeSize: "MIN_TRADE_SIZE",
  allowWeakQualityEntries: "ALLOW_WEAK_QUALITY_ENTRIES",
  allowWeakQualityOnlyForStrongSpikes:
    "ALLOW_WEAK_QUALITY_ONLY_FOR_STRONG_SPIKES",
  allowAcceptableQualityStrongSpikes:
    "ALLOW_ACCEPTABLE_QUALITY_STRONG_SPIKES",
  weakQualitySizeMultiplier: "WEAK_QUALITY_SIZE_MULTIPLIER",
  strongQualitySizeMultiplier: "STRONG_QUALITY_SIZE_MULTIPLIER",
  exceptionalQualitySizeMultiplier: "EXCEPTIONAL_QUALITY_SIZE_MULTIPLIER",
  unstableContextMode: "UNSTABLE_CONTEXT_MODE",
  testMode: "TEST_MODE",
  paperPositionMtmDebug: "PAPER_POSITION_MTM_DEBUG",
  feedStaleMaxAgeMs: "FEED_STALE_MAX_AGE_MS",
  blockEntriesOnStaleFeed: "BLOCK_ENTRIES_ON_STALE_FEED",
  marketMode: "MARKET_MODE",
  binarySignalSource: "BINARY_SIGNAL_SOURCE",
  binarySignalSymbol: "BINARY_SIGNAL_SYMBOL",
};

function parseEnvNumber(
  envVar: string,
  defaultValue: number
): { value: number; fromEnv: boolean } {
  const raw = process.env[envVar];
  if (raw === undefined) {
    return { value: defaultValue, fromEnv: false };
  }

  const trimmed = raw.trim();
  if (trimmed === "") {
    return { value: defaultValue, fromEnv: false };
  }

  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) {
    console.warn(
      `[config] ${envVar}="${raw}" is not a valid number; using default ${defaultValue}`
    );
    return { value: defaultValue, fromEnv: false };
  }

  return { value: parsed, fromEnv: true };
}

function parseEnvBoolean(
  envVar: string,
  defaultValue: boolean
): { value: boolean; fromEnv: boolean } {
  const raw = process.env[envVar];
  if (raw === undefined) {
    return { value: defaultValue, fromEnv: false };
  }
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === "") {
    return { value: defaultValue, fromEnv: false };
  }
  if (trimmed === "1" || trimmed === "true" || trimmed === "yes" || trimmed === "on") {
    return { value: true, fromEnv: true };
  }
  if (trimmed === "0" || trimmed === "false" || trimmed === "no" || trimmed === "off") {
    return { value: false, fromEnv: true };
  }
  console.warn(
    `[config] ${envVar}="${raw}" is not a valid boolean; using default ${defaultValue}`
  );
  return { value: defaultValue, fromEnv: false };
}

function parseBinarySignalSource(
  defaultValue: BinarySignalSource
): {
  value: BinarySignalSource;
  fromEnv: boolean;
  envSourceKey?: string;
  resolvedFrom?: string;
} {
  const raw =
    process.env.BINARY_SIGNAL_SOURCE?.trim() || process.env.SIGNAL_MODE?.trim();
  if (!raw) {
    return { value: defaultValue, fromEnv: false };
  }
  const t = raw.toLowerCase();
  if (t === "binance_spot") {
    const fromPrimary = Boolean(process.env.BINARY_SIGNAL_SOURCE?.trim());
    return {
      value: "binance_spot",
      fromEnv: true,
      envSourceKey: fromPrimary ? "BINARY_SIGNAL_SOURCE" : "SIGNAL_MODE",
      ...(!fromPrimary
        ? { resolvedFrom: "SIGNAL_MODE (deprecated → BINARY_SIGNAL_SOURCE)" as const }
        : {}),
    };
  }
  console.warn(
    `[config] BINARY_SIGNAL_SOURCE / SIGNAL_MODE="${raw}" is not supported (only binance_spot); using "${defaultValue}"`
  );
  return { value: defaultValue, fromEnv: false };
}

/** Prefer `primaryVar`; fall back to legacy env name for backward compatibility. */
function parseEnvNumberPrimaryOrLegacy(
  primaryVar: string,
  legacyVar: string,
  defaultValue: number
): {
  value: number;
  fromEnv: boolean;
  envSourceKey?: string;
  resolvedFrom?: string;
} {
  const primary = parseEnvNumber(primaryVar, defaultValue);
  const legacy = parseEnvNumber(legacyVar, defaultValue);
  if (primary.fromEnv) {
    return { value: primary.value, fromEnv: true, envSourceKey: primaryVar };
  }
  if (legacy.fromEnv) {
    return {
      value: legacy.value,
      fromEnv: true,
      envSourceKey: legacyVar,
      resolvedFrom: `${legacyVar} (deprecated alias → ${primaryVar})`,
    };
  }
  return { value: primary.value, fromEnv: false };
}

function parseBinarySignalSymbol(defaultValue: string): {
  value: string;
  fromEnv: boolean;
  /** When set, shown in startup config (e.g. fallback env name). */
  resolvedFrom?: string;
  envSourceKey?: string;
} {
  const explicit = process.env.BINARY_SIGNAL_SYMBOL?.trim();
  if (explicit) {
    return {
      value: explicit.toUpperCase(),
      fromEnv: true,
      envSourceKey: "BINARY_SIGNAL_SYMBOL",
    };
  }
  const binance = process.env.BINANCE_SYMBOL?.trim();
  if (binance) {
    return {
      value: binance.toUpperCase(),
      fromEnv: false,
      envSourceKey: "BINANCE_SYMBOL",
      resolvedFrom:
        "default — BINANCE_SYMBOL (fallback; prefer BINARY_SIGNAL_SYMBOL for binary signal feed)",
    };
  }
  return { value: defaultValue.toUpperCase(), fromEnv: false };
}

function parseMarketMode(
  envVar: string,
  defaultValue: MarketMode
): { value: MarketMode; fromEnv: boolean; envSourceKey?: string } {
  const raw = process.env[envVar];
  if (raw === undefined) {
    return { value: defaultValue, fromEnv: false };
  }
  const t = raw.trim().toLowerCase();
  if (t === "") {
    return { value: defaultValue, fromEnv: false };
  }
  if (t === "spot") return { value: "spot", fromEnv: true, envSourceKey: envVar };
  if (t === "binary") return { value: "binary", fromEnv: true, envSourceKey: envVar };
  console.warn(
    `[config] ${envVar}="${raw}" must be spot or binary; using default "${defaultValue}"`
  );
  return { value: defaultValue, fromEnv: false };
}

function parseEnvUnstableContextMode(
  envVar: string,
  defaultValue: "hard" | "soft"
): { value: "hard" | "soft"; fromEnv: boolean } {
  const raw = process.env[envVar];
  if (raw === undefined) {
    return { value: defaultValue, fromEnv: false };
  }
  const t = raw.trim().toLowerCase();
  if (t === "") {
    return { value: defaultValue, fromEnv: false };
  }
  if (t === "hard" || t === "soft") {
    return { value: t, fromEnv: true };
  }
  console.warn(
    `[config] ${envVar}="${raw}" must be "hard" or "soft"; using default "${defaultValue}"`
  );
  return { value: defaultValue, fromEnv: false };
}

function loadConfig(): {
  config: AppConfig;
  _meta: ConfigSourceMeta;
} {
  hydrateBinaryGammaEnvAliases();
  warnLegacyPolymarketGammaSelectors();
  warnDeprecatedPolymarketEnv();
  const marketMode = parseMarketMode("MARKET_MODE", configDefaults.marketMode);
  warnLegacyBinaryEnvAliasesInUse(marketMode.value);
  const binarySignalSource = parseBinarySignalSource(configDefaults.binarySignalSource);
  const binarySignalSymbol = parseBinarySignalSymbol(configDefaults.binarySignalSymbol);
  const spikeThreshold = parseEnvNumber(
    "SPIKE_THRESHOLD",
    configDefaults.spikeThreshold
  );
  const tradableSpikeMinPercent = parseEnvNumber(
    "TRADABLE_SPIKE_MIN_PERCENT",
    configDefaults.tradableSpikeMinPercent
  );
  const rangeThreshold = parseEnvNumber(
    "RANGE_THRESHOLD",
    configDefaults.rangeThreshold
  );
  const stableRangeSoftToleranceRatio = parseEnvNumber(
    "STABLE_RANGE_SOFT_TOLERANCE_RATIO",
    configDefaults.stableRangeSoftToleranceRatio
  );
  const maxPriorRangeForNormalEntry = parseEnvNumber(
    "MAX_PRIOR_RANGE_FOR_NORMAL_ENTRY",
    configDefaults.maxPriorRangeForNormalEntry
  );
  const hardRejectPriorRangePercent = parseEnvNumber(
    "HARD_REJECT_PRIOR_RANGE_PERCENT",
    configDefaults.hardRejectPriorRangePercent
  );
  const strongSpikeHardRejectPoorRange = parseEnvBoolean(
    "STRONG_SPIKE_HARD_REJECT_POOR_RANGE",
    configDefaults.strongSpikeHardRejectPoorRange
  );
  const strongSpikeConfirmationTicksRaw = parseEnvNumber(
    "STRONG_SPIKE_CONFIRMATION_TICKS",
    configDefaults.strongSpikeConfirmationTicks
  );
  const strongSpikeConfirmationTicks = Math.max(
    0,
    Math.trunc(strongSpikeConfirmationTicksRaw.value)
  );
  const exceptionalSpikePercent = parseEnvNumber(
    "EXCEPTIONAL_SPIKE_PERCENT",
    configDefaults.exceptionalSpikePercent
  );
  const exceptionalSpikeOverridesCooldown = parseEnvBoolean(
    "EXCEPTIONAL_SPIKE_OVERRIDES_COOLDOWN",
    configDefaults.exceptionalSpikeOverridesCooldown
  );
  const strongSpikeEarlyEntryExceptionalFractionRaw = parseEnvNumber(
    "STRONG_SPIKE_EARLY_ENTRY_EXCEPTIONAL_FRACTION",
    configDefaults.strongSpikeEarlyEntryExceptionalFraction
  );
  const strongSpikeEarlyEntryExceptionalFraction = Math.min(
    1,
    Math.max(0, strongSpikeEarlyEntryExceptionalFractionRaw.value)
  );
  const maxEntrySpreadBps = parseEnvNumber(
    "MAX_ENTRY_SPREAD_BPS",
    configDefaults.maxEntrySpreadBps
  );
  const spikeMinRangeMultiple = parseEnvNumber(
    "SPIKE_MIN_RANGE_MULT",
    configDefaults.spikeMinRangeMultiple
  );
  const borderlineMinRatio = parseEnvNumber(
    "BORDERLINE_MIN_RATIO",
    configDefaults.borderlineMinRatio
  );
  const borderlineWatchTicksRaw = parseEnvNumber(
    "BORDERLINE_WATCH_TICKS",
    configDefaults.borderlineWatchTicks
  );
  const borderlineWatchTicks = Math.max(0, Math.trunc(borderlineWatchTicksRaw.value));
  const borderlineRequirePause = parseEnvBoolean(
    "BORDERLINE_REQUIRE_PAUSE",
    configDefaults.borderlineRequirePause
  );
  const borderlineRequireNoContinuation = parseEnvBoolean(
    "BORDERLINE_REQUIRE_NO_CONTINUATION",
    configDefaults.borderlineRequireNoContinuation
  );
  const borderlineContinuationThreshold = parseEnvNumber(
    "BORDERLINE_CONTINUATION_THRESHOLD",
    configDefaults.borderlineContinuationThreshold
  );
  const borderlineReversionThreshold = parseEnvNumber(
    "BORDERLINE_REVERSION_THRESHOLD",
    configDefaults.borderlineReversionThreshold
  );
  const borderlinePauseBandPercent = parseEnvNumber(
    "BORDERLINE_PAUSE_BAND_PERCENT",
    configDefaults.borderlinePauseBandPercent
  );
  const borderlineMaxLifetimeMs = parseEnvNumber(
    "BORDERLINE_MAX_LIFETIME_MS",
    configDefaults.borderlineMaxLifetimeMs
  );
  const borderlineFastPromoteDeltaBps = parseEnvNumber(
    "BORDERLINE_FAST_PROMOTE_DELTA_BPS",
    configDefaults.borderlineFastPromoteDeltaBps
  );
  const borderlineFastPromoteProbDelta = parseEnvNumber(
    "BORDERLINE_FAST_PROMOTE_PROB_DELTA",
    configDefaults.borderlineFastPromoteProbDelta
  );
  const enableBorderlineMode = parseEnvBoolean(
    "ENABLE_BORDERLINE_MODE",
    configDefaults.enableBorderlineMode
  );
  const borderlineEntryMinThresholdRatio = parseEnvNumber(
    "BORDERLINE_ENTRY_MIN_THRESHOLD_RATIO",
    configDefaults.borderlineEntryMinThresholdRatio
  );
  const borderlineEntryRequiresStableRange = parseEnvBoolean(
    "BORDERLINE_ENTRY_REQUIRES_STABLE_RANGE",
    configDefaults.borderlineEntryRequiresStableRange
  );
  const borderlineFastRejectSameDirectionBps = parseEnvNumber(
    "BORDERLINE_FAST_REJECT_SAME_DIRECTION_BPS",
    configDefaults.borderlineFastRejectSameDirectionBps
  );
  const takeProfitBps = parseEnvNumber(
    "TAKE_PROFIT_BPS",
    configDefaults.takeProfitBps
  );
  const stopLossBps = parseEnvNumber(
    "STOP_LOSS_BPS",
    configDefaults.stopLossBps
  );
  const binaryPaperSlippageBps = parseEnvNumberPrimaryOrLegacy(
    "BINARY_PAPER_SLIPPAGE_BPS",
    "PAPER_SLIPPAGE_BPS",
    configDefaults.binaryPaperSlippageBps
  );
  const paperFeeRoundTripBps = parseEnvNumber(
    "PAPER_FEE_ROUND_TRIP_BPS",
    configDefaults.paperFeeRoundTripBps
  );
  const initialCapital = parseEnvNumber(
    "INITIAL_CAPITAL",
    configDefaults.initialCapital
  );
  const riskPercentPerTrade = parseEnvNumber(
    "RISK_PERCENT_PER_TRADE",
    configDefaults.riskPercentPerTrade
  );
  const stakePerTrade = parseEnvNumber(
    "STAKE_PER_TRADE",
    configDefaults.stakePerTrade
  );
  const exitTimeoutMs = parseEnvNumber(
    "EXIT_TIMEOUT_MS",
    configDefaults.exitTimeoutMs
  );
  const binaryTakeProfitPriceDelta = parseEnvNumber(
    "BINARY_TAKE_PROFIT_PRICE_DELTA",
    configDefaults.binaryTakeProfitPriceDelta
  );
  const binaryStopLossPriceDelta = parseEnvNumber(
    "BINARY_STOP_LOSS_PRICE_DELTA",
    configDefaults.binaryStopLossPriceDelta
  );
  const binaryExitTimeoutMs = parseEnvNumber(
    "BINARY_EXIT_TIMEOUT_MS",
    configDefaults.binaryExitTimeoutMs
  );
  const binaryMaxEntryPrice = parseEnvNumber(
    "BINARY_MAX_ENTRY_PRICE",
    configDefaults.binaryMaxEntryPrice
  );
  const binaryMaxOppositeSideEntryPrice = parseEnvNumberPrimaryOrLegacy(
    "BINARY_MAX_OPPOSITE_SIDE_ENTRY_PRICE",
    "MAX_OPPOSITE_SIDE_ENTRY_PRICE",
    configDefaults.binaryMaxOppositeSideEntryPrice
  );
  const binaryMaxEntrySidePrice = parseEnvNumberPrimaryOrLegacy(
    "BINARY_MAX_ENTRY_SIDE_PRICE",
    "MAX_ENTRY_SIDE_PRICE",
    configDefaults.binaryMaxEntrySidePrice
  );
  const binaryNeutralQuoteBandMin = parseEnvNumberPrimaryOrLegacy(
    "BINARY_NEUTRAL_QUOTE_BAND_MIN",
    "NEUTRAL_QUOTE_BAND_MIN",
    configDefaults.binaryNeutralQuoteBandMin
  );
  const binaryNeutralQuoteBandMax = parseEnvNumberPrimaryOrLegacy(
    "BINARY_NEUTRAL_QUOTE_BAND_MAX",
    "NEUTRAL_QUOTE_BAND_MAX",
    configDefaults.binaryNeutralQuoteBandMax
  );
  const entryCooldownMs = parseEnvNumber(
    "ENTRY_COOLDOWN_MS",
    configDefaults.entryCooldownMs
  );
  const priceBufferSizeRaw = parseEnvNumber(
    "PRICE_BUFFER_SIZE",
    configDefaults.priceBufferSize
  );
  const priceBufferSize = Math.max(1, Math.trunc(priceBufferSizeRaw.value));
  const probabilityWindowSizeRaw = parseEnvNumber(
    "PROBABILITY_WINDOW_SIZE",
    configDefaults.probabilityWindowSize
  );
  const probabilityWindowSize = Math.max(
    2,
    Math.min(500, Math.trunc(probabilityWindowSizeRaw.value))
  );
  const probabilityTimeHorizonMsRaw = parseEnvNumber(
    "PROBABILITY_TIME_HORIZON_MS",
    configDefaults.probabilityTimeHorizonMs
  );
  const probabilityTimeHorizonMs = Math.max(100, probabilityTimeHorizonMsRaw.value);
  const probabilitySigmoidKRaw = parseEnvNumber(
    "PROBABILITY_SIGMOID_K",
    configDefaults.probabilitySigmoidK
  );
  const probabilitySigmoidK = Math.max(0.01, probabilitySigmoidKRaw.value);
  const minEdgeThresholdRaw = parseEnvNumber(
    "MIN_EDGE_THRESHOLD",
    configDefaults.minEdgeThreshold
  );
  const minEdgeThreshold = Math.min(
    1,
    Math.max(0, minEdgeThresholdRaw.value)
  );
  const maxTradeSizeRaw = parseEnvNumber(
    "MAX_TRADE_SIZE",
    configDefaults.maxTradeSize
  );
  const maxTradeSize = Math.max(0, maxTradeSizeRaw.value);
  const minTradeSizeRaw = parseEnvNumber(
    "MIN_TRADE_SIZE",
    configDefaults.minTradeSize
  );
  const minTradeSize = Math.max(0, minTradeSizeRaw.value);
  const allowWeakQualityEntries = parseEnvBoolean(
    "ALLOW_WEAK_QUALITY_ENTRIES",
    configDefaults.allowWeakQualityEntries
  );
  const allowWeakQualityOnlyForStrongSpikes = parseEnvBoolean(
    "ALLOW_WEAK_QUALITY_ONLY_FOR_STRONG_SPIKES",
    configDefaults.allowWeakQualityOnlyForStrongSpikes
  );
  const allowAcceptableQualityStrongSpikes = parseEnvBoolean(
    "ALLOW_ACCEPTABLE_QUALITY_STRONG_SPIKES",
    configDefaults.allowAcceptableQualityStrongSpikes
  );
  const weakQualitySizeMultiplier = parseEnvNumber(
    "WEAK_QUALITY_SIZE_MULTIPLIER",
    configDefaults.weakQualitySizeMultiplier
  );
  const strongQualitySizeMultiplier = parseEnvNumber(
    "STRONG_QUALITY_SIZE_MULTIPLIER",
    configDefaults.strongQualitySizeMultiplier
  );
  const exceptionalQualitySizeMultiplier = parseEnvNumber(
    "EXCEPTIONAL_QUALITY_SIZE_MULTIPLIER",
    configDefaults.exceptionalQualitySizeMultiplier
  );
  const unstableContextMode = parseEnvUnstableContextMode(
    "UNSTABLE_CONTEXT_MODE",
    configDefaults.unstableContextMode
  );
  const testModeParsed = parseEnvBoolean("TEST_MODE", configDefaults.testMode);
  const feedStaleMaxAgeMs = parseEnvNumber(
    "FEED_STALE_MAX_AGE_MS",
    configDefaults.feedStaleMaxAgeMs
  );
  const blockEntriesOnStaleFeed = parseEnvBoolean(
    "BLOCK_ENTRIES_ON_STALE_FEED",
    configDefaults.blockEntriesOnStaleFeed
  );
  const binaryDisableImmediateStrongSpike = parseEnvBoolean(
    "BINARY_DISABLE_IMMEDIATE_STRONG_SPIKE",
    configDefaults.binaryDisableImmediateStrongSpike
  );
  const paperPositionMtmDebug = parseEnvBoolean(
    "PAPER_POSITION_MTM_DEBUG",
    configDefaults.paperPositionMtmDebug
  );
  const binaryEnableSideSpecificGating = parseEnvBoolean(
    "BINARY_ENABLE_SIDE_SPECIFIC_GATING",
    configDefaults.binaryEnableSideSpecificGating
  );
  const binaryYesMinMispricingThresholdRaw = parseEnvNumber(
    "BINARY_YES_MIN_MISPRICING_THRESHOLD",
    configDefaults.binaryYesMinMispricingThreshold
  );
  const binaryNoMinMispricingThresholdRaw = parseEnvNumber(
    "BINARY_NO_MIN_MISPRICING_THRESHOLD",
    configDefaults.binaryNoMinMispricingThreshold
  );
  const binaryYesMaxEntryPriceRaw = parseEnvNumber(
    "BINARY_YES_MAX_ENTRY_PRICE",
    configDefaults.binaryYesMaxEntryPrice
  );
  const binaryNoMaxEntryPriceRaw = parseEnvNumber(
    "BINARY_NO_MAX_ENTRY_PRICE",
    configDefaults.binaryNoMaxEntryPrice
  );
  const binaryYesMinMispricingThreshold =
    binaryYesMinMispricingThresholdRaw.value < 0
      ? -1
      : Math.min(1, Math.max(0, binaryYesMinMispricingThresholdRaw.value));
  const binaryNoMinMispricingThreshold =
    binaryNoMinMispricingThresholdRaw.value < 0
      ? -1
      : Math.min(1, Math.max(0, binaryNoMinMispricingThresholdRaw.value));
  const binaryYesMaxEntryPrice =
    binaryYesMaxEntryPriceRaw.value < 0
      ? -1
      : Math.min(10, Math.max(0, binaryYesMaxEntryPriceRaw.value));
  const binaryNoMaxEntryPrice =
    binaryNoMaxEntryPriceRaw.value < 0
      ? -1
      : Math.min(10, Math.max(0, binaryNoMaxEntryPriceRaw.value));
  const binaryYesMidExtremeFilterEnabled = parseEnvBoolean(
    "BINARY_YES_MID_EXTREME_FILTER_ENABLED",
    configDefaults.binaryYesMidExtremeFilterEnabled
  );
  const binaryYesMidBandMinRaw = parseEnvNumber(
    "BINARY_YES_MID_BAND_MIN",
    configDefaults.binaryYesMidBandMin
  );
  const binaryYesMidBandMaxRaw = parseEnvNumber(
    "BINARY_YES_MID_BAND_MAX",
    configDefaults.binaryYesMidBandMax
  );
  let binaryYesMidBandMin = Math.min(
    1,
    Math.max(0, binaryYesMidBandMinRaw.value)
  );
  let binaryYesMidBandMax = Math.min(
    1,
    Math.max(0, binaryYesMidBandMaxRaw.value)
  );
  if (binaryYesMidBandMin > binaryYesMidBandMax) {
    const t = binaryYesMidBandMin;
    binaryYesMidBandMin = binaryYesMidBandMax;
    binaryYesMidBandMax = t;
  }
  const binaryHardMaxSpreadBpsRaw = parseEnvNumber(
    "BINARY_HARD_MAX_SPREAD_BPS",
    configDefaults.binaryHardMaxSpreadBps
  );
  const binaryHardMaxSpreadBps = Math.max(0, binaryHardMaxSpreadBpsRaw.value);
  const testModeSoftUnstable = parseEnvBoolean(
    "TEST_MODE_SOFT_UNSTABLE",
    false
  );
  if (testModeSoftUnstable.value && !testModeParsed.value) {
    console.warn(
      "[config] TEST_MODE_SOFT_UNSTABLE is ignored unless TEST_MODE=true"
    );
  }

  let config: AppConfig = {
      spikeThreshold: spikeThreshold.value,
      tradableSpikeMinPercent: Math.max(0, tradableSpikeMinPercent.value),
      rangeThreshold: rangeThreshold.value,
      stableRangeSoftToleranceRatio: Math.max(
        1,
        stableRangeSoftToleranceRatio.value
      ),
      maxPriorRangeForNormalEntry: Math.max(0, maxPriorRangeForNormalEntry.value),
      hardRejectPriorRangePercent: Math.max(0, hardRejectPriorRangePercent.value),
      strongSpikeHardRejectPoorRange: strongSpikeHardRejectPoorRange.value,
      strongSpikeConfirmationTicks,
      exceptionalSpikePercent: Math.max(0, exceptionalSpikePercent.value),
      strongSpikeEarlyEntryExceptionalFraction,
      exceptionalSpikeOverridesCooldown: exceptionalSpikeOverridesCooldown.value,
      maxEntrySpreadBps: Math.max(0, maxEntrySpreadBps.value),
      spikeMinRangeMultiple: Math.max(0, spikeMinRangeMultiple.value),
      borderlineMinRatio: Math.min(1, Math.max(0, borderlineMinRatio.value)),
      borderlineWatchTicks,
      borderlineRequirePause: borderlineRequirePause.value,
      borderlineRequireNoContinuation: borderlineRequireNoContinuation.value,
      borderlineContinuationThreshold: Math.max(
        0,
        borderlineContinuationThreshold.value
      ),
      borderlineReversionThreshold: Math.max(0, borderlineReversionThreshold.value),
      borderlinePauseBandPercent: Math.max(0, borderlinePauseBandPercent.value),
      borderlineMaxLifetimeMs: Math.max(0, borderlineMaxLifetimeMs.value),
      borderlineFastPromoteDeltaBps: Math.max(0, borderlineFastPromoteDeltaBps.value),
      borderlineFastPromoteProbDelta: Math.max(
        0,
        borderlineFastPromoteProbDelta.value
      ),
      enableBorderlineMode: enableBorderlineMode.value,
      borderlineEntryMinThresholdRatio: Math.min(
        1,
        Math.max(0, borderlineEntryMinThresholdRatio.value)
      ),
      borderlineEntryRequiresStableRange: borderlineEntryRequiresStableRange.value,
      borderlineFastRejectSameDirectionBps: Math.max(
        0,
        borderlineFastRejectSameDirectionBps.value
      ),
      takeProfitBps: Math.max(0, takeProfitBps.value),
      stopLossBps: Math.max(0, stopLossBps.value),
      binaryPaperSlippageBps: Math.max(0, binaryPaperSlippageBps.value),
      paperFeeRoundTripBps: Math.max(0, paperFeeRoundTripBps.value),
      initialCapital: Math.max(1, initialCapital.value),
      riskPercentPerTrade: Math.min(100, Math.max(0, riskPercentPerTrade.value)),
      stakePerTrade: Math.max(0, stakePerTrade.value),
      exitTimeoutMs: Math.max(0, exitTimeoutMs.value),
      binaryTakeProfitPriceDelta: Math.max(0, binaryTakeProfitPriceDelta.value),
      binaryStopLossPriceDelta: Math.max(0, binaryStopLossPriceDelta.value),
      binaryExitTimeoutMs: Math.max(0, binaryExitTimeoutMs.value),
      binaryMaxEntryPrice: Math.max(0, binaryMaxEntryPrice.value),
      binaryMaxOppositeSideEntryPrice: Math.max(
        0,
        binaryMaxOppositeSideEntryPrice.value
      ),
      binaryMaxEntrySidePrice: Math.max(0, binaryMaxEntrySidePrice.value),
      binaryNeutralQuoteBandMin: Math.max(0, binaryNeutralQuoteBandMin.value),
      binaryNeutralQuoteBandMax: Math.max(
        0,
        binaryNeutralQuoteBandMax.value
      ),
      binaryEnableSideSpecificGating: binaryEnableSideSpecificGating.value,
      binaryYesMinMispricingThreshold,
      binaryNoMinMispricingThreshold,
      binaryYesMaxEntryPrice,
      binaryNoMaxEntryPrice,
      binaryYesMidExtremeFilterEnabled: binaryYesMidExtremeFilterEnabled.value,
      binaryYesMidBandMin,
      binaryYesMidBandMax,
      binaryHardMaxSpreadBps,
      entryCooldownMs: Math.max(0, entryCooldownMs.value),
      priceBufferSize,
      probabilityWindowSize,
      probabilityTimeHorizonMs,
      probabilitySigmoidK,
      minEdgeThreshold,
      maxTradeSize,
      minTradeSize,
      allowWeakQualityEntries: allowWeakQualityEntries.value,
      allowWeakQualityOnlyForStrongSpikes:
        allowWeakQualityOnlyForStrongSpikes.value,
      allowAcceptableQualityStrongSpikes: allowAcceptableQualityStrongSpikes.value,
      weakQualitySizeMultiplier: Math.max(0, weakQualitySizeMultiplier.value),
      strongQualitySizeMultiplier: Math.max(0, strongQualitySizeMultiplier.value),
      exceptionalQualitySizeMultiplier: Math.max(
        0,
        exceptionalQualitySizeMultiplier.value
      ),
      unstableContextMode: unstableContextMode.value,
      testMode: testModeParsed.value,
      feedStaleMaxAgeMs: Math.max(0, feedStaleMaxAgeMs.value),
      blockEntriesOnStaleFeed: blockEntriesOnStaleFeed.value,
      binaryDisableImmediateStrongSpike: binaryDisableImmediateStrongSpike.value,
      paperPositionMtmDebug: paperPositionMtmDebug.value,
      marketMode: marketMode.value,
      binarySignalSource: binarySignalSource.value,
      binarySignalSymbol: binarySignalSymbol.value,
  };

  if (config.testMode) {
    if (!config.allowWeakQualityEntries) {
      console.log(
        "[config] TEST_MODE=true: overriding allowWeakQualityEntries false → true (diagnostic preset; not production)"
      );
    }
    if (!config.allowWeakQualityOnlyForStrongSpikes) {
      console.log(
        "[config] TEST_MODE=true: overriding allowWeakQualityOnlyForStrongSpikes false → true (weak entries limited to strong_spike path)"
      );
    }
    config.allowWeakQualityEntries = true;
    config.allowWeakQualityOnlyForStrongSpikes = true;
    console.log(
      `[config] TEST_MODE preset: weak-profile strong_spike entries allowed; weak stake uses WEAK_QUALITY_SIZE_MULTIPLIER=${config.weakQualitySizeMultiplier} (explicit, not silent)`
    );
    if (testModeSoftUnstable.value) {
      config.unstableContextMode = "soft";
      console.log(
        "[config] TEST_MODE=true: TEST_MODE_SOFT_UNSTABLE=1 → unstableContextMode=soft (optional diagnostic; UNSTABLE_CONTEXT_MODE from env was overridden)"
      );
    }
  }

  const _meta: ConfigSourceMeta = {
      spikeThreshold: { fromEnv: spikeThreshold.fromEnv },
      tradableSpikeMinPercent: { fromEnv: tradableSpikeMinPercent.fromEnv },
      rangeThreshold: { fromEnv: rangeThreshold.fromEnv },
      stableRangeSoftToleranceRatio: {
        fromEnv: stableRangeSoftToleranceRatio.fromEnv,
      },
      maxPriorRangeForNormalEntry: {
        fromEnv: maxPriorRangeForNormalEntry.fromEnv,
      },
      hardRejectPriorRangePercent: {
        fromEnv: hardRejectPriorRangePercent.fromEnv,
      },
      strongSpikeHardRejectPoorRange: {
        fromEnv: strongSpikeHardRejectPoorRange.fromEnv,
      },
      strongSpikeConfirmationTicks: {
        fromEnv: strongSpikeConfirmationTicksRaw.fromEnv,
      },
      exceptionalSpikePercent: { fromEnv: exceptionalSpikePercent.fromEnv },
      strongSpikeEarlyEntryExceptionalFraction: {
        fromEnv: strongSpikeEarlyEntryExceptionalFractionRaw.fromEnv,
      },
      exceptionalSpikeOverridesCooldown: {
        fromEnv: exceptionalSpikeOverridesCooldown.fromEnv,
      },
      maxEntrySpreadBps: { fromEnv: maxEntrySpreadBps.fromEnv },
      spikeMinRangeMultiple: { fromEnv: spikeMinRangeMultiple.fromEnv },
      borderlineMinRatio: { fromEnv: borderlineMinRatio.fromEnv },
      borderlineWatchTicks: { fromEnv: borderlineWatchTicksRaw.fromEnv },
      borderlineRequirePause: { fromEnv: borderlineRequirePause.fromEnv },
      borderlineRequireNoContinuation: {
        fromEnv: borderlineRequireNoContinuation.fromEnv,
      },
      borderlineContinuationThreshold: {
        fromEnv: borderlineContinuationThreshold.fromEnv,
      },
      borderlineReversionThreshold: { fromEnv: borderlineReversionThreshold.fromEnv },
      borderlinePauseBandPercent: { fromEnv: borderlinePauseBandPercent.fromEnv },
      borderlineMaxLifetimeMs: { fromEnv: borderlineMaxLifetimeMs.fromEnv },
      borderlineFastPromoteDeltaBps: {
        fromEnv: borderlineFastPromoteDeltaBps.fromEnv,
      },
      borderlineFastPromoteProbDelta: {
        fromEnv: borderlineFastPromoteProbDelta.fromEnv,
      },
      enableBorderlineMode: { fromEnv: enableBorderlineMode.fromEnv },
      borderlineEntryMinThresholdRatio: {
        fromEnv: borderlineEntryMinThresholdRatio.fromEnv,
      },
      borderlineEntryRequiresStableRange: {
        fromEnv: borderlineEntryRequiresStableRange.fromEnv,
      },
      borderlineFastRejectSameDirectionBps: {
        fromEnv: borderlineFastRejectSameDirectionBps.fromEnv,
      },
      takeProfitBps: { fromEnv: takeProfitBps.fromEnv },
      stopLossBps: { fromEnv: stopLossBps.fromEnv },
      binaryPaperSlippageBps: {
        fromEnv: binaryPaperSlippageBps.fromEnv,
        ...(binaryPaperSlippageBps.envSourceKey !== undefined
          ? { envSourceKey: binaryPaperSlippageBps.envSourceKey }
          : {}),
        ...(binaryPaperSlippageBps.resolvedFrom !== undefined
          ? { resolvedFrom: binaryPaperSlippageBps.resolvedFrom }
          : {}),
      },
      paperFeeRoundTripBps: { fromEnv: paperFeeRoundTripBps.fromEnv },
      initialCapital: { fromEnv: initialCapital.fromEnv },
      riskPercentPerTrade: { fromEnv: riskPercentPerTrade.fromEnv },
      stakePerTrade: { fromEnv: stakePerTrade.fromEnv },
      exitTimeoutMs: { fromEnv: exitTimeoutMs.fromEnv },
      binaryTakeProfitPriceDelta: { fromEnv: binaryTakeProfitPriceDelta.fromEnv },
      binaryStopLossPriceDelta: { fromEnv: binaryStopLossPriceDelta.fromEnv },
      binaryExitTimeoutMs: { fromEnv: binaryExitTimeoutMs.fromEnv },
      binaryMaxEntryPrice: { fromEnv: binaryMaxEntryPrice.fromEnv },
      binaryMaxOppositeSideEntryPrice: {
        fromEnv: binaryMaxOppositeSideEntryPrice.fromEnv,
        ...(binaryMaxOppositeSideEntryPrice.envSourceKey !== undefined
          ? { envSourceKey: binaryMaxOppositeSideEntryPrice.envSourceKey }
          : {}),
        ...(binaryMaxOppositeSideEntryPrice.resolvedFrom !== undefined
          ? { resolvedFrom: binaryMaxOppositeSideEntryPrice.resolvedFrom }
          : {}),
      },
      binaryMaxEntrySidePrice: {
        fromEnv: binaryMaxEntrySidePrice.fromEnv,
        ...(binaryMaxEntrySidePrice.envSourceKey !== undefined
          ? { envSourceKey: binaryMaxEntrySidePrice.envSourceKey }
          : {}),
        ...(binaryMaxEntrySidePrice.resolvedFrom !== undefined
          ? { resolvedFrom: binaryMaxEntrySidePrice.resolvedFrom }
          : {}),
      },
      binaryNeutralQuoteBandMin: {
        fromEnv: binaryNeutralQuoteBandMin.fromEnv,
        ...(binaryNeutralQuoteBandMin.envSourceKey !== undefined
          ? { envSourceKey: binaryNeutralQuoteBandMin.envSourceKey }
          : {}),
        ...(binaryNeutralQuoteBandMin.resolvedFrom !== undefined
          ? { resolvedFrom: binaryNeutralQuoteBandMin.resolvedFrom }
          : {}),
      },
      binaryNeutralQuoteBandMax: {
        fromEnv: binaryNeutralQuoteBandMax.fromEnv,
        ...(binaryNeutralQuoteBandMax.envSourceKey !== undefined
          ? { envSourceKey: binaryNeutralQuoteBandMax.envSourceKey }
          : {}),
        ...(binaryNeutralQuoteBandMax.resolvedFrom !== undefined
          ? { resolvedFrom: binaryNeutralQuoteBandMax.resolvedFrom }
          : {}),
      },
      binaryEnableSideSpecificGating: {
        fromEnv: binaryEnableSideSpecificGating.fromEnv,
      },
      binaryYesMinMispricingThreshold: {
        fromEnv: binaryYesMinMispricingThresholdRaw.fromEnv,
      },
      binaryNoMinMispricingThreshold: {
        fromEnv: binaryNoMinMispricingThresholdRaw.fromEnv,
      },
      binaryYesMaxEntryPrice: {
        fromEnv: binaryYesMaxEntryPriceRaw.fromEnv,
      },
      binaryNoMaxEntryPrice: {
        fromEnv: binaryNoMaxEntryPriceRaw.fromEnv,
      },
      binaryYesMidExtremeFilterEnabled: {
        fromEnv: binaryYesMidExtremeFilterEnabled.fromEnv,
      },
      binaryYesMidBandMin: {
        fromEnv: binaryYesMidBandMinRaw.fromEnv,
      },
      binaryYesMidBandMax: {
        fromEnv: binaryYesMidBandMaxRaw.fromEnv,
      },
      binaryHardMaxSpreadBps: {
        fromEnv: binaryHardMaxSpreadBpsRaw.fromEnv,
      },
      entryCooldownMs: { fromEnv: entryCooldownMs.fromEnv },
      priceBufferSize: { fromEnv: priceBufferSizeRaw.fromEnv },
      probabilityWindowSize: { fromEnv: probabilityWindowSizeRaw.fromEnv },
      probabilityTimeHorizonMs: {
        fromEnv: probabilityTimeHorizonMsRaw.fromEnv,
      },
      probabilitySigmoidK: { fromEnv: probabilitySigmoidKRaw.fromEnv },
      minEdgeThreshold: { fromEnv: minEdgeThresholdRaw.fromEnv },
      maxTradeSize: { fromEnv: maxTradeSizeRaw.fromEnv },
      minTradeSize: { fromEnv: minTradeSizeRaw.fromEnv },
      allowWeakQualityEntries: { fromEnv: allowWeakQualityEntries.fromEnv },
      allowWeakQualityOnlyForStrongSpikes: {
        fromEnv: allowWeakQualityOnlyForStrongSpikes.fromEnv,
      },
      allowAcceptableQualityStrongSpikes: {
        fromEnv: allowAcceptableQualityStrongSpikes.fromEnv,
      },
      weakQualitySizeMultiplier: { fromEnv: weakQualitySizeMultiplier.fromEnv },
      strongQualitySizeMultiplier: {
        fromEnv: strongQualitySizeMultiplier.fromEnv,
      },
      exceptionalQualitySizeMultiplier: {
        fromEnv: exceptionalQualitySizeMultiplier.fromEnv,
      },
      unstableContextMode: { fromEnv: unstableContextMode.fromEnv },
      testMode: { fromEnv: testModeParsed.fromEnv },
      feedStaleMaxAgeMs: { fromEnv: feedStaleMaxAgeMs.fromEnv },
      blockEntriesOnStaleFeed: {
        fromEnv: blockEntriesOnStaleFeed.fromEnv,
      },
      binaryDisableImmediateStrongSpike: {
        fromEnv: binaryDisableImmediateStrongSpike.fromEnv,
      },
      paperPositionMtmDebug: { fromEnv: paperPositionMtmDebug.fromEnv },
      marketMode: {
        fromEnv: marketMode.fromEnv,
        ...(marketMode.envSourceKey !== undefined
          ? { envSourceKey: marketMode.envSourceKey }
          : {}),
      },
      binarySignalSource: {
        fromEnv: binarySignalSource.fromEnv,
        ...(binarySignalSource.envSourceKey !== undefined
          ? { envSourceKey: binarySignalSource.envSourceKey }
          : {}),
        ...(binarySignalSource.resolvedFrom !== undefined
          ? { resolvedFrom: binarySignalSource.resolvedFrom }
          : {}),
      },
      binarySignalSymbol: {
        fromEnv: binarySignalSymbol.fromEnv,
        ...(binarySignalSymbol.envSourceKey !== undefined
          ? { envSourceKey: binarySignalSymbol.envSourceKey }
          : {}),
        ...(binarySignalSymbol.resolvedFrom !== undefined
          ? { resolvedFrom: binarySignalSymbol.resolvedFrom }
          : {}),
      },
  };

  warnCrossModeEnvAmbiguities(config, _meta);

  return { config, _meta };
}

const loaded = loadConfig();
export const config: AppConfig = loaded.config;
/** Per-key env vs default provenance for the loaded config (startup / session JSON). */
export const configMeta: ConfigSourceMeta = loaded._meta;

/** Canonical env variable name for `key` (documentation / normalized summaries). */
export function canonicalEnvKeyFor(key: keyof AppConfig): string {
  return ENV_KEYS[key];
}

/**
 * When truthy (`1`, `true`, `yes`), the live monitor prints verbose diagnostics
 * only via `logMonitorDebug` (`src/monitor/monitorDebugLog.ts`): Polymarket
 * quote / freshness, spike tracker lines, rolling-range diagnostics, full
 * strategy decision text, quality-gate / lifecycle messages, borderline
 * blocks, opportunity ASCII blocks, spike JSON trace, and the large paper-trade
 * box on close. The compact Italian tick line and trade one-liner still print
 * every tick / close; this flag only adds technical detail.
 * Controlled by the `DEBUG_MONITOR` environment variable.
 */
export const debugMonitor: boolean = (() => {
  const raw = process.env.DEBUG_MONITOR?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
})();

function formatConfigValue(
  v: number | boolean | "hard" | "soft" | MarketMode | BinarySignalSource | string
): string {
  if (v === "hard" || v === "soft") return v;
  if (v === "spot" || v === "binary") return v;
  if (typeof v === "boolean") return String(v);
  if (typeof v === "string") return v;
  const n = v;
  if (!Number.isFinite(n)) return String(n);
  if (Number.isInteger(n)) return String(n);
  const s = n.toString();
  return s.length > 12 ? n.toPrecision(6) : s;
}

/** One-line summary for monitor session JSON and shutdown banners. */
export function describeActiveConfigGroups(mode: MarketMode): string {
  if (mode === "binary") {
    return "runtime: shared + binary-only | spot-only keys not applied (see config print)";
  }
  return "runtime: shared + spot-only | binary-only keys not applied (see config print)";
}

function formatConfigProvenance(
  key: keyof AppConfig,
  m: ConfigSourceMeta[keyof AppConfig]
): string {
  const canon = ENV_KEYS[key];
  if (m.fromEnv) {
    const src = m.envSourceKey ?? canon;
    if (src === canon) {
      return `canonical=${canon} · from=${src}`;
    }
    return `canonical=${canon} · from=${src} (alias — prefer ${canon})`;
  }
  if (m.resolvedFrom !== undefined) {
    return `canonical=${canon} · ${m.resolvedFrom}`;
  }
  return `canonical=${canon} · default`;
}

function formatConfigRow(
  key: keyof AppConfig,
  cfg: AppConfig,
  meta: ConfigSourceMeta,
  labelW: number
): string {
  const name = String(key).padEnd(labelW);
  const val = formatConfigValue(cfg[key]);
  const m = meta[key];
  return `  ${name}  ${val.padStart(12)}  ${formatConfigProvenance(key, m)}`;
}

/**
 * Grouped configuration lines for startup logging and tests.
 * Order: shared → mode-active section → mode-ignored section (with ignored subtitle).
 */
export function formatGroupedConfigLines(
  cfg: AppConfig,
  meta: ConfigSourceMeta
): string[] {
  const mode = cfg.marketMode;
  const keys = Object.keys(configDefaults) as (keyof AppConfig)[];
  const labelW = Math.max(...keys.map((k) => String(k).length));

  const lines: string[] = [
    "────────── Configuration ──────────",
    `  (runtime)  ${describeActiveConfigGroups(mode)}`,
  ];

  const sharedKeys = keys.filter((k) => CONFIG_KEY_GROUP[k] === "shared");
  const sharedSorted = [...sharedKeys].sort((a, b) => {
    if (a === "marketMode") return -1;
    if (b === "marketMode") return 1;
    return String(a).localeCompare(String(b));
  });

  lines.push("");
  lines.push("Shared (strategy, sizing, paper commons — all modes)");
  for (const k of sharedSorted) {
    lines.push(formatConfigRow(k, cfg, meta, labelW));
  }

  if (mode === "binary") {
    lines.push("");
    lines.push("Binary-only (MARKET_MODE=binary — venue paper, YES/NO exits, signal routing)");
    for (const k of keys) {
      if (CONFIG_KEY_GROUP[k] === "binary") {
        lines.push(formatConfigRow(k, cfg, meta, labelW));
      }
    }
    lines.push("");
    lines.push(
      "Legacy spot execution — not used when MARKET_MODE=binary (reference only; exits use BINARY_* price Δ)"
    );
    for (const k of keys) {
      if (CONFIG_KEY_GROUP[k] === "spot") {
        lines.push(formatConfigRow(k, cfg, meta, labelW));
      }
    }
  } else {
    lines.push("");
    lines.push(
      "Legacy spot execution (MARKET_MODE=spot — Binance book paper, bps exits)"
    );
    for (const k of keys) {
      if (CONFIG_KEY_GROUP[k] === "spot") {
        lines.push(formatConfigRow(k, cfg, meta, labelW));
      }
    }
    lines.push("");
    lines.push(
      "Binary-only — not used when MARKET_MODE=spot (reference only; Polymarket / BINARY_* ignored at runtime)"
    );
    for (const k of keys) {
      if (CONFIG_KEY_GROUP[k] === "binary") {
        lines.push(formatConfigRow(k, cfg, meta, labelW));
      }
    }
  }

  lines.push("");
  lines.push("───────────────────────────────────");
  return lines;
}

/** Pretty-print current config (call once at startup). */
export function logConfig(): void {
  if (config.testMode) {
    console.log(
      "!!!!!!!!!! TEST MODE ACTIVE — DIAGNOSTIC RUN — NOT PRODUCTION BASELINE !!!!!!!!!!"
    );
  }
  console.log(formatGroupedConfigLines(config, configMeta).join("\n"));
  if (config.marketMode === "binary") {
    const srcMeta = configMeta.binarySignalSource.fromEnv
      ? `from ${configMeta.binarySignalSource.envSourceKey ?? ENV_KEYS.binarySignalSource}${
          configMeta.binarySignalSource.resolvedFrom ? ` — ${configMeta.binarySignalSource.resolvedFrom}` : ""
        }`
      : "default";
    const symMeta = configMeta.binarySignalSymbol.fromEnv
      ? `from ${configMeta.binarySignalSymbol.envSourceKey ?? ENV_KEYS.binarySignalSymbol}`
      : configMeta.binarySignalSymbol.resolvedFrom !== undefined
        ? configMeta.binarySignalSymbol.resolvedFrom
        : "default";
    console.log(
      `  (binary) underlying signal: ${config.binarySignalSource} / ${config.binarySignalSymbol}  (${srcMeta} · ${symMeta})`
    );
    const venue = resolveBinaryMarketSelectorFromEnv();
    console.log(
      `  (binary) execution venue: ${formatBinaryExecutionVenueBannerLine(venue)}`
    );
    if (venue.sourceEnvKey.startsWith("POLYMARKET_")) {
      console.warn(
        `[config] Gamma selector is read from ${venue.sourceEnvKey} (legacy env name). Prefer BINARY_MARKET_ID, BINARY_MARKET_SLUG, or BINARY_CONDITION_ID.`
      );
    }
  }
}
