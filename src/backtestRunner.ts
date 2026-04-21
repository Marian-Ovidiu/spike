import { writeFile } from "node:fs/promises";

import type { BacktestResult } from "./backtest.js";
import { runBacktestFromFile, runBinaryBacktestFromFile } from "./backtest.js";
import { config } from "./config.js";

const BACKTEST_SUMMARY_SCHEMA = "backtest_summary_v1" as const;

type BacktestSummaryJson = {
  schema: typeof BACKTEST_SUMMARY_SCHEMA;
  replayMode: "binary" | "legacy_spot";
  inputPath: string;
  writtenAt: string;
  marketMode: "binary" | "spot";
  evaluationNote: string;
  simulation: {
    totalTrades: number;
    wins: number;
    losses: number;
    winRatePercent: number;
    totalPnl: number;
    maxDrawdown: number;
    totalEntries: number;
  };
  movement: BacktestResult["movement"];
  blockers: BacktestResult["blockers"];
  strongSpike: BacktestResult["strongSpike"];
  borderline: BacktestResult["borderline"];
  combined: BacktestResult["combined"];
  binaryRunAnalytics?: BacktestResult["binaryRunAnalytics"];
};

function parseArgs(argv: string[]): {
  filePath: string;
  spotLegacy: boolean;
  jsonOutPath: string | undefined;
  noStrictComparison: boolean;
} {
  let filePath = "";
  let spotLegacy = false;
  let jsonOutPath: string | undefined;
  let noStrictComparison = false;
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--spot-legacy") {
      spotLegacy = true;
      continue;
    }
    if (a === "--no-strict-comparison") {
      noStrictComparison = true;
      continue;
    }
    if (a === "--json-out") {
      const next = argv[i + 1];
      if (!next || next.startsWith("-")) {
        console.error("Usage: --json-out requires a file path");
        process.exit(1);
      }
      jsonOutPath = next;
      i += 1;
      continue;
    }
    if (a.startsWith("-")) {
      console.error(`Unknown flag: ${a}`);
      process.exit(1);
    }
    if (!filePath) filePath = a;
    else {
      console.error(`Unexpected extra argument: ${a}`);
      process.exit(1);
    }
  }
  if (!filePath) {
    console.error(
      "Usage: node backtestRunner.js <path-to-price-file.csv> [options]\n" +
        "  Default: binary-first replay (BTC signal → probability → synthetic YES/NO → same pipeline as live monitor).\n" +
        "  --spot-legacy     Legacy CSV replay (Binance-mid paper execution); sets LEGACY_SPOT_MARKET_MODE for this process.\n" +
        "  --json-out <path> Write comparable summary JSON (includes binaryRunAnalytics when replayMode=binary).\n" +
        "  --no-strict-comparison  Skip relaxed-vs-strict baseline comparison (faster; binary replay only).\n" +
        "\n" +
        "Synthetic venue profile during binary replay: SYNTHETIC_MARKET_PROFILE and SYNTHETIC_MARKET_* from the environment."
    );
    process.exit(1);
  }
  return { filePath, spotLegacy, jsonOutPath, noStrictComparison };
}

function buildSummaryJson(
  result: BacktestResult,
  replayMode: "binary" | "legacy_spot",
  inputPath: string
): BacktestSummaryJson {
  const base: BacktestSummaryJson = {
    schema: BACKTEST_SUMMARY_SCHEMA,
    replayMode,
    inputPath,
    writtenAt: new Date().toISOString(),
    marketMode: replayMode === "binary" ? "binary" : "spot",
    evaluationNote: result.evaluationNote,
    simulation: {
      totalTrades: result.totalTrades,
      wins: result.wins,
      losses: result.losses,
      winRatePercent: result.winRate,
      totalPnl: result.totalProfit,
      maxDrawdown: result.maxDrawdown,
      totalEntries: result.totalEntries,
    },
    movement: result.movement,
    blockers: result.blockers,
    strongSpike: result.strongSpike,
    borderline: result.borderline,
    combined: result.combined,
  };
  if (result.binaryRunAnalytics !== undefined) {
    base.binaryRunAnalytics = result.binaryRunAnalytics;
  }
  return base;
}

