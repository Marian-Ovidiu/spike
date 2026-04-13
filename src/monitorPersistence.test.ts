import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildMonitorSessionSummary,
  MonitorFilePersistence,
  opportunityToJsonlRecord,
  tradeToJsonlRecord,
} from "./monitorPersistence.js";
import { SimulationEngine } from "./simulationEngine.js";

describe("monitorPersistence", () => {
  it("creates dir and appends JSONL lines", () => {
    const dir = mkdtempSync(join(tmpdir(), "spike-monitor-"));
    try {
      const p = new MonitorFilePersistence(dir);
      p.ensureReady();

      const opp = {
        timestamp: 1_700_000_000_000,
        btcPrice: 100_000,
        previousPrice: 99_000,
        currentPrice: 100_500,
        spikeDirection: "UP" as const,
        spikePercent: 1.5,
        priorRangePercent: 0.1,
        upSidePrice: 0.4,
        downSidePrice: 0.35,
        stableRangeDetected: true,
        spikeDetected: true,
        entryAllowed: true,
        entryRejectionReasons: [] as const,
        status: "valid" as const,
      };
      p.appendOpportunityLine(opp);

      const trade = {
        id: 1,
        direction: "UP" as const,
        contracts: 2,
        entryPrice: 0.2,
        exitPrice: 0.5,
        profitLoss: 0.6,
        riskAtEntry: 0.1,
        exitReason: "profit" as const,
        openedAt: 1_700_000_000_000,
        closedAt: 1_700_000_090_000,
      };
      p.appendTradeLine(trade);

      const oppLine = readFileSync(join(dir, "opportunities.jsonl"), "utf8").trim();
      const parsedOpp = JSON.parse(oppLine) as { observedAt: string };
      expect(parsedOpp.observedAt).toBe(new Date(opp.timestamp).toISOString());

      const tradeLine = readFileSync(join(dir, "trades.jsonl"), "utf8").trim();
      const parsedTrade = JSON.parse(tradeLine) as { closedAt: string };
      expect(parsedTrade.closedAt).toBe(new Date(trade.closedAt).toISOString());

      const sim = new SimulationEngine({ silent: true, initialEquity: 1000 });
      const summary = buildMonitorSessionSummary({
        outputDirectory: dir,
        startedAtMs: 1000,
        endedAtMs: 5000,
        ticksObserved: 10,
        btcFetchFailures: 0,
        spikeEventsDetected: 2,
        candidateOpportunities: 1,
        validOpportunities: 1,
        rejectedOpportunities: 1,
        perf: sim.getPerformanceStats(),
      });
      p.writeSessionSummary(summary);
      const sumRaw = readFileSync(join(dir, "session-summary.json"), "utf8");
      const sum = JSON.parse(sumRaw) as { sessionStartedAt: string; runtimeMs: number };
      expect(sum.sessionStartedAt).toBe(new Date(1000).toISOString());
      expect(sum.runtimeMs).toBe(4000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("opportunityToJsonlRecord uses ISO observedAt", () => {
    const r = opportunityToJsonlRecord({
      timestamp: 0,
      btcPrice: 1,
      previousPrice: 1,
      currentPrice: 1.1,
      spikeDirection: null,
      spikePercent: 0,
      priorRangePercent: 0,
      upSidePrice: 0.5,
      downSidePrice: 0.5,
      stableRangeDetected: false,
      spikeDetected: false,
      entryAllowed: false,
      entryRejectionReasons: ["market_not_stable"],
      status: "rejected",
    });
    expect(r.observedAt).toBe("1970-01-01T00:00:00.000Z");
  });

  it("tradeToJsonlRecord uses ISO openedAt/closedAt", () => {
    const r = tradeToJsonlRecord({
      id: 1,
      direction: "DOWN",
      contracts: 1,
      entryPrice: 0.2,
      exitPrice: 0.1,
      profitLoss: -0.1,
      riskAtEntry: 0.05,
      exitReason: "stop",
      openedAt: 1000,
      closedAt: 2000,
    });
    expect(r.openedAt).toBe(new Date(1000).toISOString());
    expect(r.closedAt).toBe(new Date(2000).toISOString());
    expect(r.holdDurationMs).toBe(1000);
  });
});
