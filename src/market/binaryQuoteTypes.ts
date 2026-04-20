/**
 * Normalized YES/NO (or first two outcome) prices from a Polymarket Gamma market row.
 * Data-only — no order placement.
 */
export type NormalizedBinaryQuote = {
  marketId: string;
  conditionId: string | null;
  slug: string;
  question: string;
  /** Implied YES probability (0–1) from Gamma `outcomePrices` (or CLOB mid when used). */
  yesPrice: number;
  /** Implied NO probability (0–1). */
  noPrice: number;
  /** Local time when this snapshot was parsed from HTTP. */
  observedAtMs: number;
  /**
   * How old the venue-reported `updatedAt` is relative to `observedAtMs`
   * (`observedAtMs - venueUpdatedAtMs`), or `null` if server time missing.
   */
  quoteAgeMs: number | null;
  venueUpdatedAtMs: number | null;
  active: boolean | null;
  closed: boolean | null;
  /** Total market volume when present (`volumeNum` or parsed `volume`). */
  volume: number | null;
};
