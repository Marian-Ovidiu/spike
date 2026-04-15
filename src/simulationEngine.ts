import type { AppConfig } from "./config.js";
import type { EntryDirection, EntryEvaluation } from "./entryConditions.js";
import { evaluateExitConditions } from "./exitConditions.js";
import type { ExitReason } from "./exitConditions.js";
export type SimulatedTrade = {
  id: number;
  direction: EntryDirection;
  /** Fixed notional deployed at entry (USDC). */
  stake: number;
  /** Position size in outcome shares: stake / entryPrice. */
  shares: number;
  entryPrice: number;
  exitPrice: number;
  /** Total P/L for the position: shares × (exit − entry). */
  profitLoss: number;
  /** Account equity immediately before this trade’s P/L is applied. */
  equityBefore: number;
  /** Account equity immediately after this trade’s P/L is applied. */
  equityAfter: number;
  /** Unused in fixed-stake model; kept for persisted session shape. */
  riskAtEntry: number;
  exitReason: ExitReason;
  /** Which strategy path opened this trade. */
  entryPath: "strong_spike_immediate" | "borderline_delayed";
  openedAt: number;
  closedAt: number;
};

type OpenSimPosition = {
  direction: EntryDirection;
  stake: number;
  shares: number;
  entryPrice: number;
  stopLoss: number;
  entryPath: "strong_spike_immediate" | "borderline_delayed";
  openedAt: number;
};

export type SimulationTickInput = {
  now: number;
  entry: EntryEvaluation;
  /** Optional source tagging for attribution stats. */
  entryPath?: "strong_spike_immediate" | "borderline_delayed";
  sides: { upSidePrice: number; downSidePrice: number };
  /** Exit, stop, sizing, cooldown. */
  config: Pick<
    AppConfig,
    | "exitPrice"
    | "stopLoss"
    | "exitTimeoutMs"
    | "entryCooldownMs"
    | "stakePerTrade"
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

/** One closed-trade record for console / JSONL (manual recheck: pnl ≈ shares×(exit−entry), equityAfter ≈ equityBefore+pnl). */
export type TransparentTradeLog = {
  tradeId: number;
  /** ISO time at exit (close). */
  timestamp: string;
  direction: EntryDirection;
  stake: number;
  shares: number;
  entryPrice: number;
  exitPrice: number;
  pnl: number;
  equityBefore: number;
  equityAfter: number;
  /** Strategy path that opened the trade. */
  reasonEntry: SimulatedTrade["entryPath"];
  reasonExit: ExitReason;
};

export function buildTransparentTradeLog(t: SimulatedTrade): TransparentTradeLog {
  return {
    tradeId: t.id,
    timestamp: new Date(t.closedAt).toISOString(),
    direction: t.direction,
    stake: t.stake,
    shares: t.shares,
    entryPrice: t.entryPrice,
    exitPrice: t.exitPrice,
    pnl: t.profitLoss,
    equityBefore: t.equityBefore,
    equityAfter: t.equityAfter,
    reasonEntry: t.entryPath,
    reasonExit: t.exitReason,
  };
}

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
  }

  getTradeHistory(): readonly SimulatedTrade[] {
    return this.trades;
  }

  /** Paper position currently open, if any. */
  getOpenPosition(): Readonly<{
    direction: EntryDirection;
    entryPrice: number;
    stake: number;
    shares: number;
  }> | null {
    if (!this.position) return null;
    return {
      direction: this.position.direction,
      entryPrice: this.position.entryPrice,
      stake: this.position.stake,
      shares: this.position.shares,
    };
  }

  /**
   * True when a new entry can be accepted right now, considering open position
   * and post-exit cooldown.
   */
  canOpenNewPosition(now: number, cooldownMs: number): boolean {
    if (this.position !== null) return false;
    if (this.lastExitAt !== null && now - this.lastExitAt < cooldownMs) {
      return false;
    }
    return true;
  }

  /**
   * Full P/L summary from **closed trades only** (same numbers as summing
   * `profitLoss` on {@link getTradeHistory} and replaying equity).
   */
  getPerformanceStats(): SimulationPerformanceStats {
    return computePerformanceFromClosedTrades(this.trades, this.initialEquity);
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

      if (!(fill > config.stopLoss)) {
        if (!this.silent) {
          console.log(
            `[SIM] Skip entry: stopLoss (${config.stopLoss}) must be below entry (${fill.toFixed(4)})`
          );
        }
        return;
      }

      const stake = config.stakePerTrade;
      if (!(stake > 0)) {
        if (!this.silent) {
          console.log(`[SIM] Skip entry: stakePerTrade must be > 0`);
        }
        return;
      }

      const shares = stake / fill;

      this.position = {
        direction: entry.direction,
        stake,
        shares,
        entryPrice: fill,
        stopLoss: config.stopLoss,
        entryPath: input.entryPath ?? "strong_spike_immediate",
        openedAt: now,
      };
      if (!this.silent) {
        console.log(
          `[SIM] Open ${entry.direction} | stake=${stake.toFixed(2)} shares=${shares.toFixed(4)} @ ${fill.toFixed(4)}`
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

    const { direction, stake, shares, entryPrice, entryPath, openedAt } =
      this.position;
    this.position = null;

    const equityBefore = this.equity;
    const profitLoss = shares * (exitPrice - entryPrice);
    const equityAfter = equityBefore + profitLoss;
    const riskAtEntry = 0;

    this.equity = equityAfter;

    const record: SimulatedTrade = {
      id: this.nextId++,
      direction,
      stake,
      shares,
      entryPrice,
      exitPrice,
      profitLoss,
      equityBefore,
      equityAfter,
      riskAtEntry,
      exitReason,
      entryPath,
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
    const payload = buildTransparentTradeLog(t);
    console.log("[SIM] Trade closed (full log):");
    console.log(JSON.stringify(payload, null, 2));
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

/**
 * Win/loss counts, totals, and avg P/L from closed trades only
 * (`profitLoss` sums to `totalProfit`).
 */
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

/**
 * Paper performance for reporting: everything is derived from `trades` + starting equity.
 * Max drawdown = peak-to-trough of running account equity after each closed trade.
 */
export function computePerformanceFromClosedTrades(
  trades: readonly SimulatedTrade[],
  initialEquity: number
): SimulationPerformanceStats {
  const base = computeSimulationPerformance(trades);
  let equity = initialEquity;
  let peak = initialEquity;
  let maxEquityDrawdown = 0;
  for (const t of trades) {
    equity += t.profitLoss;
    peak = Math.max(peak, equity);
    maxEquityDrawdown = Math.max(maxEquityDrawdown, peak - equity);
  }
  return {
    ...base,
    maxEquityDrawdown,
    currentEquity: equity,
    initialEquity,
  };
}
