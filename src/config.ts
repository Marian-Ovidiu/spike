import dotenv from "dotenv";

dotenv.config();

const DEPRECATED_POLYMARKET_ENV_KEYS = [
  "POLYMARKET_MARKET_SLUG",
  "POLYMARKET_MARKET_ID",
  "POLYMARKET_DISCOVERY_QUERY",
  "POLYMARKET_DISCOVERY_MIN_CONFIDENCE",
  "BINARY_MARKET_SOURCE",
  "UP_SIDE_PRICE",
  "DOWN_SIDE_PRICE",
] as const;

function warnDeprecatedPolymarketEnv(): void {
  for (const k of DEPRECATED_POLYMARKET_ENV_KEYS) {
    const v = process.env[k]?.trim();
    if (v) {
      console.warn(
        `[config] ${k} is deprecated (Polymarket removed). Value ignored — use Binance spot settings; see .env.example.`
      );
    }
  }
}

/** Built-in defaults when an env var is missing or invalid. */
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
  /** Take profit vs entry fill, in basis points (spot). */
  takeProfitBps: 35,
  /** Stop loss vs entry fill, in basis points (spot). */
  stopLossBps: 25,
  /** Extra slippage applied to entry fill (bps) for paper realism. */
  paperSlippageBps: 3,
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
  /** Min ms after a simulated exit before another entry (reduces churn). */
  entryCooldownMs: 120_000,
  /** Max number of recent prices to retain in the rolling buffer. */
  priceBufferSize: 20,
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
} as const;

type ConfigKey = keyof typeof configDefaults;
type NumericOrBoolConfigKey = Exclude<ConfigKey, "unstableContextMode">;

export type AppConfig = {
  [K in NumericOrBoolConfigKey]: (typeof configDefaults)[K] extends boolean
    ? boolean
    : number;
} & {
  unstableContextMode: "hard" | "soft";
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
  takeProfitBps: "TAKE_PROFIT_BPS",
  stopLossBps: "STOP_LOSS_BPS",
  paperSlippageBps: "PAPER_SLIPPAGE_BPS",
  paperFeeRoundTripBps: "PAPER_FEE_ROUND_TRIP_BPS",
  initialCapital: "INITIAL_CAPITAL",
  riskPercentPerTrade: "RISK_PERCENT_PER_TRADE",
  stakePerTrade: "STAKE_PER_TRADE",
  exitTimeoutMs: "EXIT_TIMEOUT_MS",
  entryCooldownMs: "ENTRY_COOLDOWN_MS",
  priceBufferSize: "PRICE_BUFFER_SIZE",
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
  _meta: { [K in keyof AppConfig]: { fromEnv: boolean } };
} {
  warnDeprecatedPolymarketEnv();
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
  const takeProfitBps = parseEnvNumber(
    "TAKE_PROFIT_BPS",
    configDefaults.takeProfitBps
  );
  const stopLossBps = parseEnvNumber(
    "STOP_LOSS_BPS",
    configDefaults.stopLossBps
  );
  const paperSlippageBps = parseEnvNumber(
    "PAPER_SLIPPAGE_BPS",
    configDefaults.paperSlippageBps
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
  const entryCooldownMs = parseEnvNumber(
    "ENTRY_COOLDOWN_MS",
    configDefaults.entryCooldownMs
  );
  const priceBufferSizeRaw = parseEnvNumber(
    "PRICE_BUFFER_SIZE",
    configDefaults.priceBufferSize
  );
  const priceBufferSize = Math.max(1, Math.trunc(priceBufferSizeRaw.value));
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
  const paperPositionMtmDebug = parseEnvBoolean(
    "PAPER_POSITION_MTM_DEBUG",
    configDefaults.paperPositionMtmDebug
  );
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
      takeProfitBps: Math.max(0, takeProfitBps.value),
      stopLossBps: Math.max(0, stopLossBps.value),
      paperSlippageBps: Math.max(0, paperSlippageBps.value),
      paperFeeRoundTripBps: Math.max(0, paperFeeRoundTripBps.value),
      initialCapital: Math.max(1, initialCapital.value),
      riskPercentPerTrade: Math.min(100, Math.max(0, riskPercentPerTrade.value)),
      stakePerTrade: Math.max(0, stakePerTrade.value),
      exitTimeoutMs: Math.max(0, exitTimeoutMs.value),
      entryCooldownMs: Math.max(0, entryCooldownMs.value),
      priceBufferSize,
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
      paperPositionMtmDebug: paperPositionMtmDebug.value,
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

  return {
    config,
    _meta: {
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
      takeProfitBps: { fromEnv: takeProfitBps.fromEnv },
      stopLossBps: { fromEnv: stopLossBps.fromEnv },
      paperSlippageBps: { fromEnv: paperSlippageBps.fromEnv },
      paperFeeRoundTripBps: { fromEnv: paperFeeRoundTripBps.fromEnv },
      initialCapital: { fromEnv: initialCapital.fromEnv },
      riskPercentPerTrade: { fromEnv: riskPercentPerTrade.fromEnv },
      stakePerTrade: { fromEnv: stakePerTrade.fromEnv },
      exitTimeoutMs: { fromEnv: exitTimeoutMs.fromEnv },
      entryCooldownMs: { fromEnv: entryCooldownMs.fromEnv },
      priceBufferSize: { fromEnv: priceBufferSizeRaw.fromEnv },
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
      paperPositionMtmDebug: { fromEnv: paperPositionMtmDebug.fromEnv },
    },
  };
}

const loaded = loadConfig();
export const config: AppConfig = loaded.config;
const _meta = loaded._meta;

/**
 * When truthy (`1`, `true`, `yes`), the live monitor prints extra
 * per-tick strategy diagnostics: spike debug lines, rolling range %,
 * strongest recent move, expanded blocks for rejected candidates, and
 * when `entry.spikeDetected`, a JSON **spike decision trace** (spike %,
 * prior range, stable range, classification, entryAllowed, rejectionReasons).
 * Controlled by the `DEBUG_MONITOR` environment variable.
 */
export const debugMonitor: boolean = (() => {
  const raw = process.env.DEBUG_MONITOR?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
})();

/** Pretty-print current config (call once at startup). */
export function logConfig(): void {
  if (config.testMode) {
    console.log(
      "!!!!!!!!!! TEST MODE ACTIVE — DIAGNOSTIC RUN — NOT PRODUCTION BASELINE !!!!!!!!!!"
    );
  }
  const keys = Object.keys(configDefaults) as (keyof AppConfig)[];
  const labelW = Math.max(...keys.map((k) => k.length));

  const lines: string[] = [
    "────────── Configuration ──────────",
    ...keys.map((key) => {
      const name = String(key).padEnd(labelW);
      const val = formatConfigValue(config[key]);
      const source = _meta[key].fromEnv
        ? `env ${ENV_KEYS[key]}`
        : "default";
      return `  ${name}  ${val.padStart(12)}  ${source}`;
    }),
    "───────────────────────────────────",
  ];
  console.log(lines.join("\n"));
}

function formatConfigValue(v: number | boolean | "hard" | "soft"): string {
  if (v === "hard" || v === "soft") return v;
  if (typeof v === "boolean") return String(v);
  const n = v;
  if (!Number.isFinite(n)) return String(n);
  if (Number.isInteger(n)) return String(n);
  const s = n.toString();
  return s.length > 12 ? n.toPrecision(6) : s;
}
