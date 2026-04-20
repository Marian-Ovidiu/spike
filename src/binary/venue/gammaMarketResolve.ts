/**
 * Resolves a Polymarket **Gamma** market row for execution (HTTP only).
 *
 * Gamma list query `GET /markets?slug=…` / `?id=…` often returns `[]` even for valid
 * slugs; the supported shapes are path lookups (`/markets/slug/…`, `/markets/{id}`)
 * and event wrappers (`/events/slug/…` → nested `markets[]`).
 */
import type { AxiosInstance } from "axios";

import type { NormalizedBinaryQuote } from "../../market/binaryQuoteTypes.js";
import {
  tryFillOutcomePricesFromClobBooks,
  gammaRowMissingOnlyOutcomePrices,
} from "./gammaClobOutcomePrices.js";
import {
  diagnoseGammaRowParseFailure,
  parseGammaJsonStringArray,
  parseNormalizedBinaryQuoteFromGammaRow,
  type GammaMarketRow,
} from "./gammaMarketQuoteParse.js";

export const DEFAULT_CLOB_API_BASE = "https://clob.polymarket.com";

export type GammaResolveQuery =
  | { type: "id"; value: string }
  | { type: "slug"; value: string }
  | { type: "condition_id"; value: string };

export type GammaBootstrapStep = {
  label: string;
  method: "GET";
  url: string;
  httpStatus: number | null;
  outcome: "ok" | "http_error" | "empty" | "wrong_shape" | "skipped";
  detail?: string;
};

export type GammaResolveResult = {
  row: GammaMarketRow | null;
  quote: NormalizedBinaryQuote | null;
  steps: GammaBootstrapStep[];
  /** How we obtained `row` (for logs and session JSON). */
  resolution:
    | { kind: "gamma_markets_by_numeric_id"; marketId: string }
    | { kind: "gamma_markets_by_slug_path"; slug: string }
    | { kind: "gamma_event_slug_nested_market"; eventSlug: string; marketSlug: string }
    | { kind: "clob_condition_then_gamma_slug"; conditionId: string; marketSlug: string }
    | { kind: "failed"; reason: string };
  parseFailure: string | null;
};