async function main(): Promise<void> {
  const { filePath, spotLegacy, jsonOutPath, noStrictComparison } = parseArgs(process.argv);

  let result: BacktestResult;
  if (spotLegacy) {
    process.env.LEGACY_SPOT_MARKET_MODE = "1";
    result = await runBacktestFromFile(filePath, { config });
  } else {
    result = await runBinaryBacktestFromFile(filePath, {
      config,
      includeStrictComparison: !noStrictComparison,
    });
  }

  if (jsonOutPath !== undefined) {
    const payload = buildSummaryJson(
      result,
      spotLegacy ? "legacy_spot" : "binary",
      filePath
    );
    await writeFile(jsonOutPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    console.log(`Wrote summary JSON → ${jsonOutPath}`);
  }

  console.log(
    spotLegacy
      ? "─── Backtest results (legacy spot CSV replay) ───"
      : "─── Backtest results (binary CSV replay) ───"
  );
  console.log(`  Trades:     ${result.totalTrades} (wins: ${result.wins}, losses: ${result.losses})`);
  console.log(`  Total entries: ${result.totalEntries}`);
  console.log(`  Win rate:   ${result.winRate.toFixed(2)}%`);
  console.log(`  Total P/L:  ${result.totalProfit >= 0 ? "+" : ""}${result.totalProfit.toFixed(4)}`);
  console.log(`  Max equity DD: ${result.maxDrawdown.toFixed(4)}`);
  console.log("");
  console.log("  Strong spike (immediate):");
  console.log(
    `    signals ${result.strongSpike.signals}  | entries ${result.strongSpike.entries}  | trades ${result.strongSpike.tradesClosed}`
  );
  console.log(
    `    win ${result.strongSpike.winRate.toFixed(2)}%  | avg ${result.strongSpike.averagePnL >= 0 ? "+" : ""}${result.strongSpike.averagePnL.toFixed(4)}  | Σ ${result.strongSpike.totalPnL >= 0 ? "+" : ""}${result.strongSpike.totalPnL.toFixed(4)}`
  );
  console.log("  Borderline (delayed):");
  console.log(
    `    signals ${result.borderline.signals}  | created ${result.borderline.candidatesCreated}  | promoted ${result.borderline.promotions}  | cancelled ${result.borderline.cancellations}  | expired ${result.borderline.expirations}`
  );
  console.log(
    `    trades ${result.borderline.tradesClosed}  | win ${result.borderline.winRate.toFixed(2)}%  | avg ${result.borderline.averagePnL >= 0 ? "+" : ""}${result.borderline.averagePnL.toFixed(4)}  | Σ ${result.borderline.totalPnL >= 0 ? "+" : ""}${result.borderline.totalPnL.toFixed(4)}`
  );
  console.log("  Combined:");
  console.log(
    `    trades ${result.combined.tradesClosed}  | win ${result.combined.winRate.toFixed(2)}%  | avg ${result.combined.averagePnL >= 0 ? "+" : ""}${result.combined.averagePnL.toFixed(4)}  | Σ ${result.combined.totalPnL >= 0 ? "+" : ""}${result.combined.totalPnL.toFixed(4)}`
  );
  console.log("  Movement:");
  console.log(
    `    no-signal ${result.movement.noSignalMoves}  | borderline ${result.movement.borderlineMoves}  | strong ${result.movement.strongSpikeMoves}`
  );
  console.log("  Blockers:");
  console.log(
    `    cooldown ${result.blockers.blockedByCooldown}  | active-pos ${result.blockers.blockedByActivePosition}  | invalid-quotes ${result.blockers.blockedByInvalidQuotes}  | noisy-range ${result.blockers.blockedByNoisyRange}  | wide-prior ${result.blockers.blockedByWidePriorRange}  | hard-reject ${result.blockers.blockedByHardRejectUnstableContext}  | overrides ${result.blockers.cooldownOverridesUsed}  | expensive-opp ${result.blockers.blockedByExpensiveOppositeSide}  | neutral ${result.blockers.blockedByNeutralQuotes}`
  );
  console.log(
    `  Selectivity diagnostics: weak-quality ${result.blockers.rejectedByWeakSpikeQuality}  | prior-wide ${result.blockers.rejectedByPriorRangeTooWide}  | hard-unstable ${result.blockers.rejectedByHardUnstableContext}  | strong-cont ${result.blockers.rejectedByStrongSpikeContinuation}  | borderline-cont ${result.blockers.rejectedByBorderlineContinuation}  | expensive-opp ${result.blockers.rejectedByExpensiveOppositeSide}  | exceptional signals/entries ${result.blockers.exceptionalSpikeSignals}/${result.blockers.exceptionalSpikeEntries}`
  );
  console.log(
    `  Weak spikes: signals ${result.weakSpike.signals}  | rejected ${result.weakSpike.rejected}  | reject-rate ${result.weakSpike.rejectionRate.toFixed(2)}%`
  );
  console.log("  Rejection reason breakdown:");
  for (const [reason, count] of Object.entries(result.rejectionReasonBreakdown).sort(
    (a, b) => b[1] - a[1]
  )) {
    console.log(`    ${reason}: ${count}`);
  }
  console.log(`  Evaluation note: ${result.evaluationNote}`);
  if (result.binaryRunAnalytics !== undefined && result.binaryRunAnalytics !== null) {
    const b = result.binaryRunAnalytics;
    console.log("");
    console.log("  Binary run analytics (binary_run_analytics_v2):");
    console.log(
      `    opened ${b.openedTrades}  | closed ${b.closedTrades}  | win ${b.winRate.toFixed(2)}%  | Σ pnl ${b.pnlTotal >= 0 ? "+" : ""}${b.pnlTotal.toFixed(4)}  | timeout rate ${(b.timeoutRate * 100).toFixed(1)}%`
    );
  }
  if (result.noiseComparison !== undefined) {
    console.log(
      `  Noise comparison: refined entries ${result.noiseComparison.refinedEntries} vs baseline ${result.noiseComparison.baselineEntries} | reduced=${result.noiseComparison.reducedNoise ? "yes" : "no"}`
    );
  }
  if (result.comparison !== undefined) {
    console.log("  Relaxed vs strict (same shared core):");
    console.log(
      `    relaxed trades ${result.comparison.relaxed.totalTrades} (win ${result.comparison.relaxed.winRate.toFixed(2)}%, Σ ${result.comparison.relaxed.totalProfit >= 0 ? "+" : ""}${result.comparison.relaxed.totalProfit.toFixed(4)})`
    );
    console.log(
      `    strict  trades ${result.comparison.strict.totalTrades} (win ${result.comparison.strict.winRate.toFixed(2)}%, Σ ${result.comparison.strict.totalProfit >= 0 ? "+" : ""}${result.comparison.strict.totalProfit.toFixed(4)})`
    );
  }
  console.log("─────────────────────────");
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
