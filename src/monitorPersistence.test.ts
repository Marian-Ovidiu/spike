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
        spikeSource: "tick-1" as const,
        spikeReferencePrice: 99_000,
        priorRangePercent: 0.1,
        upSidePrice: 0.4,
        downSidePrice: 0.35,
        stableRangeDetected: true,
        stableRangeQuality: "good" as const,
        spikeDetected: true,
        movementClassification: "strong_spike" as const,
        movementThresholdRatio: 1.2,
        tradableSpikeMinPercent: 0.0015,
        qualityProfile: "strong" as const,
        cooldownOverridden: true,
        overrideReason: "exceptional_spike_cooldown_override",
        opportunityType: "strong_spike" as const,
        opportunityOutcome: "entered_immediate" as const,
        movement: {
          strongestMovePercent: 0.015,
          strongestMoveAbsolute: 1500,
          strongestMoveDirection: "UP" as const,
          thresholdPercent: 0.01,
          thresholdRatio: 1.5,
          classification: "strong_spike" as const,
          sourceWindowLabel: "tick-1",
        },
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
        entryPath: "strong_spike_immediate" as const,
        openedAt: 1_700_000_000_000,
        closedAt: 1_700_000_090_000,
      };
      p.appendTradeLine(trade);

      const oppLine = readFileSync(join(dir, "opportunities.jsonl"), "utf8").trim();
      const parsedOpp = JSON.parse(oppLine) as { observedAt: string };
      expect(parsedOpp.observedAt).toBe(new Date(opp.timestamp).toISOString());
      expect((parsedOpp as { stableRangeQuality?: string }).stableRangeQuality).toBe(
        "good"
      );

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
        extended: {
          strongSpikeSignals: 4,
          strongSpikeEntries: 2,
          noSignalMoves: 10,
          borderlineMoves: 5,
          strongSpikeMoves: 4,
          borderlineSignals: 5,
          borderlineCandidatesCreated: 3,
          borderlinePromotions: 1,
          borderlineCancellations: 1,
          borderlineExpirations: 1,
          blockedByCooldown: 2,
          blockedByActivePosition: 1,
          blockedByInvalidQuotes: 1,
          blockedByNoisyRange: 0,
          blockedByWidePriorRange: 0,
          blockedByHardRejectUnstableContext: 0,
          rejectedByWeakSpikeQuality: 2,
          rejectedByPriorRangeTooWide: 1,
          rejectedByHardUnstableContext: 0,
          rejectedByStrongSpikeContinuation: 1,
          rejectedByBorderlineContinuation: 1,
          rejectedByExpensiveOppositeSide: 1,
          exceptionalSpikeSignals: 3,
          exceptionalSpikeEntries: 1,
          cooldownOverridesUsed: 1,
          blockedByExpensiveOppositeSide: 1,
          blockedByNeutralQuotes: 0,
          borderlineTradesClosed: 1,
          borderlineWins: 1,
          borderlineLosses: 0,
          borderlinePnL: 0.2,
          averageBorderlinePnL: 0.2,
          strongSpikeTradesClosed: 2,
          strongSpikeWins: 1,
          strongSpikeLosses: 1,
          strongSpikePnL: 0.1,
          averageStrongSpikePnL: 0.05,
          strongSpikeWinRate: 50,
          delayedBorderlineWinRate: 100,
          borderlineNetImpact: "positive",
          verdict: "helpful",
          qualityWeak: 2,
          qualityStrong: 3,
          qualityExceptional: 1,
          topRejectionReasons: [{ reason: "quality_gate_rejected", count: 2 }],
          interpretation: [
            "strong spikes were present and strategy now entered them",
          ],
        },
      });
      p.writeSessionSummary(summary);
      const sumRaw = readFileSync(join(dir, "session-summary.json"), "utf8");
      const sum = JSON.parse(sumRaw) as { sessionStartedAt: string; runtimeMs: number };
      expect(sum.sessionStartedAt).toBe(new Date(1000).toISOString());
      expect(sum.runtimeMs).toBe(4000);
      expect(
        (
          sum as {
            extended?: { blockedByCooldown?: number; interpretation?: string[] };
          }
        ).extended?.blockedByCooldown
      ).toBe(2);
      expect(
        (
          sum as {
            extended?: { blockedByCooldown?: number; interpretation?: string[] };
          }
        ).extended?.interpretation?.[0]
      ).toContain("strong spikes");
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
      spikeSource: null,
      spikeReferencePrice: 1,
      priorRangePercent: 0,
      upSidePrice: 0.5,
      downSidePrice: 0.5,
      stableRangeDetected: false,
      stableRangeQuality: "poor",
      spikeDetected: false,
      movementClassification: "no_signal",
      tradableSpikeMinPercent: 0.0015,
      qualityProfile: "weak",
      cooldownOverridden: false,
      overrideReason: null,
      movement: {
        strongestMovePercent: 0,
        strongestMoveAbsolute: 0,
        strongestMoveDirection: null,
        thresholdPercent: 0.01,
        thresholdRatio: 0,
        classification: "no_signal",
        sourceWindowLabel: null,
      },
      movementThresholdRatio: 0,
      opportunityType: "borderline",
      opportunityOutcome: "rejected",
      thresholdRatio: 0.9,
      watchTicksConfigured: 2,
      watchTicksObserved: 1,
      postMoveClassification: "pause",
      cancellationReason: "waiting_for_pause_or_reversion",
      borderlineCandidateId: "bl-1",
      entryAllowed: false,
      entryRejectionReasons: ["market_not_stable"],
      status: "rejected",
    });
    expect(r.observedAt).toBe("1970-01-01T00:00:00.000Z");
    expect(r.stableRangeQuality).toBe("poor");
    expect(r.thresholdRatio).toBe(0.9);
    expect(r.movementClassification).toBe("no_signal");
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
      entryPath: "borderline_delayed",
      openedAt: 1000,
      closedAt: 2000,
    });
    expect(r.openedAt).toBe(new Date(1000).toISOString());
    expect(r.closedAt).toBe(new Date(2000).toISOString());
    expect(r.holdDurationMs).toBe(1000);
  });
});
