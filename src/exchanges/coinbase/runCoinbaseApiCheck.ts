import "../../config/loadEnv.js";

import { EnvConfigError, readCoinbaseExchangeConfig, readLiveSafetyConfig } from "../../config/env.js";
import {
  CoinbaseApiError,
  CoinbaseClient,
  maskSecret,
  type CoinbaseProduct,
} from "./coinbaseClient.js";

function formatNumber(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) return value.toString();
  if (typeof value === "string" && value.trim().length > 0) return value;
  return "n/a";
}

function pickDiscoveredProductId(
  client: CoinbaseClient,
  products: CoinbaseProduct[],
  configuredProductId?: string
): string {
  const configured = configuredProductId?.trim();
  if (configured) return configured;
  const discovered = client.pickDiscoveryProduct(products);
  if (!discovered) {
    throw new Error("Unable to discover a Coinbase product id from listProducts().");
  }
  return discovered;
}

async function main(): Promise<void> {
  const exchange = readCoinbaseExchangeConfig();
  const liveSafety = readLiveSafetyConfig();
  const client = new CoinbaseClient(exchange);

  console.log(`baseUrl used: ${exchange.baseUrl}`);
  console.log(`exchange=coinbase`);
  console.log(`derivatives=${exchange.derivativesEnabled ? "enabled" : "disabled"}`);
  console.log(`apiKeyName=${maskSecret(exchange.apiKeyName)}`);

  if (liveSafety.liveTradingEnabled !== false) {
    console.log(`LIVE_TRADING_ENABLED=${String(liveSafety.liveTradingEnabled)}`);
  } else {
    console.log("LIVE_TRADING_ENABLED=false confirmed");
  }

  const serverTime = await client.getServerTime();
  console.log(
    `server time ok: iso=${serverTime.iso ?? "n/a"} epochMillis=${serverTime.epochMillis ?? "n/a"}`
  );

  try {
    const accounts = await client.listAccounts();
    console.log(`account read ok: accounts=${accounts.accounts?.length ?? 0}`);
  } catch (error) {
    if (error instanceof CoinbaseApiError) {
      console.log(
        `account read unavailable: status=${error.status} body=${error.responseSummary ?? error.responseBody}`
      );
    } else if (error instanceof Error) {
      console.log(`account read unavailable: ${error.message}`);
    } else {
      console.log("account read unavailable: unknown error");
    }
  }

  const productList = await client.listProducts(
    exchange.derivativesEnabled
      ? {
          productType: "FUTURE",
          contractExpiryType: "PERPETUAL",
          limit: 100,
        }
      : { limit: 100 }
  );
  const products = productList.products ?? [];
  console.log(`products ok: count=${products.length}`);

  const productId = pickDiscoveredProductId(client, products, exchange.productId);
  console.log(`selected productId=${productId}`);

  const product = await client.getProduct(productId);
  console.log(
    `product details ok: product_id=${product.product_id} product_type=${product.product_type ?? "n/a"}`
  );

  const productBook = await client.getProductBook(productId);
  const book = productBook.pricebook;
  const bestBid = book?.bids?.[0]?.price;
  const bestAsk = book?.asks?.[0]?.price;
  console.log(
    `product book ok: bestBid=${bestBid ?? "n/a"} bestAsk=${bestAsk ?? "n/a"} spreadBps=${
      productBook.spread_bps ?? "n/a"
    }`
  );

  const bestBidAsk = await client.getBestBidAsk([productId]);
  const pricebook = bestBidAsk.pricebooks?.find((entry) => entry.product_id === productId) ??
    bestBidAsk.pricebooks?.[0];
  console.log(
    `best bid ask ok: bestBid=${pricebook?.bids?.[0]?.price ?? "n/a"} bestAsk=${
      pricebook?.asks?.[0]?.price ?? "n/a"
    }`
  );

  const feeSchedule = await client.getFeeSchedule();
  console.log(
    `fees ok: source=${feeSchedule.source} maker=${formatNumber(feeSchedule.makerFeeBps)}bps taker=${formatNumber(feeSchedule.takerFeeBps)}bps${feeSchedule.pricingTier ? ` tier=${feeSchedule.pricingTier}` : ""}`
  );

  try {
    const portfolios = await client.listPortfolios();
    console.log(`portfolio read ok: portfolios=${portfolios.portfolios?.length ?? 0}`);
  } catch (error) {
    if (error instanceof CoinbaseApiError) {
      console.log(
        `portfolio read unavailable: status=${error.status} body=${error.responseSummary ?? error.responseBody}`
      );
    } else if (error instanceof Error) {
      console.log(`portfolio read unavailable: ${error.message}`);
    } else {
      console.log("portfolio read unavailable: unknown error");
    }
  }

  if (exchange.derivativesEnabled) {
    try {
      const futuresPosition = await client.getFuturesPosition(productId);
      const positionCount =
        (Array.isArray(futuresPosition.positions) && futuresPosition.positions.length) ||
        (futuresPosition.position ? 1 : 0);
      console.log(`open position read ok: positions=${positionCount}`);
    } catch (error) {
      if (error instanceof CoinbaseApiError) {
        console.log(
          `open position read unavailable: status=${error.status} body=${error.responseSummary ?? error.responseBody}`
        );
      } else if (error instanceof Error) {
        console.log(`open position read unavailable: ${error.message}`);
      } else {
        console.log("open position read unavailable: unknown error");
      }
    }
  }
}

main().catch((error: unknown) => {
  if (error instanceof EnvConfigError) {
    console.error(error.message);
    if (error.issues.length > 0) {
      console.error(`issues: ${error.issues.join(", ")}`);
    }
  } else if (error instanceof CoinbaseApiError) {
    console.error(
      `${error.message}\nstatus=${error.status}\nbody=${error.responseSummary ?? error.responseBody}`
    );
  } else if (error instanceof Error) {
    console.error(error.message);
  } else {
    console.error(String(error));
  }
  process.exitCode = 1;
});
