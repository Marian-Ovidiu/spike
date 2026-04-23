import type { RiskEngineConfig } from "./riskConfig.js";
import type { RiskEvaluationInput, RiskGateResult } from "./riskTypes.js";
import { RISK_REJECTION_CODES } from "./riskTypes.js";

function clampStake(
  raw: number,
  minQ: number,
  maxQ: number
): number {
  const lo = Math.max(0, minQ);
  const hi = maxQ > 0 ? Math.max(lo, maxQ) : Number.POSITIVE_INFINITY;
  let v = raw;
  if (!Number.isFinite(v)) return lo;
  v = Math.min(hi, Math.max(lo, v));
  return v;
}

/**
 * Centralizes feed/stale, spread, cooldown, capacity, and basic stake bounds.
 * Strategy / spike / edge stay outside.
 *
 * Legacy lineage: see `src/core/risk/index.ts`.
 */
export class RiskEngine {
  constructor(private cfg: RiskEngineConfig) {}

  getConfig(): RiskEngineConfig {
    return { ...this.cfg };
  }

  setConfig(patch: Partial<RiskEngineConfig>): void {
    this.cfg = { ...this.cfg, ...patch };
  }

  evaluateNewEntry(input: RiskEvaluationInput): RiskGateResult {
    const reasons: string[] = [];
    const c = this.cfg;

    const bookOk =
      input.execution.bookValid !== false &&
      Number.isFinite(input.execution.spreadBps);

    if (!bookOk) {
      reasons.push(RISK_REJECTION_CODES.INVALID_BOOK);
    }

    if (c.blockEntriesOnExecutionFeedStale && input.execution.feedStale) {
      reasons.push(RISK_REJECTION_CODES.EXECUTION_FEED_STALE);
    }

    if (
      c.blockEntriesOnSignalFeedStale &&
      input.signal?.feedStale === true
    ) {
      reasons.push(RISK_REJECTION_CODES.SIGNAL_FEED_STALE);
    }

    if (
      bookOk &&
      c.maxEntrySpreadBps > 0 &&
      input.execution.spreadBps > c.maxEntrySpreadBps
    ) {
      reasons.push(RISK_REJECTION_CODES.SPREAD_TOO_WIDE);
    }

    const cdMs = Math.max(0, c.entryCooldownMs);
    if (
      cdMs > 0 &&
      input.lastCooldownAnchorMs !== null &&
      input.nowMs - input.lastCooldownAnchorMs < cdMs
    ) {
      reasons.push(RISK_REJECTION_CODES.COOLDOWN_ACTIVE);
    }

    if (input.hasOpenPosition) {
      reasons.push(RISK_REJECTION_CODES.POSITION_ALREADY_OPEN);
    }

    const raw =
      input.proposedSizeQuote !== undefined
        ? input.proposedSizeQuote
        : c.baseStakeQuote;

    if (!Number.isFinite(raw)) {
      reasons.push(RISK_REJECTION_CODES.BELOW_MIN_TRADE_SIZE);
    } else if (raw < c.minTradeSizeQuote) {
      reasons.push(RISK_REJECTION_CODES.BELOW_MIN_TRADE_SIZE);
    }

    if (c.maxTradeSizeQuote > 0 && raw > c.maxTradeSizeQuote) {
      reasons.push(RISK_REJECTION_CODES.ABOVE_MAX_TRADE_SIZE);
    }

    const suggested = clampStake(raw, c.minTradeSizeQuote, c.maxTradeSizeQuote);

    const allowed =
      reasons.length === 0 && suggested >= c.minTradeSizeQuote;

    return {
      allowed,
      rejectionReasons: [...reasons],
      suggestedSizeQuote: allowed ? suggested : 0,
    };
  }
}
