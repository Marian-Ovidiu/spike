import { config } from "./config.js";
import { runBacktestFromFile } from "./backtest.js";

async function main(): Promise<void> {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error("Usage: node backtestRunner.js <path-to-price-file.csv>");
    process.exit(1);
  }

  const result = await runBacktestFromFile(filePath, { config });

  console.log("─── Backtest results ───");
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
