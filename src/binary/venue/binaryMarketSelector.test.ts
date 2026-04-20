import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  applyAutoDiscoveredBtc5mMarketForTests,
  resetBinaryAutoDiscoveryStateForTests,
} from "./discoverBtc5mUpDownMarket.js";
import {
  formatBinaryExecutionVenueBannerLine,
  resolveBinaryMarketSelectorFromEnv,
} from "./binaryMarketSelector.js";

const MARKET_ENV_KEYS = [
  "BINARY_MARKET_ID",
  "BINARY_MARKET_SLUG",
  "BINARY_CONDITION_ID",
  "POLYMARKET_MARKET_ID",
  "POLYMARKET_MARKET_SLUG",
  "POLYMARKET_CONDITION_ID",
] as const;

describe("resolveBinaryMarketSelectorFromEnv", () => {
  const saved: Partial<Record<(typeof MARKET_ENV_KEYS)[number], string | undefined>> = {};

  beforeAll(() => {
    for (const k of MARKET_ENV_KEYS) {
      saved[k] = process.env[k];
    }
  });

  beforeEach(() => {
    resetBinaryAutoDiscoveryStateForTests();
    for (const k of MARKET_ENV_KEYS) {
      delete process.env[k];
    }
  });

  afterEach(() => {
    resetBinaryAutoDiscoveryStateForTests();
    for (const k of MARKET_ENV_KEYS) {
      if (saved[k] !== undefined) process.env[k] = saved[k];
      else delete process.env[k];
    }
  });

  it("prefers BINARY_MARKET_ID over BINARY_MARKET_SLUG", () => {
    process.env.BINARY_MARKET_ID = "m1";
    process.env.BINARY_MARKET_SLUG = "slug1";
    const r = resolveBinaryMarketSelectorFromEnv();
    expect(r.executionMode).toBe("gamma");
    expect(r.selectorKind).toBe("market_id");
    expect(r.selectorValue).toBe("m1");
    expect(r.sourceEnvKey).toBe("BINARY_MARKET_ID");
  });

  it("prefers BINARY_MARKET_SLUG over BINARY_CONDITION_ID", () => {
    process.env.BINARY_MARKET_SLUG = "slug-x";
    process.env.BINARY_CONDITION_ID = "0xabc";
    const r = resolveBinaryMarketSelectorFromEnv();
    expect(r.selectorKind).toBe("slug");
    expect(r.selectorValue).toBe("slug-x");
  });

  it("uses condition id when no id or slug", () => {
    process.env.BINARY_CONDITION_ID = "0xdead";
    const r = resolveBinaryMarketSelectorFromEnv();
    expect(r.selectorKind).toBe("condition_id");
    expect(r.selectorValue).toBe("0xdead");
  });

  it("prefers BINARY_MARKET_ID over POLYMARKET_MARKET_SLUG", () => {
    process.env.BINARY_MARKET_ID = "id-bin";
    process.env.POLYMARKET_MARKET_SLUG = "slug-poly";
    const r = resolveBinaryMarketSelectorFromEnv();
    expect(r.selectorKind).toBe("market_id");
    expect(r.selectorValue).toBe("id-bin");
  });

  it("uses POLYMARKET_MARKET_ID when BINARY_MARKET_ID unset", () => {
    process.env.POLYMARKET_MARKET_ID = "poly-id";
    const r = resolveBinaryMarketSelectorFromEnv();
    expect(r.selectorKind).toBe("market_id");
    expect(r.sourceEnvKey).toBe("POLYMARKET_MARKET_ID");
  });

  it("returns synthetic when nothing set", () => {
    const r = resolveBinaryMarketSelectorFromEnv();
    expect(r.executionMode).toBe("synthetic");
    expect(r.selectorKind).toBe("none");
  });

  it("uses AUTO_DISCOVER_BINARY_MARKET as source when slug was applied by auto-picker", () => {
    applyAutoDiscoveredBtc5mMarketForTests({
      slug: "btc-5m-auto-slug",
      marketId: "123",
      conditionId: "0x1",
      title: "Bitcoin Up or Down 5m",
      acceptingOrders: true,
      enableOrderBook: true,
      tokenIds: ["t1", "t2"],
      validationResult: "PASS: test",
    });
    const r = resolveBinaryMarketSelectorFromEnv();
    expect(r.sourceEnvKey).toBe("AUTO_DISCOVER_BINARY_MARKET");
    expect(r.selectorValue).toBe("btc-5m-auto-slug");
  });
});

describe("formatBinaryExecutionVenueBannerLine", () => {
  it("formats synthetic and gamma lines", () => {
    expect(
      formatBinaryExecutionVenueBannerLine({
        executionMode: "synthetic",
        selectorKind: "none",
        selectorValue: "",
        sourceEnvKey: "",
      })
    ).toContain("synthetic");
    expect(
      formatBinaryExecutionVenueBannerLine({
        executionMode: "gamma",
        selectorKind: "slug",
        selectorValue: "foo",
        sourceEnvKey: "BINARY_MARKET_SLUG",
      })
    ).toContain("foo");
    expect(
      formatBinaryExecutionVenueBannerLine({
        executionMode: "gamma",
        selectorKind: "market_id",
        selectorValue: "42",
        sourceEnvKey: "BINARY_MARKET_ID",
      })
    ).toContain("market_id");
    expect(
      formatBinaryExecutionVenueBannerLine({
        executionMode: "gamma",
        selectorKind: "slug",
        selectorValue: "x",
        sourceEnvKey: "AUTO_DISCOVER_BINARY_MARKET",
      })
    ).toContain("AUTO_DISCOVER_BINARY_MARKET");
  });
});
