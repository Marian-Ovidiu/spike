import axios from "axios";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  classifyBtc5mEmbedDiscovery,
  discoverActiveBtc5mUpDownMarket,
  embedMatchesBitcoinUpDown5mDiscovery,
  hasManualGammaSelectorBlockingAutoDiscover,
  isLikelyBtc5mUpDownMarket,
  parseBtcRolling5mWindowFromSlug,
  relaxedBtc5mTextMatch,
  resetBinaryAutoDiscoveryStateForTests,
} from "./discoverBtc5mUpDownMarket.js";
import type { GammaMarketRow } from "./gammaMarketQuoteParse.js";

describe("isLikelyBtc5mUpDownMarket", () => {
  it("matches slug-style btc 5m updown", () => {
    const row: GammaMarketRow = {
      slug: "btc-updown-5m-123",
      question: "",
    };
    expect(isLikelyBtc5mUpDownMarket(row)).toBe(true);
  });

  it("matches question-style bitcoin 5 minute up or down", () => {
    const row: GammaMarketRow = {
      slug: "some-slug",
      question: "Bitcoin Up or Down - 5 minute window",
    };
    expect(isLikelyBtc5mUpDownMarket(row)).toBe(true);
  });

  it("rejects unrelated market", () => {
    const row: GammaMarketRow = {
      slug: "will-rain-tomorrow",
      question: "Will it rain?",
    };
    expect(isLikelyBtc5mUpDownMarket(row)).toBe(false);
  });
});

describe("embedMatchesBitcoinUpDown5mDiscovery", () => {
  /** `now` is before the window so `endDate` is still in the tradable future. */
  const now = Date.parse("2026-06-15T10:00:00.000Z");
  const start = new Date("2026-06-15T11:50:00.000Z").toISOString();
  const end = new Date("2026-06-15T11:55:00.000Z").toISOString();
  const rollingSlugEpoch = Math.trunc(Date.parse(start) / 1000);

  it("matches Bitcoin Up or Down copy with ~5m window", () => {
    const row: GammaMarketRow = {
      question: "Bitcoin Up or Down — June 15, 7:50AM-7:55AM ET",
      active: true,
      closed: false,
      startDate: start,
      endDate: end,
    };
    expect(embedMatchesBitcoinUpDown5mDiscovery(row, "Crypto 5m", now)).toBe(true);
  });

  it("matches when phrase is only on the parent event title", () => {
    const row: GammaMarketRow = {
      question: "June 15, 7:50AM-7:55AM ET",
      active: true,
      closed: false,
      startDate: start,
      endDate: end,
    };
    expect(embedMatchesBitcoinUpDown5mDiscovery(row, "Bitcoin Up or Down (5m)", now)).toBe(
      true
    );
  });

  it("rejects wrong duration", () => {
    const row: GammaMarketRow = {
      question: "Bitcoin Up or Down — long",
      active: true,
      closed: false,
      startDate: new Date("2026-06-15T10:00:00.000Z").toISOString(),
      endDate: new Date("2026-06-15T11:00:00.000Z").toISOString(),
    };
    expect(embedMatchesBitcoinUpDown5mDiscovery(row, "", now)).toBe(false);
  });

  it("matches rolling slug btc-updown-5m without full headline in question", () => {
    const row: GammaMarketRow = {
      slug: `btc-updown-5m-${rollingSlugEpoch}`,
      question: "7:50AM-7:55AM ET",
      active: true,
      closed: false,
      startDate: start,
      endDate: end,
    };
    expect(embedMatchesBitcoinUpDown5mDiscovery(row, "", now)).toBe(true);
  });
});

describe("parseBtcRolling5mWindowFromSlug", () => {
  it("reads window start from slug epoch seconds", () => {
    const w = parseBtcRolling5mWindowFromSlug("btc-updown-5m-1776776400");
    expect(w).not.toBeNull();
    expect(w!.startMs).toBe(1776776400 * 1000);
    expect(w!.endMs - w!.startMs).toBe(5 * 60_000);
  });

  it("returns null for non-rolling test slugs", () => {
    expect(parseBtcRolling5mWindowFromSlug("btc-updown-5m-good")).toBeNull();
  });
});

