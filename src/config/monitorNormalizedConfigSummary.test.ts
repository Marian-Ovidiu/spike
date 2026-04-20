import { describe, expect, it } from "vitest";

import {
  configDefaults,
  configMeta,
  type AppConfig,
  type ConfigSourceMeta,
} from "../config.js";
import {
  buildNormalizedMonitorConfigSummary,
  buildSignalDetectionThresholdsNormalized,
  formatSignalDetectionBannerLines,
} from "./monitorNormalizedConfigSummary.js";

function baseCfg(over: Partial<AppConfig> = {}): AppConfig {
  return { ...(configDefaults as unknown as AppConfig), ...over };
}

/** Pin the eight signal-detection keys for stable provenance in tests. */
function metaSignalDefaults(overrides: Partial<ConfigSourceMeta> = {}): ConfigSourceMeta {
  return {
    ...configMeta,
    spikeThreshold: { fromEnv: false },
    tradableSpikeMinPercent: { fromEnv: false },
    exceptionalSpikePercent: { fromEnv: false },
    rangeThreshold: { fromEnv: false },
    maxPriorRangeForNormalEntry: { fromEnv: false },
    spikeMinRangeMultiple: { fromEnv: false },
    strongSpikeConfirmationTicks: { fromEnv: false },
    enableBorderlineMode: { fromEnv: false },
    ...overrides,
  };
}

describe("buildNormalizedMonitorConfigSummary", () => {
  it("binary mode reports outcome delta exits, optional gamma tuning, and signalDetection", () => {
    const cfg = baseCfg({
      marketMode: "binary",
      binaryTakeProfitPriceDelta: 0.04,
      binaryStopLossPriceDelta: 0.03,
      binaryExitTimeoutMs: 60_000,
      feedStaleMaxAgeMs: 12_000,
      blockEntriesOnStaleFeed: true,
    });
    const meta = metaSignalDefaults();
    const n = buildNormalizedMonitorConfigSummary(cfg, meta);
    expect(n.schema).toBe("normalized_monitor_config_v2");
    expect(n.marketMode).toBe("binary");
    expect(n.effectiveExits.takeProfitUnit).toBe("outcome_price_delta");
    expect(n.effectiveExits.takeProfit).toBe(0.04);
    expect(n.effectiveExits.timeoutAppliesTo).toBe("binary_outcome_leg");
    expect(n.staleFeeds.signalFeedStaleMaxAgeMs).toBe(12_000);
    expect(n.signalDetection.SPIKE_THRESHOLD.effective).toBe(cfg.spikeThreshold);
    expect(n.signalDetection.SPIKE_THRESHOLD.fromEnv).toBe(false);
    expect(n.signalDetection.ENABLE_BORDERLINE_MODE.effective).toBe(false);
    if (n.executionVenue.kind === "polymarket_gamma") {
      expect(n.staleFeeds.gammaExecution?.pollIntervalMs).toBeGreaterThanOrEqual(2000);
    }
  });

  it("spot mode reports bps exits and signalDetection", () => {
    const cfg = baseCfg({
      marketMode: "spot",
      takeProfitBps: 40,
      stopLossBps: 20,
      exitTimeoutMs: 30_000,
    });
    const meta = metaSignalDefaults();
    const n = buildNormalizedMonitorConfigSummary(cfg, meta);
    expect(n.marketMode).toBe("spot");
    expect(n.effectiveExits.takeProfitUnit).toBe("bps");
    expect(n.effectiveExits.timeoutAppliesTo).toBe("spot_position");
    expect(n.staleFeeds.gammaExecution).toBeUndefined();
    expect(n.signalDetection.TRADABLE_SPIKE_MIN_PERCENT.fromEnv).toBe(false);
  });
});

describe("buildSignalDetectionThresholdsNormalized", () => {
  it("marks explicit canonical env without envSourceKey when it matches canonical", () => {
    const cfg = baseCfg({ spikeThreshold: 0.02, marketMode: "binary" });
    const meta = metaSignalDefaults({
      spikeThreshold: { fromEnv: true, envSourceKey: "SPIKE_THRESHOLD" },
    });
    const s = buildSignalDetectionThresholdsNormalized(cfg, meta);
    expect(s.SPIKE_THRESHOLD).toEqual({ effective: 0.02, fromEnv: true });
    expect(s.SPIKE_THRESHOLD.envSourceKey).toBeUndefined();
  });

  it("includes envSourceKey when the supplying env name differs from canonical", () => {
    const cfg = baseCfg({ maxPriorRangeForNormalEntry: 0.009, marketMode: "binary" });
    const meta = metaSignalDefaults({
      maxPriorRangeForNormalEntry: {
        fromEnv: true,
        envSourceKey: "LEGACY_MAX_PRIOR_RANGE",
      },
    });
    const s = buildSignalDetectionThresholdsNormalized(cfg, meta);
    expect(s.MAX_PRIOR_RANGE_FOR_NORMAL_ENTRY).toEqual({
      effective: 0.009,
      fromEnv: true,
      envSourceKey: "LEGACY_MAX_PRIOR_RANGE",
    });
  });
});

describe("formatSignalDetectionBannerLines", () => {
  it("prints default and explicit-env provenance", () => {
    const cfg = baseCfg({
      marketMode: "binary",
      spikeThreshold: 0.005,
      enableBorderlineMode: true,
    });
    const meta = metaSignalDefaults({
      spikeThreshold: { fromEnv: false },
      enableBorderlineMode: { fromEnv: true, envSourceKey: "ENABLE_BORDERLINE_MODE" },
    });
    const lines = formatSignalDetectionBannerLines(cfg, meta);
    expect(lines.some((l) => l.startsWith("SPIKE_THRESHOLD=") && l.includes("(default)"))).toBe(
      true
    );
    expect(
      lines.some(
        (l) => l.startsWith("ENABLE_BORDERLINE_MODE=true") && l.includes("from ENABLE_BORDERLINE_MODE")
      )
    ).toBe(true);
  });
});
