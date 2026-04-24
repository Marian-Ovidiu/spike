import { z } from "zod";

export type FuturesExchangeKind = "binance" | "bybit" | "coinbase";
export type TradingModeKind = "public_paper" | "authenticated_paper" | "live";
export type MarketModeKind = "spot" | "binary";

export type RuntimeConfig = {
  futuresExchange: FuturesExchangeKind;
  tradingMode: TradingModeKind;
  futuresContractSymbol: string;
  bybitCategory: "linear" | "inverse";
  bybitWsPublicUrl: string;
  testMode: boolean;
  marketMode: MarketModeKind;
};

export type BinanceExchangeDefaults = {
  apiKey: string;
  apiSecret: string;
  useTestnet: boolean;
  baseUrl: string;
};

export type BybitExchangeDefaults = {
  enabled: boolean;
  testnet: boolean;
  baseUrl: string;
  wsPublicUrl: string;
  apiKey: string;
  apiSecret: string;
  category: "linear" | "inverse";
  symbol: string;
  recvWindow: number;
  authDebug: boolean;
};

export type CoinbaseExchangeDefaults = {
  apiKeyName: string;
  apiPrivateKey: string;
  baseUrl: string;
  productId: string;
  derivativesEnabled: boolean;
  authDebug: boolean;
  publicTickSize: number;
  publicLotSize: number;
  publicMinQuantity: number;
  publicMinNotional: number;
  feeMakerBps?: number | undefined;
  feeTakerBps?: number | undefined;
};

export type ExchangeConfig = {
  selectedExchange: FuturesExchangeKind;
  binance: BinanceExchangeDefaults;
  bybit: BybitExchangeDefaults;
  coinbase: CoinbaseExchangeDefaults;
};

export type StrategyConfig = {
  testMode: boolean;
  marketMode: MarketModeKind;
};

export type PaperSimulationConfig = {
  takeProfitBps: number;
  stopLossBps: number;
  exitTimeoutMs: number;
  feeRoundTripBps: number;
  slippageBps: number;
  exitGracePeriodMs: number;
  forcedExitPenaltyBps: number;
  initialMarginRate: number;
  maintenanceMarginRate: number;
  marginWarningRatio: number;
  liquidationRiskRatio: number;
  liquidationPenaltyBps: number;
  profitLockEnabled: boolean;
  profitLockThresholdQuote: number;
  trailingProfitEnabled: boolean;
  trailingProfitDropQuote: number;
  realisticMode: boolean;
  makerFeeBps: number;
  takerFeeBps: number;
  realisticSlippageBps: number;
  realisticLatencyMs: number;
  realisticSpreadBps: number;
  partialFillEnabled: boolean;
  partialFillRatio: number;
  fundingBpsPerHour: number;
  minNotionalQuote: number;
  feedStaleMaxAgeMs: number;
  tickIntervalMs: number;
  entryConfirmationTicks: number;
  entryRequireReversal: boolean;
  balanceTrackingEnabled: boolean;
  balanceStartingBalance: number;
  balanceReserveBalance: number;
  balanceFixedStakeUntilBalance: number;
  balanceMinBalanceToContinue: number;
  useSpotProxyFallback: boolean;
  initialSignalMid: number;
  initialSpreadBps: number;
  syntheticUpdateMs: number;
  oscillationBps: number;
  markBasisBps: number;
  indexBasisBps: number;
  fundingBiasBps: number;
};

export type LiveSafetyConfig = {
  liveTradingEnabled: boolean;
  liveExchangeAck: boolean;
  maxNotionalPerTrade: number;
  dailyMaxLossQuote: number;
  maxOpenPositions: number;
  allowedSymbols: string[];
};

export type EnvConfig = {
  runtime: RuntimeConfig;
  exchange: ExchangeConfig;
  strategy: StrategyConfig;
  paperSimulation: PaperSimulationConfig;
  liveSafety: LiveSafetyConfig;
};

export class EnvConfigError extends Error {
  readonly issues: string[];

  constructor(message: string, issues: string[] = []) {
    super(message);
    this.name = "EnvConfigError";
    this.issues = issues;
  }
}

