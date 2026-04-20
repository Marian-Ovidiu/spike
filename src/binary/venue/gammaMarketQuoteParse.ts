import type { NormalizedBinaryQuote } from "../../market/binaryQuoteTypes.js";

export type GammaMarketRow = Record<string, unknown>;

function asString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function asBoolean(v: unknown): boolean | null {
  return typeof v === "boolean" ? v : null;
}

function asNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Parse Gamma JSON-encoded array fields (`"[\"Yes\",\"No\"]"`). */
export function parseGammaJsonStringArray(raw: unknown): string[] | null {
  if (Array.isArray(raw)) {
    return raw.map((x) => String(x));
  }
  const s = asString(raw);
  if (s === null) return null;
  try {
    const v = JSON.parse(s) as unknown;
    if (!Array.isArray(v)) return null;
    return v.map((x) => String(x));
  } catch {
    return null;
  }
}

/** Parse Gamma JSON-encoded numeric array (`"[\"0.52\",\"0.48\"]"`). */
export function parseGammaJsonNumberArray(raw: unknown): number[] | null {
  if (Array.isArray(raw)) {
    const out: number[] = [];
    for (const x of raw) {
      const n = asNumber(x);
      if (n === null) return null;
      out.push(n);
    }
    return out;
  }
  const s = asString(raw);
  if (s === null) return null;
  try {
    const v = JSON.parse(s) as unknown;
    if (!Array.isArray(v)) return null;
    const out: number[] = [];
    for (const x of v) {
      const n = asNumber(x);
      if (n === null) return null;
      out.push(n);
    }
    return out;
  } catch {
    return null;
  }
}

export function extractVenueUpdatedAtMs(row: GammaMarketRow): number | null {
  const u = row["updatedAt"];
  if (typeof u !== "string") return null;
  const t = Date.parse(u);
  return Number.isFinite(t) ? t : null;
}

/**
 * Map outcome labels to YES (first index) and NO (second) prices.
 * Expects exactly two outcomes; matches "Yes"/"No" case-insensitively when possible.
 */
export function mapYesNoFromOutcomes(
  outcomes: string[],
  prices: number[]
): { yesPrice: number; noPrice: number } | null {
  if (outcomes.length !== 2 || prices.length !== 2) return null;
  const p0 = prices[0];
  const p1 = prices[1];
  if (p0 === undefined || p1 === undefined) return null;
  const o0 = outcomes[0]?.trim().toLowerCase() ?? "";
  const o1 = outcomes[1]?.trim().toLowerCase() ?? "";
  if (o0 === "yes" && o1 === "no") {
    return { yesPrice: p0, noPrice: p1 };
  }
  if (o0 === "no" && o1 === "yes") {
    return { yesPrice: p1, noPrice: p0 };
  }
  return { yesPrice: p0, noPrice: p1 };
}

/**
 * Build {@link NormalizedBinaryQuote} from one Gamma `/markets` row.
 * Returns `null` if required fields are missing or invalid.
 */
function marketIdFromRow(row: GammaMarketRow): string | null {
  const raw = row["id"];
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return String(Math.trunc(raw));
  }
  return asString(raw);
}

export function parseNormalizedBinaryQuoteFromGammaRow(
  row: GammaMarketRow,
  observedAtMs: number
): NormalizedBinaryQuote | null {
  const marketId = marketIdFromRow(row);
  if (marketId === null || marketId === "") return null;

  const slug = asString(row["slug"]) ?? "";
  const question = asString(row["question"]) ?? "";
  const conditionId = asString(row["conditionId"]);

  const outcomes = parseGammaJsonStringArray(row["outcomes"]);
  const priceArr = parseGammaJsonNumberArray(row["outcomePrices"]);
  if (outcomes === null || priceArr === null) return null;

  const yn = mapYesNoFromOutcomes(outcomes, priceArr);
  if (yn === null) return null;
  if (
    !Number.isFinite(yn.yesPrice) ||
    !Number.isFinite(yn.noPrice) ||
    yn.yesPrice < 0 ||
    yn.yesPrice > 1 ||
    yn.noPrice < 0 ||
    yn.noPrice > 1
  ) {
    return null;
  }

  const venueUpdatedAtMs = extractVenueUpdatedAtMs(row);
  const quoteAgeMs =
    venueUpdatedAtMs !== null ? Math.max(0, observedAtMs - venueUpdatedAtMs) : null;

  const vol = asNumber(row["volumeNum"]) ?? asNumber(row["volume"]);

  return {
    marketId,
    conditionId,
    slug,
    question,
    yesPrice: yn.yesPrice,
    noPrice: yn.noPrice,
    observedAtMs,
    quoteAgeMs,
    venueUpdatedAtMs,
    active: asBoolean(row["active"]),
    closed: asBoolean(row["closed"]),
    volume: vol,
  };
}

/** Human-readable first failure reason for startup / CLI diagnostics. */
export function diagnoseGammaRowParseFailure(row: GammaMarketRow | null): string | null {
  if (row === null) return "no_market_row";
  const id = marketIdFromRow(row);
  if (id === null || id === "") return "missing_or_empty_id";
  if (row["outcomes"] === undefined || row["outcomes"] === null) {
    return "missing_outcomes_field";
  }
  if (row["outcomePrices"] === undefined || row["outcomePrices"] === null) {
    return "missing_outcomePrices_field";
  }
  const outcomes = parseGammaJsonStringArray(row["outcomes"]);
  const priceArr = parseGammaJsonNumberArray(row["outcomePrices"]);
  if (outcomes === null) return "outcomes_not_json_array_or_invalid";
  if (priceArr === null) return "outcomePrices_not_json_numeric_array_or_invalid";
  if (outcomes.length !== 2 || priceArr.length !== 2) {
    return `expected_two_outcomes_got_outcomes=${outcomes.length}_prices=${priceArr.length}`;
  }
  const yn = mapYesNoFromOutcomes(outcomes, priceArr);
  if (yn === null) return "could_not_map_two_prices_to_yes_no";
  if (
    !Number.isFinite(yn.yesPrice) ||
    !Number.isFinite(yn.noPrice) ||
    yn.yesPrice < 0 ||
    yn.yesPrice > 1 ||
    yn.noPrice < 0 ||
    yn.noPrice > 1
  ) {
    return `yes_no_prices_out_of_unit_interval_yes=${yn.yesPrice}_no=${yn.noPrice}`;
  }
  return null;
}
