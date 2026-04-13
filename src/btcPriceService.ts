import axios from "axios";

const BINANCE_TICKER_URL = "https://api.binance.com/api/v3/ticker/price";

/** Initial request + up to this many retries after failure. */
const MAX_RETRIES = 3;
const MAX_ATTEMPTS = MAX_RETRIES + 1;

const REQUEST_TIMEOUT_MS = 10_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveSymbol(): string {
  const raw = process.env.BTC_SYMBOL?.trim();
  return raw && raw.length > 0 ? raw : "BTCUSDT";
}

/**
 * Fetches the latest BTC (or configured symbol) price from Binance.
 * On repeated failure, logs errors and returns null — callers should skip work for that tick.
 */
export async function getBTCPrice(): Promise<number | null> {
  const symbol = resolveSymbol();

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await axios.get<{ price: string }>(BINANCE_TICKER_URL, {
        params: { symbol },
        timeout: REQUEST_TIMEOUT_MS,
        validateStatus: (status) => status === 200,
      });

      const price = Number(res.data.price);
      if (!Number.isFinite(price)) {
        console.error(
          `[btc-price] Non-numeric price in response (attempt ${attempt}/${MAX_ATTEMPTS})`
        );
      } else {
        return price;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `[btc-price] Request failed (attempt ${attempt}/${MAX_ATTEMPTS}): ${message}`
      );
    }

    if (attempt < MAX_ATTEMPTS) {
      await delay(200 * attempt);
    }
  }

  console.error(
    `[btc-price] Giving up after ${MAX_ATTEMPTS} attempts for ${symbol}`
  );
  return null;
}
