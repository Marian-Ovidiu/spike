import type { MarketMode } from "../../market/types.js";

/**
 * Binary-first product: `MARKET_MODE=spot` (legacy Binance book **execution** paper) is opt-in.
 * Set `LEGACY_SPOT_MARKET_MODE=1` (or `true` / `yes`) to acknowledge. Does **not** apply to
 * `MARKET_MODE=binary` (Binance remains the **signal** feed there).
 */
export function assertLegacySpotMarketModeAcknowledged(mode: MarketMode): void {
  if (mode !== "spot") return;
  const raw = process.env.LEGACY_SPOT_MARKET_MODE?.trim().toLowerCase();
  if (raw === "1" || raw === "true" || raw === "yes") return;
  console.error(
    "[legacy-spot] MARKET_MODE=spot is legacy-only. Binance spot as **signal** for binary is unchanged — use MARKET_MODE=binary.\n" +
      "To run deprecated spot **execution** paper anyway, set LEGACY_SPOT_MARKET_MODE=1 in the environment."
  );
  process.exit(1);
}
