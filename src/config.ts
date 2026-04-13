import dotenv from "dotenv";

dotenv.config();

/** Built-in defaults when an env var is missing or invalid. */
export const configDefaults = {
  /** Minimum relative 1-tick move (fraction) to count as a spike. */
  spikeThreshold: 0.005,
  /** Max prior-window chop (excl. latest tick) for a “stable” regime. */
  rangeThreshold: 0.0012,
  /** Spike move must be ≥ this × prior-window relative range (filters weak spikes). */
  spikeMinRangeMultiple: 2.2,
  entryPrice: 0.22,
  exitPrice: 0.52,
  /** Exit long if mark at or below this (tighter = less $ at risk per contract). */
  stopLoss: 0.085,
  /** Starting paper equity (same units as contract P/L). */
  initialCapital: 10_000,
  /** Max fraction of **current** equity at planned stop per trade (1 = 1%). */
  riskPercentPerTrade: 1,
  /** Max hold time for a position before time-exit (ms). */
  exitTimeoutMs: 90_000,
  /** Min ms after a simulated exit before another entry (reduces churn). */
  entryCooldownMs: 120_000,
  /** Max number of recent prices to retain in the rolling buffer. */
  priceBufferSize: 20,
} as const;

export type AppConfig = {
  [K in keyof typeof configDefaults]: number;
};

const ENV_KEYS: { [K in keyof AppConfig]: string } = {
  spikeThreshold: "SPIKE_THRESHOLD",
  rangeThreshold: "RANGE_THRESHOLD",
  spikeMinRangeMultiple: "SPIKE_MIN_RANGE_MULT",
  entryPrice: "ENTRY_PRICE",
  exitPrice: "EXIT_PRICE",
  stopLoss: "STOP_LOSS",
  initialCapital: "INITIAL_CAPITAL",
  riskPercentPerTrade: "RISK_PERCENT_PER_TRADE",
  exitTimeoutMs: "EXIT_TIMEOUT_MS",
  entryCooldownMs: "ENTRY_COOLDOWN_MS",
  priceBufferSize: "PRICE_BUFFER_SIZE",
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

function loadConfig(): {
  config: AppConfig;
  _meta: { [K in keyof AppConfig]: { fromEnv: boolean } };
} {
  const spikeThreshold = parseEnvNumber(
    "SPIKE_THRESHOLD",
    configDefaults.spikeThreshold
  );
  const rangeThreshold = parseEnvNumber(
    "RANGE_THRESHOLD",
    configDefaults.rangeThreshold
  );
  const spikeMinRangeMultiple = parseEnvNumber(
    "SPIKE_MIN_RANGE_MULT",
    configDefaults.spikeMinRangeMultiple
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

  return {
    config: {
      spikeThreshold: spikeThreshold.value,
      rangeThreshold: rangeThreshold.value,
      spikeMinRangeMultiple: Math.max(0, spikeMinRangeMultiple.value),
      entryPrice: entryPrice.value,
      exitPrice: exitPrice.value,
      stopLoss: stopLoss.value,
      initialCapital: Math.max(1, initialCapital.value),
      riskPercentPerTrade: Math.min(100, Math.max(0, riskPercentPerTrade.value)),
      exitTimeoutMs: Math.max(0, exitTimeoutMs.value),
      entryCooldownMs: Math.max(0, entryCooldownMs.value),
      priceBufferSize,
    },
    _meta: {
      spikeThreshold: { fromEnv: spikeThreshold.fromEnv },
      rangeThreshold: { fromEnv: rangeThreshold.fromEnv },
      spikeMinRangeMultiple: { fromEnv: spikeMinRangeMultiple.fromEnv },
      entryPrice: { fromEnv: entryPrice.fromEnv },
      exitPrice: { fromEnv: exitPrice.fromEnv },
      stopLoss: { fromEnv: stopLoss.fromEnv },
      initialCapital: { fromEnv: initialCapital.fromEnv },
      riskPercentPerTrade: { fromEnv: riskPercentPerTrade.fromEnv },
      exitTimeoutMs: { fromEnv: exitTimeoutMs.fromEnv },
      entryCooldownMs: { fromEnv: entryCooldownMs.fromEnv },
      priceBufferSize: { fromEnv: priceBufferSizeRaw.fromEnv },
    },
  };
}

const loaded = loadConfig();
export const config: AppConfig = loaded.config;
const _meta = loaded._meta;

/** Pretty-print current config (call once at startup). */
export function logConfig(): void {
  const keys = Object.keys(configDefaults) as (keyof AppConfig)[];
  const labelW = Math.max(...keys.map((k) => k.length));

  const lines: string[] = [
    "────────── Configuration ──────────",
    ...keys.map((key) => {
      const name = String(key).padEnd(labelW);
      const val = formatConfigNumber(config[key]);
      const source = _meta[key].fromEnv
        ? `env ${ENV_KEYS[key]}`
        : "default";
      return `  ${name}  ${val.padStart(12)}  ${source}`;
    }),
    "───────────────────────────────────",
  ];
  console.log(lines.join("\n"));
}

function formatConfigNumber(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  if (Number.isInteger(n)) return String(n);
  const s = n.toString();
  return s.length > 12 ? n.toPrecision(6) : s;
}
