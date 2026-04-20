import axios from "axios";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BinaryMarketFeed,
  evaluateBinaryQuoteStale,
  extractVenueUpdatedAtMs,
  parseGammaJsonStringArray,
  parseNormalizedBinaryQuoteFromGammaRow,
  type GammaMarketRow,
} from "./binaryMarketFeed.js";

const FIXTURE_ROW: GammaMarketRow = {
  id: "540816",
  conditionId: "0x9c1a953fe92c8357f1b646ba25d983aa83e90c525992db14fb726fa895cb5763",
  slug: "test-market-slug",
  question: "Will tests pass?",
  outcomes: "[\"Yes\", \"No\"]",
  outcomePrices: "[\"0.6\", \"0.4\"]",
  volume: "1234.5",
  volumeNum: 1234.5,
  active: true,
  closed: false,
  updatedAt: "2026-04-20T08:00:00.000Z",
};

describe("parseNormalizedBinaryQuoteFromGammaRow", () => {
  it("extracts metadata and YES/NO prices", () => {
    const observedAt = Date.parse("2026-04-20T09:00:00.000Z");
    const q = parseNormalizedBinaryQuoteFromGammaRow(FIXTURE_ROW, observedAt);
    expect(q).not.toBeNull();
    expect(q!.marketId).toBe("540816");
    expect(q!.slug).toBe("test-market-slug");
    expect(q!.question).toBe("Will tests pass?");
    expect(q!.yesPrice).toBe(0.6);
    expect(q!.noPrice).toBe(0.4);
    expect(q!.volume).toBe(1234.5);
    expect(q!.active).toBe(true);
    expect(q!.closed).toBe(false);
    expect(q!.conditionId).toBe(
      "0x9c1a953fe92c8357f1b646ba25d983aa83e90c525992db14fb726fa895cb5763"
    );
    expect(q!.venueUpdatedAtMs).toBe(Date.parse("2026-04-20T08:00:00.000Z"));
    expect(q!.quoteAgeMs).toBe(60 * 60 * 1000);
  });

  it("maps NO/YES outcome order to YES/NO prices", () => {
    const row: GammaMarketRow = {
      ...FIXTURE_ROW,
      outcomes: "[\"No\", \"Yes\"]",
      outcomePrices: "[\"0.35\", \"0.65\"]",
      updatedAt: "2026-04-20T10:00:00.000Z",
    };
    const q = parseNormalizedBinaryQuoteFromGammaRow(row, Date.parse("2026-04-20T10:00:01.000Z"));
    expect(q!.yesPrice).toBe(0.65);
    expect(q!.noPrice).toBe(0.35);
  });
});

describe("extractVenueUpdatedAtMs", () => {
  it("parses ISO updatedAt", () => {
    expect(extractVenueUpdatedAtMs(FIXTURE_ROW)).toBe(Date.parse("2026-04-20T08:00:00.000Z"));
  });

  it("returns null when missing", () => {
    expect(extractVenueUpdatedAtMs({})).toBeNull();
  });
});

describe("parseGammaJsonStringArray", () => {
  it("parses JSON-encoded outcomes", () => {
    expect(parseGammaJsonStringArray("[\"Yes\", \"No\"]")).toEqual(["Yes", "No"]);
  });
});

describe("evaluateBinaryQuoteStale", () => {
  it("flags stale when venue quote age exceeds max", () => {
    const now = Date.parse("2026-04-20T12:00:00.000Z");
    const quote = parseNormalizedBinaryQuoteFromGammaRow(
      { ...FIXTURE_ROW, updatedAt: "2026-04-20T08:00:00.000Z" },
      now
    )!;
    const r = evaluateBinaryQuoteStale({
      quote,
      lastPollSuccessObservedAtMs: now - 1000,
      nowMs: now,
      maxQuoteAgeMs: 60_000,
      maxSilenceMs: 120_000,
    });
    expect(r.stale).toBe(true);
    expect(r.reason).toContain("venue_quote_age");
  });

  it("flags stale when poll silence exceeds max", () => {
    const now = 1_000_000;
    const quote = parseNormalizedBinaryQuoteFromGammaRow(
      { ...FIXTURE_ROW, updatedAt: new Date(now - 1000).toISOString() },
      now
    )!;
    const r = evaluateBinaryQuoteStale({
      quote,
      lastPollSuccessObservedAtMs: now - 400_000,
      nowMs: now,
      maxQuoteAgeMs: 500_000,
      maxSilenceMs: 120_000,
    });
    expect(r.stale).toBe(true);
    expect(r.reason).toContain("poll_silence");
  });

  it("not stale when fresh venue and recent poll", () => {
    const now = Date.parse("2026-04-20T12:00:00.000Z");
    const quote = parseNormalizedBinaryQuoteFromGammaRow(
      { ...FIXTURE_ROW, updatedAt: new Date(now - 5000).toISOString() },
      now
    )!;
    const r = evaluateBinaryQuoteStale({
      quote,
      lastPollSuccessObservedAtMs: now - 2000,
      nowMs: now,
      maxQuoteAgeMs: 120_000,
      maxSilenceMs: 60_000,
    });
    expect(r.stale).toBe(false);
    expect(r.reason).toBeNull();
  });
});

describe("BinaryMarketFeed", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("bootstrapRest fills quote and executable book from mocked Gamma HTTP", async () => {
    const http = axios.create();
    vi.spyOn(http, "get").mockResolvedValue({
      status: 200,
      data: [FIXTURE_ROW],
    } as Awaited<ReturnType<typeof http.get>>);

    const feed = new BinaryMarketFeed({
      slug: "test-market-slug",
      http,
      pollIntervalMs: 60_000,
    });
    const ok = await feed.bootstrapRest();
    expect(ok).toBe(true);
    expect(feed.getNormalizedBinaryQuote()?.yesPrice).toBe(0.6);
    const book = feed.getNormalizedBook();
    expect(book).not.toBeNull();
    expect(book!.midPrice).toBeCloseTo(0.6, 5);
  });

  it("uses Gamma bestBid/bestAsk when present", async () => {
    const row = {
      ...FIXTURE_ROW,
      bestBid: 0.58,
      bestAsk: 0.62,
    };
    const http = axios.create();
    vi.spyOn(http, "get").mockResolvedValue({
      status: 200,
      data: [row],
    } as Awaited<ReturnType<typeof http.get>>);

    const feed = new BinaryMarketFeed({
      slug: "x",
      http,
      pollIntervalMs: 60_000,
    });
    await feed.bootstrapRest();
    const book = feed.getNormalizedBook()!;
    expect(book.bestBid).toBe(0.58);
    expect(book.bestAsk).toBe(0.62);
    expect(book.midPrice).toBeCloseTo(0.6, 5);
  });
});
