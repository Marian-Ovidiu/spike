/**
 * Aggregated friction for a trade or round-trip (paper or live).
 * All monetary fields in **quote currency** unless you extend with a currency code.
 */
export interface FeeSlippageSummary {
  readonly feesQuote: number;
  /** Modelled extra cost vs mid at decision time */
  readonly slippageQuoteEstimate?: number;
  /** Optional summary rates for logs / calibration */
  readonly feeRoundTripBps?: number;
  readonly entrySlippageBps?: number;
}
