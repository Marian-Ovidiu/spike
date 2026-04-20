/**
 * When Gamma `/markets` rows omit `outcomePrices` (common for short-lived BTC Up/Down
 * windows embedded under `/events`), derive per-outcome mids from the public CLOB
 * L2 book for each `clobTokenIds` entry.
 */
import type { AxiosInstance } from "axios";

import {
  diagnoseGammaRowParseFailure,
  parseGammaJsonStringArray,
  type GammaMarketRow,
} from "./gammaMarketQuoteParse.js";
import type { GammaBootstrapStep } from "./gammaMarketResolve.js";

export const DEFAULT_CLOB_API_BASE = "https://clob.polymarket.com";

type ClobBook = {
  bids?: Array<{ price?: string }>;
  asks?: Array<{ price?: string }>;
};

function bestBidAskFromBook(book: ClobBook): { bid: number; ask: number } | null {
  const bids = book.bids ?? [];
  const asks = book.asks ?? [];
  if (bids.length === 0 || asks.length === 0) return null;
  let bid = Number.NEGATIVE_INFINITY;
  for (const b of bids) {
    const p = Number(b.price);
    if (Number.isFinite(p)) bid = Math.max(bid, p);
  }
  let ask = Number.POSITIVE_INFINITY;
  for (const a of asks) {
    const p = Number(a.price);
    if (Number.isFinite(p)) ask = Math.min(ask, p);
  }
  if (!Number.isFinite(bid) || !Number.isFinite(ask) || ask <= bid || bid < 0 || ask > 1) {
    return null;
  }
  return { bid, ask };
}

function midFromBook(book: ClobBook): number | null {
  const ba = bestBidAskFromBook(book);
  if (ba === null) return null;
  return (ba.bid + ba.ask) / 2;
}

export type BothClobBooksEval =
  | {
      ok: true;
      tokenIds: [string, string];
      /** Sum of (ask − bid) for each token; lower is a tighter book. */
      spreadSum: number;
      /** Mid prices aligned with `tokenIds` (same fetch pass — avoids duplicate `/book`). */
      mids: [number, number];
    }
  | { ok: false; detail: string };

/**
 * Fetches CLOB `/book` for each token and checks both have a proper bid/ask ladder.
 * Used by BTC 5m auto-discovery to skip illiquid / broken books before selection.
 */
export async function evaluateBothOutcomeClobBooks(input: {
  http: AxiosInstance;
  clobBaseUrl: string;
  tokenIds: string[];
}): Promise<BothClobBooksEval> {
  const base = input.clobBaseUrl.replace(/\/$/, "");
  if (input.tokenIds.length !== 2) {
    return { ok: false, detail: "expected_two_token_ids" };
  }
  const a = input.tokenIds[0]!;
  const b = input.tokenIds[1]!;
  let spreadSum = 0;
  const mids: number[] = [];
  for (const tokenId of [a, b]) {
    const url = `${base}/book?token_id=${encodeURIComponent(tokenId)}`;
    const res = await input.http.get<unknown>(url, { validateStatus: () => true });
    if (res.status !== 200) {
      return { ok: false, detail: `book_http_${res.status}_token=${tokenId.slice(0, 12)}…` };
    }
    const book = res.data as ClobBook;
    const ba = bestBidAskFromBook(book);
    if (ba === null) {
      return { ok: false, detail: `invalid_book_token=${tokenId.slice(0, 12)}…` };
    }
    spreadSum += ba.ask - ba.bid;
    const mid = midFromBook(book);
    if (mid === null) {
      return { ok: false, detail: `mid_null_token=${tokenId.slice(0, 12)}…` };
    }
    mids.push(mid);
  }
  return {
    ok: true,
    tokenIds: [a, b],
    spreadSum,
    mids: [mids[0]!, mids[1]!],
  };
}

export function gammaRowMissingOnlyOutcomePrices(row: GammaMarketRow | null): boolean {
  if (row === null) return false;
  return diagnoseGammaRowParseFailure(row) === "missing_outcomePrices_field";
}

/**
 * If `row` is otherwise parseable but lacks `outcomePrices`, fills `outcomePrices` on a
 * shallow copy using CLOB `/book?token_id=…` mids (same order as `clobTokenIds`).
 */
export async function tryFillOutcomePricesFromClobBooks(input: {
  http: AxiosInstance;
  row: GammaMarketRow;
  clobBaseUrl?: string;
  steps?: GammaBootstrapStep[];
}): Promise<GammaMarketRow> {
  const row = input.row;
  if (!gammaRowMissingOnlyOutcomePrices(row)) {
    return row;
  }
  const base = (input.clobBaseUrl ?? DEFAULT_CLOB_API_BASE).replace(/\/$/, "");
  const tokens = parseGammaJsonStringArray(row["clobTokenIds"]);
  if (tokens === null || tokens.length !== 2) {
    return row;
  }

  const mids: number[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const tokenId = tokens[i]!;
    const url = `${base}/book?token_id=${encodeURIComponent(tokenId)}`;
    const res = await input.http.get<unknown>(url, { validateStatus: () => true });
    const status = res.status;
    input.steps?.push(
      status === 200
        ? {
            label: `clob_book_outcome_index_${i}`,
            method: "GET",
            url,
            httpStatus: status,
            outcome: "ok",
          }
        : {
            label: `clob_book_outcome_index_${i}`,
            method: "GET",
            url,
            httpStatus: status,
            outcome: "http_error",
            detail: `HTTP ${status}`,
          }
    );
    if (status !== 200) {
      return row;
    }
    const book = res.data as ClobBook;
    const mid = midFromBook(book);
    if (mid === null) {
      return row;
    }
    mids.push(mid);
  }

  const out: GammaMarketRow = { ...row };
  out.outcomePrices = JSON.stringify(mids.map((m) => String(m)));
  return out;
}
