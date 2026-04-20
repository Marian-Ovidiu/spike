/**
 * Risk- and edge-aware notional sizing (e.g. USDT stake) for paper trades.
 */

export type PositionSizeContext = {
  /** Account equity / bankroll used for the risk budget. */
  accountBalance: number;
  /** Model edge on the intended buy leg (probability − ask), same units as edge entry gate. */
  edge: number;
  /** Percent of balance for base risk budget (e.g. `1` = 1%). */
  riskPercentPerTrade: number;
  /** Hard cap on returned stake; must be > 0 when used from the simulator. */
  maxTradeSize: number;
  /** Floor on returned stake (≥ 0). */
  minTradeSize: number;
  /**
   * Edge at which the edge multiplier reaches 1.0 (weak edges scale down; strong edges scale up).
   * Default 0.03 (3 percentage points).
   */
  referenceEdge?: number;
};

/**
 * Base risk budget = `accountBalance * (riskPercentPerTrade / 100)`,
 * then scaled by edge vs `referenceEdge`, clamped to `[minTradeSize, maxTradeSize]`.
 */
export function getPositionSize(context: PositionSizeContext): number {
  const {
    accountBalance,
    edge,
    riskPercentPerTrade,
    maxTradeSize,
    minTradeSize,
  } = context;
  const ref = context.referenceEdge ?? 0.03;

  const bal = Math.max(0, accountBalance);
  const pct = Math.max(0, Math.min(100, riskPercentPerTrade));
  const baseRisk = (bal * pct) / 100;

  let mult: number;
  if (edge > 0 && ref > 0) {
    mult = Math.min(2, Math.max(0.25, edge / ref));
  } else {
    mult = 0.25;
  }

  let stake = baseRisk * mult;
  const lo = Math.max(0, minTradeSize);
  const hi = Math.max(lo, Math.max(0, maxTradeSize));
  stake = Math.min(hi, Math.max(lo, stake));
  if (!Number.isFinite(stake)) return lo;
  return stake;
}
