/**
 * **Optional Gamma integration** — auto-pick of the active Polymarket **Bitcoin / BTC ~5-minute
 * Up or Down** market from Gamma when `AUTO_DISCOVER_BINARY_MARKET=true`.
 *
 * Primary feed: **`GET /events?active=true&closed=false&limit=100`**. If that yields no
 * candidates after relaxed matching, falls back to **`GET /markets?active=true&closed=false`**
 * (paginated) — `/events` often omits short-lived rows or nests incomplete `startDate`/`endDate`.
 *
 * When `AUTO_DISCOVER_BINARY_MARKET=true`, **`BINARY_MARKET_SLUG` is ignored** (only
 * `BINARY_MARKET_ID` / `BINARY_CONDITION_ID` block auto-pick). See
 * {@link hasManualGammaSelectorBlockingAutoDiscover}.
 */
import axios, { type AxiosInstance } from "axios";

import { assessTradingSuitability } from "./gammaMarketResolve.js";
import {
  diagnoseGammaRowParseFailure,
  parseNormalizedBinaryQuoteFromGammaRow,
  parseGammaJsonStringArray,
  type GammaMarketRow,
} from "./gammaMarketQuoteParse.js";
import {
  DEFAULT_CLOB_API_BASE,
  evaluateBothOutcomeClobBooks,
} from "./gammaClobOutcomePrices.js";
import type { MarketMode } from "../../market/types.js";

const DEFAULT_GAMMA_EVENTS_BASE = "https://gamma-api.polymarket.com";

/**
 * Path + query for Gamma `/events` discovery.
 * Uses **`order=volume&ascending=true`** so low-liquidity recurring windows (BTC ~5m Up/Down)
 * surface near the top; default ordering buries them past typical pagination limits.
 */
export function gammaBtc5mDiscoveryEventsUrl(baseNoTrailingSlash: string, limit: number): string {
  return `${baseNoTrailingSlash}/events?active=true&closed=false&limit=${limit}&order=volume&ascending=true`;
}

/** Paginated `/markets` fallback with the same volume ordering as {@link gammaBtc5mDiscoveryEventsUrl}. */
export function gammaMarketsListUrl(
  baseNoTrailingSlash: string,
  limit: number,
  offset: number
): string {
  return `${baseNoTrailingSlash}/markets?active=true&closed=false&limit=${limit}&offset=${offset}&order=volume&ascending=true`;
}

export type AutoDiscoveredBtc5mMarket = {
  slug: string;
  marketId: string;
  conditionId: string | null;
  /** Primary human label (usually `question`). */
  title: string;
  acceptingOrders: boolean | null;
  enableOrderBook: boolean | null;
  /** Both CLOB outcome token ids (same order as Gamma `clobTokenIds`). */
  tokenIds: [string, string];
  /** Short human-readable validation summary for banners / logs. */
  validationResult: string;
};

/** Counters from the last {@link discoverActiveBtc5mUpDownMarket} attempt (success or failure). */
export type Btc5mDiscoveryAttemptStats = {
  source: "events" | "markets_fallback";
  eventsFetched: number;
  /** Total `markets[]` children scanned under those events. */
  embeddedMarketsSeen: number;
  eventsFailActiveClosed: number;
  eventsFailTextSlug: number;
  eventsFailDurationTiming: number;
  eventsPassedFilter: number;
  /** Rows from `GET /markets` (all pages tried; only if /events yielded zero candidates). */
  flatMarketsSeen: number;
  marketsFailActiveClosed: number;
  marketsFailTextSlug: number;
  marketsFailDurationTiming: number;
  marketsPassedFilter: number;
};

let lastAutoDiscovered: AutoDiscoveredBtc5mMarket | null = null;
let autoDiscoveryAppliedThisProcess = false;
let lastDiscoveryAttemptStats: Btc5mDiscoveryAttemptStats | null = null;

export function getLastAutoDiscoveredBtc5mMarket(): AutoDiscoveredBtc5mMarket | null {
  return lastAutoDiscovered;
}

export function wasBinaryMarketAutoDiscovered(): boolean {
  return autoDiscoveryAppliedThisProcess;
}

export function getLastBtc5mDiscoveryAttemptStats(): Btc5mDiscoveryAttemptStats | null {
  return lastDiscoveryAttemptStats;
}