function logLine(log: ((s: string) => void) | undefined, msg: string): void {
  if (log) log(msg);
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function asString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function asBoolean(v: unknown): boolean | null {
  return typeof v === "boolean" ? v : null;
}

export type TradingSuitability = {
  suitable: boolean;
  checks: Array<{ name: string; ok: boolean; detail?: string }>;
};

/**
 * Heuristic for “would a human trader expect orders to work?” — Gamma + CLOB flags only.
 */
export function assessTradingSuitability(row: GammaMarketRow): TradingSuitability {
  const checks: TradingSuitability["checks"] = [];

  const closed = asBoolean(row["closed"]);
  checks.push(
    closed === true
      ? { name: "not_closed", ok: false, detail: "market_is_closed" }
      : { name: "not_closed", ok: true }
  );

  const active = asBoolean(row["active"]);
  checks.push(
    active === false
      ? { name: "active", ok: false, detail: "active_is_false" }
      : { name: "active", ok: true }
  );

  const enableOb = asBoolean(row["enableOrderBook"]);
  checks.push(
    enableOb === false
      ? { name: "enableOrderBook", ok: false, detail: "enableOrderBook_false" }
      : { name: "enableOrderBook", ok: true }
  );

  const accepting = asBoolean(row["acceptingOrders"]);
  checks.push(
    accepting === false
      ? {
          name: "acceptingOrders",
          ok: false,
          detail: "acceptingOrders_false_no_new_orders",
        }
      : { name: "acceptingOrders", ok: true }
  );

  const tokens = parseGammaJsonStringArray(row["clobTokenIds"]);
  checks.push(
    tokens === null || tokens.length < 2
      ? {
          name: "clobTokenIds",
          ok: false,
          detail: "missing_or_short_clobTokenIds_json",
        }
      : { name: "clobTokenIds", ok: true }
  );

  const suitable = checks.every((c) => c.ok);
  return { suitable, checks };
}

async function httpGetJson(
  http: AxiosInstance,
  url: string,
  label: string,
  steps: GammaBootstrapStep[]
): Promise<{ status: number; data: unknown }> {
  try {
    const res = await http.get<unknown>(url, { validateStatus: () => true });
    const status = res.status;
    steps.push(
      status === 200
        ? {
            label,
            method: "GET",
            url,
            httpStatus: status,
            outcome: "ok",
          }
        : {
            label,
            method: "GET",
            url,
            httpStatus: status,
            outcome: "http_error",
            detail: `HTTP ${status}`,
          }
    );
    return { status, data: res.data };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    steps.push({
      label,
      method: "GET",
      url,
      httpStatus: null,
      outcome: "http_error",
      detail: msg,
    });
    return { status: 0, data: null };
  }
}

function normalizeMarketsPayload(data: unknown): GammaMarketRow[] {
  if (Array.isArray(data)) {
    return data as GammaMarketRow[];
  }
  const one = asRecord(data);
  if (one !== null) {
    return [one as GammaMarketRow];
  }
  return [];
}

function pickChildMarketFromEvent(
  event: Record<string, unknown>
): { row: GammaMarketRow | null; marketSlug: string | null; detail: string } {
  const rawMarkets = event["markets"];
  if (!Array.isArray(rawMarkets) || rawMarkets.length === 0) {
    return {
      row: null,
      marketSlug: null,
      detail:
        "event_wrapper_has_no_markets_array_or_empty_children_set_BINARY_MARKET_SLUG_to_a_specific_market_slug_or_BINARY_MARKET_ID",
    };
  }

  const preferActive = rawMarkets.filter((m) => {
    const rec = asRecord(m);
    if (rec === null) return false;
    const closed = asBoolean(rec["closed"]);
    const active = asBoolean(rec["active"]);
    return active === true && closed !== true;
  });
  const pool =
    preferActive.length > 0
      ? (preferActive as GammaMarketRow[])
      : (rawMarkets as GammaMarketRow[]);

  for (const m of pool) {
    const fail = diagnoseGammaRowParseFailure(m);
    if (fail === null) {
      const slug = asString(m["slug"]) ?? "";
      return { row: m, marketSlug: slug || null, detail: "first_parseable_child" };
    }
  }

  for (const m of pool) {
    if (!gammaRowMissingOnlyOutcomePrices(m as GammaMarketRow)) continue;
    const tok = parseGammaJsonStringArray((m as GammaMarketRow)["clobTokenIds"]);
    const outc = parseGammaJsonStringArray((m as GammaMarketRow)["outcomes"]);
    if (tok === null || tok.length !== 2 || outc === null || outc.length !== 2) continue;
    const slug = asString((m as GammaMarketRow)["slug"]) ?? "";
    return {
      row: m as GammaMarketRow,
      marketSlug: slug || null,
      detail: "first_child_missing_outcomePrices_will_fill_from_clob",
    };
  }

  const titles = (rawMarkets as unknown[])
    .slice(0, 8)
    .map((m) => {
      const r = asRecord(m);
      return r ? (asString(r["question"]) ?? asString(r["slug"]) ?? "?") : "?";
    })
    .join(" | ");

  return {
    row: null,
    marketSlug: null,
    detail: `event_has_${rawMarkets.length}_markets_but_none_yield_parseable_yes_no_prices_sample=${titles}`,
  };
}

async function finalizeGammaQuote(input: {
  http: AxiosInstance;
  clobBase: string;
  row: GammaMarketRow | null;
  steps: GammaBootstrapStep[];
}): Promise<{
  row: GammaMarketRow | null;
  quote: NormalizedBinaryQuote | null;
  parseFailure: string | null;
}> {
  if (input.row === null) {
    return { row: null, quote: null, parseFailure: "no_market_row" };
  }
  const filled = await tryFillOutcomePricesFromClobBooks({
    http: input.http,
    row: input.row,
    clobBaseUrl: input.clobBase,
    steps: input.steps,
  });
  const pf = diagnoseGammaRowParseFailure(filled);
  if (pf !== null) {
    return { row: filled, quote: null, parseFailure: pf };
  }
  const quote = parseNormalizedBinaryQuoteFromGammaRow(filled, Date.now());
  if (quote === null) {
    return { row: filled, quote: null, parseFailure: "parse_failed_after_clob_fill" };
  }
  return { row: filled, quote, parseFailure: null };
}

/**
 * Full resolution used by {@link BinaryMarketFeed} bootstrap and `validate-binary-market`.
 */
export async function resolveGammaMarketForMonitor(input: {
  http: AxiosInstance;
  gammaBase: string;
  query: GammaResolveQuery;
  clobBaseUrl?: string;
  /** Extra lines (default: `console.log`). */
  log?: (s: string) => void;
}): Promise<GammaResolveResult> {
  const { http, gammaBase } = input;
  const base = gammaBase.replace(/\/$/, "");
  const clobBase = (input.clobBaseUrl ?? DEFAULT_CLOB_API_BASE).replace(/\/$/, "");
  const steps: GammaBootstrapStep[] = [];
  const log = input.log;

  const fail = (reason: string): GammaResolveResult => ({
    row: null,
    quote: null,
    steps,
    resolution: { kind: "failed", reason },
    parseFailure: reason,
  });

  if (input.query.type === "id") {
    const id = input.query.value.trim();
    const url = `${base}/markets/${encodeURIComponent(id)}`;
    logLine(log, `[gamma-bootstrap] selector=id value=${id}`);
    const { status, data } = await httpGetJson(http, url, "markets_by_numeric_id", steps);
    if (status !== 200) {
      return fail(
        `gamma_markets_by_id_http_${status}_expected_single_market_object_at_${url}`
      );
    }
    const rows = normalizeMarketsPayload(data);
    const row0 = rows[0] ?? null;
    if (row0 === null) {
      return fail(`gamma_markets_by_id_empty_or_unreadable_body`);
    }
    const { row, quote, parseFailure } = await finalizeGammaQuote({
      http,
      clobBase,
      row: row0,
      steps,
    });
    if (quote === null || row === null) {
      return fail(parseFailure ?? "parse_failed");
    }
    logLine(
      log,
      `[gamma-bootstrap] resolved via GET /markets/{id} marketId=${quote.marketId} slug=${quote.slug}`
    );
    return {
      row,
      quote,
      steps,
      resolution: { kind: "gamma_markets_by_numeric_id", marketId: quote.marketId },
      parseFailure: null,
    };
  }

  if (input.query.type === "condition_id") {
    const conditionId = input.query.value.trim();
    logLine(
      log,
      `[gamma-bootstrap] selector=condition_id value=${conditionId} (CLOB bridge then Gamma slug)`
    );
    const clobUrl = `${clobBase}/markets/${encodeURIComponent(conditionId)}`;
    const { status, data } = await httpGetJson(http, clobUrl, "clob_market_by_condition", steps);
    if (status !== 200) {
      return fail(
        `clob_markets_condition_http_${status}_check_condition_id_and_clob_base_${clobUrl}`
      );
    }
    const rec = asRecord(data);
    const marketSlug =
      rec !== null
        ? (asString(rec["market_slug"]) ?? asString(rec["marketSlug"]))
        : null;
    if (marketSlug === null || marketSlug === "") {
      return fail("clob_response_missing_market_slug_cannot_map_to_gamma_row");
    }
    logLine(log, `[gamma-bootstrap] CLOB market_slug=${marketSlug}`);
    const gammaUrl = `${base}/markets/slug/${encodeURIComponent(marketSlug)}`;
    const g2 = await httpGetJson(http, gammaUrl, "gamma_markets_by_slug_after_clob", steps);
    if (g2.status !== 200) {
      return fail(
        `after_clob_gamma_slug_http_${g2.status}_url=${gammaUrl}`
      );
    }
    const rows = normalizeMarketsPayload(g2.data);
    const row0 = rows[0] ?? null;
    const { row, quote, parseFailure } = await finalizeGammaQuote({
      http,
      clobBase,
      row: row0,
      steps,
    });
    if (quote === null || row === null) {
      return fail(parseFailure ?? "parse_failed_after_clob_bridge");
    }
    logLine(
      log,
      `[gamma-bootstrap] resolved via CLOB→Gamma slug marketId=${quote.marketId} slug=${quote.slug}`
    );
    return {
      row,
      quote,
      steps,
      resolution: {
        kind: "clob_condition_then_gamma_slug",
        conditionId,
        marketSlug,
      },
      parseFailure: null,
    };
  }

  // slug
  const slug = input.query.value.trim();
  logLine(log, `[gamma-bootstrap] selector=slug value=${slug}`);

  const urlMarket = `${base}/markets/slug/${encodeURIComponent(slug)}`;
  const m1 = await httpGetJson(http, urlMarket, "gamma_markets_by_slug_path", steps);
  if (m1.status === 200) {
    const rows = normalizeMarketsPayload(m1.data);
    const row0 = rows[0] ?? null;
    const fin = await finalizeGammaQuote({ http, clobBase, row: row0, steps });
    if (fin.quote !== null && fin.row !== null) {
      logLine(
        log,
        `[gamma-bootstrap] resolved via GET /markets/slug/{slug} marketId=${fin.quote.marketId} slug=${fin.quote.slug}`
      );
      return {
        row: fin.row,
        quote: fin.quote,
        steps,
        resolution: { kind: "gamma_markets_by_slug_path", slug },
        parseFailure: null,
      };
    }
    logLine(
      log,
      `[gamma-bootstrap] /markets/slug did not yield parseable row (${fin.parseFailure ?? "empty"}); trying /events/slug (event page slug)`
    );
  } else {
    logLine(
      log,
      `[gamma-bootstrap] GET /markets/slug → HTTP ${m1.status}; trying /events/slug`
    );
  }

  const urlEvent = `${base}/events/slug/${encodeURIComponent(slug)}`;
  const e1 = await httpGetJson(http, urlEvent, "gamma_events_by_slug_path", steps);
  let eventObj: Record<string, unknown> | null = null;
  if (e1.status === 200) {
    if (Array.isArray(e1.data) && e1.data.length > 0) {
      eventObj = asRecord(e1.data[0]);
    } else {
      eventObj = asRecord(e1.data);
    }
  }
  if (eventObj === null) {
    const urlEventQ = `${base}/events?slug=${encodeURIComponent(slug)}`;
    const e2 = await httpGetJson(http, urlEventQ, "gamma_events_by_slug_query", steps);
    if (e2.status === 200 && Array.isArray(e2.data) && e2.data.length > 0) {
      eventObj = asRecord(e2.data[0]);
    }
  }

  if (eventObj === null) {
    return fail(
      `slug_not_found_as_market_or_event_GET_${urlMarket}_and_GET_${base}/events/slug/…_returned_no_usable_event_try_BINARY_MARKET_SLUG_of_the_child_market_or_BINARY_MARKET_ID`
    );
  }

  const eventTitle = asString(eventObj["title"]) ?? "";
  logLine(
    log,
    `[gamma-bootstrap] found event wrapper title="${eventTitle}" id=${String(eventObj["id"] ?? "")}`
  );

  const picked = pickChildMarketFromEvent(eventObj);
  if (picked.row === null) {
    return fail(picked.detail);
  }

  const fin = await finalizeGammaQuote({
    http,
    clobBase,
    row: picked.row,
    steps,
  });
  if (fin.quote === null || fin.row === null) {
    return fail(fin.parseFailure ?? "nested_market_parse_failed_unexpected");
  }
  const quote = fin.quote;
  logLine(
    log,
    `[gamma-bootstrap] resolved event→nested market marketId=${quote.marketId} child_slug=${picked.marketSlug ?? quote.slug}`
  );
  return {
    row: fin.row,
    quote,
    steps,
    resolution: {
      kind: "gamma_event_slug_nested_market",
      eventSlug: slug,
      marketSlug: picked.marketSlug ?? quote.slug,
    },
    parseFailure: null,
  };
}

export function formatGammaBootstrapStepsForLog(steps: GammaBootstrapStep[]): string {
  return steps
    .map(
      (s) =>
        `  [${s.label}] ${s.httpStatus ?? "?"} ${s.outcome}${s.detail ? ` — ${s.detail}` : ""}\n    ${s.url}`
    )
    .join("\n");
}
