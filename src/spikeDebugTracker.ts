import type { StrategyTickResult } from "./botLoop.js";
import {
  type WindowSpikeComparison,
  type WindowSpikeSource,
} from "./strategy.js";
import { classifyMovementWindow } from "./movementClassifier.js";

const DEBUG_SUMMARY_EVERY_N_TICKS = 30;

export type SpikeDebugSnapshot = {
  currentPrice: number;
  /** Reference price that produced the strongest move (may not be tick-1). */
  referencePrice: number;
  /** Which look-back comparison produced the strongest move. */
  source: WindowSpikeSource;
  classification: "no_signal" | "borderline" | "strong_spike";
  thresholdRatio: number;
  absoluteDelta: number;
  /** Percent of the strongest move (e.g. 0.6 means 0.6%). */
  percentDelta: number;
  configuredSpikeThreshold: number;
  spikeDetected: boolean;
  direction: "up" | "down" | null;
  comparisons: WindowSpikeComparison[];
};

export type SpikeDebugSessionMaxima = {
  maxAbsoluteDelta: number;
  maxPercentDelta: number;
  maxAbsoluteDeltaTick: number;
  maxPercentDeltaTick: number;
};

export class SpikeDebugTracker {
  private readyTickCount = 0;
  private maxAbsDelta = 0;
  private maxPctDelta = 0;
  private maxAbsDeltaTick = 0;
  private maxPctDeltaTick = 0;
  private spikeThreshold = 0;
  private readonly summaryInterval: number;

  constructor(summaryInterval = DEBUG_SUMMARY_EVERY_N_TICKS) {
    this.summaryInterval = summaryInterval;
  }

  /**
   * Feed a ready tick and return its window-spike diagnostics.
   * Returns `null` for non-ready ticks (nothing to diagnose).
   */
  observeTick(
    tick: StrategyTickResult,
    spikeThreshold: number,
    borderlineMinRatio = 0.85,
  ): SpikeDebugSnapshot | null {
    this.spikeThreshold = spikeThreshold;
    if (tick.kind !== "ready") return null;

    this.readyTickCount += 1;

    const ws = classifyMovementWindow({
      prices: tick.prices,
      spikeThreshold,
      borderlineMinRatio,
      windowTicks: 2,
    });
    const percentDelta = ws.strongestMove * 100;

    if (ws.strongestAbsDelta > this.maxAbsDelta) {
      this.maxAbsDelta = ws.strongestAbsDelta;
      this.maxAbsDeltaTick = this.readyTickCount;
    }
    if (percentDelta > this.maxPctDelta) {
      this.maxPctDelta = percentDelta;
      this.maxPctDeltaTick = this.readyTickCount;
    }

    return {
      currentPrice: ws.currentPrice,
      referencePrice: ws.referencePrice,
      source: ws.source,
      classification: ws.classification,
      thresholdRatio: ws.thresholdRatio,
      absoluteDelta: ws.strongestAbsDelta,
      percentDelta,
      configuredSpikeThreshold: spikeThreshold,
      spikeDetected: ws.detected,
      direction: ws.direction,
      comparisons: ws.comparisons,
    };
  }

  getSessionMaxima(): SpikeDebugSessionMaxima {
    return {
      maxAbsoluteDelta: this.maxAbsDelta,
      maxPercentDelta: this.maxPctDelta,
      maxAbsoluteDeltaTick: this.maxAbsDeltaTick,
      maxPercentDeltaTick: this.maxPctDeltaTick,
    };
  }

  getReadyTickCount(): number {
    return this.readyTickCount;
  }

  shouldPrintSummary(): boolean {
    return (
      this.readyTickCount > 0 &&
      this.readyTickCount % this.summaryInterval === 0
    );
  }

  /**
   * Compact per-tick debug line with all window comparisons.
   */
  static formatTickDebugLine(snap: SpikeDebugSnapshot): string {
    const dir = snap.direction === "up" ? "▲" : snap.direction === "down" ? "▼" : "—";
    const pctStr = snap.percentDelta.toFixed(4);
    const threshStr = (snap.configuredSpikeThreshold * 100).toFixed(4);
    const detected = snap.spikeDetected ? "YES" : "no";
    const cls = snap.classification;
    const ratio =
      snap.configuredSpikeThreshold > 0
        ? (snap.percentDelta / 100 / snap.configuredSpikeThreshold).toFixed(2)
        : "n/a";

    const cmpStr = snap.comparisons
      .map((c) => {
        const tag = c.source.replace("tick-", "t").replace("window-oldest", "win");
        const pct = (c.relativeMove * 100).toFixed(2);
        return `${tag}:${pct}%${c.exceeds ? "!" : ""}`;
      })
      .join(" ");

    return (
      `       spike? ${detected} (${snap.source})  │  cls ${cls}  │  ratio ${snap.thresholdRatio.toFixed(2)}x  │  ` +
      `${dir} Δ $${snap.absoluteDelta.toFixed(2)}  ${pctStr}%  │  thresh ${threshStr}%  │  move/thresh ${ratio}x  │  ${cmpStr}`
    );
  }

  /**
   * Compact multi-line summary printed every N ready ticks.
   */
  formatSummary(): string {
    const max = this.getSessionMaxima();
    const threshPct = (this.spikeThreshold * 100).toFixed(4);
    const headroom =
      this.spikeThreshold > 0
        ? `${((max.maxPercentDelta / 100) / this.spikeThreshold).toFixed(2)}x`
        : "n/a";
    const diagnosis =
      max.maxPercentDelta / 100 > this.spikeThreshold
        ? "spikes are occurring (max window move exceeds threshold)"
        : max.maxPercentDelta / 100 > this.spikeThreshold * 0.5
          ? "borderline — largest window move reaches >50% of threshold but never crosses"
          : "no moves close to threshold — prices are flat or threshold is too high";

    const lines = [
      "",
      `── Spike debug (${this.readyTickCount} ready ticks, window mode) ──`,
      `  threshold   ${threshPct}% (configured SPIKE_THRESHOLD)`,
      `  max |Δ|     $${max.maxAbsoluteDelta.toFixed(2)} at tick #${max.maxAbsoluteDeltaTick}`,
      `  max |Δ%|    ${max.maxPercentDelta.toFixed(4)}% at tick #${max.maxPercentDeltaTick}`,
      `  headroom    ${headroom}  (max window move ÷ threshold)`,
      `  diagnosis   ${diagnosis}`,
      "",
    ];
    return lines.join("\n");
  }
}
