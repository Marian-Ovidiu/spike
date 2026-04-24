import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CoinbaseFuturesFeedError,
  createCoinbaseFuturesMarketFeed,
} from "./coinbaseFuturesFeed.js";
import {
  createDefaultFuturesMarketFeed,
  resolveFuturesExchangeFromEnv,
} from "./futuresFeed.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("Coinbase futures feed", () => {
  it("resolves coinbase from env and boots with public reads only", async () => {
    vi.stubEnv("FUTURES_EXCHANGE", "coinbase");
    vi.stubEnv("TRADING_MODE", "public_paper");
    vi.stubEnv("COINBASE_PRODUCT_ID", "BTC-PERP");

    const requests: Array<{ url: string; headers: HeadersInit | undefined }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push({ url: String(input), headers: init?.headers });
        const url = String(input);
        if (url.includes("/time")) {
          return new Response(JSON.stringify({ iso: "2026-04-24T00:00:00Z" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (url.includes("/market/product_book")) {
          return new Response(
            JSON.stringify({
              pricebook: {
                product_id: "BTC-PERP",
                bids: [{ price: "94999.50", size: "1" }],
                asks: [{ price: "95000.50", size: "1" }],
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          );
        }
        if (url.includes("/market/products/") && url.endsWith("/ticker")) {
          return new Response(
            JSON.stringify({
              price: "95000",
              best_bid: "94999.50",
              best_ask: "95000.50",
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          );
        }
        throw new Error(`Unexpected request: ${url}`);
      })
    );

    const feed = createDefaultFuturesMarketFeed();
    expect(resolveFuturesExchangeFromEnv()).toBe("coinbase");
    expect(feed.implementationKind).toBe("coinbase_public");
    expect(feed.contract.venueSymbol.code).toBe("BTC-PERP");
    expect(feed.contract.venueSymbol.venue).toBe("coinbase_cfm_perp");

    const ok = await feed.bootstrapRest();
    expect(ok).toBe(true);
    expect(feed.getExecutionBook()?.midPrice).toBeCloseTo(95000);
    expect(requests.some((request) => request.url.includes("/api/v3/brokerage/products/"))).toBe(
      false
    );
    expect(requests.every((request) => !String(request.headers ?? "").includes("Authorization"))).toBe(true);
  });

  it("fails fast when COINBASE_PRODUCT_ID is missing", () => {
    vi.stubEnv("FUTURES_EXCHANGE", "coinbase");
    vi.stubEnv("TRADING_MODE", "public_paper");
    vi.stubEnv("COINBASE_PRODUCT_ID", "");

    expect(() => createDefaultFuturesMarketFeed()).toThrowError(
      CoinbaseFuturesFeedError
    );
    expect(() => createCoinbaseFuturesMarketFeed()).toThrowError(
      /Missing COINBASE_PRODUCT_ID/
    );
  });

  it("authenticated_paper can still use brokerage endpoints when configured", async () => {
    vi.stubEnv("FUTURES_EXCHANGE", "coinbase");
    vi.stubEnv("TRADING_MODE", "authenticated_paper");
    vi.stubEnv("COINBASE_API_KEY_NAME", "organizations/test/apiKeys/test");
    vi.stubEnv("COINBASE_API_PRIVATE_KEY", "-----BEGIN EC PRIVATE KEY-----\nabc\n-----END EC PRIVATE KEY-----");
    vi.stubEnv("COINBASE_PRODUCT_ID", "BTC-PERP");

    const requests: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        requests.push(url);
        if (url.includes("/products/BTC-PERP")) {
          return new Response(
            JSON.stringify({
              product_id: "BTC-PERP",
              product_type: "FUTURE",
              contract_expiry_type: "PERPETUAL",
              quote_increment: "0.01",
              base_increment: "0.001",
              base_min_size: "0.001",
              price: "95000",
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          );
        }
        if (url.includes("/product_book")) {
          return new Response(
            JSON.stringify({
              pricebook: {
                product_id: "BTC-PERP",
                bids: [{ price: "94999.50", size: "1" }],
                asks: [{ price: "95000.50", size: "1" }],
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          );
        }
        if (url.includes("/best_bid_ask")) {
          return new Response(
            JSON.stringify({
              pricebooks: [
                {
                  product_id: "BTC-PERP",
                  bids: [{ price: "94999.50", size: "1" }],
                  asks: [{ price: "95000.50", size: "1" }],
                },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          );
        }
        throw new Error(`Unexpected request: ${url}`);
      })
    );

    const feed = createDefaultFuturesMarketFeed();
    expect(await feed.bootstrapRest()).toBe(true);
    expect(requests.some((url) => url.includes("/api/v3/brokerage/products/BTC-PERP"))).toBe(true);
  });

  it("authenticated_paper requires Coinbase credentials", () => {
    vi.stubEnv("FUTURES_EXCHANGE", "coinbase");
    vi.stubEnv("TRADING_MODE", "authenticated_paper");
    vi.stubEnv("COINBASE_PRODUCT_ID", "BTC-PERP");

    expect(() => createDefaultFuturesMarketFeed()).toThrowError(
      /Missing Coinbase env: COINBASE_API_KEY_NAME, COINBASE_API_PRIVATE_KEY/
    );
  });
});
