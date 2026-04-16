import dotenv from "dotenv";

dotenv.config();

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
  /** Max prior range for normal mean-reversion entries (0.0015 = 0.15%). */
  maxPriorRangeForNormalEntry: 0.0015,
  /**
   * Hard reject threshold for unstable pre-spike context:
   * if stableRangeDetected=false and priorRangePercent exceeds this value.
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
  /** Hard cap for opposite-side entry quote (independent from entryPrice). */
  maxOppositeSideEntryPrice: 0.35,
  /** Lower bound of neutral quote band where both sides are considered non-tradable. */
  neutralQuoteBandMin: 0.45,
  /** Upper bound of neutral quote band where both sides are considered non-tradable. */
  neutralQuoteBandMax: 0.55,
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
  entryPrice: 0.22,
  exitPrice: 0.52,
  /** Exit long if mark at or below this (tighter = less $ at risk per contract). */
  stopLoss: 0.085,
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
  maxOppositeSideEntryPrice: "MAX_OPPOSITE_SIDE_ENTRY_PRICE",
  neutralQuoteBandMin: "NEUTRAL_QUOTE_BAND_MIN",
  neutralQuoteBandMax: "NEUTRAL_QUOTE_BAND_MAX",
  spikeMinRangeMultiple: "SPIKE_MIN_RANGE_MULT",
  borderlineMinRatio: "BORDERLINE_MIN_RATIO",
  borderlineWatchTicks: "BORDERLINE_WATCH_TICKS",
  borderlineRequirePause: "BORDERLINE_REQUIRE_PAUSE",
  borderlineRequireNoContinuation: "BORDERLINE_REQUIRE_NO_CONTINUATION",
  borderlineContinuationThreshold: "BORDERLINE_CONTINUATION_THRESHOLD",
  borderlineReversionThreshold: "BORDERLINE_REVERSION_THRESHOLD",
  borderlinePauseBandPercent: "BORDERLINE_PAUSE_BAND_PERCENT",
  entryPrice: "ENTRY_PRICE",
  exitPrice: "EXIT_PRICE",
  stopLoss: "STOP_LOSS",
  initialCapital: "INITIAL_CAPITAL",
  riskPercentPerTrade: "RISK_PERCENT_PER_TRADE",
  stakePerTrade: "STAKE_PER_TRADE",
  exitTimeoutMs: "EXIT_TIMEOUT_MS",
  entryCooldownMs: "ENTRY_COOLDOWN_MS",
  priceBufferSize: "PRICE_BUFFER_SIZE",
  allowWeakQualityEntries: "ALLOW_WEAK_QUALITY_ENTRIES",
  allowWeakQualityOnlyForStrongSpikes:
    "ALLOW_WEAK_QUALITY_ONLY_FOR_STRONG_SPIKES",
  weakQualitySizeMultiplier: "WEAK_QUALITY_SIZE_MULTIPLIER",
  strongQualitySizeMultiplier: "STRONG_QUALITY_SIZE_MULTIPLIER",
  exceptionalQualitySizeMultiplier: "EXCEPTIONAL_QUALITY_SIZE_MULTIPLIER",
  unstableContextMode: "UNSTABLE_CONTEXT_MODE",
  testMode: "TEST_MODE",
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
  const maxOppositeSideEntryPrice = parseEnvNumber(
    "MAX_OPPOSITE_SIDE_ENTRY_PRICE",
    configDefaults.maxOppositeSideEntryPrice
  );
  const neutralQuoteBandMin = parseEnvNumber(
    "NEUTRAL_QUOTE_BAND_MIN",
    configDefaults.neutralQuoteBandMin
  );
  const neutralQuoteBandMax = parseEnvNumber(
    "NEUTRAL_QUOTE_BAND_MAX",
    configDefaults.neutralQuoteBandMax
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
  const entryPrice = parseEnvNumber("ENTRY_PRICE", configDefaults.entryPrice);
  const exitPrice = parseEnvNumber("EXIT_PRICE", configDefaults.exitPrice);
  const stopLoss = parseEnvNumber("STOP_LOSS", configDefaults.stopLoss);
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
      maxOppositeSideEntryPrice: Math.max(0, maxOppositeSideEntryPrice.value),
      neutralQuoteBandMin: Math.max(0, Math.min(1, neutralQuoteBandMin.value)),
      neutralQuoteBandMax: Math.max(0, Math.min(1, neutralQuoteBandMax.value)),
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
      entryPrice: entryPrice.value,
      exitPrice: exitPrice.value,
      stopLoss: stopLoss.value,
      initialCapital: Math.max(1, initialCapital.value),
      riskPercentPerTrade: Math.min(100, Math.max(0, riskPercentPerTrade.value)),
      stakePerTrade: Math.max(0, stakePerTrade.value),
      exitTimeoutMs: Math.max(0, exitTimeoutMs.value),
      entryCooldownMs: Math.max(0, entryCooldownMs.value),
      priceBufferSize,
      allowWeakQualityEntries: allowWeakQualityEntries.value,
      allowWeakQualityOnlyForStrongSpikes:
        allowWeakQualityOnlyForStrongSpikes.value,
      weakQualitySizeMultiplier: Math.max(0, weakQualitySizeMultiplier.value),
      strongQualitySizeMultiplier: Math.max(0, strongQualitySizeMultiplier.value),
      exceptionalQualitySizeMultiplier: Math.max(
        0,
        exceptionalQualitySizeMultiplier.value
      ),
      unstableContextMode: unstableContextMode.value,
      testMode: testModeParsed.value,
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
      maxOppositeSideEntryPrice: { fromEnv: maxOppositeSideEntryPrice.fromEnv },
      neutralQuoteBandMin: { fromEnv: neutralQuoteBandMin.fromEnv },
      neutralQuoteBandMax: { fromEnv: neutralQuoteBandMax.fromEnv },
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
      entryPrice: { fromEnv: entryPrice.fromEnv },
      exitPrice: { fromEnv: exitPrice.fromEnv },
      stopLoss: { fromEnv: stopLoss.fromEnv },
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
      weakQualitySizeMultiplier: { fromEnv: weakQualitySizeMultiplier.fromEnv },
      strongQualitySizeMultiplier: {
        fromEnv: strongQualitySizeMultiplier.fromEnv,
      },
      exceptionalQualitySizeMultiplier: {
        fromEnv: exceptionalQualitySizeMultiplier.fromEnv,
      },
      unstableContextMode: { fromEnv: unstableContextMode.fromEnv },
      testMode: { fromEnv: testModeParsed.fromEnv },
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
