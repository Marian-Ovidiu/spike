/**
 * Planned loss per contract (long) if stopped at `stopLossPrice`.
 * Invalid if entry is not above stop.
 */
export function riskPerContractAtStop(
  entryPrice: number,
  stopLossPrice: number
): number {
  if (
    !Number.isFinite(entryPrice) ||
    !Number.isFinite(stopLossPrice) ||
    entryPrice <= stopLossPrice
  ) {
    return 0;
  }
  return entryPrice - stopLossPrice;
}

/**
 * Integer contracts such that planned stop loss does not exceed `riskPercentPerTrade`% of `equity`.
 */
export function contractsFromRiskBudget(
  equity: number,
  riskPercentPerTrade: number,
  riskPerContract: number
): number {
  if (
    !(equity > 0) ||
    !(riskPercentPerTrade > 0) ||
    !(riskPerContract > 0)
  ) {
    return 0;
  }
  const maxLossBudget = (equity * riskPercentPerTrade) / 100;
  return Math.max(0, Math.floor(maxLossBudget / riskPerContract));
}
