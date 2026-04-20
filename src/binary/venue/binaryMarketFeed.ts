/**
 * **Optional Polymarket Gamma integration** — Gamma REST adapter: polls one explicitly selected
 * market (id, slug, or condition id). Public data only — no trading.
 *
 * **Execution venue only** in binary mode: supplies YES/NO quotes, venue metadata, and quote
 * freshness for entry filters, paper fills, and marks. BTC spike logic uses
 * {@link BinaryBtcSpotSignalFeed} / {@link BotContext.signalFeed}, not these prices.
 *
 * @see https://docs.polymarket.com/ (Gamma markets API)
 */
import axios, { type AxiosInstance } from "axios";

import type { BinanceFeedHealth, NormalizedSpotBook } from "../../adapters/binanceSpotFeed.js";
import type { NormalizedBinaryQuote } from "../../market/binaryQuoteTypes.js";
import type { MarketDataFeed, QuoteStaleResult } from "../../market/types.js";
import { resolveBinaryMarketSelectorFromEnv } from "./binaryMarketSelector.js";
import {
  parseNormalizedBinaryQuoteFromGammaRow,
  diagnoseGammaRowParseFailure,
  type GammaMarketRow,
} from "./gammaMarketQuoteParse.js";
import {
  formatGammaBootstrapStepsForLog,
  resolveGammaMarketForMonitor,
  type GammaResolveResult,
} from "./gammaMarketResolve.js";

export type { GammaMarketRow } from "./gammaMarketQuoteParse.js";
export {
  parseGammaJsonStringArray,
  parseGammaJsonNumberArray,
  extractVenueUpdatedAtMs,
  mapYesNoFromOutcomes,
  parseNormalizedBinaryQuoteFromGammaRow,
  diagnoseGammaRowParseFailure,
} from "./gammaMarketQuoteParse.js";

export const DEFAULT_GAMMA_API_BASE = "https://gamma-api.polymarket.com";
export const DEFAULT_POLL_INTERVAL_MS = 10_000;