/** @internal Vitest — clears sticky auto-discovery state. */
export function resetBinaryAutoDiscoveryStateForTests(): void {
  lastAutoDiscovered = null;
  autoDiscoveryAppliedThisProcess = false;
  lastDiscoveryAttemptStats = null;
}

/** @internal Vitest — simulates a successful auto-pick without HTTP. */
export function applyAutoDiscoveredBtc5mMarketForTests(d: AutoDiscoveredBtc5mMarket): void {
  lastAutoDiscovered = d;
  autoDiscoveryAppliedThisProcess = true;
  process.env.BINARY_MARKET_SLUG = d.slug;
}

function envTrim(key: string): string {
  return process.env[key]?.trim() ?? "";
}

export function parseAutoDiscoverBinaryMarketEnv(): boolean {
  const t = process.env.AUTO_DISCOVER_BINARY_MARKET?.trim().toLowerCase();
  return t === "1" || t === "true" || t === "yes";
}

/**
 * When `AUTO_DISCOVER_BINARY_MARKET=true`, **slug env does not block** auto-discovery
 * (slug is overwritten after a successful pick). Only id / condition id count as manual.
 */
export function hasManualGammaSelectorBlockingAutoDiscover(): boolean {
  return (
    !!envTrim("BINARY_MARKET_ID") ||
    !!envTrim("POLYMARKET_MARKET_ID") ||
    !!envTrim("BINARY_CONDITION_ID") ||
    !!envTrim("POLYMARKET_CONDITION_ID")
  );
}

/** True if any explicit Gamma selector env is set (including slug). */
export function hasManualGammaSelectorEnv(): boolean {
  return (
    hasManualGammaSelectorBlockingAutoDiscover() ||
    !!envTrim("BINARY_MARKET_SLUG") ||
    !!envTrim("POLYMARKET_MARKET_SLUG")
  );
}

function asString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function asBoolean(v: unknown): boolean | null {
  return typeof v === "boolean" ? v : null;
}

/**
 * Embedded `markets[]` rows often omit `active`; parent `/events?active=true` still applies.
 * Reject only explicitly closed or explicitly inactive rows.
 */
function gammaMarketLooksTradeableNotClosed(row: GammaMarketRow): boolean {
  const closed = row["closed"];
  if (closed === true || closed === 1 || closed === "true" || closed === "1") {
    return false;
  }
  const active = row["active"];
  if (active === false || active === 0 || active === "false" || active === "0") {
    return false;
  }
  return true;
}

export function marketIdString(row: GammaMarketRow): string | null {
  const raw = row["id"];
  if (typeof raw === "number" && Number.isFinite(raw)) return String(Math.trunc(raw));
  return asString(raw);
}

