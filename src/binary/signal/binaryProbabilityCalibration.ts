/**
 * Reliability / calibration helpers for {@link estimateProbabilityUpFromPriceBuffer} outputs
 * vs realized BTC signal path over {@link ProbabilityCalibrationEventBase.probabilityTimeHorizonMs}.
 */

export const PROBABILITY_CALIBRATION_SCHEMA = "probability_calibration_event_v1" as const;

export type ProbabilityCalibrationSource = "trade" | "opportunity";

export type ProbabilityCalibrationEvent = {
  schema: typeof PROBABILITY_CALIBRATION_SCHEMA;
  source: ProbabilityCalibrationSource;
  /** Wall-clock when the prediction was made (trade open or opportunity row). */
  referenceTimeMs: number;
  probabilityTimeHorizonMs: number;
  /** When the horizon label was evaluated (≥ referenceTimeMs + horizon). */
  resolvedAtMs: number;
  predictedProbabilityUp: number;
  /** BTC signal mid at reference time. */
  referenceSignalMid: number;
  /** BTC signal mid at or after horizon end (first tick ≥ referenceTimeMs + horizon). */
  horizonEndSignalMid: number;
  /** 1 if horizonEndSignalMid > referenceSignalMid, else 0 (ties → 0). */
  realizedUp: 0 | 1;
  /** Model edge at reference when known (binary trade entryModelEdge). */
  entryModelEdge?: number | null;
  tradeId?: number;
  opportunityObservedAtMs?: number;
};

export function realizedUpFromMids(
  referenceMid: number,
  horizonEndMid: number
): 0 | 1 {
  if (!Number.isFinite(referenceMid) || !Number.isFinite(horizonEndMid)) return 0;
  return horizonEndMid > referenceMid ? 1 : 0;
}

export type CalibrationBucketLabel =
  | "<0.50"
  | "0.50–0.55"
  | "0.55–0.60"
  | "0.60–0.65"
  | "0.65–0.70"
  | "0.70–0.75"
  | "0.75–0.80"
  | "0.80–0.85"
  | "0.85–0.90"
  | "0.90–0.95"
  | "0.95–1.00";

const BUCKET_ORDER: CalibrationBucketLabel[] = [
  "<0.50",
  "0.50–0.55",
  "0.55–0.60",
  "0.60–0.65",
  "0.65–0.70",
  "0.70–0.75",
  "0.75–0.80",
  "0.80–0.85",
  "0.85–0.90",
  "0.90–0.95",
  "0.95–1.00",
];

export function calibrationBucketForProbability(p: number): CalibrationBucketLabel {
  if (!Number.isFinite(p)) return "<0.50";
  if (p < 0.5) return "<0.50";
  if (p < 0.55) return "0.50–0.55";
  if (p < 0.6) return "0.55–0.60";
  if (p < 0.65) return "0.60–0.65";
  if (p < 0.7) return "0.65–0.70";
  if (p < 0.75) return "0.70–0.75";
  if (p < 0.8) return "0.75–0.80";
  if (p < 0.85) return "0.80–0.85";
  if (p < 0.9) return "0.85–0.90";
  if (p < 0.95) return "0.90–0.95";
  return "0.95–1.00";
}

export type CalibrationBucketStats = {
  label: CalibrationBucketLabel;
  sampleCount: number;
  /** Mean predicted P(up) in bucket. */
  meanPredicted: number;
  /** Fraction of samples where realizedUp === 1. */
  realizedUpFrequency: number;
  /** Mean of entryModelEdge when set, else mean(predicted − realizedUp). */
  meanEdge: number;
};

export type CalibrationReliabilityReport = {
  schema: "probability_calibration_report_v1";
  totalSamples: number;
  buckets: CalibrationBucketStats[];
  /** Mean absolute calibration error: mean(|p − y|) over samples. */
  meanAbsoluteCalibrationError: number;
  /** Mean predicted minus mean realized (0–1). Positive → average overconfidence on UP. */
  meanPredictedMinusRealized: number;
  /** Heuristic verdict from bucket shape + global bias. */
  calibrationVerdict:
    | "roughly_calibrated"
    | "overconfident_up"
    | "underconfident_up"
    | "insufficient_data";
  verdictNotes: string[];
};

function bucketMidpoint(label: CalibrationBucketLabel): number {
  switch (label) {
    case "<0.50":
      return 0.45;
    case "0.50–0.55":
      return 0.525;
    case "0.55–0.60":
      return 0.575;
    case "0.60–0.65":
      return 0.625;
    case "0.65–0.70":
      return 0.675;
    case "0.70–0.75":
      return 0.725;
    case "0.75–0.80":
      return 0.775;
    case "0.80–0.85":
      return 0.825;
    case "0.85–0.90":
      return 0.875;
    case "0.90–0.95":
      return 0.925;
    case "0.95–1.00":
      return 0.975;
    default:
      return 0.5;
  }
}

