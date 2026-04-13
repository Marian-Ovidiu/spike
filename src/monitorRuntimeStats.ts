import type { StrategyTickResult } from "./botLoop.js";
import type { Opportunity } from "./opportunityTracker.js";

export class MonitorRuntimeStats {
  ticksObserved = 0;
  btcFetchFailures = 0;
  spikeEventsDetected = 0;
  /** Ready ticks: entry direction set but strategy does not enter (e.g. opposite leg too expensive). */
  candidateOpportunities = 0;
  /** Raw spike events where strategy would enter (`Opportunity.status === "valid"`). */
  validOpportunities = 0;
  /** Raw spike events where strategy does not enter (`Opportunity.status === "rejected"`). */
  rejectedOpportunities = 0;

  observeTick(tick: StrategyTickResult): void {
    this.ticksObserved += 1;
    if (tick.kind === "no_btc") {
      this.btcFetchFailures += 1;
      return;
    }
    if (tick.kind !== "ready") return;
    const { entry } = tick;
    if (entry.direction !== null && !entry.shouldEnter) {
      this.candidateOpportunities += 1;
    }
  }

  observeOpportunityRecord(recorded: Opportunity | null): void {
    if (recorded === null) return;
    this.spikeEventsDetected += 1;
    if (recorded.status === "valid") {
      this.validOpportunities += 1;
    } else {
      this.rejectedOpportunities += 1;
    }
  }
}
