import type { StrategyTickResult } from "./botLoop.js";
import type { Opportunity } from "./opportunityTracker.js";

/** Funnel levels (increment only via {@link StrategyStatsTracker.observeReadyTickFunnel}). */
export type ReadyTickFunnelSnapshot = {
  /**
   * Level 1 — raw spike context: detector fired, or a borderline promotion tick
   * (counts as one spike for reporting consistency).
   */
  spikeRawEvent: boolean;
  /**
   * Level 2 — passes base movement filter: strong_spike or borderline path (subset of level 1).
   */
  candidatePass: boolean;
  /**
   * Level 3 — strategy approves entry (`enter_immediate` or `promote_borderline_candidate`).
   */
  validEntryApproved: boolean;
  /** Level 4 — paper sim actually opened a position this tick. */
  positionOpenedThisTick: boolean;
};

export class StrategyStatsTracker {
  private readonly exceptionalSpikePercent: number;

  constructor(options?: { exceptionalSpikePercent?: number }) {
    this.exceptionalSpikePercent = Number.isFinite(options?.exceptionalSpikePercent)
      ? Math.max(0, options?.exceptionalSpikePercent ?? 0.0025)
      : 0.0025;
  }

  ticksObserved = 0;
  btcFetchFailures = 0;
  /** Level 1 — raw spike events (see {@link ReadyTickFunnelSnapshot.spikeRawEvent}). */
  spikeEventsDetected = 0;
  /** Level 2 — candidate opportunities (base filters). */
  candidateOpportunities = 0;
  /** Level 3 — strategy-approved entries. */
  validOpportunities = 0;
  /** Strong-spike rows stored with `status === "rejected"` (diagnostics; see funnel for totals). */
  rejectedOpportunities = 0;
  /** Level 4 — positions opened by the simulation (incremented once per open). */
  tradesExecuted = 0;

  strongSpikeSignals = 0;
  strongSpikeEntries = 0;
  borderlineSignals = 0;
  noSignalMoves = 0;
  borderlineMoves = 0;
  strongSpikeMoves = 0;

  blockedByCooldown = 0;
  blockedByActivePosition = 0;
  blockedByInvalidQuotes = 0;
  blockedByNoisyRange = 0;
  blockedByWidePriorRange = 0;
  blockedByHardRejectUnstableContext = 0;
  cooldownOverridesUsed = 0;
  blockedByExpensiveOppositeSide = 0;
  blockedByNeutralQuotes = 0;
  rejectedByWeakSpikeQuality = 0;
  rejectedByPriorRangeTooWide = 0;
  rejectedByHardUnstableContext = 0;
  rejectedByStrongSpikeContinuation = 0;
  rejectedByBorderlineContinuation = 0;
  rejectedByExpensiveOppositeSide = 0;
  exceptionalSpikeSignals = 0;
  exceptionalSpikeEntries = 0;
  borderlineCandidatesCreated = 0;
  borderlinePromotions = 0;
  borderlineCancellations = 0;
  borderlineExpirations = 0;

  borderlineTradesClosed = 0;
  borderlineWins = 0;
  borderlineLosses = 0;
  borderlinePnL = 0;
  strongSpikeTradesClosed = 0;
  strongSpikeWins = 0;
  strongSpikeLosses = 0;
  strongSpikePnL = 0;
  qualityWeak = 0;
  qualityStrong = 0;
  qualityExceptional = 0;
  private readonly rejectionReasonCounts = new Map<string, number>();

  observeTick(tick: StrategyTickResult): void {
    this.ticksObserved += 1;
    if (tick.kind === "no_btc") {
      this.btcFetchFailures += 1;
      return;
    }
    if (tick.kind !== "ready") return;
    const { entry } = tick;
    const cls = entry.movementClassification;
    if (cls === "strong_spike") {
      this.strongSpikeSignals += 1;
      this.strongSpikeMoves += 1;
      if (entry.movement.strongestMovePercent >= this.exceptionalSpikePercent) {
        this.exceptionalSpikeSignals += 1;
      }
      if (entry.shouldEnter) this.strongSpikeEntries += 1;
    } else if (cls === "borderline") {
      this.borderlineSignals += 1;
      this.borderlineMoves += 1;
    } else {
      this.noSignalMoves += 1;
    }
  }

  /**
   * Single place to increment funnel counters for one ready tick.
   * Call once per monitor tick after pipeline + {@link SimulationEngine.onTick}.
   */
  observeReadyTickFunnel(s: ReadyTickFunnelSnapshot): void {
    if (s.spikeRawEvent) this.spikeEventsDetected += 1;
    if (s.candidatePass) this.candidateOpportunities += 1;
    if (s.validEntryApproved) this.validOpportunities += 1;
    if (s.positionOpenedThisTick) this.tradesExecuted += 1;

    if (s.positionOpenedThisTick && !s.validEntryApproved) {
      console.error(
        "[monitor] Report invariant: position opened without valid entry approval"
      );
    }
    if (s.validEntryApproved && !s.candidatePass) {
      console.error(
        "[monitor] Report invariant: valid entry without candidate pass"
      );
    }
    if (s.candidatePass && !s.spikeRawEvent) {
      console.error(
        "[monitor] Report invariant: candidate without raw spike event"
      );
    }
  }

