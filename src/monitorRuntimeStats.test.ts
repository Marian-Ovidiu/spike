import { describe, expect, it, vi } from "vitest";

import { printPeriodicRuntimeSummary, printShutdownReport } from "./monitorConsole.js";
import { MonitorRuntimeStats } from "./monitorRuntimeStats.js";
import { SimulationEngine } from "./simulationEngine.js";

describe("MonitorRuntimeStats", () => {
  it("aggregates tick and opportunity counters", () => {
    const s = new MonitorRuntimeStats();
    s.observeTick({ kind: "no_btc" });
    s.observeTick({
      kind: "warming",
      btc: 1,
      n: 1,
      cap: 20,
    });
    expect(s.ticksObserved).toBe(2);
    expect(s.btcFetchFailures).toBe(1);

    s.observeTick({
      kind: "ready",
      btc: 1,
      n: 11,
      cap: 20,
      prev: 1,
      last: 1,
      prices: [],
      sides: { upSidePrice: 0.5, downSidePrice: 0.5 },
      entry: {
        shouldEnter: false,
        direction: "UP",
        reasons: ["opposite_side_price_too_high"],
      },
    });
    expect(s.candidateOpportunities).toBe(1);

    s.observeOpportunityRecord({
      timestamp: 0,
      btcPrice: 1,
      previousPrice: 1,
      currentPrice: 1.1,
      spikeDirection: "UP",
      spikePercent: 1,
      priorRangePercent: 0.1,
      upSidePrice: 0.5,
      downSidePrice: 0.5,
      stableRangeDetected: true,
      spikeDetected: true,
      entryAllowed: true,
      entryRejectionReasons: [],
      status: "valid",
    });
    expect(s.spikeEventsDetected).toBe(1);
    expect(s.validOpportunities).toBe(1);
    expect(s.rejectedOpportunities).toBe(0);
  });
});

describe("monitorConsole periodic / shutdown", () => {
  it("printPeriodicRuntimeSummary logs", () => {
    const s = new MonitorRuntimeStats();
    const sim = new SimulationEngine({ silent: true, initialEquity: 1000 });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    printPeriodicRuntimeSummary(
      "test",
      {
        ticksObserved: s.ticksObserved,
        btcFetchFailures: s.btcFetchFailures,
        spikeEventsDetected: s.spikeEventsDetected,
        candidateOpportunities: s.candidateOpportunities,
        validOpportunities: s.validOpportunities,
        rejectedOpportunities: s.rejectedOpportunities,
      },
      sim
    );
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });

  it("printShutdownReport logs final report", () => {
    const sim = new SimulationEngine({ silent: true, initialEquity: 1000 });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const t0 = Date.now() - 5000;
    printShutdownReport(
      t0,
      {
        ticksObserved: 3,
        validOpportunities: 1,
        rejectedOpportunities: 0,
      },
      sim.getPerformanceStats()
    );
    const combined = log.mock.calls.map((c) => String(c[0])).join("\n");
    expect(combined).toContain("final report");
    log.mockRestore();
  });
});