const FuturesExchangeSchema = z.enum(["binance", "bybit", "coinbase"]);
const TradingModeSchema = z.enum(["public_paper", "authenticated_paper", "live"]);
const MarketModeSchema = z.enum(["spot", "binary"]);
const BybitCategorySchema = z.enum(["linear", "inverse"]);

export function readEnvString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function readEnvStringValue(
  raw: NodeJS.ProcessEnv,
  key: string,
  fallback: string
): string {
  return readEnvString(raw[key]) ?? fallback;
}

export function readEnvBool(
  raw: NodeJS.ProcessEnv,
  key: string,
  fallback: boolean
): boolean {
  const value = readEnvString(raw[key])?.toLowerCase();
  if (!value) return fallback;
  if (value === "1" || value === "true" || value === "yes") return true;
  if (value === "0" || value === "false" || value === "no") return false;
  return fallback;
}

export function readEnvNumber(
  raw: NodeJS.ProcessEnv,
  key: string,
  fallback: number
): number {
  const value = readEnvString(raw[key]);
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function readEnvOptionalNumber(
  raw: NodeJS.ProcessEnv,
  key: string
): number | undefined {
  const value = readEnvString(raw[key]);
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function readEnvNumberWithDeprecatedFallback(
  raw: NodeJS.ProcessEnv,
  preferredKey: string,
  deprecatedKey: string | undefined,
  fallback: number
): number {
  const preferred = readEnvString(raw[preferredKey]);
  if (preferred !== undefined) {
    return readEnvNumber(raw, preferredKey, fallback);
  }

  if (deprecatedKey) {
    const deprecated = readEnvString(raw[deprecatedKey]);
    if (deprecated !== undefined) {
      console.warn(
        `[config] ${deprecatedKey} is deprecated; use ${preferredKey} instead.`
      );
      return readEnvNumber(raw, deprecatedKey, fallback);
    }
  }

  return fallback;
}

export function readEnvCsv(
  raw: NodeJS.ProcessEnv,
  key: string,
  fallback: string[]
): string[] {
  const value = readEnvString(raw[key]);
  if (!value) return fallback;
  const items = value
    .split(",")
    .map((entry) => entry.trim().toUpperCase())
    .filter((entry) => entry.length > 0);
  return items.length > 0 ? items : fallback;
}

export function readCurrentEnvBool(key: string, fallback: boolean): boolean {
  return readEnvBool(process.env, key, fallback);
}

export function readCurrentEnvNumber(key: string, fallback: number): number {
  return readEnvNumber(process.env, key, fallback);
}

export function readCurrentEnvString(key: string, fallback: string): string {
  return readEnvStringValue(process.env, key, fallback);
}

function defaultBinanceBaseUrl(useTestnet: boolean): string {
  return useTestnet ? "https://testnet.binancefuture.com" : "https://fapi.binance.com";
}

function defaultBybitBaseUrl(testnet: boolean): string {
  return testnet ? "https://api-testnet.bybit.com" : "https://api.bybit.com";
}

function defaultBybitWsPublicUrl(testnet: boolean, category: "linear" | "inverse"): string {
  if (testnet) {
    return category === "inverse"
      ? "wss://stream-testnet.bybit.com/v5/public/inverse"
      : "wss://stream-testnet.bybit.com/v5/public/linear";
  }
  return category === "inverse"
    ? "wss://stream.bybit.com/v5/public/inverse"
    : "wss://stream.bybit.com/v5/public/linear";
}

function resolveSelectedExchange(raw: NodeJS.ProcessEnv): FuturesExchangeKind {
  const parsed = FuturesExchangeSchema.safeParse(readEnvStringValue(raw, "FUTURES_EXCHANGE", "binance"));
  return parsed.success ? parsed.data : "binance";
}

function resolveTradingMode(raw: NodeJS.ProcessEnv): TradingModeKind {
  const tradingMode = readEnvString(raw.TRADING_MODE);
  if (tradingMode) {
    const parsed = TradingModeSchema.safeParse(tradingMode);
    return parsed.success ? parsed.data : "public_paper";
  }

  const legacyTestMode = readEnvString(raw.TEST_MODE);
  if (legacyTestMode !== undefined) {
    console.warn(
      "[config] TEST_MODE is deprecated; use TRADING_MODE=public_paper|authenticated_paper|live instead."
    );
  }
  return "public_paper";
}

function resolveFuturesSymbol(raw: NodeJS.ProcessEnv, exchange: FuturesExchangeKind): string {
  if (exchange === "bybit") {
    return (
      readEnvString(raw.BYBIT_SYMBOL) ??
      readEnvString(raw.FUTURES_CONTRACT_SYMBOL) ??
      readEnvString(raw.FUTURES_DEFAULT_SYMBOL) ??
      "BTCUSDT"
    ).toUpperCase();
  }
  return (
    readEnvString(raw.FUTURES_CONTRACT_SYMBOL) ??
    readEnvString(raw.FUTURES_DEFAULT_SYMBOL) ??
    "BTCUSDT"
  ).toUpperCase();
}

function resolveBybitCategory(raw: NodeJS.ProcessEnv): "linear" | "inverse" {
  const parsed = BybitCategorySchema.safeParse(readEnvStringValue(raw, "BYBIT_CATEGORY", "linear"));
  return parsed.success ? parsed.data : "linear";
}

function buildRuntimeConfig(raw: NodeJS.ProcessEnv): RuntimeConfig {
  const futuresExchange = resolveSelectedExchange(raw);
  const tradingMode = resolveTradingMode(raw);
  const bybitCategory = resolveBybitCategory(raw);
  const bybitTestnet = readEnvBool(raw, "BYBIT_TESTNET", true);
  const bybitWsPublicUrl =
    readEnvString(raw.BYBIT_WS_PUBLIC_URL) ??
    defaultBybitWsPublicUrl(bybitTestnet, bybitCategory);
  const runtime = {
    futuresExchange,
    tradingMode,
    futuresContractSymbol: resolveFuturesSymbol(raw, futuresExchange),
    bybitCategory,
    bybitWsPublicUrl,
    testMode: readEnvBool(raw, "TEST_MODE", false),
    marketMode: MarketModeSchema.safeParse(readEnvStringValue(raw, "MARKET_MODE", "spot")).success
      ? (readEnvStringValue(raw, "MARKET_MODE", "spot") as MarketModeKind)
      : "spot",
  };
  return RuntimeConfigSchema.parse(runtime);
}

function buildExchangeDefaults(raw: NodeJS.ProcessEnv): ExchangeConfig {
  const selectedExchange = resolveSelectedExchange(raw);
  const bybitTestnet = readEnvBool(raw, "BYBIT_TESTNET", true);
  const bybitCategory = resolveBybitCategory(raw);
  const bybit = {
    enabled: readEnvBool(raw, "BYBIT_ENABLED", true),
    testnet: bybitTestnet,
    baseUrl: readEnvString(raw.BYBIT_BASE_URL) ?? defaultBybitBaseUrl(bybitTestnet),
    wsPublicUrl:
      readEnvString(raw.BYBIT_WS_PUBLIC_URL) ??
      defaultBybitWsPublicUrl(bybitTestnet, bybitCategory),
    apiKey: readEnvString(raw.BYBIT_API_KEY) ?? "",
    apiSecret: readEnvString(raw.BYBIT_API_SECRET) ?? "",
    category: bybitCategory,
    symbol: resolveFuturesSymbol(raw, "bybit"),
    recvWindow: readEnvNumber(raw, "BYBIT_RECV_WINDOW", 5000),
    authDebug: readEnvBool(raw, "BYBIT_AUTH_DEBUG", false),
  };
  const binanceUseTestnet = readEnvBool(raw, "BINANCE_FUTURES_USE_TESTNET", true);
  const exchange = {
    selectedExchange,
    binance: {
      apiKey: readEnvString(raw.BINANCE_FUTURES_API_KEY) ?? "",
      apiSecret: readEnvString(raw.BINANCE_FUTURES_API_SECRET) ?? "",
      useTestnet: binanceUseTestnet,
      baseUrl:
        readEnvString(raw.BINANCE_FUTURES_BASE_URL) ??
        defaultBinanceBaseUrl(binanceUseTestnet),
    },
    bybit,
    coinbase: {
      apiKeyName: readEnvString(raw.COINBASE_API_KEY_NAME) ?? "",
      apiPrivateKey: readEnvString(raw.COINBASE_API_PRIVATE_KEY) ?? "",
      baseUrl: readEnvString(raw.COINBASE_BASE_URL) ?? "https://api.coinbase.com",
      productId: readEnvString(raw.COINBASE_PRODUCT_ID) ?? "",
      derivativesEnabled: readEnvBool(raw, "COINBASE_DERIVATIVES_ENABLED", true),
      authDebug: readEnvBool(raw, "COINBASE_AUTH_DEBUG", false),
      publicTickSize: readEnvNumber(raw, "COINBASE_PUBLIC_TICK_SIZE", 0.01),
      publicLotSize: readEnvNumber(raw, "COINBASE_PUBLIC_LOT_SIZE", 0.0001),
      publicMinQuantity: readEnvNumber(raw, "COINBASE_PUBLIC_MIN_QUANTITY", 0.0001),
      publicMinNotional: readEnvNumber(raw, "COINBASE_PUBLIC_MIN_NOTIONAL", 5),
      feeMakerBps: readEnvOptionalNumber(raw, "COINBASE_FEE_MAKER_BPS"),
      feeTakerBps: readEnvOptionalNumber(raw, "COINBASE_FEE_TAKER_BPS"),
    },
  };
  return ExchangeConfigSchema.parse(exchange);
}

export function readCoinbasePublicConfig(
  rawEnv: NodeJS.ProcessEnv = process.env
): CoinbaseExchangeDefaults {
  return buildExchangeDefaults(rawEnv).coinbase;
}

function validateSelectedExchangeAuth(exchange: ExchangeConfig): void {
  const missing: string[] = [];
  if (exchange.selectedExchange === "binance") {
    if (!exchange.binance.apiKey) missing.push("BINANCE_FUTURES_API_KEY");
    if (!exchange.binance.apiSecret) missing.push("BINANCE_FUTURES_API_SECRET");
    if (missing.length > 0) {
      throw new EnvConfigError(
        `Missing Binance Futures env: ${missing.join(", ")}.`,
        missing
      );
    }
    return;
  }
  if (exchange.selectedExchange === "bybit") {
    if (!exchange.bybit.apiKey) missing.push("BYBIT_API_KEY");
    if (!exchange.bybit.apiSecret) missing.push("BYBIT_API_SECRET");
    if (missing.length > 0) {
      throw new EnvConfigError(
        `Missing Bybit env: ${missing.join(", ")}.`,
        missing
      );
    }
    return;
  }
  if (!exchange.coinbase.apiKeyName) missing.push("COINBASE_API_KEY_NAME");
  if (!exchange.coinbase.apiPrivateKey) missing.push("COINBASE_API_PRIVATE_KEY");
  if (missing.length > 0) {
    throw new EnvConfigError(`Missing Coinbase env: ${missing.join(", ")}.`, missing);
  }
}

export function readCoinbaseExchangeConfig(
  rawEnv: NodeJS.ProcessEnv = process.env
): CoinbaseExchangeDefaults {
  const coinbase = buildExchangeDefaults(rawEnv).coinbase;
  const missing: string[] = [];
  if (!coinbase.apiKeyName) missing.push("COINBASE_API_KEY_NAME");
  if (!coinbase.apiPrivateKey) missing.push("COINBASE_API_PRIVATE_KEY");
  if (missing.length > 0) {
    throw new EnvConfigError(`Missing Coinbase env: ${missing.join(", ")}.`, missing);
  }
  return coinbase;
}

function buildStrategyConfig(raw: NodeJS.ProcessEnv): StrategyConfig {
  return StrategyConfigSchema.parse({
    testMode: readEnvBool(raw, "TEST_MODE", false),
    marketMode: MarketModeSchema.safeParse(readEnvStringValue(raw, "MARKET_MODE", "spot")).success
      ? (readEnvStringValue(raw, "MARKET_MODE", "spot") as MarketModeKind)
      : "spot",
  });
}

function buildPaperSimulationConfig(raw: NodeJS.ProcessEnv): PaperSimulationConfig {
  return PaperSimulationConfigSchema.parse({
    takeProfitBps: readEnvNumber(raw, "FUTURES_TP_BPS", 12),
    stopLossBps: readEnvNumber(raw, "FUTURES_SL_BPS", 8),
    exitTimeoutMs: readEnvNumber(raw, "FUTURES_EXIT_TIMEOUT_MS", 30_000),
    feeRoundTripBps: readEnvNumber(raw, "FUTURES_FEE_ROUND_TRIP_BPS", 8),
    slippageBps: readEnvNumber(raw, "FUTURES_SLIPPAGE_BPS", 2),
    exitGracePeriodMs: readEnvNumber(raw, "FUTURES_EXIT_GRACE_MS", 5_000),
    forcedExitPenaltyBps: readEnvNumber(raw, "FUTURES_FORCED_EXIT_PENALTY_BPS", 25),
    initialMarginRate: readEnvNumber(raw, "FUTURES_INITIAL_MARGIN_RATE", 0.05),
    maintenanceMarginRate: readEnvNumber(raw, "FUTURES_MAINTENANCE_MARGIN_RATE", 0.0375),
    marginWarningRatio: readEnvNumber(raw, "FUTURES_MARGIN_WARNING_RATIO", 1.25),
    liquidationRiskRatio: readEnvNumber(raw, "FUTURES_LIQUIDATION_RISK_RATIO", 1.05),
    liquidationPenaltyBps: readEnvNumber(raw, "FUTURES_LIQUIDATION_PENALTY_BPS", 50),
    profitLockEnabled: readEnvBool(raw, "FUTURES_PROFIT_LOCK_ENABLED", false),
    profitLockThresholdQuote: readEnvNumber(raw, "FUTURES_PROFIT_LOCK_THRESHOLD_QUOTE", 1),
    trailingProfitEnabled: readEnvBool(raw, "FUTURES_TRAILING_PROFIT_ENABLED", false),
    trailingProfitDropQuote: readEnvNumber(raw, "FUTURES_TRAILING_PROFIT_DROP_QUOTE", 0),
    realisticMode: readEnvBool(raw, "PAPER_REALISTIC_MODE", false),
    makerFeeBps: readEnvNumberWithDeprecatedFallback(
      raw,
      "PAPER_REALISTIC_MAKER_FEE_BPS",
      "PAPER_MAKER_FEE_BPS",
      0
    ),
    takerFeeBps: readEnvNumberWithDeprecatedFallback(
      raw,
      "PAPER_REALISTIC_TAKER_FEE_BPS",
      "PAPER_TAKER_FEE_BPS",
      0
    ),
    realisticSlippageBps: readEnvNumberWithDeprecatedFallback(
      raw,
      "PAPER_REALISTIC_SLIPPAGE_BPS",
      "PAPER_SLIPPAGE_BPS",
      0
    ),
    realisticLatencyMs: readEnvNumberWithDeprecatedFallback(
      raw,
      "PAPER_REALISTIC_LATENCY_MS",
      "PAPER_LATENCY_MS",
      0
    ),
    realisticSpreadBps: readEnvNumberWithDeprecatedFallback(
      raw,
      "PAPER_REALISTIC_SPREAD_BPS",
      "PAPER_SPREAD_BPS",
      0
    ),
    partialFillEnabled: readEnvBool(raw, "PAPER_PARTIAL_FILL_ENABLED", false),
    partialFillRatio: readEnvNumber(raw, "PAPER_PARTIAL_FILL_RATIO", 1),
    fundingBpsPerHour: readEnvNumberWithDeprecatedFallback(
      raw,
      "PAPER_REALISTIC_FUNDING_BPS_PER_HOUR",
      "PAPER_FUNDING_BPS_PER_HOUR",
      0
    ),
    minNotionalQuote: readEnvNumberWithDeprecatedFallback(
      raw,
      "PAPER_REALISTIC_MIN_NOTIONAL",
      "PAPER_MIN_NOTIONAL",
      0
    ),
    feedStaleMaxAgeMs: readEnvNumber(raw, "FUTURES_FEED_STALE_MAX_MS", 15_000),
    tickIntervalMs: readEnvNumber(raw, "FUTURES_TICK_INTERVAL_MS", 5_000),
    entryConfirmationTicks: readEnvNumber(raw, "FUTURES_ENTRY_CONFIRMATION_TICKS", 2),
    entryRequireReversal: readEnvBool(raw, "FUTURES_ENTRY_REQUIRE_REVERSAL", false),
    balanceTrackingEnabled: readEnvBool(raw, "FUTURES_BALANCE_TRACKING_ENABLED", false),
    balanceStartingBalance: readEnvNumber(raw, "FUTURES_STARTING_BALANCE", 110),
    balanceReserveBalance: readEnvNumber(raw, "FUTURES_RESERVE_BALANCE", 10),
    balanceFixedStakeUntilBalance: readEnvNumber(raw, "FUTURES_FIXED_STAKE_UNTIL_BALANCE", 120),
    balanceMinBalanceToContinue: readEnvNumber(raw, "FUTURES_MIN_BALANCE_TO_CONTINUE", 100),
    useSpotProxyFallback: readEnvBool(raw, "FUTURES_USE_SPOT_PROXY_FALLBACK", false),
    initialSignalMid: readEnvNumber(raw, "FUTURES_PAPER_MID", 95_000),
    initialSpreadBps: readEnvNumber(raw, "FUTURES_PAPER_SPREAD_BPS", 2),
    syntheticUpdateMs: readEnvNumber(raw, "FUTURES_FEED_SYNTHETIC_UPDATE_MS", 2_000),
    oscillationBps: readEnvNumber(raw, "FUTURES_FEED_OSCILLATION_BPS", 18),
    markBasisBps: readEnvNumber(raw, "FUTURES_FEED_MARK_BASIS_BPS", 0.8),
    indexBasisBps: readEnvNumber(raw, "FUTURES_FEED_INDEX_BASIS_BPS", -0.2),
    fundingBiasBps: readEnvNumber(raw, "FUTURES_FEED_FUNDING_BIAS_BPS", 0.05),
  });
}

function buildLiveSafetyConfig(raw: NodeJS.ProcessEnv): LiveSafetyConfig {
  return LiveSafetyConfigSchema.parse({
    liveTradingEnabled: readEnvBool(raw, "LIVE_TRADING_ENABLED", false),
    liveExchangeAck: readEnvBool(raw, "LIVE_EXCHANGE_ACK", false),
    maxNotionalPerTrade: readEnvNumber(raw, "LIVE_MAX_NOTIONAL_PER_TRADE", 10),
    dailyMaxLossQuote: readEnvNumber(raw, "LIVE_DAILY_MAX_LOSS_QUOTE", 2),
    maxOpenPositions: readEnvNumber(raw, "LIVE_MAX_OPEN_POSITIONS", 1),
    allowedSymbols: readEnvCsv(raw, "LIVE_ALLOWED_SYMBOLS", ["BTCUSDT"]),
  });
}

const RuntimeConfigSchema = z.object({
  futuresExchange: FuturesExchangeSchema,
  tradingMode: TradingModeSchema,
  futuresContractSymbol: z.string().min(1),
  bybitCategory: BybitCategorySchema,
  bybitWsPublicUrl: z.string().min(1),
  testMode: z.boolean(),
  marketMode: MarketModeSchema,
});

const BinanceExchangeSchema = z.object({
  apiKey: z.string(),
  apiSecret: z.string(),
  useTestnet: z.boolean(),
  baseUrl: z.string().min(1),
});

const BybitExchangeSchema = z.object({
  enabled: z.boolean(),
  testnet: z.boolean(),
  baseUrl: z.string().min(1),
  wsPublicUrl: z.string().min(1),
  apiKey: z.string(),
  apiSecret: z.string(),
  category: BybitCategorySchema,
  symbol: z.string().min(1),
  recvWindow: z.number().finite(),
  authDebug: z.boolean(),
});

const CoinbaseExchangeSchema = z.object({
  apiKeyName: z.string(),
  apiPrivateKey: z.string(),
  baseUrl: z.string().min(1),
  productId: z.string(),
  derivativesEnabled: z.boolean(),
  authDebug: z.boolean(),
  publicTickSize: z.number().finite(),
  publicLotSize: z.number().finite(),
  publicMinQuantity: z.number().finite(),
  publicMinNotional: z.number().finite(),
  feeMakerBps: z.number().finite().optional(),
  feeTakerBps: z.number().finite().optional(),
});

const ExchangeConfigSchema = z.object({
  selectedExchange: FuturesExchangeSchema,
  binance: BinanceExchangeSchema,
  bybit: BybitExchangeSchema,
  coinbase: CoinbaseExchangeSchema,
});

const StrategyConfigSchema = z.object({
  testMode: z.boolean(),
  marketMode: MarketModeSchema,
});

const PaperSimulationConfigSchema = z.object({
  takeProfitBps: z.number().finite(),
  stopLossBps: z.number().finite(),
  exitTimeoutMs: z.number().finite(),
  feeRoundTripBps: z.number().finite(),
  slippageBps: z.number().finite(),
  exitGracePeriodMs: z.number().finite(),
  forcedExitPenaltyBps: z.number().finite(),
  initialMarginRate: z.number().finite(),
  maintenanceMarginRate: z.number().finite(),
  marginWarningRatio: z.number().finite(),
  liquidationRiskRatio: z.number().finite(),
  liquidationPenaltyBps: z.number().finite(),
  profitLockEnabled: z.boolean(),
  profitLockThresholdQuote: z.number().finite(),
  trailingProfitEnabled: z.boolean(),
  trailingProfitDropQuote: z.number().finite(),
  realisticMode: z.boolean(),
  makerFeeBps: z.number().finite(),
  takerFeeBps: z.number().finite(),
  realisticSlippageBps: z.number().finite(),
  realisticLatencyMs: z.number().finite(),
  realisticSpreadBps: z.number().finite(),
  partialFillEnabled: z.boolean(),
  partialFillRatio: z.number().finite(),
  fundingBpsPerHour: z.number().finite(),
  minNotionalQuote: z.number().finite(),
  feedStaleMaxAgeMs: z.number().finite(),
  tickIntervalMs: z.number().finite(),
  entryConfirmationTicks: z.number().finite(),
  entryRequireReversal: z.boolean(),
  balanceTrackingEnabled: z.boolean(),
  balanceStartingBalance: z.number().finite(),
  balanceReserveBalance: z.number().finite(),
  balanceFixedStakeUntilBalance: z.number().finite(),
  balanceMinBalanceToContinue: z.number().finite(),
  useSpotProxyFallback: z.boolean(),
  initialSignalMid: z.number().finite(),
  initialSpreadBps: z.number().finite(),
  syntheticUpdateMs: z.number().finite(),
  oscillationBps: z.number().finite(),
  markBasisBps: z.number().finite(),
  indexBasisBps: z.number().finite(),
  fundingBiasBps: z.number().finite(),
});

const LiveSafetyConfigSchema = z.object({
  liveTradingEnabled: z.boolean(),
  liveExchangeAck: z.boolean(),
  maxNotionalPerTrade: z.number().finite(),
  dailyMaxLossQuote: z.number().finite(),
  maxOpenPositions: z.number().finite(),
  allowedSymbols: z.array(z.string().min(1)),
});

export function readRuntimeConfig(rawEnv: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  return buildRuntimeConfig(rawEnv);
}

export function readExchangeDefaults(rawEnv: NodeJS.ProcessEnv = process.env): ExchangeConfig {
  return buildExchangeDefaults(rawEnv);
}

export function readExchangeConfig(rawEnv: NodeJS.ProcessEnv = process.env): ExchangeConfig {
  const exchange = buildExchangeDefaults(rawEnv);
  validateSelectedExchangeAuth(exchange);
  return exchange;
}

export function readBinanceExchangeConfig(
  rawEnv: NodeJS.ProcessEnv = process.env
): BinanceExchangeDefaults {
  const binance = buildExchangeDefaults(rawEnv).binance;
  if (!binance.apiKey || !binance.apiSecret) {
    const missing: string[] = [];
    if (!binance.apiKey) missing.push("BINANCE_FUTURES_API_KEY");
    if (!binance.apiSecret) missing.push("BINANCE_FUTURES_API_SECRET");
    throw new EnvConfigError(
      `Missing Binance Futures env: ${missing.join(", ")}.`,
      missing
    );
  }
  return binance;
}

export function readBybitExchangeConfig(
  rawEnv: NodeJS.ProcessEnv = process.env
): BybitExchangeDefaults {
  const bybit = buildExchangeDefaults(rawEnv).bybit;
  if (!bybit.apiKey || !bybit.apiSecret) {
    const missing: string[] = [];
    if (!bybit.apiKey) missing.push("BYBIT_API_KEY");
    if (!bybit.apiSecret) missing.push("BYBIT_API_SECRET");
    throw new EnvConfigError(`Missing Bybit env: ${missing.join(", ")}.`, missing);
  }
  return bybit;
}

export function readStrategyConfig(rawEnv: NodeJS.ProcessEnv = process.env): StrategyConfig {
  return buildStrategyConfig(rawEnv);
}

export function readPaperSimulationConfig(
  rawEnv: NodeJS.ProcessEnv = process.env
): PaperSimulationConfig {
  return buildPaperSimulationConfig(rawEnv);
}

export function readLiveSafetyConfig(
  rawEnv: NodeJS.ProcessEnv = process.env
): LiveSafetyConfig {
  return buildLiveSafetyConfig(rawEnv);
}

export function assertCanUseLiveExecution(
  config: Pick<EnvConfig, "runtime" | "exchange" | "liveSafety">
): true {
  const issues: string[] = [];
  if (config.runtime.tradingMode !== "live") {
    issues.push(`TRADING_MODE must be live (received ${config.runtime.tradingMode}).`);
  }
  if (!config.liveSafety.liveTradingEnabled) {
    issues.push("LIVE_TRADING_ENABLED must be true.");
  }
  if (!config.liveSafety.liveExchangeAck) {
    issues.push("LIVE_EXCHANGE_ACK must be true.");
  }

  const exchange = config.exchange.selectedExchange;
  if (exchange === "binance") {
    if (!config.exchange.binance.apiKey) issues.push("BINANCE_FUTURES_API_KEY is required.");
    if (!config.exchange.binance.apiSecret) issues.push("BINANCE_FUTURES_API_SECRET is required.");
  } else if (exchange === "bybit") {
    if (!config.exchange.bybit.apiKey) issues.push("BYBIT_API_KEY is required.");
    if (!config.exchange.bybit.apiSecret) issues.push("BYBIT_API_SECRET is required.");
  } else if (exchange === "coinbase") {
    if (!config.exchange.coinbase.apiKeyName) issues.push("COINBASE_API_KEY_NAME is required.");
    if (!config.exchange.coinbase.apiPrivateKey) issues.push("COINBASE_API_PRIVATE_KEY is required.");
  }

  if (issues.length > 0) {
    throw new EnvConfigError(`Live execution is blocked: ${issues.join(" ")}`, issues);
  }
  return true;
}

export function readEnvConfig(rawEnv: NodeJS.ProcessEnv = process.env): EnvConfig {
  return {
    runtime: readRuntimeConfig(rawEnv),
    exchange: readExchangeConfig(rawEnv),
    strategy: readStrategyConfig(rawEnv),
    paperSimulation: readPaperSimulationConfig(rawEnv),
    liveSafety: readLiveSafetyConfig(rawEnv),
  };
}
