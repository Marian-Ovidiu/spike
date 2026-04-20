import axios from "axios";
import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveGammaMarketForMonitor } from "./gammaMarketResolve.js";
import type { GammaMarketRow } from "./gammaMarketQuoteParse.js";

const childRow: GammaMarketRow = {
  id: "999001",
  conditionId: "0xabc",
  slug: "child-market-slug",
  question: "Child?",
  outcomes: "[\"Yes\", \"No\"]",
  outcomePrices: "[\"0.55\", \"0.45\"]",
  active: true,
  closed: false,
  updatedAt: "2026-04-20T08:00:00.000Z",
  clobTokenIds: "[\"1\", \"2\"]",
};

describe("resolveGammaMarketForMonitor", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses GET /markets/slug/{slug} for a direct market slug", async () => {
    const http = axios.create();
    const spy = vi.spyOn(http, "get").mockImplementation(async (url: string) => {
      expect(url).toContain("/markets/slug/my-market");
      return {
        status: 200,
        data: childRow,
      } as Awaited<ReturnType<typeof http.get>>;
    });

    const r = await resolveGammaMarketForMonitor({
      http,
      gammaBase: "https://gamma-api.polymarket.com",
      query: { type: "slug", value: "my-market" },
    });
    expect(spy).toHaveBeenCalled();
    expect(r.quote?.yesPrice).toBeCloseTo(0.55, 5);
    expect(r.resolution).toEqual({ kind: "gamma_markets_by_slug_path", slug: "my-market" });
  });

  it("falls back to event slug when /markets/slug returns 404", async () => {
    const http = axios.create();
    vi.spyOn(http, "get").mockImplementation(async (url: string) => {
      if (url.includes("/markets/slug/event-only")) {
        return { status: 404, data: null } as Awaited<ReturnType<typeof http.get>>;
      }
      if (url.includes("/events/slug/event-only")) {
        return {
          status: 200,
          data: {
            id: "ev1",
            title: "Parent event",
            slug: "event-only",
            markets: [childRow],
          },
        } as Awaited<ReturnType<typeof http.get>>;
      }
      throw new Error(`unexpected url ${url}`);
    });

    const r = await resolveGammaMarketForMonitor({
      http,
      gammaBase: "https://gamma-api.polymarket.com",
      query: { type: "slug", value: "event-only" },
    });
    expect(r.resolution.kind).toBe("gamma_event_slug_nested_market");
    if (r.resolution.kind === "gamma_event_slug_nested_market") {
      expect(r.resolution.eventSlug).toBe("event-only");
      expect(r.resolution.marketSlug).toBe("child-market-slug");
    }
    expect(r.quote?.marketId).toBe("999001");
  });

  it("uses CLOB then Gamma slug for condition_id", async () => {
    const http = axios.create();
    vi.spyOn(http, "get").mockImplementation(async (url: string) => {
      if (url.startsWith("https://clob.polymarket.com/markets/0xcond")) {
        return {
          status: 200,
          data: { market_slug: "resolved-from-clob" },
        } as Awaited<ReturnType<typeof http.get>>;
      }
      if (url.includes("/markets/slug/resolved-from-clob")) {
        return { status: 200, data: childRow } as Awaited<ReturnType<typeof http.get>>;
      }
      throw new Error(`unexpected url ${url}`);
    });

    const r = await resolveGammaMarketForMonitor({
      http,
      gammaBase: "https://gamma-api.polymarket.com",
      query: { type: "condition_id", value: "0xcond" },
      clobBaseUrl: "https://clob.polymarket.com",
    });
    expect(r.resolution.kind).toBe("clob_condition_then_gamma_slug");
    expect(r.quote).not.toBeNull();
  });
});
