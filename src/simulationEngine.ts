import type { AppConfig } from "./config.js";
import type { EntryDirection, EntryEvaluation } from "./entryConditions.js";
import { evaluateExitConditions } from "./exitConditions.js";
import type { ExitReason } from "./exitConditions.js";
import { contractsFromRiskBudget, riskPerContractAtStop } from "./riskSizing.js";

export type SimulatedTrade = {
  id: number;
  direction: EntryDirection;
  contracts: number;
  entryPrice: number;
  exitPrice: number;
  /** Total P/L for the position (scaled by contracts). */
  profitLoss: number;
  /** Planned max loss at stop for this size (≤ risk budget). */
  riskAtEntry: number;
  exitReason: ExitReason;
  openedAt: number;
  closedAt: number;
};

type OpenSimPosition = {
  direction: EntryDirection;
  contracts: number;
  entryPrice: number;
  stopLoss: number;
  openedAt: number;
};

export type SimulationTickInput = {
  now: number;
  entry: EntryEvaluation;
  sides: { upSidePrice: number; downSidePrice: number };
  /** Exit, stop, sizing, cooldown. */
  config: Pick<
    AppConfig,
    | "exitPrice"
    | "stopLoss"
    | "exitTimeoutMs"
    | "entryCooldownMs"
    | "riskPercentPerTrade"
  >;
};

/** Aggregates from closed trades only (no live equity). */
export type SimulationTradeStats = {
  totalTrades: number;
  wins: number;
  losses: number;
  breakeven: number;
  winRate: number;
  totalProfit: number;
  averageProfitPerTrade: number;
};

export type SimulationPerformanceStats = SimulationTradeStats & {
  maxEquityDrawdown: number;
  currentEquity: number;
  initialEquity: number;
};

const SUMMARY_EVERY_N_TRADES = 10;

export type SimulationEngineOptions = {
  /** When true, no `[SIM]` console output (for backtests / batch runs). */
  silent?: boolean;
  /** Starting equity (must match {@link AppConfig.initialCapital} in live config). */
  initialEquity?: number;
  /**
   * Called after each closed paper trade (after the trade is appended to history).
   * Use for custom logging (e.g. live monitor); runs even when {@link silent} is true.
   */
  onTradeClosed?: (trade: SimulatedTrade) => void;
};

const DEFAULT_INITIAL_EQUITY = 10_000;

export class SimulationEngine {
  private readonly silent: boolean;
  private readonly onTradeClosed: ((trade: SimulatedTrade) => void) | undefined;
  private readonly initialEquity: number;
  private equity: number;
  private peakEquity: number;
  private maxEquityDrawdown: number;
  private nextId = 1;
  private position: OpenSimPosition | null = null;
  private lastExitAt: number | null = null;
  private readonly trades: SimulatedTrade[] = [];

  constructor(options?: SimulationEngineOptions) {
    this.silent = options?.silent === true;
    this.onTradeClosed = options?.onTradeClosed;
    const start = options?.initialEquity;
    this.initialEquity =
      start !== undefined && Number.isFinite(start) && start > 0
        ? start
        : DEFAULT_INITIAL_EQUITY;
    this.equity = this.initialEquity;
    this.peakEquity = this.initialEquity;
    this.maxEquityDrawdown = 0;
  }

  getTradeHistory(): readonly SimulatedTrade[] {
    return this.trades;
  }

  /** Paper position currently open, if any. */
  getOpenPosition(): Readonly<{
    direction: EntryDirection;
    entryPrice: number;
    contracts: number;
  }> | null {
    if (!this.position) return null;
    return {
      direction: this.position.direction,
      entryPrice: this.position.entryPrice,
      contracts: this.position.contracts,
    };
  }

  /** Cumulative stats including equity / drawdown (paper account). */
  getPerformanceStats(): SimulationPerformanceStats {
    const base = computeSimulationPerformance(this.trades);
    return {
      ...base,
      maxEquityDrawdown: this.maxEquityDrawdown,
      currentEquity: this.equity,
      initialEquity: this.initialEquity,
    };
  }

  /**
   * Paper execution: open on entry signal, mark-to-market on held leg, close via {@link evaluateExitConditions}.
   */
  onTick(input: SimulationTickInput): void {
    const { now, entry, sides, config } = input;

    if (this.position) {
      const mark = markForDirection(this.position.direction, sides);
      if (!Number.isFinite(mark)) {
        return;
      }

      const exit = evaluateExitConditions({
        currentPrice: mark,
        exitPrice: config.exitPrice,
        stopLoss: config.stopLoss,
        openedAt: this.position.openedAt,
        timeoutMs: config.exitTimeoutMs,
        now,
      });

      if (exit.shouldExit && exit.reason !== null) {
        this.closePosition(mark, now, exit.reason);
      }
      return;
    }

    if (entry.shouldEnter && entry.direction !== null) {
      if (this.lastExitAt !== null) {
        const waited = now - this.lastExitAt;
        if (waited < config.entryCooldownMs) {
          return;
        }
      }
      const fill = fillPriceForDirection(entry.direction, sides);
      if (!Number.isFinite(fill)) {
        return;
      }

      const rpc = riskPerContractAtStop(fill, config.stopLoss);
      if (!(rpc > 0)) {
        if (!this.silent) {
          console.log(
            `[SIM] Skip entry: stopLoss (${config.stopLoss}) must be below entry (${fill.toFixed(4)})`
          );
        }
        return;
      }

      const contracts = contractsFromRiskBudget(
        this.equity,
        config.riskPercentPerTrade,
        rpc
      );
      if (contracts < 1) {
        if (!this.silent) {
          console.log(
            `[SIM] Skip entry: risk budget (${config.riskPercentPerTrade}% of ${this.equity.toFixed(2)}) < 1 contract at planned stop (rpc=${rpc.toFixed(4)})`
          );
        }
        return;
      }

      const riskAtEntry = contracts * rpc;
      const budget = (this.equity * config.riskPercentPerTrade) / 100;
      if (riskAtEntry > budget + 1e-9) {
        if (!this.silent) {
          console.log(`[SIM] Skip entry: risk cap exceeded`);
        }
        return;
      }

      this.position = {
        direction: entry.direction,
        contracts,
        entryPrice: fill,
        stopLoss: config.stopLoss,
        openedAt: now,
      };
      if (!this.silent) {
        console.log(
          `[SIM] Open ${entry.direction} ×${contracts} @ ${fill.toFixed(4)} | max risk ≈ ${riskAtEntry.toFixed(4)} (≤ ${budget.toFixed(2)})`
        );
      }
    }
  }

