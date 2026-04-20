import type { SyntheticMarketProfileName } from "./syntheticMarketProfile.js";

export type SyntheticPricingDiagnosticsSummary = {
  schema: "synthetic_pricing_diagnostics_v1";
  profile: SyntheticMarketProfileName | null;
  widenOnVolatility: number;
  baseSpreadBps: number;
  maxSpreadBps: number;
  ticksObserved: number;
  /** Ticks where |Δ yes mid| > epsilon after the venue step. */
  midMoveTicks: number;
  /** 100 × flatQuoteTicks / ticksObserved (0 if no ticks). */
  flatQuotePercent: number;
  /** Mean |noisyTarget − yesMid before step| (repricing backlog vs published mid). */
  repricingGapMean: number;
  repricingGapMax: number;
  /** Running mean quoted spread (bps) across ticks. */
  meanSpreadBps: number;
  /** Final quoted spread after last tick. */
  finalSpreadBps: number;
  /** EWM of |fair_t − fair_{t−1}| on probability scale. */
  fairJumpEwm: number;
  /** EWM of blended instability (fair jump + vs lagged fair). */
  instabilityEwm: number;
  spreadRegime: {
    /** spread bps ≤ 35 */
    tight: number;
    /** 35 < spread ≤ 70 */
    medium: number;
    /** spread > 70 */
    wide: number;
  };
};

const MID_MOVE_EPS = 1e-7;
const TIGHT_SPREAD_BPS = 35;
const MEDIUM_SPREAD_BPS = 70;

export class SyntheticVenueDiagnosticsCollector {
  private readonly profile: SyntheticMarketProfileName | null;
  private readonly widenOnVolatility: number;
  private readonly baseSpreadBps: number;
  private readonly maxSpreadBps: number;

  private ticks = 0;
  private midMoves = 0;
  private flatQuotes = 0;
  private repricingGapSum = 0;
  private repricingGapMax = 0;
  private spreadSum = 0;
  private lastSpreadBps = 0;
  private fairJumpEwm = 0;
  private instabilityEwm = 0;
  private regimeTight = 0;
  private regimeMedium = 0;
  private regimeWide = 0;

  constructor(input: {
    profile: SyntheticMarketProfileName | null;
    widenOnVolatility: number;
    baseSpreadBps: number;
    maxSpreadBps: number;
  }) {
    this.profile = input.profile;
    this.widenOnVolatility = input.widenOnVolatility;
    this.baseSpreadBps = input.baseSpreadBps;
    this.maxSpreadBps = input.maxSpreadBps;
  }

  /** Clears tick counters (e.g. after a manual `setOutcomePrices` on the synthetic feed). */
  reset(): void {
    this.ticks = 0;
    this.midMoves = 0;
    this.flatQuotes = 0;
    this.repricingGapSum = 0;
    this.repricingGapMax = 0;
    this.spreadSum = 0;
    this.lastSpreadBps = 0;
    this.regimeTight = 0;
    this.regimeMedium = 0;
    this.regimeWide = 0;
  }

  recordTick(input: {
    publishedYesMidBefore: number;
    newYesMidAfter: number;
    noisyTargetYes: number;
    spreadBpsAfter: number;
    fairJumpEwm: number;
    instabilityEwm: number;
  }): void {
    this.ticks += 1;
    const dMid = Math.abs(input.newYesMidAfter - input.publishedYesMidBefore);
    if (dMid > MID_MOVE_EPS) {
      this.midMoves += 1;
    } else {
      this.flatQuotes += 1;
    }

    const gap = Math.abs(input.noisyTargetYes - input.publishedYesMidBefore);
    this.repricingGapSum += gap;
    if (gap > this.repricingGapMax) this.repricingGapMax = gap;

    const sp = input.spreadBpsAfter;
    this.spreadSum += sp;
    this.lastSpreadBps = sp;
    if (sp <= TIGHT_SPREAD_BPS) this.regimeTight += 1;
    else if (sp <= MEDIUM_SPREAD_BPS) this.regimeMedium += 1;
    else this.regimeWide += 1;

    this.fairJumpEwm = input.fairJumpEwm;
    this.instabilityEwm = input.instabilityEwm;
  }

  snapshot(): SyntheticPricingDiagnosticsSummary {
    const n = Math.max(1, this.ticks);
    return {
      schema: "synthetic_pricing_diagnostics_v1",
      profile: this.profile,
      widenOnVolatility: this.widenOnVolatility,
      baseSpreadBps: this.baseSpreadBps,
      maxSpreadBps: this.maxSpreadBps,
      ticksObserved: this.ticks,
      midMoveTicks: this.midMoves,
      flatQuotePercent: this.ticks > 0 ? (100 * this.flatQuotes) / this.ticks : 0,
      repricingGapMean: this.repricingGapSum / n,
      repricingGapMax: this.repricingGapMax,
      meanSpreadBps: this.spreadSum / n,
      finalSpreadBps: this.lastSpreadBps,
      fairJumpEwm: this.fairJumpEwm,
      instabilityEwm: this.instabilityEwm,
      spreadRegime: {
        tight: this.regimeTight,
        medium: this.regimeMedium,
        wide: this.regimeWide,
      },
    };
  }
}
