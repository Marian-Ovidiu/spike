import type { SimulatedTrade } from "../../simulationEngine.js";
import type { SignalMidRingBuffer } from "./signalMidRingBuffer.js";
import {
  type ProbabilityCalibrationEvent,
  PROBABILITY_CALIBRATION_SCHEMA,
  realizedUpFromMids,
} from "./binaryProbabilityCalibration.js";

export type ResolveTradeCalibrationResult =
  | { kind: "event"; event: ProbabilityCalibrationEvent }
  | { kind: "deferred" }
  | { kind: "skip" };

export function resolveTradeCalibration(
  trade: SimulatedTrade,
  horizonMs: number,
  ring: SignalMidRingBuffer,
  nowMs: number
): ResolveTradeCalibrationResult {
  if (trade.executionModel !== "binary") return { kind: "skip" };
  const p = trade.estimatedProbabilityUpAtEntry;
  const refMid = trade.underlyingSignalPriceAtEntry;
  if (p === undefined || !Number.isFinite(p)) return { kind: "skip" };
  if (refMid === undefined || !Number.isFinite(refMid) || refMid <= 0) {
    return { kind: "skip" };
  }
  const endT = trade.openedAt + horizonMs;
  if (nowMs < endT) return { kind: "deferred" };
  const endMid = ring.midAtOrAfter(endT) ?? ring.midAtOrBefore(nowMs);
  if (endMid === null || !Number.isFinite(endMid)) return { kind: "skip" };
  const event: ProbabilityCalibrationEvent = {
    schema: PROBABILITY_CALIBRATION_SCHEMA,
    source: "trade",
    referenceTimeMs: trade.openedAt,
    probabilityTimeHorizonMs: horizonMs,
    resolvedAtMs: nowMs,
    predictedProbabilityUp: p,
    referenceSignalMid: refMid,
    horizonEndSignalMid: endMid,
    realizedUp: realizedUpFromMids(refMid, endMid),
    ...(trade.entryModelEdge !== undefined && Number.isFinite(trade.entryModelEdge)
      ? { entryModelEdge: trade.entryModelEdge }
      : {}),
    tradeId: trade.id,
  };
  return { kind: "event", event };
}

export function resolveOpportunityCalibration(input: {
  opportunityTimestampMs: number;
  predictedProbabilityUp: number;
  probabilityTimeHorizonMs: number;
  referenceSignalMid: number;
  ring: SignalMidRingBuffer;
  sessionEndMs: number;
}): ProbabilityCalibrationEvent | null {
  const endT =
    input.opportunityTimestampMs + input.probabilityTimeHorizonMs;
  if (input.sessionEndMs < endT) return null;
  const endMid =
    input.ring.midAtOrAfter(endT) ??
    input.ring.midAtOrBefore(input.sessionEndMs);
  if (endMid === null || !Number.isFinite(endMid)) return null;
  return {
    schema: PROBABILITY_CALIBRATION_SCHEMA,
    source: "opportunity",
    referenceTimeMs: input.opportunityTimestampMs,
    probabilityTimeHorizonMs: input.probabilityTimeHorizonMs,
    resolvedAtMs: input.sessionEndMs,
    predictedProbabilityUp: input.predictedProbabilityUp,
    referenceSignalMid: input.referenceSignalMid,
    horizonEndSignalMid: endMid,
    realizedUp: realizedUpFromMids(input.referenceSignalMid, endMid),
    opportunityObservedAtMs: input.opportunityTimestampMs,
  };
}