function parseEndDateMs(row: GammaMarketRow): number | null {
  const iso =
    asString(row["endDate"]) ??
    (typeof row["endDateIso"] === "string" ? row["endDateIso"] : null);
  if (iso === null || iso === "") return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

function parseStartDateMs(row: GammaMarketRow): number | null {
  const iso =
    asString(row["startDate"]) ??
    (typeof row["startDateIso"] === "string" ? row["startDateIso"] : null);
  if (iso === null || iso === "") return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

/**
 * Legacy heuristic (slug / loose copy). Prefer {@link relaxedBtc5mTextMatch} for discovery.
 */
export function isLikelyBtc5mUpDownMarket(row: GammaMarketRow): boolean {
  const slug = String(row["slug"] ?? "").toLowerCase();
  const q = String(row["question"] ?? "").toLowerCase();
  const hay = `${slug} ${q}`;

  const btc = hay.includes("btc") || hay.includes("bitcoin");
  const fiveMin =
    /\b5[\s-]?min(ute)?s?\b/i.test(hay) ||
    /\b5m\b/i.test(hay) ||
    hay.includes("five minute");
  const upDown =
    hay.includes("up or down") ||
    hay.includes("up/down") ||
    hay.includes("updown") ||
    hay.includes("up down");

  const slugLooksRolling =
    slug.includes("btc") &&
    (slug.includes("5m") || slug.includes("5-min") || slug.includes("5-minute"));

  return (btc && fiveMin && upDown) || slugLooksRolling;
}

/** Case-insensitive: `bitcoin` / `btc`, **and** up/down phrasing — **or** rolling slug `btc-updown-5m`. */
export function relaxedBtc5mTextMatch(marketSlug: string, haystack: string): boolean {
  const slug = marketSlug.trim().toLowerCase();
  if (slug.includes("btc-updown-5m")) {
    return true;
  }
  const h = haystack.toLowerCase();
  const hasCrypto = /\b(btc|bitcoin)\b/i.test(h) || h.includes("bitcoin");
  const hasUpDown =
    /up\s+or\s+down/i.test(h) ||
    h.includes("up/down") ||
    h.includes("updown") ||
    /up\s+down/i.test(h);
  return hasCrypto && hasUpDown;
}

function buildEmbedHaystack(
  eventTitle: string,
  eventSlug: string,
  row: GammaMarketRow
): string {
  const mSlug = asString(row["slug"]) ?? "";
  const q = asString(row["question"]) ?? "";
  return `${eventTitle}\n${eventSlug}\n${mSlug}\n${q}`;
}

/**
 * Rolling Polymarket BTC 5m windows encode window **start** as Unix seconds in the slug
 * (`btc-updown-5m-1776776400`). Gamma `startDate` on the row is often listing metadata, not the
 * candle start, so duration checks must use this when present.
 */
export function parseBtcRolling5mWindowFromSlug(slug: string): { startMs: number; endMs: number } | null {
  const m = /btc-updown-5m-(\d{10,13})\b/i.exec(slug.trim());
  if (m === null) return null;
  let sec = Number(m[1]);
  if (!Number.isFinite(sec)) return null;
  if (sec > 1e12) sec = Math.floor(sec / 1000);
  if (sec < 1e9) return null;
  const startMs = sec * 1000;
  return { startMs, endMs: startMs + 5 * 60_000 };
}

type EmbedClassify = "candidate" | "fail_active_closed" | "fail_text" | "fail_duration_timing";

/**
 * Classify one embedded (or flat) market row for BTC ~5m discovery gates **before** resolve/CLOB.
 */
export function classifyBtc5mEmbedDiscovery(
  row: GammaMarketRow,
  eventTitle: string,
  eventSlug: string,
  nowMs: number
): EmbedClassify {
  if (!gammaMarketLooksTradeableNotClosed(row)) {
    return "fail_active_closed";
  }
  const mSlug = asString(row["slug"]) ?? "";
  const hay = buildEmbedHaystack(eventTitle, eventSlug, row);
  if (!relaxedBtc5mTextMatch(mSlug, hay)) {
    return "fail_text";
  }

  const fromSlug = parseBtcRolling5mWindowFromSlug(mSlug);
  let startMs: number;
  let endMs: number;
  if (fromSlug !== null) {
    ({ startMs, endMs } = fromSlug);
  } else {
    const start = parseStartDateMs(row);
    const end = parseEndDateMs(row);
    if (start === null || end === null) {
      return "fail_duration_timing";
    }
    const durMin = (end - start) / 60_000;
    if (durMin < 4 || durMin > 8) {
      return "fail_duration_timing";
    }
    startMs = start;
    endMs = end;
  }

  if (endMs < nowMs - 60_000) {
    return "fail_duration_timing";
  }
  return "candidate";
}

/**
 * @deprecated Prefer {@link classifyBtc5mEmbedDiscovery} — kept for tests / external callers.
 */
export function embedMatchesBitcoinUpDown5mDiscovery(
  row: GammaMarketRow,
  eventTitle: string,
  nowMs: number
): boolean {
  const evSlug = "";
  return classifyBtc5mEmbedDiscovery(row, eventTitle, evSlug, nowMs) === "candidate";
}

function logEventsShapeDebug(events: unknown[], max: number): void {
  console.log(`[auto-discovery] debug: logging first ${Math.min(max, events.length)} /events items (shape probe)`);
  for (let i = 0; i < Math.min(max, events.length); i++) {
    const ev = events[i];
    if (ev === null || typeof ev !== "object") {
      console.log(`[auto-discovery]   [${i}] (non-object)`);
      continue;
    }
    const r = ev as Record<string, unknown>;
    const id = r["id"];
    const slug = r["slug"];
    const title = r["title"];
    const startDate = r["startDate"] ?? r["startDateIso"];
    const endDate = r["endDate"] ?? r["endDateIso"];
    const markets = r["markets"];
    const nM = Array.isArray(markets) ? markets.length : 0;
    console.log(
      `[auto-discovery]   [${i}] event id=${String(id)} slug=${String(slug)} title=${String(title).slice(0, 72)}`
    );
    console.log(
      `[auto-discovery]       event startDate=${String(startDate)} endDate=${String(endDate)} markets_n=${nM}`
    );
    if (Array.isArray(markets) && markets.length > 0) {
      const m0 = markets[0];
      if (m0 !== null && typeof m0 === "object") {
        const mr = m0 as Record<string, unknown>;
        const qRaw = String(mr["question"] ?? "");
        const firstQ = qRaw.slice(0, 80);
        const firstMSlug = String(mr["slug"] ?? "");
        const qSuffix = qRaw.length > 80 ? "…" : "";
        console.log(
          `[auto-discovery]       first_market slug=${firstMSlug.slice(0, 64)} question="${firstQ}${qSuffix}"`
        );
      }
    }
  }
}

function emptyStats(): Btc5mDiscoveryAttemptStats {
  return {
    source: "events",
    eventsFetched: 0,
    embeddedMarketsSeen: 0,
    eventsFailActiveClosed: 0,
    eventsFailTextSlug: 0,
    eventsFailDurationTiming: 0,
    eventsPassedFilter: 0,
    flatMarketsSeen: 0,
    marketsFailActiveClosed: 0,
    marketsFailTextSlug: 0,
    marketsFailDurationTiming: 0,
    marketsPassedFilter: 0,
  };
}

function normalizeGammaMarketPayload(data: unknown): GammaMarketRow | null {
  if (data === null || typeof data !== "object") return null;
  if (Array.isArray(data)) {
    const first = data[0];
    if (first === null || typeof first !== "object") return null;
    return first as GammaMarketRow;
  }
  return data as GammaMarketRow;
}

async function fetchResolvedGammaMarketRow(
  http: AxiosInstance,
  gammaBase: string,
  embed: GammaMarketRow
): Promise<GammaMarketRow | null> {
  const slug = asString(embed["slug"]);
  if (slug !== null && slug !== "") {
    const url = `${gammaBase}/markets/slug/${encodeURIComponent(slug)}`;
    const res = await http.get<unknown>(url, { validateStatus: () => true });
    if (res.status !== 200) return null;
    return normalizeGammaMarketPayload(res.data);
  }
  const id = marketIdString(embed);
  if (id !== null && id !== "") {
    const url = `${gammaBase}/markets/${encodeURIComponent(id)}`;
    const res = await http.get<unknown>(url, { validateStatus: () => true });
    if (res.status !== 200) return null;
    return normalizeGammaMarketPayload(res.data);
  }
  return null;
}

function resolvedRowPassesExecutionGates(row: GammaMarketRow): {
  ok: boolean;
  reason?: string;
} {
  if (asBoolean(row["enableOrderBook"]) !== true) {
    return { ok: false, reason: "enableOrderBook_not_true" };
  }
  const tokens = parseGammaJsonStringArray(row["clobTokenIds"]);
  if (tokens === null || tokens.length !== 2) {
    return { ok: false, reason: "clobTokenIds_missing_or_not_two" };
  }
  if ("acceptingOrders" in row && asBoolean(row["acceptingOrders"]) === false) {
    return { ok: false, reason: "acceptingOrders_false" };
  }
  return { ok: true };
}

type ScoredPick = {
  full: GammaMarketRow;
  quote: NonNullable<ReturnType<typeof parseNormalizedBinaryQuoteFromGammaRow>>;
  startMs: number;
  spreadSum: number;
  tokenIds: [string, string];
};

type EmbedCand = { evTitle: string; evSlug: string; row: GammaMarketRow };

function scanEmbeddedFromEvents(
  data: unknown[],
  nowMs: number,
  stats: Btc5mDiscoveryAttemptStats
): EmbedCand[] {
  const embedCandidates: EmbedCand[] = [];
  stats.eventsFetched = data.length;
  for (const ev of data) {
    if (ev === null || typeof ev !== "object") continue;
    const evRec = ev as Record<string, unknown>;
    const evTitle = asString(evRec["title"]) ?? "";
    const evSlug = asString(evRec["slug"]) ?? "";
    const marketsRaw = evRec["markets"];
    if (!Array.isArray(marketsRaw)) continue;
    for (const m of marketsRaw) {
      if (m === null || typeof m !== "object") continue;
      stats.embeddedMarketsSeen += 1;
      const row = m as GammaMarketRow;
      const c = classifyBtc5mEmbedDiscovery(row, evTitle, evSlug, nowMs);
      if (c === "fail_active_closed") stats.eventsFailActiveClosed += 1;
      else if (c === "fail_text") stats.eventsFailTextSlug += 1;
      else if (c === "fail_duration_timing") stats.eventsFailDurationTiming += 1;
      else {
        stats.eventsPassedFilter += 1;
        embedCandidates.push({ evTitle, evSlug, row });
      }
    }
  }
  return embedCandidates;
}

async function scanFlatMarketsFallback(
  http: AxiosInstance,
  gammaBase: string,
  nowMs: number,
  stats: Btc5mDiscoveryAttemptStats,
  pageLimit: number,
  maxPages: number
): Promise<EmbedCand[]> {
  const out: EmbedCand[] = [];
  const seen = new Set<string>();
  for (let page = 0; page < maxPages; page++) {
    const offset = page * pageLimit;
    const url = gammaMarketsListUrl(gammaBase, pageLimit, offset);
    console.log(`[auto-discovery] markets fallback GET ${url}`);
    const res = await http.get<unknown>(url, { validateStatus: () => true });
    if (res.status !== 200) {
      console.error(`[auto-discovery] markets list HTTP ${res.status} — stop pagination`);
      break;
    }
    const arr = res.data;
    if (!Array.isArray(arr)) {
      console.error("[auto-discovery] markets list body is not an array — stop");
      break;
    }
    if (arr.length === 0) break;
    for (const m of arr) {
      if (m === null || typeof m !== "object") continue;
      stats.flatMarketsSeen += 1;
      const row = m as GammaMarketRow;
      const c = classifyBtc5mEmbedDiscovery(row, "", "", nowMs);
      if (c === "fail_active_closed") stats.marketsFailActiveClosed += 1;
      else if (c === "fail_text") stats.marketsFailTextSlug += 1;
      else if (c === "fail_duration_timing") stats.marketsFailDurationTiming += 1;
      else {
        const id = marketIdString(row) ?? asString(row["slug"]) ?? "";
        if (seen.has(id)) continue;
        seen.add(id);
        stats.marketsPassedFilter += 1;
        out.push({ evTitle: "", evSlug: "", row });
      }
    }
    if (arr.length < pageLimit) break;
  }
  return out;
}

/**
 * Fetches **`GET /events?active=true&closed=false&order=volume&ascending=true`**, then optionally paginated
 * **`GET /markets?...&order=volume&ascending=true`**, applies relaxed BTC 5m filters, resolves,
 * validates gates + CLOB books, picks best by **latest `startDate`** then **tightest spread**.
 */
export async function discoverActiveBtc5mUpDownMarket(input?: {
  http?: AxiosInstance;
  gammaBaseUrl?: string;
  limit?: number;
  /** Pages for `/markets` fallback (`limit` each). Default 20 (= 2000 markets max). */
  marketsFallbackMaxPages?: number;
}): Promise<AutoDiscoveredBtc5mMarket | null> {
  const base = (
    input?.gammaBaseUrl ??
    process.env.POLYMARKET_GAMMA_API_BASE ??
    DEFAULT_GAMMA_EVENTS_BASE
  ).replace(/\/$/, "");
  const limit = input?.limit ?? 100;
  const marketsMaxPages = input?.marketsFallbackMaxPages ?? 20;
  const http =
    input?.http ??
    axios.create({
      timeout: 25_000,
      validateStatus: () => true,
    });
  const clobBase =
    process.env.POLYMARKET_CLOB_API_BASE?.trim().replace(/\/$/, "") ??
    DEFAULT_CLOB_API_BASE.replace(/\/$/, "");

  const stats = emptyStats();
  lastDiscoveryAttemptStats = stats;

  const eventsUrl = gammaBtc5mDiscoveryEventsUrl(base, limit);
  console.log("[auto-discovery] AUTO DISCOVER ACTIVE");
  console.log(`[auto-discovery] GET ${eventsUrl}`);

  const res = await http.get<unknown>(eventsUrl, { validateStatus: () => true });
  if (res.status !== 200) {
    console.error(`[auto-discovery] Gamma events HTTP ${res.status} — abort`);
    return null;
  }
  const data = res.data;
  if (!Array.isArray(data)) {
    console.error("[auto-discovery] Gamma events body is not an array — abort");
    return null;
  }

  logEventsShapeDebug(data, 10);

  const nowMs = Date.now();
  let embedCandidates = scanEmbeddedFromEvents(data, nowMs, stats);
  console.log(
    `[auto-discovery] /events summary: events=${stats.eventsFetched} embedded_markets=${stats.embeddedMarketsSeen} ` +
      `fail_active_closed=${stats.eventsFailActiveClosed} fail_text_slug=${stats.eventsFailTextSlug} ` +
      `fail_duration_timing=${stats.eventsFailDurationTiming} passed_filter=${stats.eventsPassedFilter}`
  );

  if (embedCandidates.length === 0) {
    console.log(
      "[auto-discovery] zero candidates from /events — trying /markets list fallback (short windows often absent from events feed)"
    );
    const fb = await scanFlatMarketsFallback(http, base, nowMs, stats, limit, marketsMaxPages);
    embedCandidates = fb;
    stats.source = "markets_fallback";
    console.log(
      `[auto-discovery] /markets fallback summary: flat_markets=${stats.flatMarketsSeen} ` +
        `fail_active_closed=${stats.marketsFailActiveClosed} fail_text_slug=${stats.marketsFailTextSlug} ` +
        `fail_duration_timing=${stats.marketsFailDurationTiming} passed_filter=${stats.marketsPassedFilter}`
    );
  }

  console.log(
    `[auto-discovery] embedded candidates after title/duration/active/closed filter: ${embedCandidates.length}`
  );

  const scored: ScoredPick[] = [];
  let idx = 0;
  for (const { evTitle, row: embed } of embedCandidates) {
    idx += 1;
    const slugHint = asString(embed["slug"]) ?? marketIdString(embed) ?? "?";
    console.log(
      `[auto-discovery] [${idx}/${embedCandidates.length}] embed slug=${slugHint} event_title="${evTitle.slice(0, 60)}${evTitle.length > 60 ? "…" : ""}"`
    );

    const full = await fetchResolvedGammaMarketRow(http, base, embed);
    if (full === null) {
      console.log(`[auto-discovery]   → skip: Gamma resolve failed (slug/id HTTP)`);
      continue;
    }

    const gates = resolvedRowPassesExecutionGates(full);
    if (!gates.ok) {
      console.log(`[auto-discovery]   → skip: ${gates.reason ?? "gates"}`);
      continue;
    }

    const tokens = parseGammaJsonStringArray(full["clobTokenIds"]);
    if (tokens === null || tokens.length !== 2) {
      console.log(`[auto-discovery]   → skip: clobTokenIds_parse`);
      continue;
    }

    const books = await evaluateBothOutcomeClobBooks({
      http,
      clobBaseUrl: clobBase,
      tokenIds: tokens,
    });
    if (!books.ok) {
      console.log(`[auto-discovery]   → skip: CLOB books — ${books.detail}`);
      continue;
    }

    const withPrices: GammaMarketRow = {
      ...full,
      outcomePrices: JSON.stringify(books.mids.map((m) => String(m))),
    };
    const quote = parseNormalizedBinaryQuoteFromGammaRow(withPrices, Date.now());
    if (quote === null) {
      const pf = diagnoseGammaRowParseFailure(withPrices);
      console.log(`[auto-discovery]   → skip: quote parse (${pf ?? "null"})`);
      continue;
    }

    const slugForPick = asString(withPrices["slug"]) ?? "";
    const rollingWin = parseBtcRolling5mWindowFromSlug(slugForPick);
    const startMs =
      rollingWin !== null ? rollingWin.startMs : parseStartDateMs(withPrices) ?? 0;
    const suit = assessTradingSuitability(withPrices);
    const suitNote = suit.suitable ? "suitable" : "suitability_warnings";
    console.log(
      `[auto-discovery]   → OK: books spread_sum=${books.spreadSum.toFixed(6)} startMs=${startMs} ${suitNote}`
    );

    scored.push({
      full: withPrices,
      quote,
      startMs,
      spreadSum: books.spreadSum,
      tokenIds: books.tokenIds,
    });
  }

  if (scored.length === 0) {
    console.log("[auto-discovery] no valid market after resolve + gates + CLOB books");
    return null;
  }

  scored.sort((a, b) => {
    if (b.startMs !== a.startMs) return b.startMs - a.startMs;
    return a.spreadSum - b.spreadSum;
  });

  const best = scored[0]!;
  const slug = asString(best.full["slug"]);
  const marketId = marketIdString(best.full);
  if (slug === null || slug === "" || marketId === null || marketId === "") {
    return null;
  }

  const validationResult = `PASS: CLOB_books_ok spread_sum=${best.spreadSum.toFixed(6)} startMs=${best.startMs} ${assessTradingSuitability(best.full).suitable ? "suitability_ok" : "suitability_mixed"}`;

  console.log("[auto-discovery] SELECTED (best = latest start, then tightest spreads):");
  console.log(`[auto-discovery]   slug:          ${slug}`);
  console.log(`[auto-discovery]   title:         ${best.quote.question}`);
  console.log(`[auto-discovery]   market_id:     ${marketId}`);
  console.log(`[auto-discovery]   condition_id: ${best.quote.conditionId ?? "—"}`);
  console.log(
    `[auto-discovery]   token_ids:     ${best.tokenIds[0]!.slice(0, 18)}…  ${best.tokenIds[1]!.slice(0, 18)}…`
  );
  console.log(`[auto-discovery]   validation:    ${validationResult}`);

  const result: AutoDiscoveredBtc5mMarket = {
    slug,
    marketId,
    conditionId: best.quote.conditionId ?? null,
    title: best.quote.question,
    acceptingOrders: asBoolean(best.full["acceptingOrders"]),
    enableOrderBook: asBoolean(best.full["enableOrderBook"]),
    tokenIds: best.tokenIds,
    validationResult,
  };
  lastDiscoveryAttemptStats = stats;
  return result;
}

function formatDiscoveryFailureMessage(): string {
  const s = lastDiscoveryAttemptStats;
  const tail =
    s !== null
      ? ` Stats: source=${s.source} | /events: fetched=${s.eventsFetched} embedded_seen=${s.embeddedMarketsSeen} ` +
        `fail_active_closed=${s.eventsFailActiveClosed} fail_text_slug=${s.eventsFailTextSlug} ` +
        `fail_duration_timing=${s.eventsFailDurationTiming} passed=${s.eventsPassedFilter} | /markets: flat_seen=${s.flatMarketsSeen} ` +
        `fail_active_closed=${s.marketsFailActiveClosed} fail_text_slug=${s.marketsFailTextSlug} ` +
        `fail_duration_timing=${s.marketsFailDurationTiming} passed=${s.marketsPassedFilter}.`
      : "";
  return (
    `[auto-discovery] No qualifying BTC ~5m Up/Down market after /events (and optional /markets fallback), resolve, gates, and CLOB books.${tail} ` +
    `Set BINARY_MARKET_ID or BINARY_CONDITION_ID for manual Gamma, or set AUTO_DISCOVER_BINARY_MARKET=false and use BINARY_MARKET_SLUG.`
  );
}

/**
 * When `AUTO_DISCOVER_BINARY_MARKET` is true, `MARKET_MODE=binary`, and no blocking
 * manual selector (**id / condition**) is set, sets `process.env.BINARY_MARKET_SLUG`
 * to the discovered market (slug env is ignored for blocking and overwritten on success).
 */
export async function ensureAutoDiscoveredBinaryMarketSlug(
  marketMode: MarketMode
): Promise<void> {
  lastAutoDiscovered = null;
  autoDiscoveryAppliedThisProcess = false;

  if (marketMode !== "binary") return;
  if (!parseAutoDiscoverBinaryMarketEnv()) return;
  if (hasManualGammaSelectorBlockingAutoDiscover()) return;

  const d = await discoverActiveBtc5mUpDownMarket();
  if (d === null) {
    throw new Error(formatDiscoveryFailureMessage());
  }

  process.env.BINARY_MARKET_SLUG = d.slug;
  lastAutoDiscovered = d;
  autoDiscoveryAppliedThisProcess = true;

  console.log("[auto-discovery] applied BINARY_MARKET_SLUG in-process for this run");
}
