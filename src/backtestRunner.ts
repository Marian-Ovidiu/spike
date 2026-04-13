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
  console.log(`  Win rate:   ${result.winRate.toFixed(2)}%`);
  console.log(`  Total P/L:  ${result.totalProfit >= 0 ? "+" : ""}${result.totalProfit.toFixed(4)}`);
  console.log(`  Max equity DD: ${result.maxDrawdown.toFixed(4)}`);
  console.log("─────────────────────────");
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
