import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertLiveTradingEnabled,
  maskSecret,
  type LiveOrderIntentInput,
  validateLiveOrderIntent,
  LiveSafetyGuardError,
} from "./liveSafetyGuard.js";

const ENV_KEYS = [
  "LIVE_TRADING_ENABLED",
  "LIVE_MAX_NOTIONAL_PER_TRADE",
  "LIVE_DAILY_MAX_LOSS_QUOTE",
  "LIVE_MAX_OPEN_POSITIONS",
  "LIVE_ALLOWED_SYMBOLS",
] as const;

function setBaseEnv(overrides: Partial<Record<(typeof ENV_KEYS)[number], string>> = {}): void {
  vi.stubEnv("LIVE_TRADING_ENABLED", "true");
  vi.stubEnv("LIVE_MAX_NOTIONAL_PER_TRADE", "10");
  vi.stubEnv("LIVE_DAILY_MAX_LOSS_QUOTE", "2");
  vi.stubEnv("LIVE_MAX_OPEN_POSITIONS", "1");
  vi.stubEnv("LIVE_ALLOWED_SYMBOLS", "BTCUSDT");
  for (const [key, value] of Object.entries(overrides)) {
    vi.stubEnv(key, value);
  }
}

describe("liveSafetyGuard", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("masks secrets without leaking the full value", () => {
    expect(maskSecret("supersecretvalue")).toBe("supe***alue");
    expect(maskSecret("abcd")).toBe("a***");
    expect(maskSecret("")).toBe("");
  });

  it("rejects any intent when live trading is disabled", () => {
    vi.stubEnv("LIVE_TRADING_ENABLED", "false");
    expect(() => assertLiveTradingEnabled()).toThrowError(
      LiveSafetyGuardError
    );
    expect(() =>
      validateLiveOrderIntent({
        symbol: "BTCUSDT",
        side: "BUY",
        notional: 1,
        currentOpenPositions: 0,
        dailyLossQuote: 0,
      })
    ).toThrowError(LiveSafetyGuardError);
    try {
      validateLiveOrderIntent({
        symbol: "BTCUSDT",
        side: "BUY",
        notional: 1,
        currentOpenPositions: 0,
        dailyLossQuote: 0,
      });
    } catch (err) {
      expect(err).toBeInstanceOf(LiveSafetyGuardError);
      if (err instanceof LiveSafetyGuardError) {
        expect(err.code).toBe("live_trading_disabled");
      }
    }
  });

  it("accepts a valid entry intent and normalizes casing", () => {
    setBaseEnv();
    const intent: LiveOrderIntentInput = {
      symbol: " btcusdt ",
      side: "buy",
      notional: 10,
      currentOpenPositions: 0,
      dailyLossQuote: 0,
      reduceOnly: true,
    };
    const validated = validateLiveOrderIntent(intent);
    expect(validated).toEqual({
      symbol: "BTCUSDT",
      side: "BUY",
      notional: 10,
      reduceOnly: true,
      currentOpenPositions: 0,
      dailyLossQuote: 0,
    });
  });

  it("rejects symbols outside the allow-list", () => {
    setBaseEnv({ LIVE_ALLOWED_SYMBOLS: "BTCUSDT,ETHUSDT" });
    expect(() =>
      validateLiveOrderIntent({
        symbol: "SOLUSDT",
        side: "BUY",
        notional: 1,
        currentOpenPositions: 0,
        dailyLossQuote: 0,
      })
    ).toThrowError(/not allowed/i);
  });

  it("rejects notional above the per-trade cap", () => {
    setBaseEnv();
    expect(() =>
      validateLiveOrderIntent({
        symbol: "BTCUSDT",
        side: "SELL",
        notional: 10.01,
        currentOpenPositions: 0,
        dailyLossQuote: 0,
      })
    ).toThrowError(/LIVE_MAX_NOTIONAL_PER_TRADE=10/);
  });

  it("rejects invalid sides", () => {
    setBaseEnv();
    expect(() =>
      validateLiveOrderIntent({
        symbol: "BTCUSDT",
        side: "HOLD",
        notional: 1,
        currentOpenPositions: 0,
        dailyLossQuote: 0,
      })
    ).toThrowError(/BUY or SELL/);
  });

  it("rejects when open positions are already at the limit", () => {
    setBaseEnv();
    expect(() =>
      validateLiveOrderIntent({
        symbol: "BTCUSDT",
        side: "BUY",
        notional: 1,
        currentOpenPositions: 1,
        dailyLossQuote: 0,
      })
    ).toThrowError(/LIVE_MAX_OPEN_POSITIONS=1/);
  });

  it("rejects when daily loss exceeds the limit", () => {
    setBaseEnv();
    expect(() =>
      validateLiveOrderIntent({
        symbol: "BTCUSDT",
        side: "SELL",
        notional: 1,
        currentOpenPositions: 0,
        dailyLossQuote: 2.01,
      })
    ).toThrowError(/LIVE_DAILY_MAX_LOSS_QUOTE=2/);
  });
});
