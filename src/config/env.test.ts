import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EnvConfigError,
  assertCanUseLiveExecution,
  readCoinbaseExchangeConfig,
  readCoinbasePublicConfig,
  readExchangeConfig,
  readLiveSafetyConfig,
  readPaperSimulationConfig,
  readRuntimeConfig,
} from "./env.js";

describe("env config loader", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("loads a valid Binance config", () => {
    const cfg = readExchangeConfig({
      FUTURES_EXCHANGE: "binance",
      BINANCE_FUTURES_API_KEY: "bin-key",
      BINANCE_FUTURES_API_SECRET: "bin-secret",
      BINANCE_FUTURES_USE_TESTNET: "true",
    });
    expect(cfg.selectedExchange).toBe("binance");
    expect(cfg.binance.apiKey).toBe("bin-key");
    expect(cfg.binance.apiSecret).toBe("bin-secret");
    expect(cfg.binance.useTestnet).toBe(true);
  });

  it("loads a valid Bybit config", () => {
    const cfg = readExchangeConfig({
      FUTURES_EXCHANGE: "bybit",
      BYBIT_API_KEY: "bybit-key",
      BYBIT_API_SECRET: "bybit-secret",
      BYBIT_TESTNET: "true",
      BYBIT_BASE_URL: "https://api-testnet.bybit.com",
      BYBIT_CATEGORY: "linear",
      BYBIT_SYMBOL: "BTCUSDT",
      BYBIT_WS_PUBLIC_URL: "wss://stream-testnet.bybit.com/v5/public/linear",
    });
    expect(cfg.selectedExchange).toBe("bybit");
    expect(cfg.bybit.apiKey).toBe("bybit-key");
    expect(cfg.bybit.apiSecret).toBe("bybit-secret");
    expect(cfg.bybit.category).toBe("linear");
  });

  it("loads a valid Coinbase config", () => {
    const cfg = readExchangeConfig({
      FUTURES_EXCHANGE: "coinbase",
      COINBASE_API_KEY_NAME: "cb-key",
      COINBASE_API_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----",
      COINBASE_BASE_URL: "https://api.coinbase.com",
      COINBASE_PRODUCT_ID: "BTC-PERP",
      COINBASE_DERIVATIVES_ENABLED: "true",
    });
    expect(cfg.selectedExchange).toBe("coinbase");
    expect(cfg.coinbase.apiKeyName).toBe("cb-key");
    expect(cfg.coinbase.apiPrivateKey).toContain("BEGIN PRIVATE KEY");
    expect(cfg.coinbase.productId).toBe("BTC-PERP");
  });

  it("requires Coinbase credentials for authenticated_paper exchange config", () => {
    expect(() =>
      readExchangeConfig({
        FUTURES_EXCHANGE: "coinbase",
        TRADING_MODE: "authenticated_paper",
        COINBASE_PRODUCT_ID: "BTC-PERP",
      })
    ).toThrowError(/Missing Coinbase env: COINBASE_API_KEY_NAME, COINBASE_API_PRIVATE_KEY/);
  });

  it("defaults trading mode to public_paper", () => {
    const runtime = readRuntimeConfig({});
    expect(runtime.tradingMode).toBe("public_paper");
  });

  it("loads public_paper Coinbase config without credentials", () => {
    const cfg = readCoinbasePublicConfig({
      FUTURES_EXCHANGE: "coinbase",
      TRADING_MODE: "public_paper",
      COINBASE_PRODUCT_ID: "BTC-PERP",
    });
    expect(cfg.productId).toBe("BTC-PERP");
    expect(cfg.apiKeyName).toBe("");
    expect(cfg.apiPrivateKey).toBe("");
  });

  it("requires Coinbase credentials for authenticated_paper exchange config", () => {
    expect(() =>
      readExchangeConfig({
        FUTURES_EXCHANGE: "coinbase",
        TRADING_MODE: "authenticated_paper",
      })
    ).toThrowError(/Missing Coinbase env: COINBASE_API_KEY_NAME, COINBASE_API_PRIVATE_KEY/);
  });

  it("fails with a readable error when selected exchange credentials are missing", () => {
    expect(() => readExchangeConfig({ FUTURES_EXCHANGE: "bybit" })).toThrowError(
      EnvConfigError
    );
    expect(() => readExchangeConfig({ FUTURES_EXCHANGE: "bybit" })).toThrowError(
      /Missing Bybit env: BYBIT_API_KEY, BYBIT_API_SECRET/
    );
  });

  it("defaults LIVE_TRADING_ENABLED to false", () => {
    const liveSafety = readLiveSafetyConfig({});
    expect(liveSafety.liveTradingEnabled).toBe(false);
    expect(liveSafety.liveExchangeAck).toBe(false);
  });

  it("defaults PAPER_REALISTIC_MODE to false", () => {
    expect(readPaperSimulationConfig({}).realisticMode).toBe(false);
  });

  it("loads realistic paper config from the new canonical env names", () => {
    const cfg = readPaperSimulationConfig({
      PAPER_REALISTIC_MODE: "true",
      PAPER_REALISTIC_MAKER_FEE_BPS: "1.5",
      PAPER_REALISTIC_TAKER_FEE_BPS: "2.5",
      PAPER_REALISTIC_SLIPPAGE_BPS: "3.5",
      PAPER_REALISTIC_LATENCY_MS: "150",
      PAPER_REALISTIC_SPREAD_BPS: "4.5",
      PAPER_REALISTIC_MIN_NOTIONAL: "12.25",
      PAPER_REALISTIC_FUNDING_BPS_PER_HOUR: "0.75",
    });
    expect(cfg.realisticMode).toBe(true);
    expect(cfg.makerFeeBps).toBe(1.5);
    expect(cfg.takerFeeBps).toBe(2.5);
    expect(cfg.realisticSlippageBps).toBe(3.5);
    expect(cfg.realisticLatencyMs).toBe(150);
    expect(cfg.realisticSpreadBps).toBe(4.5);
    expect(cfg.minNotionalQuote).toBe(12.25);
    expect(cfg.fundingBpsPerHour).toBe(0.75);
  });

  it("keeps backward compatibility with warnings for legacy realistic paper env names", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const cfg = readPaperSimulationConfig({
      PAPER_REALISTIC_MODE: "true",
      PAPER_MAKER_FEE_BPS: "11",
      PAPER_TAKER_FEE_BPS: "22",
      PAPER_SLIPPAGE_BPS: "33",
      PAPER_SPREAD_BPS: "44",
      PAPER_LATENCY_MS: "55",
      PAPER_MIN_NOTIONAL: "66",
      PAPER_FUNDING_BPS_PER_HOUR: "77",
    });
    expect(cfg.makerFeeBps).toBe(11);
    expect(cfg.takerFeeBps).toBe(22);
    expect(cfg.realisticSlippageBps).toBe(33);
    expect(cfg.realisticSpreadBps).toBe(44);
    expect(cfg.realisticLatencyMs).toBe(55);
    expect(cfg.minNotionalQuote).toBe(66);
    expect(cfg.fundingBpsPerHour).toBe(77);
    expect(warn).toHaveBeenCalledWith(
      "[config] PAPER_MAKER_FEE_BPS is deprecated; use PAPER_REALISTIC_MAKER_FEE_BPS instead."
    );
    expect(warn).toHaveBeenCalledWith(
      "[config] PAPER_TAKER_FEE_BPS is deprecated; use PAPER_REALISTIC_TAKER_FEE_BPS instead."
    );
    expect(warn).toHaveBeenCalledWith(
      "[config] PAPER_SLIPPAGE_BPS is deprecated; use PAPER_REALISTIC_SLIPPAGE_BPS instead."
    );
    expect(warn).toHaveBeenCalledWith(
      "[config] PAPER_SPREAD_BPS is deprecated; use PAPER_REALISTIC_SPREAD_BPS instead."
    );
  });

  it("resolves runtime symbol for Bybit without requiring credentials", () => {
    const runtime = readRuntimeConfig({
      FUTURES_EXCHANGE: "bybit",
      BYBIT_SYMBOL: "BTCUSDT",
      BYBIT_CATEGORY: "linear",
      BYBIT_WS_PUBLIC_URL: "wss://stream-testnet.bybit.com/v5/public/linear",
    });
    expect(runtime.futuresExchange).toBe("bybit");
    expect(runtime.futuresContractSymbol).toBe("BTCUSDT");
    expect(runtime.bybitCategory).toBe("linear");
  });

  it("reads Coinbase config with fallback fee settings", () => {
    const cfg = readCoinbaseExchangeConfig({
      COINBASE_API_KEY_NAME: "cb-key",
      COINBASE_API_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----",
      COINBASE_FEE_MAKER_BPS: "12.5",
      COINBASE_FEE_TAKER_BPS: "25",
    });
    expect(cfg.apiKeyName).toBe("cb-key");
    expect(cfg.feeMakerBps).toBe(12.5);
    expect(cfg.feeTakerBps).toBe(25);
    expect(cfg.derivativesEnabled).toBe(true);
  });

  it("blocks live execution until all guards are true", () => {
    expect(() =>
      assertCanUseLiveExecution({
        runtime: {
          futuresExchange: "coinbase",
          tradingMode: "live",
          futuresContractSymbol: "BTCUSDT",
          bybitCategory: "linear",
          bybitWsPublicUrl: "wss://stream.bybit.com/v5/public/linear",
          testMode: false,
          marketMode: "spot",
        },
        exchange: {
          selectedExchange: "coinbase",
          binance: {
            apiKey: "",
            apiSecret: "",
            useTestnet: true,
            baseUrl: "https://fapi.binance.com",
          },
          bybit: {
            enabled: true,
            testnet: true,
            baseUrl: "https://api-testnet.bybit.com",
            wsPublicUrl: "wss://stream-testnet.bybit.com/v5/public/linear",
            apiKey: "",
            apiSecret: "",
            category: "linear",
            symbol: "BTCUSDT",
            recvWindow: 5000,
            authDebug: false,
          },
          coinbase: {
            apiKeyName: "",
            apiPrivateKey: "",
            baseUrl: "https://api.coinbase.com",
            productId: "BTC-PERP",
            derivativesEnabled: true,
            authDebug: false,
            feeMakerBps: undefined,
            feeTakerBps: undefined,
          },
        },
        liveSafety: {
          liveTradingEnabled: false,
          liveExchangeAck: false,
          maxNotionalPerTrade: 10,
          dailyMaxLossQuote: 2,
          maxOpenPositions: 1,
          allowedSymbols: ["BTCUSDT"],
        },
      })
    ).toThrowError(/LIVE_TRADING_ENABLED must be true/);

    expect(() =>
      assertCanUseLiveExecution({
        runtime: {
          futuresExchange: "coinbase",
          tradingMode: "live",
          futuresContractSymbol: "BTCUSDT",
          bybitCategory: "linear",
          bybitWsPublicUrl: "wss://stream.bybit.com/v5/public/linear",
          testMode: false,
          marketMode: "spot",
        },
        exchange: {
          selectedExchange: "coinbase",
          binance: {
            apiKey: "",
            apiSecret: "",
            useTestnet: true,
            baseUrl: "https://fapi.binance.com",
          },
          bybit: {
            enabled: true,
            testnet: true,
            baseUrl: "https://api-testnet.bybit.com",
            wsPublicUrl: "wss://stream-testnet.bybit.com/v5/public/linear",
            apiKey: "",
            apiSecret: "",
            category: "linear",
            symbol: "BTCUSDT",
            recvWindow: 5000,
            authDebug: false,
          },
          coinbase: {
            apiKeyName: "organizations/abc/apiKeys/def",
            apiPrivateKey: "-----BEGIN EC PRIVATE KEY-----\nabc\n-----END EC PRIVATE KEY-----",
            baseUrl: "https://api.coinbase.com",
            productId: "BTC-PERP",
            derivativesEnabled: true,
            authDebug: false,
            feeMakerBps: undefined,
            feeTakerBps: undefined,
          },
        },
        liveSafety: {
          liveTradingEnabled: true,
          liveExchangeAck: false,
          maxNotionalPerTrade: 10,
          dailyMaxLossQuote: 2,
          maxOpenPositions: 1,
          allowedSymbols: ["BTCUSDT"],
        },
      })
    ).toThrowError(/LIVE_EXCHANGE_ACK must be true/);
  });
});
