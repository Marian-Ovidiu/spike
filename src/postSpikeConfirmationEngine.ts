export type PostSpikeMoveClassification =
  | "continuation"
  | "pause"
  | "reversion"
  | "noisy_unclear";

export type PostSpikeConfirmationResult = {
  postMoveClassification: PostSpikeMoveClassification;
  continuationPercent: number;
  reversionPercent: number;
  pauseBandPercent: number;
  notes: string[];
};

export type PostSpikeConfirmationInput = {
  originalDirection: "UP" | "DOWN" | null;
  detectionPrice: number;
  originalAbsMove: number;
  watchedTickPrices: readonly number[];
  continuationThreshold: number;
  reversionThreshold: number;
  pauseBandPercent: number;
};

/** Shared delayed-entry analyzer for both borderline and strong-spike flows. */
export function analyzePostSpikeConfirmation(
  input: PostSpikeConfirmationInput
): PostSpikeConfirmationResult {
  const notes: string[] = [];
  const detection = input.detectionPrice;
  const originalAbsMove = Math.max(input.originalAbsMove, 1e-9);
  const continuationThreshold = Number.isFinite(input.continuationThreshold)
    ? Math.max(0, input.continuationThreshold)
    : 0.25;
  const reversionThreshold = Number.isFinite(input.reversionThreshold)
    ? Math.max(0, input.reversionThreshold)
    : 0.2;
  const pauseBandPercent = Number.isFinite(input.pauseBandPercent)
    ? Math.max(0, input.pauseBandPercent)
    : 0.00015;

  if (
    input.originalDirection === null ||
    !Number.isFinite(detection) ||
    input.watchedTickPrices.length === 0
  ) {
    return {
      postMoveClassification: "noisy_unclear",
      continuationPercent: 0,
      reversionPercent: 0,
      pauseBandPercent: pauseBandPercent * 100,
      notes: ["missing direction/detection or watched prices"],
    };
  }

  let maxContinuationAbs = 0;
  let maxReversionAbs = 0;
  let maxDistanceFromDetection = 0;
  for (const p of input.watchedTickPrices) {
    if (!Number.isFinite(p)) continue;
    const delta = p - detection;
    const absDistance = Math.abs(delta);
    maxDistanceFromDetection = Math.max(maxDistanceFromDetection, absDistance);
    if (input.originalDirection === "UP") {
      if (delta > 0) maxContinuationAbs = Math.max(maxContinuationAbs, delta);
      if (delta < 0) maxReversionAbs = Math.max(maxReversionAbs, Math.abs(delta));
    } else {
      if (delta < 0) maxContinuationAbs = Math.max(maxContinuationAbs, Math.abs(delta));
      if (delta > 0) maxReversionAbs = Math.max(maxReversionAbs, delta);
    }
  }

  const continuationFraction = maxContinuationAbs / originalAbsMove;
  const reversionFraction = maxReversionAbs / originalAbsMove;
  const pauseBandAbs = detection * pauseBandPercent;
  const inPauseBand = maxDistanceFromDetection <= pauseBandAbs;

  notes.push(
    `continuation=${(continuationFraction * 100).toFixed(2)}% of original`,
    `reversion=${(reversionFraction * 100).toFixed(2)}% of original`,
    `maxDistance=${maxDistanceFromDetection.toFixed(2)} vs pauseBandAbs=${pauseBandAbs.toFixed(
      2
    )}`
  );

  if (continuationFraction >= continuationThreshold) {
    notes.push("classification: continuation");
    return {
      postMoveClassification: "continuation",
      continuationPercent: continuationFraction,
      reversionPercent: reversionFraction,
      pauseBandPercent: pauseBandPercent * 100,
      notes,
    };
  }
  if (reversionFraction >= reversionThreshold) {
    notes.push("classification: reversion");
    return {
      postMoveClassification: "reversion",
      continuationPercent: continuationFraction,
      reversionPercent: reversionFraction,
      pauseBandPercent: pauseBandPercent * 100,
      notes,
    };
  }
  if (inPauseBand) {
    notes.push("classification: pause");
    return {
      postMoveClassification: "pause",
      continuationPercent: continuationFraction,
      reversionPercent: reversionFraction,
      pauseBandPercent: pauseBandPercent * 100,
      notes,
    };
  }
  notes.push("classification: noisy_unclear");
  return {
    postMoveClassification: "noisy_unclear",
    continuationPercent: continuationFraction,
    reversionPercent: reversionFraction,
    pauseBandPercent: pauseBandPercent * 100,
    notes,
  };
}

