import type { SimulatedTrade } from "../../simulationEngine.js";

/**
 * JSON-serializable closed trade for **binary paper** only — outcome tokens, USDT, and BTC signal context.
 * Intentionally omits spot fields (`entryBid`, `exitBid`, BTC qty wording).
 */
export function buildBinaryPaperTradeLog(t: SimulatedTrade): Record<string, unknown> {
  if (t.executionModel !== "binary") {
    throw new Error("buildBinaryPaperTradeLog: executionModel must be binary");
  }
  return {
    schema: "binary_paper_trade_v1",
    tradeId: t.id,
    venueSymbol: t.symbol,
    /** Spike direction that led to this contrarian outcome buy. */
    strategyDirection: t.direction,
    outcomeTokenBought: t.sideBought ?? null,
    stakeUsdt: t.stake,
    contracts: t.shares,
    entryOutcomePrice: t.entrySidePrice ?? t.entryPrice,
    exitOutcomePrice: t.exitSidePrice ?? t.exitPrice,
    yesMidAtEntry: t.yesPriceAtEntry,
    noMidAtEntry: t.noPriceAtEntry,
    yesMidAtExit: t.yesPriceAtExit,
    noMidAtExit: t.noPriceAtExit,
    signalBtcMidAtEntry: t.underlyingSignalPriceAtEntry,
    signalBtcMidAtExit: t.underlyingSignalPriceAtExit,
    grossPnlUsdt: t.grossPnl,
    feesUsdt: t.feesEstimate,
    netPnlUsdt: t.profitLoss,
    equityBeforeUsdt: t.equityBefore,
    equityAfterUsdt: t.equityAfter,
    exitReason: t.exitReason,
    entryPath: t.entryPath,
    baseStakeUsdt: t.baseStakePerTrade,
    qualityStakeMultiplier: t.qualityStakeMultiplier,
    entryQualityProfile: t.entryQualityProfile,
    ...(t.entryModelEdge !== undefined && Number.isFinite(t.entryModelEdge)
      ? { entryModelEdge: t.entryModelEdge }
      : {}),
    ...(t.estimatedProbabilityUpAtEntry !== undefined &&
    Number.isFinite(t.estimatedProbabilityUpAtEntry)
      ? { estimatedProbabilityUpAtEntry: t.estimatedProbabilityUpAtEntry }
      : {}),
    ...(t.probabilityTimeHorizonMs !== undefined &&
    Number.isFinite(t.probabilityTimeHorizonMs)
      ? { probabilityTimeHorizonMs: t.probabilityTimeHorizonMs }
      : {}),
    riskAtEntryUsdt: t.riskAtEntry,
  };
}
