import "../../config/loadEnv.js";

import {
  createBinanceFuturesClient,
  resolveBinanceFuturesClientOptionsFromEnv,
} from "./binanceFuturesClient.js";
import { readLiveSafetyConfig } from "../../config/env.js";

function formatMaybeNumber(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "n/a";
  return value.toString();
}

async function main(): Promise<void> {
  if (readLiveSafetyConfig().liveTradingEnabled) {
    throw new Error(
      "LIVE_TRADING_ENABLED must be false for the Binance Futures API check. This runner is read-only and will not submit orders."
    );
  }

  const client = createBinanceFuturesClient(resolveBinanceFuturesClientOptionsFromEnv());

  console.log(`baseUrl used: ${client.getBaseUrl()}`);
  const serverTime = await client.getServerTime();
  console.log(`server time ok: ${new Date(serverTime.serverTime).toISOString()} (${serverTime.serverTime})`);

  const exchangeInfo = await client.getExchangeInfo();
  console.log(
    `exchangeInfo ok: timezone=${exchangeInfo.timezone}, symbols=${exchangeInfo.symbols.length}`
  );

  const btcFilters = await client.getSymbolFilters("BTCUSDT");
  if (!btcFilters) {
    throw new Error("BTCUSDT not found in exchangeInfo");
  }
  console.log(
    `BTCUSDT filters: tickSize=${formatMaybeNumber(btcFilters.tickSize)}, stepSize=${formatMaybeNumber(btcFilters.stepSize)}, minQty=${formatMaybeNumber(btcFilters.minQty)}, minNotional=${formatMaybeNumber(btcFilters.minNotional)}`
  );

  const account = await client.getAccountInfo();
  console.log(
    `account read ok: assets=${account.assets.length}, positions=${account.positions.length}, canTrade=${account.canTrade}`
  );

  const balances = await client.getBalances();
  console.log("balances synthetic:");
  for (const balance of balances) {
    console.log(
      `  ${balance.asset}: wallet=${balance.walletBalance}, available=${balance.availableBalance}, unrealized=${balance.unrealizedProfit}, margin=${balance.marginBalance}`
    );
  }

  const openPositions = await client.getOpenPositions();
  console.log("open positions synthetic:");
  if (openPositions.length === 0) {
    console.log("  none");
  } else {
    for (const position of openPositions) {
      console.log(
        `  ${position.symbol} ${position.positionSide}: amt=${position.positionAmt}, entry=${position.entryPrice}, mark=${position.markPrice}, pnl=${position.unrealizedProfit}, lev=${position.leverage}`
      );
    }
  }

  console.log("LIVE_TRADING_ENABLED=false confirmed");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
