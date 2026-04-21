/**
 * Deterministic short-horizon **momentum / continuation** score from recent spot mids → P(up).
 * Distinct from Polymarket YES price and from **contrarian** fair P on the bought leg used in
 * binary edge (`fairBuyLegProbabilityFromMomentumUp` in `binaryEdgeSemantics.ts`).
 * Heuristic only — not calibrated market probability.
 */

const REF_HORIZON_MS = 30_000;
const REF_REL_MOVE = 0.00015;
const REF_REL_RANGE = 0.00035;
const MOMENTUM_WEIGHT = 1;
const VELOCITY_WEIGHT = 0.55;
const VOLATILITY_WEIGHT = 0.4;

export type BinaryProbabilityTick = {
  price: number;
  timeMs: number;
};

export type BinaryProbabilityContext = {
  /** Newest last; typically Binance spot mids at a fixed cadence. */
  ticks: readonly BinaryProbabilityTick[];
  /** How many trailing samples to use (clamped to available length, min 2). */
  windowSize: number;
  /** Prediction horizon — longer horizons attenuate the score toward 0.5. */
  timeHorizonMs: number;
  /** Sigmoid steepness applied to the normalized score. */
  sigmoidK: number;
};

export type BinaryProbabilityDiagnostics = {
  ok: boolean;
  up: number;
  down: number;
  momentum: number;
  velocity: number;
  volatility: number;
  rawScore: number;
  windowTicks: number;
};

/** Map rolling buffer prices to ticks with synthetic timestamps (uniform spacing). */
export function pricesToProbabilityTicks(
  prices: readonly number[],
  lastSampleTimeMs: number,
  sampleIntervalMs: number
): BinaryProbabilityTick[] {
  const n = prices.length;
  if (n === 0) return [];
  const step = Math.max(1, sampleIntervalMs);
  return prices.map((price, i) => ({
    price,
    timeMs: lastSampleTimeMs - (n - 1 - i) * step,
  }));
}

function clamp01(x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  return x;
}

function sigmoid(score: number, k: number): number {
  const z = k * score;
  const c = Math.min(20, Math.max(-20, z));
  return 1 / (1 + Math.exp(-c));
}

/**
 * Full model output for logging and inspection.
 * When fewer than two finite ticks fall in the window, returns ok=false and 0.5 / 0.5.
 */
export function getBinaryProbabilityDiagnostics(
  context: BinaryProbabilityContext
): BinaryProbabilityDiagnostics {
  const { ticks, windowSize, timeHorizonMs, sigmoidK } = context;
  const w = Math.max(2, Math.trunc(windowSize));
  const slice =
    ticks.length <= w ? ticks : ticks.slice(ticks.length - w, ticks.length);
  const finite = slice.filter(
    (t) => Number.isFinite(t.price) && Number.isFinite(t.timeMs)
  );
  if (finite.length < 2) {
    return {
      ok: false,
      up: 0.5,
      down: 0.5,
      momentum: 0,
      velocity: 0,
      volatility: 0,
      rawScore: 0,
      windowTicks: finite.length,
    };
  }

  const first = finite[0]!;
  const last = finite[finite.length - 1]!;
  const anchor = last.price;
  if (!Number.isFinite(anchor) || anchor === 0) {
    return {
      ok: false,
      up: 0.5,
      down: 0.5,
      momentum: 0,
      velocity: 0,
      volatility: 0,
      rawScore: 0,
      windowTicks: finite.length,
    };
  }

  let hi = -Infinity;
  let lo = Infinity;
  for (const t of finite) {
    if (t.price > hi) hi = t.price;
    if (t.price < lo) lo = t.price;
  }
  const range = hi - lo;
  const momentum = last.price - first.price;
  const n = finite.length;
  const denomSteps = Math.max(1, n - 1);
  const velocity = momentum / denomSteps;
  const relMomentum = momentum / anchor;
  const relVelocity = velocity / anchor;
  const relVolatility = range / anchor;

  const mNorm = relMomentum / REF_REL_MOVE;
  const vNorm = relVelocity / REF_REL_MOVE;
  const volNorm = relVolatility / Math.max(REF_REL_RANGE, 1e-12);

  let rawScore =
    MOMENTUM_WEIGHT * mNorm +
    VELOCITY_WEIGHT * vNorm -
    VOLATILITY_WEIGHT * volNorm;

  const spanMs = Math.max(1, last.timeMs - first.timeMs);
  const tickRateFactor = Math.sqrt(
    (denomSteps * REF_HORIZON_MS) / Math.max(spanMs, 1)
  );
  rawScore *= tickRateFactor;

  const h = Math.max(1, timeHorizonMs);
  const horizonAtten = Math.sqrt(REF_HORIZON_MS / h);
  rawScore *= horizonAtten;

  const k = Number.isFinite(sigmoidK) && sigmoidK > 0 ? sigmoidK : 1;
  const up = clamp01(sigmoid(rawScore, k));
  const down = 1 - up;

  return {
    ok: true,
    up,
    down,
    momentum,
    velocity,
    volatility: relVolatility,
    rawScore,
    windowTicks: n,
  };
}

/**
 * Short-horizon directional probability from recent BTC mids (pure, deterministic).
 */
export function getBinaryProbability(
  context: BinaryProbabilityContext
): { up: number; down: number } {
  const d = getBinaryProbabilityDiagnostics(context);
  return { up: d.up, down: d.down };
}

/**
 * Rolling BTC mids → short-horizon **momentum** p(up) for calibration / feeds.
 * Binary **entry edge** in `edgeEntryDecision` defaults to mean-reversion mapping
 * (complement on the bought leg) so it matches contrarian spike entries.
 */
export function estimateProbabilityUpFromPriceBuffer(input: {
  prices: readonly number[];
  lastSampleTimeMs: number;
  sampleIntervalMs: number;
  windowSize: number;
  timeHorizonMs: number;
  sigmoidK: number;
}): number | undefined {
  if (input.prices.length < 2) return undefined;
  const ticks = pricesToProbabilityTicks(
    input.prices,
    input.lastSampleTimeMs,
    input.sampleIntervalMs
  );
  return getBinaryProbability({
    ticks,
    windowSize: input.windowSize,
    timeHorizonMs: input.timeHorizonMs,
    sigmoidK: input.sigmoidK,
  }).up;
}

export function formatBinaryProbabilityDebugLine(
  d: BinaryProbabilityDiagnostics,
  horizonMs: number
): string {
  return `[btc-prob] ok=${d.ok} win=${d.windowTicks} H=${horizonMs}ms  mom=${d.momentum.toFixed(6)} vel=${d.velocity.toFixed(8)} vol=${(d.volatility * 100).toFixed(5)}%  score=${d.rawScore.toFixed(4)}  p_up=${d.up.toFixed(4)} p_down=${d.down.toFixed(4)}`;
}