describe("classifyBtc5mEmbedDiscovery", () => {
  const now = Date.parse("2026-06-15T10:00:00.000Z");
  const start = new Date("2026-06-15T11:50:00.000Z").toISOString();
  const end = new Date("2026-06-15T11:55:00.000Z").toISOString();
  const rollingSlugEpoch = Math.trunc(Date.parse(start) / 1000);

  it("uses slug epoch for duration when Gamma row dates span listing lifetime", () => {
    const row: GammaMarketRow = {
      slug: "btc-updown-5m-1776776400",
      question: "Bitcoin Up or Down - April 21, 9:00AM-9:05AM ET",
      active: true,
      closed: false,
      startDate: "2026-04-20T13:08:48.697659Z",
      endDate: "2026-04-21T13:05:00Z",
    };
    const tMid = Date.parse("2026-04-21T13:02:00.000Z");
    expect(classifyBtc5mEmbedDiscovery(row, "", "", tMid)).toBe("candidate");
  });

  it("treats missing active as tradeable when slug matches and row is not explicitly closed", () => {
    const row: GammaMarketRow = {
      slug: `btc-updown-5m-${rollingSlugEpoch}`,
      question: "7:50AM-7:55AM ET",
      closed: false,
      startDate: start,
      endDate: end,
    };
    expect(classifyBtc5mEmbedDiscovery(row, "", "", now)).toBe("candidate");
  });

  it("still rejects explicitly closed embeds", () => {
    const row: GammaMarketRow = {
      slug: `btc-updown-5m-${rollingSlugEpoch}`,
      question: "7:50AM-7:55AM ET",
      active: true,
      closed: true,
      startDate: start,
      endDate: end,
    };
    expect(classifyBtc5mEmbedDiscovery(row, "", "", now)).toBe("fail_active_closed");
  });
});

describe("relaxedBtc5mTextMatch", () => {
  it("matches slug prefix alone", () => {
    expect(relaxedBtc5mTextMatch("btc-updown-5m-xyz", "")).toBe(true);
  });

  it("matches bitcoin + up or down in haystack", () => {
    expect(relaxedBtc5mTextMatch("other-slug", "Something about Bitcoin up or down here")).toBe(
      true
    );
  });

  it("rejects bitcoin without up/down", () => {
    expect(relaxedBtc5mTextMatch("x", "Bitcoin will moon")).toBe(false);
  });
});

describe("hasManualGammaSelectorBlockingAutoDiscover", () => {
  const keys = [
    "BINARY_MARKET_ID",
    "BINARY_MARKET_SLUG",
    "BINARY_CONDITION_ID",
    "POLYMARKET_MARKET_ID",
    "POLYMARKET_MARKET_SLUG",
    "POLYMARKET_CONDITION_ID",
  ] as const;
  const saved: Partial<Record<(typeof keys)[number], string | undefined>> = {};

  afterEach(() => {
    for (const k of keys) {
      if (saved[k] !== undefined) process.env[k] = saved[k];
      else delete process.env[k];
    }
  });

  it("ignores BINARY_MARKET_SLUG", () => {
    for (const k of keys) saved[k] = process.env[k];
    process.env.BINARY_MARKET_SLUG = "some-slug";
    delete process.env.BINARY_MARKET_ID;
    delete process.env.BINARY_CONDITION_ID;
    expect(hasManualGammaSelectorBlockingAutoDiscover()).toBe(false);
  });

  it("is true when BINARY_MARKET_ID is set", () => {
    for (const k of keys) saved[k] = process.env[k];
    process.env.BINARY_MARKET_ID = "42";
    expect(hasManualGammaSelectorBlockingAutoDiscover()).toBe(true);
  });
});

