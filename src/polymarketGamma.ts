import axios from "axios";

const GAMMA_API_BASE = "https://gamma-api.polymarket.com";

const REQUEST_TIMEOUT_MS = 12_000;
const DISCOVERY_REFRESH_MS = 10 * 60 * 1000;

/** Gamma market list item (subset of fields we use). */
export type GammaMarket = {
  id: string;
  slug: string;
  question: string;
  outcomes: string;
  outcomePrices: string;
  volumeNum?: number;
  active?: boolean;
  closed?: boolean;
};

export type PolymarketYesNoPrices = {
  /** YES outcome price (0–1), maps to strategy `upSidePrice`. */
  yesPrice: number;
  /** NO outcome price (0–1), maps to strategy `downSidePrice`. */
  noPrice: number;
  marketId: string;
  slug: string;
  question: string;
};

let cachedMarketId: string | null = null;
let lastDiscoveryAt = 0;

function parseYesNoFromMarket(m: GammaMarket): PolymarketYesNoPrices | null {
  try {
    const prices = JSON.parse(m.outcomePrices) as unknown;
    if (!Array.isArray(prices) || prices.length < 2) return null;
    const yes = Number(prices[0]);
    const no = Number(prices[1]);
    if (!Number.isFinite(yes) || !Number.isFinite(no)) return null;
    return {
      yesPrice: yes,
      noPrice: no,
      marketId: m.id,
      slug: m.slug,
      question: m.question,
    };
  } catch {
    return null;
  }
}

/** Extract likely USD price levels from a market question (e.g. $100k, $95,000). */
export function extractUsdLevelsFromQuestion(question: string): number[] {
  const out: number[] = [];
  const re = /\$\s*([\d,.]+)\s*(k|K)?/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(question)) !== null) {
    const g1 = match[1];
    if (g1 === undefined) continue;
    let v = parseFloat(g1.replace(/,/g, ""));
    if (match[2]) v *= 1000;
    if (Number.isFinite(v) && v >= 500) {
      out.push(v);
    }
  }
  return out;
}

/**
 * Pick a market whose referenced USD level is closest to current BTC spot
 * (among BTC-related Gamma listings).
 */
export function selectMarketNearestBtcLevel(
  btcUsd: number,
  markets: readonly GammaMarket[]
): GammaMarket | null {
  const candidates = markets.filter(
    (m) =>
      m.active !== false &&
      m.closed !== true &&
      /bitcoin|btc/i.test(m.question)
  );
  if (candidates.length === 0) return null;

  let best: GammaMarket | null = null;
  let bestScore = Infinity;

  for (const m of candidates) {
    const levels = extractUsdLevelsFromQuestion(m.question);
    if (levels.length === 0) continue;
    const nearest = Math.min(...levels.map((L) => Math.abs(L - btcUsd)));
    if (nearest < bestScore) {
      bestScore = nearest;
      best = m;
    }
  }

  if (best !== null) return best;

  return [...candidates].sort(
    (a, b) => (b.volumeNum ?? 0) - (a.volumeNum ?? 0)
  )[0] ?? null;
}

async function getJson<T>(path: string, params?: Record<string, string>): Promise<T> {
  const res = await axios.get<T>(`${GAMMA_API_BASE}${path}`, {
    params,
    timeout: REQUEST_TIMEOUT_MS,
    validateStatus: (s) => s === 200,
  });
  return res.data;
}

async function fetchMarketById(id: string): Promise<GammaMarket | null> {
  try {
    return await getJson<GammaMarket>(`/markets/${encodeURIComponent(id)}`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[polymarket] Failed to fetch market ${id}: ${msg}`);
    return null;
  }
}

async function fetchMarketsList(
  params: Record<string, string>
): Promise<GammaMarket[]> {
  const data = await getJson<GammaMarket[] | GammaMarket>(
    "/markets",
    params
  );
  return Array.isArray(data) ? data : [data];
}

async function resolveMarketForBtc(btcUsd: number): Promise<GammaMarket | null> {
  const slug = process.env.POLYMARKET_MARKET_SLUG?.trim();
  if (slug) {
    if (cachedMarketId) {
      const refreshed = await fetchMarketById(cachedMarketId);
      if (refreshed) return refreshed;
    }
    const list = await fetchMarketsList({ slug });
    const m = list[0] ?? null;
    if (m) cachedMarketId = m.id;
    return m;
  }

  const id = process.env.POLYMARKET_MARKET_ID?.trim();
  if (id) {
    cachedMarketId = id;
    return fetchMarketById(id);
  }

  const now = Date.now();
  const needDiscovery =
    cachedMarketId === null || now - lastDiscoveryAt > DISCOVERY_REFRESH_MS;

  if (!needDiscovery && cachedMarketId) {
    return fetchMarketById(cachedMarketId);
  }

  const query =
    process.env.POLYMARKET_DISCOVERY_QUERY?.trim() || "bitcoin";
  const list = await fetchMarketsList({
    active: "true",
    closed: "false",
    limit: "100",
    query,
  });

  const picked = selectMarketNearestBtcLevel(btcUsd, list);
  if (picked) {
    cachedMarketId = picked.id;
    lastDiscoveryAt = now;
  }
  return picked;
}

/**
 * When false, binary legs come from `UP_SIDE_PRICE` / `DOWN_SIDE_PRICE`.
 * When true, fetch YES/NO from Polymarket Gamma (slug, id, or discovery).
 *
 * Override with `BINARY_MARKET_SOURCE=env` or `gamma`.
 */
export function isPolymarketGammaEnabled(): boolean {
  const mode = process.env.BINARY_MARKET_SOURCE?.trim().toLowerCase();
  if (mode === "env" || mode === "static") return false;
  if (mode === "gamma" || mode === "polymarket") return true;
  const up = process.env.UP_SIDE_PRICE?.trim();
  const down = process.env.DOWN_SIDE_PRICE?.trim();
  if (up && down) return false;
  return true;
}

/**
 * Fetch live YES/NO prices from Polymarket Gamma for the configured or auto-selected BTC-related market.
 * Maps YES → `upSidePrice`, NO → `downSidePrice` for the existing strategy.
 */
export async function fetchPolymarketYesNoForBtc(
  btcUsd: number
): Promise<PolymarketYesNoPrices | null> {
  try {
    const market = await resolveMarketForBtc(btcUsd);
    if (!market) {
      console.error("[polymarket] No market resolved (check env or discovery query)");
      return null;
    }
    const parsed = parseYesNoFromMarket(market);
    if (!parsed) {
      console.error("[polymarket] Could not parse outcomePrices for", market.id);
      return null;
    }
    return parsed;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[polymarket] Gamma request failed: ${msg}`);
    return null;
  }
}

/** Strategy-facing shape: UP = YES, DOWN = NO (Polymarket naming). */
export function polymarketToStrategySides(
  p: PolymarketYesNoPrices
): { upSidePrice: number; downSidePrice: number } {
  return {
    upSidePrice: p.yesPrice,
    downSidePrice: p.noPrice,
  };
}
