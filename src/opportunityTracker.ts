import type { AppConfig } from "./config.js";
import type { EntryEvaluation } from "./entryConditions.js";
import {
  detectContextualSpike,
  detectSpike,
  detectStableRangePriorToLast,
} from "./strategy.js";

/** Direction of the BTC move on the spike candle (not the entry side). */
export type SpikeDirection = "UP" | "DOWN";

/**
 * Every stored row is a raw spike event (`detectSpike`).
 * `valid` = strategy would enter; `rejected` = spike seen but entry disallowed.
 */
export type OpportunityStatus = "valid" | "rejected";

export type Opportunity = {
  timestamp: number;
  btcPrice: number;
  previousPrice: number;
  currentPrice: number;
  spikeDirection: SpikeDirection | null;
  /** Absolute 1-tick relative move as a percent (e.g. 0.42 means 0.42%). */
  spikePercent: number;
  /** Prior-window relative range (max−min)/min as a percent (chop context). */
  priorRangePercent: number;
  upSidePrice: number;
  downSidePrice: number;
  stableRangeDetected: boolean;
  /** Contextual spike (strong vs prior chop). */
  spikeDetected: boolean;
  entryAllowed: boolean;
  /** Same codes as {@link EntryEvaluation.reasons} when rejected. */
  entryRejectionReasons: readonly string[];
  status: OpportunityStatus;
};

export type RecordReadyTickInput = {
  timestamp: number;
  btcPrice: number;
  prices: readonly number[];
  previousPrice: number;
  currentPrice: number;
  sides: { upSidePrice: number; downSidePrice: number };
  entry: EntryEvaluation;
  config: AppConfig;
};

function priorWindowRelativeRangePercent(
  prices: readonly number[]
): number {
  const priorWindow = prices.slice(0, -1);
  if (priorWindow.length < 2) return 0;
  const max = Math.max(...priorWindow);
  const min = Math.min(...priorWindow);
  if (!(min > 0 && Number.isFinite(min) && Number.isFinite(max))) {
    return 0;
  }
  return ((max - min) / min) * 100;
}

function spikeDirectionFromPrices(
  previousPrice: number,
  currentPrice: number
): SpikeDirection | null {
  if (currentPrice > previousPrice) return "UP";
  if (currentPrice < previousPrice) return "DOWN";
  return null;
}

/**
 * Build an {@link Opportunity} for a ready tick when the latest move is a raw spike.
 * Returns `null` when {@link detectSpike} is false (no row created).
 */
export function buildOpportunityFromReadyTick(
  input: RecordReadyTickInput
): Opportunity | null {
  const {
    timestamp,
    btcPrice,
    prices,
    previousPrice,
    currentPrice,
    sides,
    entry,
    config,
  } = input;

  if (
    !detectSpike(
      previousPrice,
      currentPrice,
      config.spikeThreshold
    )
  ) {
    return null;
  }

  const priorWindow = prices.slice(0, -1);
  const stableRangeDetected = detectStableRangePriorToLast(
    prices,
    config.rangeThreshold
  );
  const spikeDetected = detectContextualSpike(
    previousPrice,
    currentPrice,
    config.spikeThreshold,
    priorWindow,
    config.spikeMinRangeMultiple
  );

  const relMove = Math.abs(currentPrice - previousPrice) / previousPrice;
  const spikePercent = relMove * 100;
  const priorRangePercent = priorWindowRelativeRangePercent(prices);

  const spikeDirection = spikeDirectionFromPrices(previousPrice, currentPrice);
  const entryAllowed = entry.shouldEnter;
  const entryRejectionReasons = entryAllowed ? [] : [...entry.reasons];

  return {
    timestamp,
    btcPrice,
    previousPrice,
    currentPrice,
    spikeDirection,
    spikePercent,
    priorRangePercent,
    upSidePrice: sides.upSidePrice,
    downSidePrice: sides.downSidePrice,
    stableRangeDetected,
    spikeDetected,
    entryAllowed,
    entryRejectionReasons,
    status: entryAllowed ? "valid" : "rejected",
  };
}

const DEFAULT_MAX_STORED = 10_000;

export class OpportunityTracker {
  private readonly maxStored: number;
  private readonly opportunities: Opportunity[] = [];

  constructor(options?: { maxStored?: number }) {
    const m = options?.maxStored;
    this.maxStored =
      m !== undefined && Number.isFinite(m) && m > 0
        ? Math.trunc(m)
        : DEFAULT_MAX_STORED;
  }

  /**
   * If the tick is a raw spike, append an {@link Opportunity} and return it.
   * Otherwise return `null`.
   */
  recordFromReadyTick(input: RecordReadyTickInput): Opportunity | null {
    const o = buildOpportunityFromReadyTick(input);
    if (!o) return null;
    this.opportunities.push(o);
    if (this.opportunities.length > this.maxStored) {
      const drop = this.opportunities.length - this.maxStored;
      this.opportunities.splice(0, drop);
    }
    return o;
  }

  /** In-memory history (oldest → newest, capped by `maxStored`). */
  getOpportunities(): readonly Opportunity[] {
    return this.opportunities;
  }

  get counts(): { rawSpikeEvents: number; valid: number; rejected: number } {
    let valid = 0;
    let rejected = 0;
    for (const o of this.opportunities) {
      if (o.status === "valid") valid += 1;
      else rejected += 1;
    }
    return {
      rawSpikeEvents: this.opportunities.length,
      valid,
      rejected,
    };
  }

}
