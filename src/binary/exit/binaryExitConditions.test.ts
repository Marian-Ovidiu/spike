import { describe, expect, it } from "vitest";
import {
  computeBinaryExitDiagnostics,
  evaluateBinaryExitConditions,
} from "./binaryExitConditions.js";

describe("evaluateBinaryExitConditions", () => {
  const base = {
    entryFillPrice: 0.49,
    takeProfitPriceDelta: 0.05,
    stopLossPriceDelta: 0.05,
    openedAt: 1_000,
    timeoutMs: 60_000,
  };

  it("fires profit when mark reaches entry + TP delta", () => {
    expect(
      evaluateBinaryExitConditions({
        ...base,
        markPrice: 0.54,
        now: 2_000,
      })
    ).toEqual({ shouldExit: true, reason: "profit" });
    expect(
      evaluateBinaryExitConditions({
        ...base,
        markPrice: 0.539,
        now: 2_000,
      })
    ).toEqual({ shouldExit: false, reason: null });
  });

  it("fires stop when mark reaches entry − SL delta", () => {
    expect(
      evaluateBinaryExitConditions({
        ...base,
        markPrice: 0.44,
        now: 2_000,
      })
    ).toEqual({ shouldExit: true, reason: "stop" });
    expect(
      evaluateBinaryExitConditions({
        ...base,
        markPrice: 0.441,
        now: 2_000,
      })
    ).toEqual({ shouldExit: false, reason: null });
  });

  it("profit takes precedence over stop when both deltas hit same tick", () => {
    expect(
      evaluateBinaryExitConditions({
        entryFillPrice: 0.5,
        takeProfitPriceDelta: 0.05,
        stopLossPriceDelta: 0.05,
        markPrice: 0.8,
        openedAt: 0,
        timeoutMs: 60_000,
        now: 1,
      }).reason
    ).toBe("profit");
  });

  it("fires timeout when elapsed exceeds timeoutMs", () => {
    expect(
      evaluateBinaryExitConditions({
        ...base,
        markPrice: 0.49,
        now: 1_000 + 60_000,
      })
    ).toEqual({ shouldExit: true, reason: "timeout" });
  });

  it("does not timeout when timeoutMs is 0", () => {
    expect(
      evaluateBinaryExitConditions({
        ...base,
        markPrice: 0.49,
        timeoutMs: 0,
        now: 9_999_999,
      })
    ).toEqual({ shouldExit: false, reason: null });
  });

  it("ignores TP/SL when corresponding delta is 0", () => {
    expect(
      evaluateBinaryExitConditions({
        entryFillPrice: 0.5,
        takeProfitPriceDelta: 0,
        stopLossPriceDelta: 0,
        markPrice: 0.99,
        openedAt: 0,
        timeoutMs: 0,
        now: 1,
      })
    ).toEqual({ shouldExit: false, reason: null });
  });
});

describe("computeBinaryExitDiagnostics", () => {
  it("mirrors evaluate flags", () => {
    const d = computeBinaryExitDiagnostics({
      markPrice: 0.55,
      entryFillPrice: 0.5,
      takeProfitPriceDelta: 0.05,
      stopLossPriceDelta: 0.05,
      openedAt: 0,
      timeoutMs: 10_000,
      now: 11_000,
    });
    expect(d.inputsValid).toBe(true);
    expect(d.targetHit).toBe(true);
    expect(d.stopHit).toBe(false);
    expect(d.timeoutReached).toBe(true);
  });
});
