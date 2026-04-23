import { describe, expect, it } from "vitest";
import { RiskEngine } from "./RiskEngine.js";
import { RISK_REJECTION_CODES } from "./riskTypes.js";

const baseCfg = () => ({
  blockEntriesOnExecutionFeedStale: true,
  blockEntriesOnSignalFeedStale: false,
  maxEntrySpreadBps: 50,
  entryCooldownMs: 60_000,
  baseStakeQuote: 100,
  minTradeSizeQuote: 10,
  maxTradeSizeQuote: 500,
});

describe("RiskEngine", () => {
  it("allows clean entry with suggested size clamped", () => {
    const eng = new RiskEngine(baseCfg());
    const r = eng.evaluateNewEntry({
      nowMs: 1_000_000,
      lastCooldownAnchorMs: null,
      hasOpenPosition: false,
      execution: { feedStale: false, spreadBps: 10 },
    });
    expect(r.allowed).toBe(true);
    expect(r.rejectionReasons).toEqual([]);
    expect(r.suggestedSizeQuote).toBe(100);
  });

  it("blocks execution feed stale", () => {
    const eng = new RiskEngine(baseCfg());
    const r = eng.evaluateNewEntry({
      nowMs: 1,
      lastCooldownAnchorMs: null,
      hasOpenPosition: false,
      execution: { feedStale: true, spreadBps: 5 },
    });
    expect(r.allowed).toBe(false);
    expect(r.rejectionReasons).toContain(
      RISK_REJECTION_CODES.EXECUTION_FEED_STALE
    );
    expect(r.suggestedSizeQuote).toBe(0);
  });

  it("blocks wide spread", () => {
    const eng = new RiskEngine(baseCfg());
    const r = eng.evaluateNewEntry({
      nowMs: 1,
      lastCooldownAnchorMs: null,
      hasOpenPosition: false,
      execution: { feedStale: false, spreadBps: 200 },
    });
    expect(r.allowed).toBe(false);
    expect(r.rejectionReasons).toContain(RISK_REJECTION_CODES.SPREAD_TOO_WIDE);
  });

  it("blocks during cooldown", () => {
    const eng = new RiskEngine(baseCfg());
    const r = eng.evaluateNewEntry({
      nowMs: 1_000_000,
      lastCooldownAnchorMs: 999_000,
      hasOpenPosition: false,
      execution: { feedStale: false, spreadBps: 5 },
    });
    expect(r.allowed).toBe(false);
    expect(r.rejectionReasons).toContain(RISK_REJECTION_CODES.COOLDOWN_ACTIVE);
  });

  it("blocks when position open", () => {
    const eng = new RiskEngine(baseCfg());
    const r = eng.evaluateNewEntry({
      nowMs: 200_000,
      lastCooldownAnchorMs: null,
      hasOpenPosition: true,
      execution: { feedStale: false, spreadBps: 5 },
    });
    expect(r.allowed).toBe(false);
    expect(r.rejectionReasons).toContain(
      RISK_REJECTION_CODES.POSITION_ALREADY_OPEN
    );
  });
});
