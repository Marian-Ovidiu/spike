import { describe, expect, it } from "vitest";

import {
  CONFIG_KEY_GROUP,
  configDefaults,
  describeActiveConfigGroups,
  formatGroupedConfigLines,
  type AppConfig,
  type ConfigSourceMeta,
} from "./config.js";

function defaultMeta(): ConfigSourceMeta {
  return Object.fromEntries(
    (Object.keys(CONFIG_KEY_GROUP) as (keyof AppConfig)[]).map((k) => [
      k,
      { fromEnv: false },
    ])
  ) as ConfigSourceMeta;
}

describe("grouped configuration logging", () => {
  it("classifies spot-only and binary-only keys", () => {
    expect(CONFIG_KEY_GROUP.takeProfitBps).toBe("spot");
    expect(CONFIG_KEY_GROUP.feedStaleMaxAgeMs).toBe("shared");
    expect(CONFIG_KEY_GROUP.binaryTakeProfitPriceDelta).toBe("binary");
    expect(CONFIG_KEY_GROUP.binarySignalSymbol).toBe("binary");
    expect(CONFIG_KEY_GROUP.spikeThreshold).toBe("shared");
    expect(CONFIG_KEY_GROUP.marketMode).toBe("shared");
  });

  it("binary mode lists spot block as ignored in binary mode", () => {
    const cfg = {
      ...(configDefaults as unknown as AppConfig),
      marketMode: "binary" as const,
    };
    const lines = formatGroupedConfigLines(cfg, defaultMeta()).join("\n");
    expect(lines).toContain("Legacy spot execution — not used when MARKET_MODE=binary");
    expect(lines).toContain("takeProfitBps");
    expect(lines).not.toContain("Binary-only — not used when MARKET_MODE=spot");
    expect(describeActiveConfigGroups("binary")).toContain("spot-only");
  });

  it("spot mode lists binary block as ignored in spot mode", () => {
    const cfg = {
      ...(configDefaults as unknown as AppConfig),
      marketMode: "spot" as const,
    };
    const lines = formatGroupedConfigLines(cfg, defaultMeta()).join("\n");
    expect(lines).toContain("Binary-only — not used when MARKET_MODE=spot");
    expect(lines).toContain("binaryTakeProfitPriceDelta");
    expect(lines).not.toContain("Legacy spot execution — not used when MARKET_MODE=binary");
    expect(describeActiveConfigGroups("spot")).toContain("binary-only");
  });
});
