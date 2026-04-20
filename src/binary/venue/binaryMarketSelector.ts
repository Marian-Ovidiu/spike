/**
 * **Optional Polymarket Gamma integration** — resolves which Gamma market (if any) backs
 * binary **execution** when configured. If nothing matches, callers use synthetic execution
 * ({@link BinarySyntheticFeed} via {@link createBinaryExecutionFeed}).
 *
 * Signal BTC feed is separate ({@link createBinarySignalDataFeed}); this module is execution only.
 */

import {
  getLastAutoDiscoveredBtc5mMarket,
  wasBinaryMarketAutoDiscovered,
} from "./discoverBtc5mUpDownMarket.js";

function envTrim(key: string): string {
  return process.env[key]?.trim() ?? "";
}

export type BinaryMarketSelectorKind = "market_id" | "slug" | "condition_id" | "none";

export type BinaryMarketSelectorResolution = {
  /** `gamma` when a market id / slug / condition id is configured; otherwise synthetic demo. */
  executionMode: "gamma" | "synthetic";
  selectorKind: BinaryMarketSelectorKind;
  /** Non-empty when `executionMode === "gamma"`. */
  selectorValue: string;
  /** Env key that supplied the winning value (BINARY_* preferred over legacy per tier). */
  sourceEnvKey: string;
};

/**
 * **Precedence (first non-empty wins):**
 *
 * 1. `BINARY_MARKET_ID`, else `POLYMARKET_MARKET_ID`
 * 2. else `BINARY_MARKET_SLUG`, else `POLYMARKET_MARKET_SLUG`
 * 3. else `BINARY_CONDITION_ID`, else `POLYMARKET_CONDITION_ID`
 * 4. else synthetic (no Gamma selector)
 *
 * So **market id beats slug beats condition** across both naming families; within one tier,
 * `BINARY_*` beats `POLYMARKET_*`.
 *
 * `hydrateBinaryGammaEnvAliases` in `config.ts` may copy BINARY → POLYMARKET when the legacy
 * key is empty; resolution still prefers reading `BINARY_*` first so intent stays explicit.
 */
export function resolveBinaryMarketSelectorFromEnv(): BinaryMarketSelectorResolution {
  const binId = envTrim("BINARY_MARKET_ID");
  const polyId = envTrim("POLYMARKET_MARKET_ID");
  if (binId) {
    return {
      executionMode: "gamma",
      selectorKind: "market_id",
      selectorValue: binId,
      sourceEnvKey: "BINARY_MARKET_ID",
    };
  }
  if (polyId) {
    return {
      executionMode: "gamma",
      selectorKind: "market_id",
      selectorValue: polyId,
      sourceEnvKey: "POLYMARKET_MARKET_ID",
    };
  }

  const binSlug = envTrim("BINARY_MARKET_SLUG");
  const polySlug = envTrim("POLYMARKET_MARKET_SLUG");
  if (binSlug) {
    const auto = getLastAutoDiscoveredBtc5mMarket();
    const sourceEnvKey =
      wasBinaryMarketAutoDiscovered() && auto?.slug === binSlug
        ? "AUTO_DISCOVER_BINARY_MARKET"
        : "BINARY_MARKET_SLUG";
    return {
      executionMode: "gamma",
      selectorKind: "slug",
      selectorValue: binSlug,
      sourceEnvKey,
    };
  }
  if (polySlug) {
    return {
      executionMode: "gamma",
      selectorKind: "slug",
      selectorValue: polySlug,
      sourceEnvKey: "POLYMARKET_MARKET_SLUG",
    };
  }

  const binCond = envTrim("BINARY_CONDITION_ID");
  const polyCond = envTrim("POLYMARKET_CONDITION_ID");
  if (binCond) {
    return {
      executionMode: "gamma",
      selectorKind: "condition_id",
      selectorValue: binCond,
      sourceEnvKey: "BINARY_CONDITION_ID",
    };
  }
  if (polyCond) {
    return {
      executionMode: "gamma",
      selectorKind: "condition_id",
      selectorValue: polyCond,
      sourceEnvKey: "POLYMARKET_CONDITION_ID",
    };
  }

  return {
    executionMode: "synthetic",
    selectorKind: "none",
    selectorValue: "",
    sourceEnvKey: "",
  };
}

/** @deprecated use {@link isGammaExecutionConfigured} */
export function isPolymarketGammaConfigured(): boolean {
  return isGammaExecutionConfigured();
}

export function isGammaExecutionConfigured(): boolean {
  return resolveBinaryMarketSelectorFromEnv().executionMode === "gamma";
}

/** One startup line: execution mode + selector type + value (+ env key for gamma). */
export function formatBinaryExecutionVenueBannerLine(
  r: BinaryMarketSelectorResolution
): string {
  if (r.executionMode === "synthetic") {
    return "mode: synthetic  │  selector: none  │  value: —  (BINARY_UP_PRICE / BINARY_DOWN_PRICE)";
  }
  const kind =
    r.selectorKind === "market_id"
      ? "market_id"
      : r.selectorKind === "slug"
        ? "slug"
        : "condition_id";
  const envPart =
    r.sourceEnvKey === "AUTO_DISCOVER_BINARY_MARKET"
      ? "env: AUTO_DISCOVER_BINARY_MARKET (slug applied at runtime)"
      : `env: ${r.sourceEnvKey}`;
  return `mode: gamma (HTTP)  │  selector: ${kind}  │  value: ${r.selectorValue}  │  ${envPart}`;
}