export function buildCalibrationReliabilityReport(
  events: readonly ProbabilityCalibrationEvent[]
): CalibrationReliabilityReport {
  const notes: string[] = [];
  if (events.length === 0) {
    return {
      schema: "probability_calibration_report_v1",
      totalSamples: 0,
      buckets: BUCKET_ORDER.map((label) => ({
        label,
        sampleCount: 0,
        meanPredicted: 0,
        realizedUpFrequency: 0,
        meanEdge: 0,
      })),
      meanAbsoluteCalibrationError: 0,
      meanPredictedMinusRealized: 0,
      calibrationVerdict: "insufficient_data",
      verdictNotes: ["No resolved calibration events."],
    };
  }

  const byBucket = new Map<
    CalibrationBucketLabel,
    { pSum: number; ySum: number; n: number; edgeSum: number; edgeN: number }
  >();
  for (const b of BUCKET_ORDER) {
    byBucket.set(b, { pSum: 0, ySum: 0, n: 0, edgeSum: 0, edgeN: 0 });
  }

  let maeSum = 0;
  let predMinusReal = 0;
  for (const e of events) {
    const p = e.predictedProbabilityUp;
    const y = e.realizedUp;
    const label = calibrationBucketForProbability(p);
    const agg = byBucket.get(label)!;
    agg.pSum += p;
    agg.ySum += y;
    agg.n += 1;
    maeSum += Math.abs(p - y);
    predMinusReal += p - y;
    const edge =
      e.entryModelEdge !== undefined &&
      e.entryModelEdge !== null &&
      Number.isFinite(e.entryModelEdge)
        ? e.entryModelEdge
        : p - y;
    agg.edgeSum += edge;
    agg.edgeN += 1;
  }

  const buckets: CalibrationBucketStats[] = BUCKET_ORDER.map((label) => {
    const a = byBucket.get(label)!;
    const n = a.n;
    const meanP = n > 0 ? a.pSum / n : 0;
    const freq = n > 0 ? a.ySum / n : 0;
    const edgeN = a.edgeN;
    const meanEdge = edgeN > 0 ? a.edgeSum / edgeN : 0;
    return {
      label,
      sampleCount: n,
      meanPredicted: meanP,
      realizedUpFrequency: freq,
      meanEdge,
    };
  });

  const meanAbs = maeSum / events.length;
  const meanPredMinusRealized = predMinusReal / events.length;

  let verdict: CalibrationReliabilityReport["calibrationVerdict"] =
    "roughly_calibrated";
  if (events.length < 15) {
    verdict = "insufficient_data";
    notes.push(`Only ${events.length} samples; prefer ≥30 for stable buckets.`);
  } else {
    let highBinOver = 0;
    let highBinUnder = 0;
    for (const b of buckets) {
      if (b.sampleCount < 3) continue;
      const mid = bucketMidpoint(b.label);
      if (b.label === "<0.50") continue;
      const gap = b.meanPredicted - b.realizedUpFrequency;
      if (gap > 0.08 && mid >= 0.55) highBinOver += 1;
      if (gap < -0.08 && mid >= 0.55) highBinUnder += 1;
    }
    if (meanPredMinusRealized > 0.06 && highBinOver >= 2) {
      verdict = "overconfident_up";
      notes.push(
        "Mean predicted exceeds realized UP rate; several mid/high buckets show predicted well above empirical frequency."
      );
    } else if (meanPredMinusRealized < -0.06 && highBinUnder >= 2) {
      verdict = "underconfident_up";
      notes.push(
        "Realized UP frequency exceeds mean predicted in multiple buckets — scores may be conservative vs outcomes."
      );
    } else {
      notes.push(
        "Bucket frequencies are within a loose band of predictions; treat `probability_up` as a heuristic score unless sample size grows."
      );
    }
  }

  return {
    schema: "probability_calibration_report_v1",
    totalSamples: events.length,
    buckets,
    meanAbsoluteCalibrationError: meanAbs,
    meanPredictedMinusRealized: meanPredMinusRealized,
    calibrationVerdict: verdict,
    verdictNotes: notes,
  };
}

export function formatCalibrationReportConsole(r: CalibrationReliabilityReport): string {
  const lines: string[] = [
    "=== Binary probability calibration ===",
    `Samples: ${r.totalSamples}`,
    `Mean |p − y|: ${r.meanAbsoluteCalibrationError.toFixed(4)}`,
    `Mean (p − y): ${r.meanPredictedMinusRealized.toFixed(4)}  (positive → upward bias in probability vs realized UP)`,
    `Verdict: ${r.calibrationVerdict}`,
    ...r.verdictNotes.map((n) => `  • ${n}`),
    "",
    "Bucket          n    mean_p   freq_up  mean_edge",
  ];
  for (const b of r.buckets) {
    if (b.sampleCount === 0) continue;
    lines.push(
      `${b.label.padEnd(14)} ${String(b.sampleCount).padStart(4)}  ${b.meanPredicted.toFixed(3)}   ${b.realizedUpFrequency.toFixed(3)}   ${b.meanEdge.toFixed(4)}`
    );
  }
  return lines.join("\n");
}
