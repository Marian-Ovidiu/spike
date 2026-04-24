/**
 * **Optional integration CLI** — Polymarket Gamma + CLOB wiring for the current env selector;
 * prints book / trading-suitability diagnostics. Does not start the monitor loop.
 *
 * Not part of the **core synthetic lab** path: if your `.env` has no Gamma selector and no
 * auto-discovery, this exits **`2`** (“synthetic-only”) which is expected for local research.
 *
 * `npm run validate-binary-market`
 */
import "../config/loadEnv.js";

import { config, configMeta } from "../config.js";
import { ensureAutoDiscoveredBinaryMarketSlug } from "../binary/venue/discoverBtc5mUpDownMarket.js";
import { BinaryMarketFeed } from "../binary/venue/binaryMarketFeed.js";
import { resolveBinaryMarketSelectorFromEnv } from "../binary/venue/binaryMarketSelector.js";
import {
  assessTradingSuitability,
  formatGammaBootstrapStepsForLog,
} from "../binary/venue/gammaMarketResolve.js";
import {
  parseGammaJsonNumberArray,
  parseGammaJsonStringArray,
} from "../binary/venue/gammaMarketQuoteParse.js";
import { buildNormalizedMonitorConfigSummary } from "../config/monitorNormalizedConfigSummary.js";

function asNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

async function main(): Promise<void> {
  try {
    await ensureAutoDiscoveredBinaryMarketSlug(config.marketMode);
  } catch (e) {
    console.error(
      "[validate-binary-market] Cannot resolve a Gamma market from the current env (auto-discovery failed, bad MARKET_MODE, or HTTP error)."
    );
    console.error(e);
    process.exit(2);
  }

  const sel = resolveBinaryMarketSelectorFromEnv();
  console.log("=== validate-binary-market ===");
  console.log(`MARKET_MODE=${config.marketMode}`);
  console.log(
    `selector: kind=${sel.selectorKind} value=${sel.selectorValue || "(empty)"} env=${sel.sourceEnvKey || "n/a"} executionMode=${sel.executionMode}`
  );

  if (sel.executionMode !== "gamma") {
    console.error(
      "[validate-binary-market] No Gamma execution path in env (expected for the default synthetic lab). Set BINARY_MARKET_SLUG, BINARY_MARKET_ID, or BINARY_CONDITION_ID, or AUTO_DISCOVER_BINARY_MARKET=true with MARKET_MODE=binary. This CLI only validates Gamma — use `npm run monitor` for synthetic execution."
    );
    process.exit(2);
  }

  const feed = new BinaryMarketFeed();
  const ok = await feed.bootstrapRest();
  const res = feed.getLastGammaResolve();

  if (res !== null) {
    console.log("\n--- HTTP steps ---\n" + formatGammaBootstrapStepsForLog(res.steps));
    console.log("\n--- resolution ---");
    console.log(JSON.stringify(res.resolution, null, 2));
  }

  if (!ok || res === null || res.row === null || res.quote === null) {
    console.error("\nBOOK_VALID: false");
    const reason =
      res !== null && res.resolution.kind === "failed"
        ? res.resolution.reason
        : (res?.parseFailure ?? "bootstrap_failed");
    console.error(`REASON: ${reason}`);
    process.exit(1);
  }

  const row = res.row;
  const quote = res.quote;
  const bestBid = asNumber(row["bestBid"]);
  const bestAsk = asNumber(row["bestAsk"]);
  const tokens = parseGammaJsonStringArray(row["clobTokenIds"]);
  const outcomeLabels = parseGammaJsonStringArray(row["outcomes"]);
  const outcomePricesRaw = parseGammaJsonNumberArray(row["outcomePrices"]);

  console.log("\n--- market ---");
  console.log(`title: ${quote.question}`);
  console.log(`market_id: ${quote.marketId}`);
  console.log(`slug: ${quote.slug}`);
  console.log(`conditionId: ${quote.conditionId ?? "null"}`);
  console.log(`active: ${quote.active}  closed: ${quote.closed}`);
  console.log(
    `Gamma bestBid: ${bestBid ?? "null"}  bestAsk: ${bestAsk ?? "null"} (null → bot uses synthetic spread around YES mid)`
  );
  console.log(`outcomes (Gamma): ${outcomeLabels === null ? "null/unparseable" : outcomeLabels.join(" | ")}`);
  if (outcomeLabels !== null && outcomePricesRaw !== null) {
    const pairs = outcomeLabels.map((lbl, i) => {
      const p = outcomePricesRaw[i];
      return `${lbl}=${p === undefined ? "?" : String(p)}`;
    });
    console.log(`outcomePrices (paired): ${pairs.join("  ")}`);
  } else if (outcomePricesRaw !== null) {
    console.log(`outcomePrices (raw): ${outcomePricesRaw.join(", ")}`);
  }
  console.log(`mapped YES/NO mid → yes=${quote.yesPrice} no=${quote.noPrice}`);
  console.log(
    `clobTokenIds (${tokens === null ? "null" : String(tokens.length)}): ${tokens === null ? "unparseable" : `${tokens.slice(0, 2).join(", ")}${tokens.length > 2 ? ", …" : ""}`}`
  );

  const suit = assessTradingSuitability(row);
  console.log("\n--- trading suitability (heuristic) ---");
  console.log(`suitable: ${suit.suitable}`);
  for (const c of suit.checks) {
    console.log(`  ${c.ok ? "OK" : "NO"}  ${c.name}${c.detail ? ` — ${c.detail}` : ""}`);
  }

  console.log("\n--- executable book (monitor gate) ---");
  const b = feed.getNormalizedBook();
  const bookInvalid = feed.describeExecutableBookInvalidReason();
  if (b === null) {
    console.log("BOOK_VALID: false (null book after bootstrap)");
  } else {
    console.log(
      `mid=${b.midPrice} bid=${b.bestBid} ask=${b.bestAsk} spreadBps=${Number.isFinite(b.spreadBps) ? b.spreadBps.toFixed(2) : "NaN"}`
    );
    console.log(`BOOK_VALID: ${bookInvalid === null ? "true" : "false"}`);
    if (bookInvalid !== null) console.log(`REASON: ${bookInvalid}`);
  }

  const closed =
    quote.closed === true ||
    (typeof row["closed"] === "boolean" && row["closed"] === true);
  const bookOk = bookInvalid === null && b !== null;

  const exitReasons: string[] = [];
  if (closed) exitReasons.push("closed_market");
  if (!bookOk) exitReasons.push(bookInvalid ?? "invalid_or_missing_book");
  if (!suit.suitable) exitReasons.push("trading_suitability_failed");

  const marketValid = exitReasons.length === 0;
  console.log("\n--- result ---");
  console.log(`MARKET_VALID: ${marketValid}`);
  if (!marketValid) {
    console.log(`EXIT_REASONS: ${exitReasons.join("; ")}`);
  }

  const norm = buildNormalizedMonitorConfigSummary(config, configMeta);
  console.log("\n--- normalizedConfig (same shape as session-summary.json) ---");
  console.log(JSON.stringify(norm, null, 2));

  process.exit(marketValid ? 0 : 1);
}

void main().catch((e) => {
  console.error("[validate-binary-market] fatal:", e);
  process.exit(1);
});