describe("discoverActiveBtc5mUpDownMarket", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    resetBinaryAutoDiscoveryStateForTests();
  });

  function bookSide(bid: string, ask: string) {
    return {
      status: 200,
      data: {
        bids: [{ price: bid }],
        asks: [{ price: ask }],
      },
    };
  }

  it("selects a market from GET /events?active=true&closed=false&limit=100 pipeline", async () => {
    const startMs = Date.now() + 15 * 60_000;
    const endMs = startMs + 5 * 60_000;
    const embed: GammaMarketRow = {
      id: "9001",
      slug: "btc-updown-5m-good",
      question: "Bitcoin Up or Down — 5 minutes",
      active: true,
      closed: false,
      startDate: new Date(startMs).toISOString(),
      endDate: new Date(endMs).toISOString(),
    };
    const resolved: GammaMarketRow = {
      ...embed,
      conditionId: "0x1",
      outcomes: '["Up","Down"]',
      acceptingOrders: true,
      enableOrderBook: true,
      clobTokenIds: '["10","11"]',
    };

    const http = axios.create();
    vi.spyOn(http, "get").mockImplementation(async (url: string) => {
      if (url.includes("/events?active=true&closed=false")) {
        expect(url).toContain("limit=100");
        return {
          status: 200,
          data: [
            {
              id: "ev1",
              title: "Other",
              markets: [embed],
            },
          ],
        } as Awaited<ReturnType<typeof http.get>>;
      }
      if (url.includes("/markets/slug/btc-updown-5m-good")) {
        return { status: 200, data: resolved } as Awaited<ReturnType<typeof http.get>>;
      }
      if (url.includes("token_id=10")) {
        return bookSide("0.49", "0.51") as Awaited<ReturnType<typeof http.get>>;
      }
      if (url.includes("token_id=11")) {
        return bookSide("0.48", "0.52") as Awaited<ReturnType<typeof http.get>>;
      }
      throw new Error(`unexpected url ${url}`);
    });

    const d = await discoverActiveBtc5mUpDownMarket({
      http,
      gammaBaseUrl: "https://gamma-api.polymarket.com",
      limit: 100,
    });
    expect(d).not.toBeNull();
    expect(d!.slug).toBe("btc-updown-5m-good");
    expect(d!.marketId).toBe("9001");
    expect(d!.tokenIds).toEqual(["10", "11"]);
    expect(d!.validationResult).toContain("PASS");
  });

  it("prefers later startDate when spreads tie-break", async () => {
    const base = Date.now() + 20 * 60_000;
    const mkEmbed = (id: string, slug: string, offsetMin: number) => {
      const startMs = base + offsetMin * 60_000;
      const endMs = startMs + 5 * 60_000;
      return {
        id,
        slug,
        question: "Bitcoin Up or Down — window",
        active: true,
        closed: false,
        startDate: new Date(startMs).toISOString(),
        endDate: new Date(endMs).toISOString(),
      } satisfies GammaMarketRow;
    };
    const early = mkEmbed("1", "btc-early", 0);
    const late = mkEmbed("2", "btc-late", 30);

    const http = axios.create();
    vi.spyOn(http, "get").mockImplementation(async (url: string) => {
      if (url.includes("/events?")) {
        return {
          status: 200,
          data: [{ id: "ev", title: "X", markets: [early, late] }],
        } as Awaited<ReturnType<typeof http.get>>;
      }
      if (url.includes("/markets/slug/btc-early")) {
        return {
          status: 200,
          data: {
            ...early,
            conditionId: "0xa",
            outcomes: '["Up","Down"]',
            acceptingOrders: true,
            enableOrderBook: true,
            clobTokenIds: '["10","11"]',
          },
        } as Awaited<ReturnType<typeof http.get>>;
      }
      if (url.includes("/markets/slug/btc-late")) {
        return {
          status: 200,
          data: {
            ...late,
            conditionId: "0xb",
            outcomes: '["Up","Down"]',
            acceptingOrders: true,
            enableOrderBook: true,
            clobTokenIds: '["20","21"]',
          },
        } as Awaited<ReturnType<typeof http.get>>;
      }
      if (url.includes("token_id=10") || url.includes("token_id=20")) {
        return bookSide("0.49", "0.51") as Awaited<ReturnType<typeof http.get>>;
      }
      if (url.includes("token_id=11") || url.includes("token_id=21")) {
        return bookSide("0.49", "0.51") as Awaited<ReturnType<typeof http.get>>;
      }
      throw new Error(`unexpected url ${url}`);
    });

    const d = await discoverActiveBtc5mUpDownMarket({
      http,
      gammaBaseUrl: "https://gamma-api.polymarket.com",
    });
    expect(d!.slug).toBe("btc-late");
  });

  it("falls back to GET /markets when /events embed scan finds nothing", async () => {
    const startMs = Date.now() + 25 * 60_000;
    const endMs = startMs + 5 * 60_000;
    const flat: GammaMarketRow = {
      id: "77001",
      slug: "btc-updown-5m-flatonly",
      question: "7:50AM-7:55AM ET",
      active: true,
      closed: false,
      startDate: new Date(startMs).toISOString(),
      endDate: new Date(endMs).toISOString(),
    };
    const resolved: GammaMarketRow = {
      ...flat,
      conditionId: "0xcafe",
      outcomes: '["Up","Down"]',
      acceptingOrders: true,
      enableOrderBook: true,
      clobTokenIds: '["30","31"]',
    };

    const http = axios.create();
    vi.spyOn(http, "get").mockImplementation(async (url: string) => {
      if (url.includes("/events?active=true&closed=false")) {
        return { status: 200, data: [{ id: "ev0", title: "Unrelated", markets: [] }] };
      }
      if (url.includes("/markets?active=true&closed=false")) {
        return { status: 200, data: [flat] };
      }
      if (url.includes("/markets/slug/btc-updown-5m-flatonly")) {
        return { status: 200, data: resolved };
      }
      if (url.includes("token_id=30") || url.includes("token_id=31")) {
        return bookSide("0.49", "0.51") as Awaited<ReturnType<typeof http.get>>;
      }
      throw new Error(`unexpected url ${url}`);
    });

    const d = await discoverActiveBtc5mUpDownMarket({
      http,
      gammaBaseUrl: "https://gamma-api.polymarket.com",
      marketsFallbackMaxPages: 1,
    });
    expect(d).not.toBeNull();
    expect(d!.slug).toBe("btc-updown-5m-flatonly");
  });
});