  /**
   * Per-tick diagnostics from the strong-spike {@link Opportunity} row (if any).
   * Does not increment funnel totals — use {@link observeReadyTickFunnel} for those.
   */
  observeOpportunityRecord(recorded: Opportunity | null): void {
    if (recorded === null) return;
    if (recorded.status === "valid") {
      if (recorded.cooldownOverridden === true) {
        this.cooldownOverridesUsed += 1;
      }
      if (recorded.qualityProfile === "exceptional") {
        this.exceptionalSpikeEntries += 1;
      }
    } else {
      this.rejectedOpportunities += 1;
      const reasons = new Set(recorded.entryRejectionReasons);
      for (const reason of reasons) {
        this.rejectionReasonCounts.set(
          reason,
          (this.rejectionReasonCounts.get(reason) ?? 0) + 1
        );
      }
      if (reasons.has("entry_cooldown_active")) this.blockedByCooldown += 1;
      if (reasons.has("active_position_open")) this.blockedByActivePosition += 1;
      if (reasons.has("invalid_market_prices") || reasons.has("missing_quote_data")) {
        this.blockedByInvalidQuotes += 1;
      }
      if (reasons.has("pre_spike_range_too_noisy")) this.blockedByNoisyRange += 1;
      if (reasons.has("prior_range_too_wide_for_mean_reversion")) {
        this.blockedByWidePriorRange += 1;
        this.rejectedByPriorRangeTooWide += 1;
      }
      if (reasons.has("hard_reject_unstable_pre_spike_context")) {
        this.blockedByHardRejectUnstableContext += 1;
        this.rejectedByHardUnstableContext += 1;
      }
      if (reasons.has("opposite_side_price_too_high")) {
        this.blockedByExpensiveOppositeSide += 1;
        this.rejectedByExpensiveOppositeSide += 1;
      }
      if (reasons.has("market_quotes_too_neutral")) {
        this.blockedByNeutralQuotes += 1;
      }
      if (
        reasons.has("quality_gate_rejected") &&
        recorded.qualityProfile === "weak"
      ) {
        this.rejectedByWeakSpikeQuality += 1;
      }
      if (reasons.has("strong_spike_continuation")) {
        this.rejectedByStrongSpikeContinuation += 1;
      }
      if (reasons.has("borderline_cancelled_continuation")) {
        this.rejectedByBorderlineContinuation += 1;
      }
    }
    if (recorded.qualityProfile === "exceptional") this.qualityExceptional += 1;
    else if (recorded.qualityProfile === "strong") this.qualityStrong += 1;
    else this.qualityWeak += 1;
  }

  getTopRejectionReasons(limit = 5): Array<{ reason: string; count: number }> {
    return [...this.rejectionReasonCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, Math.max(0, limit))
      .map(([reason, count]) => ({ reason, count }));
  }

  // Backward-compatible aliases used by previous runtime summaries/tests.
  get noSignalCount(): number {
    return this.noSignalMoves;
  }
  get borderlineCount(): number {
    return this.borderlineMoves;
  }
  get strongSpikeCount(): number {
    return this.strongSpikeMoves;
  }

  observeBorderlineLifecycleEventType(
    type: "created" | "watch" | "promoted" | "cancelled" | "expired"
  ): void {
    if (type === "created") this.borderlineCandidatesCreated += 1;
    else if (type === "promoted") this.borderlinePromotions += 1;
    else if (type === "cancelled") this.borderlineCancellations += 1;
    else if (type === "expired") this.borderlineExpirations += 1;
  }

  observeClosedTrade(trade: {
    entryPath: "strong_spike_immediate" | "borderline_delayed";
    profitLoss: number;
  }): void {
    if (trade.entryPath === "borderline_delayed") {
      this.borderlineTradesClosed += 1;
      this.borderlinePnL += trade.profitLoss;
      if (trade.profitLoss > 0) this.borderlineWins += 1;
      else if (trade.profitLoss < 0) this.borderlineLosses += 1;
      return;
    }
    this.strongSpikeTradesClosed += 1;
    this.strongSpikePnL += trade.profitLoss;
    if (trade.profitLoss > 0) this.strongSpikeWins += 1;
    else if (trade.profitLoss < 0) this.strongSpikeLosses += 1;
  }

  get borderlineAveragePnL(): number {
    return this.borderlineTradesClosed > 0
      ? this.borderlinePnL / this.borderlineTradesClosed
      : 0;
  }

  get strongSpikeAveragePnL(): number {
    return this.strongSpikeTradesClosed > 0
      ? this.strongSpikePnL / this.strongSpikeTradesClosed
      : 0;
  }

  get borderlineWinRate(): number {
    return this.borderlineTradesClosed > 0
      ? (this.borderlineWins / this.borderlineTradesClosed) * 100
      : 0;
  }

  get strongSpikeWinRate(): number {
    return this.strongSpikeTradesClosed > 0
      ? (this.strongSpikeWins / this.strongSpikeTradesClosed) * 100
      : 0;
  }
}

/** Call on shutdown: funnel totals must satisfy trades ≤ valid ≤ candidate ≤ spikes. */
export function logReportCounterConsistency(s: {
  tradesExecuted: number;
  validOpportunities: number;
  candidateOpportunities: number;
  spikeEventsDetected: number;
}): void {
  if (s.tradesExecuted > s.validOpportunities) {
    console.error(
      `[monitor] Report consistency error: tradesExecuted (${s.tradesExecuted}) > validOpportunities (${s.validOpportunities})`
    );
  }
  if (s.validOpportunities > s.candidateOpportunities) {
    console.error(
      `[monitor] Report consistency error: validOpportunities (${s.validOpportunities}) > candidateOpportunities (${s.candidateOpportunities})`
    );
  }
  if (s.candidateOpportunities > s.spikeEventsDetected) {
    console.error(
      `[monitor] Report consistency error: candidateOpportunities (${s.candidateOpportunities}) > spikeEventsDetected (${s.spikeEventsDetected})`
    );
  }
}