function envInt(key: string, fallback: number): number {
  const raw = process.env[key]?.trim();
  if (raw === undefined || raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

function asNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** @deprecated use {@link QuoteStaleResult} */
export type BinaryQuoteStaleResult = QuoteStaleResult;

/**
 * Stale if venue `updatedAt` is older than `maxQuoteAgeMs`, or no successful poll for `maxSilenceMs`.
 */
export function evaluateBinaryQuoteStale(input: {
  quote: NormalizedBinaryQuote | null;
  lastPollSuccessObservedAtMs: number | null;
  nowMs: number;
  maxQuoteAgeMs: number;
  maxSilenceMs: number;
}): QuoteStaleResult {
  const { quote, lastPollSuccessObservedAtMs, nowMs, maxQuoteAgeMs, maxSilenceMs } = input;
  if (quote === null) {
    return { stale: true, reason: "no_quote_yet" };
  }
  if (quote.quoteAgeMs !== null && quote.quoteAgeMs > maxQuoteAgeMs) {
    return {
      stale: true,
      reason: `venue_quote_age_ms=${Math.round(quote.quoteAgeMs)}>${maxQuoteAgeMs}`,
    };
  }
  if (lastPollSuccessObservedAtMs === null) {
    return { stale: true, reason: "never_polled" };
  }
  const silence = nowMs - lastPollSuccessObservedAtMs;
  if (silence > maxSilenceMs) {
    return {
      stale: true,
      reason: `poll_silence_ms=${Math.round(silence)}>${maxSilenceMs}`,
    };
  }
  return { stale: false, reason: null };
}

function spreadBpsFromBidAsk(bid: number, ask: number, mid: number): number {
  if (!Number.isFinite(bid) || !Number.isFinite(ask) || !Number.isFinite(mid) || mid <= 0) {
    return Number.NaN;
  }
  if (ask < bid) return Number.NaN;
  return ((ask - bid) / mid) * 10_000;
}

export type BinaryMarketFeedOptions = {
  marketId?: string;
  slug?: string;
  conditionId?: string;
  /** Which env key selected the market (startup banner / diagnostics). */
  selectorSourceEnvKey?: string;
  gammaBaseUrl?: string;
  pollIntervalMs?: number;
  /** Max age of Gamma `updatedAt` vs local observe time before quote is "stale". */
  maxQuoteAgeMs?: number;
  /** Max ms without a successful poll before stale. Default ~2.5× poll interval. */
  maxPollSilenceMs?: number;
  /** Synthetic spread (bps) around YES mid when Gamma row has no bestBid/bestAsk. */
  syntheticSpreadBps?: number;
  http?: AxiosInstance;
};

export class BinaryMarketFeed implements MarketDataFeed {
  private readonly gammaBase: string;
  private readonly pollMs: number;
  private readonly maxQuoteAgeMs: number;
  private readonly maxPollSilenceMs: number;
  private readonly syntheticSpreadBps: number;
  private readonly http: AxiosInstance;

  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private closedByUser = false;

  private quote: NormalizedBinaryQuote | null = null;
  private lastBook: NormalizedSpotBook | null = null;
  private lastPollSuccessObservedAtMs: number | null = null;
  private lastHttpAttemptAtMs: number | null = null;
  private lastError: string | null = null;
  private pollCount = 0;
  private httpAttempts = 0;

  /** Last Gamma HTTP resolution (bootstrap + polls) for diagnostics / CLI. */
  private lastGammaResolve: GammaResolveResult | null = null;

  private readonly query: { type: "id" | "slug" | "condition_id"; value: string };
  private readonly selectorSourceEnvKey: string;

  constructor(options?: BinaryMarketFeedOptions) {
    let id = options?.marketId?.trim() ?? "";
    let slug = options?.slug?.trim() ?? "";
    let conditionId = options?.conditionId?.trim() ?? "";

    if (!id && !slug && !conditionId) {
      const r = resolveBinaryMarketSelectorFromEnv();
      if (r.executionMode !== "gamma") {
        throw new Error(
          "BinaryMarketFeed: no Gamma market selector — use createBinaryExecutionFeed() which picks BinarySyntheticFeed when unset"
        );
      }
      if (r.selectorKind === "market_id") id = r.selectorValue;
      else if (r.selectorKind === "slug") slug = r.selectorValue;
      else conditionId = r.selectorValue;
      this.selectorSourceEnvKey = r.sourceEnvKey;
    } else {
      this.selectorSourceEnvKey =
        options?.selectorSourceEnvKey ?? "(constructor options)";
    }

    /** Gamma API precedence: market id > slug > condition id (same as env resolution). */
    if (id) {
      this.query = { type: "id", value: id };
    } else if (slug) {
      this.query = { type: "slug", value: slug };
    } else if (conditionId) {
      this.query = { type: "condition_id", value: conditionId };
    } else {
      throw new Error(
        "BinaryMarketFeed: pass marketId, slug, or conditionId (or rely on BINARY_MARKET_ID / BINARY_MARKET_SLUG / BINARY_CONDITION_ID and legacy POLYMARKET_* aliases)"
      );
    }

    this.gammaBase = (
      options?.gammaBaseUrl ??
      process.env.POLYMARKET_GAMMA_API_BASE ??
      DEFAULT_GAMMA_API_BASE
    ).replace(/\/$/, "");
    this.pollMs = Math.max(
      2_000,
      options?.pollIntervalMs ?? envInt("POLYMARKET_POLL_INTERVAL_MS", DEFAULT_POLL_INTERVAL_MS)
    );
    this.maxQuoteAgeMs = Math.max(
      5_000,
      options?.maxQuoteAgeMs ?? envInt("POLYMARKET_QUOTE_STALE_MAX_MS", 120_000)
    );
    this.maxPollSilenceMs = Math.max(
      this.pollMs * 2,
      options?.maxPollSilenceMs ??
        envInt("POLYMARKET_POLL_SILENCE_MAX_MS", Math.floor(this.pollMs * 2.5))
    );
    this.syntheticSpreadBps = Math.max(
      1,
      options?.syntheticSpreadBps ?? envInt("POLYMARKET_SYNTHETIC_SPREAD_BPS", 40)
    );
    this.http =
      options?.http ??
      axios.create({
        timeout: 15_000,
        validateStatus: (s) => s >= 200 && s < 500,
      });
  }

  getSymbol(): string {
    return this.query.value;
  }

  /** Startup / banner: how this feed was selected (before first quote may exist). */
  getGammaSelectorDiagnostics(): {
    selectorKind: "market_id" | "slug" | "condition_id";
    selectorValue: string;
    sourceEnvKey: string;
  } {
    const selectorKind =
      this.query.type === "id"
        ? ("market_id" as const)
        : this.query.type === "slug"
          ? ("slug" as const)
          : ("condition_id" as const);
    return {
      selectorKind,
      selectorValue: this.query.value,
      sourceEnvKey: this.selectorSourceEnvKey,
    };
  }

  getBinaryOutcomePrices(): { yesPrice: number; noPrice: number } | null {
    const q = this.quote;
    if (q === null) return null;
    return { yesPrice: q.yesPrice, noPrice: q.noPrice };
  }

  getNormalizedBinaryQuote(): NormalizedBinaryQuote | null {
    return this.quote;
  }

  getLastPollSuccessObservedAtMs(): number | null {
    return this.lastPollSuccessObservedAtMs;
  }

  getQuoteStale(now = Date.now()): BinaryQuoteStaleResult {
    return evaluateBinaryQuoteStale({
      quote: this.quote,
      lastPollSuccessObservedAtMs: this.lastPollSuccessObservedAtMs,
      nowMs: now,
      maxQuoteAgeMs: this.maxQuoteAgeMs,
      maxSilenceMs: this.maxPollSilenceMs,
    });
  }

  getLastError(): string | null {
    return this.lastError;
  }

  getPollCount(): number {
    return this.pollCount;
  }

  getHttpAttemptCount(): number {
    return this.httpAttempts;
  }

  getGammaBaseUrl(): string {
    return this.gammaBase;
  }

  getMaxQuoteAgeMs(): number {
    return this.maxQuoteAgeMs;
  }

  getMaxPollSilenceMs(): number {
    return this.maxPollSilenceMs;
  }

  getPollIntervalMs(): number {
    return this.pollMs;
  }

  getHealth(): BinanceFeedHealth {
    const ok = this.quote !== null && this.lastError === null;
    return {
      connected: ok,
      connectCount: this.pollCount > 0 ? 1 : 0,
      disconnectCount: this.lastError !== null ? 1 : 0,
      lastMessageAtMs: this.lastPollSuccessObservedAtMs,
      messagesTotal: this.pollCount,
      reconnectScheduled: false,
      lastError: this.lastError,
    };
  }

  /**
   * Age since last **successful** quote poll (for `feedStaleMaxAgeMs` alignment).
   * Returns +∞ if never successfully polled.
   */
  getLastMessageAgeMs(now = Date.now()): number {
    if (this.lastPollSuccessObservedAtMs === null) return Number.POSITIVE_INFINITY;
    return Math.max(0, now - this.lastPollSuccessObservedAtMs);
  }

  getNormalizedBook(): NormalizedSpotBook | null {
    return this.lastBook;
  }

  getLastGammaResolve(): GammaResolveResult | null {
    return this.lastGammaResolve;
  }

  /**
   * When {@link getNormalizedBook} is non-null but strategy would still return `no_book`
   * (NaN spread or crossed top), returns a stable reason string.
   */
  describeExecutableBookInvalidReason(): string | null {
    const b = this.lastBook;
    if (b === null) {
      return this.quote === null
        ? "no_book_because_quote_null_after_gamma_poll"
        : "no_book_lastBook_null_unexpected";
    }
    if (!Number.isFinite(b.spreadBps)) {
      return `executable_spread_bps_nan_mid=${b.midPrice}_bid=${b.bestBid}_ask=${b.bestAsk}`;
    }
    if (b.bestAsk < b.bestBid) {
      return `executable_book_crossed_bestAsk=${b.bestAsk}_lt_bestBid=${b.bestBid}`;
    }
    return null;
  }

  private buildBookFromQuote(q: NormalizedBinaryQuote): NormalizedSpotBook {
    const row = this.lastRawRow;
    const bestBidGamma = row ? asNumber(row["bestBid"]) : null;
    const bestAskGamma = row ? asNumber(row["bestAsk"]) : null;
    let bestBid: number;
    let bestAsk: number;
    let mid: number;
    if (
      bestBidGamma !== null &&
      bestAskGamma !== null &&
      bestAskGamma >= bestBidGamma &&
      Number.isFinite(bestBidGamma) &&
      Number.isFinite(bestAskGamma)
    ) {
      bestBid = bestBidGamma;
      bestAsk = bestAskGamma;
      mid = (bestBid + bestAsk) / 2;
    } else {
      mid = q.yesPrice;
      const half = (this.syntheticSpreadBps / 10_000 / 2) * mid;
      bestBid = Math.max(1e-12, mid - half);
      bestAsk = Math.max(bestBid * (1 + 1e-12), mid + half);
    }
    const spreadAbs = bestAsk - bestBid;
    const spreadBps = spreadBpsFromBidAsk(bestBid, bestAsk, mid);
    const t = q.observedAtMs;
    return {
      symbol: q.slug || q.marketId,
      bestBid,
      bestAsk,
      bestBidQty: 0,
      bestAskQty: 0,
      midPrice: mid,
      lastTradePrice: asNumber(row?.["lastTradePrice"]) ?? mid,
      spreadAbs,
      spreadBps,
      eventTimeMs: q.venueUpdatedAtMs ?? t,
      observedAtMs: t,
    };
  }

  private lastRawRow: GammaMarketRow | null = null;

  private async fetchOne(verboseBootstrapLog = false): Promise<void> {
    if (this.closedByUser) return;
    this.httpAttempts += 1;
    this.lastHttpAttemptAtMs = Date.now();
    this.pollCount += 1;

    const gammaQuery =
      this.query.type === "id"
        ? ({ type: "id", value: this.query.value } as const)
        : this.query.type === "slug"
          ? ({ type: "slug", value: this.query.value } as const)
          : ({ type: "condition_id", value: this.query.value } as const);

    try {
      const wantStepLogs =
        verboseBootstrapLog &&
        process.env.BINARY_GAMMA_BOOTSTRAP_LOG !== "0" &&
        process.env.VITEST !== "true";
      const res = await resolveGammaMarketForMonitor({
        http: this.http,
        gammaBase: this.gammaBase,
        query: gammaQuery,
        ...(wantStepLogs ? { log: (line: string) => console.log(line) } : {}),
      });
      this.lastGammaResolve = res;

      if (res.row === null || res.quote === null) {
        this.lastError =
          res.resolution.kind === "failed"
            ? res.resolution.reason
            : (res.parseFailure ?? "gamma_resolve_returned_no_quote");
        return;
      }

      const observedAtMs = Date.now();
      const parsed = parseNormalizedBinaryQuoteFromGammaRow(res.row, observedAtMs);
      if (parsed === null) {
        this.lastError =
          diagnoseGammaRowParseFailure(res.row) ?? "parseNormalizedBinaryQuoteFromGammaRow_failed";
        return;
      }
      this.lastRawRow = res.row;
      this.quote = parsed;
      this.lastBook = this.buildBookFromQuote(parsed);
      this.lastPollSuccessObservedAtMs = observedAtMs;
      this.lastError = null;
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
    }
  }

  async bootstrapRest(): Promise<boolean> {
    await this.fetchOne(true);
    const ok = this.quote !== null;
    if (!ok && this.lastGammaResolve !== null) {
      console.error(
        "[gamma-bootstrap] HTTP trace (see messages above if any). Step summary:\n" +
          formatGammaBootstrapStepsForLog(this.lastGammaResolve.steps)
      );
      console.error(
        `[gamma-bootstrap] resolution=${JSON.stringify(this.lastGammaResolve.resolution)} parseFailure=${this.lastGammaResolve.parseFailure ?? "n/a"}`
      );
    }
    return ok;
  }

  start(): void {
    this.closedByUser = false;
    if (this.pollTimer !== null) return;
    void this.fetchOne(false);
    this.pollTimer = setInterval(() => {
      void this.fetchOne(false);
    }, this.pollMs);
  }

  stop(): void {
    this.closedByUser = true;
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }
}