  private closePosition(
    exitPrice: number,
    closedAt: number,
    exitReason: ExitReason
  ): void {
    if (!this.position) return;

    const { direction, contracts, entryPrice, stopLoss, openedAt } =
      this.position;
    this.position = null;

    const profitLoss = (exitPrice - entryPrice) * contracts;
    const rpc = riskPerContractAtStop(entryPrice, stopLoss);
    const riskAtEntry = Number.isFinite(rpc) && rpc > 0 ? contracts * rpc : 0;

    this.equity += profitLoss;
    this.peakEquity = Math.max(this.peakEquity, this.equity);
    this.maxEquityDrawdown = Math.max(
      this.maxEquityDrawdown,
      this.peakEquity - this.equity
    );

    const record: SimulatedTrade = {
      id: this.nextId++,
      direction,
      contracts,
      entryPrice,
      exitPrice,
      profitLoss,
      riskAtEntry,
      exitReason,
      openedAt,
      closedAt,
    };
    this.trades.push(record);
    this.lastExitAt = closedAt;
    this.onTradeClosed?.(record);
    this.printTradeResult(record);
    if (
      !this.silent &&
      this.trades.length > 0 &&
      this.trades.length % SUMMARY_EVERY_N_TRADES === 0
    ) {
      this.printPerformanceSummary();
    }
  }

  private printPerformanceSummary(): void {
    if (this.silent) return;
    const s = this.getPerformanceStats();
    const wr = Number.isFinite(s.winRate) ? s.winRate.toFixed(1) : "0.0";
    const total =
      s.totalProfit >= 0
        ? `+${s.totalProfit.toFixed(4)}`
        : s.totalProfit.toFixed(4);
    const avg =
      s.averageProfitPerTrade >= 0
        ? `+${s.averageProfitPerTrade.toFixed(4)}`
        : s.averageProfitPerTrade.toFixed(4);
    console.log(
      `[SIM] ─── Performance summary (${s.totalTrades} trades) ───`
    );
    console.log(
      `[SIM]   Total: ${s.totalTrades} | Wins: ${s.wins} | Losses: ${s.losses} | Breakeven: ${s.breakeven} | Win rate: ${wr}%`
    );
    console.log(`[SIM]   Total P/L: ${total} | Avg P/L per trade: ${avg}`);
    console.log(
      `[SIM]   Equity: ${s.currentEquity.toFixed(2)} (start ${s.initialEquity.toFixed(2)}) | Max equity DD: ${s.maxEquityDrawdown.toFixed(4)}`
    );
  }

  private printTradeResult(t: SimulatedTrade): void {
    if (this.silent) return;
    const pnl =
      t.profitLoss >= 0
        ? `+${t.profitLoss.toFixed(4)}`
        : t.profitLoss.toFixed(4);
    console.log(
      `[SIM] Trade #${t.id} | ${t.direction} ×${t.contracts} | entry=${t.entryPrice.toFixed(4)} exit=${t.exitPrice.toFixed(4)} | P/L=${pnl} | ${t.exitReason}`
    );
  }
}

function markForDirection(
  direction: EntryDirection,
  sides: { upSidePrice: number; downSidePrice: number }
): number {
  return direction === "UP" ? sides.upSidePrice : sides.downSidePrice;
}

function fillPriceForDirection(
  direction: EntryDirection,
  sides: { upSidePrice: number; downSidePrice: number }
): number {
  return markForDirection(direction, sides);
}

/** Aggregate performance from a list of completed simulated trades. */
export function computeSimulationPerformance(
  trades: readonly SimulatedTrade[]
): SimulationTradeStats {
  const totalTrades = trades.length;
  let wins = 0;
  let losses = 0;
  let breakeven = 0;
  let totalProfit = 0;

  for (const t of trades) {
    totalProfit += t.profitLoss;
    if (t.profitLoss > 0) wins += 1;
    else if (t.profitLoss < 0) losses += 1;
    else breakeven += 1;
  }

  const winRate = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;
  const averageProfitPerTrade =
    totalTrades > 0 ? totalProfit / totalTrades : 0;

  return {
    totalTrades,
    wins,
    losses,
    breakeven,
    winRate,
    totalProfit,
    averageProfitPerTrade,
  };
}
