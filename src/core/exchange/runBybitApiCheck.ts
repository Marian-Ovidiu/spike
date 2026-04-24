import "../../config/loadEnv.js";

import {
  createBybitClient,
  resolveBybitClientOptionsFromEnv,
} from "./bybitClient.js";
import { readLiveSafetyConfig } from "../../config/env.js";

function formatMaybeNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "n/a";
  return String(value);
}

async function main(): Promise<void> {
  if (readLiveSafetyConfig().liveTradingEnabled) {
    throw new Error(
      "LIVE_TRADING_ENABLED must be false for the Bybit API check. This runner is read-only and will not submit orders."
    );
  }

  const client = createBybitClient(resolveBybitClientOptionsFromEnv());

  console.log(`baseUrl used: ${client.getBaseUrl()}`);
  const marketTime = await client.getMarketTime();
  console.log(
    `market time ok: ${new Date(marketTime.timeSecond * 1000).toISOString()} (${marketTime.timeSecond}${marketTime.timeNano ? `, nano=${marketTime.timeNano}` : ""})`
  );

  const instrumentInfo = await client.getInstrumentsInfo();
  console.log(
    `instrument info ok: category=${instrumentInfo.category}, symbols=${instrumentInfo.list.length}`
  );

  const btcFilters = await client.getInstrumentFilters();
  if (!btcFilters) {
    throw new Error("BTCUSDT not found in instruments-info");
  }
  console.log(
    `BTCUSDT filters: tickSize=${formatMaybeNumber(btcFilters.tickSize)}, qtyStep=${formatMaybeNumber(btcFilters.qtyStep)}, minOrderQty=${formatMaybeNumber(btcFilters.minOrderQty)}, minNotionalValue=${formatMaybeNumber(btcFilters.minNotionalValue)}`
  );

  const walletBalance = await client.getWalletBalance();
  console.log(
    `wallet balance read ok: accounts=${walletBalance.length}`
  );
  for (const account of walletBalance) {
    console.log(
      `  ${account.accountType}: totalWalletBalance=${formatMaybeNumber(account.totalWalletBalance)}, totalEquity=${formatMaybeNumber(account.totalEquity)}, totalAvailableBalance=${formatMaybeNumber(account.totalAvailableBalance)}, coins=${account.coins.length}`
    );
  }

  const openPositions = await client.getOpenPositions();
  console.log(`open position read ok: positions=${openPositions.length}`);
  if (openPositions.length === 0) {
    console.log("  none");
  } else {
    for (const position of openPositions) {
      console.log(
        `  ${position.symbol} ${position.side}: size=${formatMaybeNumber(position.size)}, avgPrice=${formatMaybeNumber(position.avgPrice)}, markPrice=${formatMaybeNumber(position.markPrice)}, pnl=${formatMaybeNumber(position.unrealisedPnl)}`
      );
    }
  }

  console.log("LIVE_TRADING_ENABLED=false confirmed");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
