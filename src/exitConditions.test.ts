import { describe, expect, it } from "vitest";
import {
  computeExitDiagnosticsFlags,
  DEFAULT_EXIT_TIMEOUT_MS,
  evaluateExitConditions,
} from "./exitConditions.js";

const base = {
  exitPrice: 0.5,
  stopLoss: 0.1,
  openedAt: 1_000_000,
  now: 1_000_000 + 30_000,
};

describe("evaluateExitConditions", () => {
  it("returns profit when currentPrice >= exitPrice", () => {
    const r = evaluateExitConditions({
      ...base,
      currentPrice: 0.55,
    });
    expect(r).toEqual({ shouldExit: true, reason: "profit" });
  });

  it("returns stop when currentPrice <= stopLoss", () => {
    const r = evaluateExitConditions({
      ...base,
      currentPrice: 0.08,
    });
    expect(r).toEqual({ shouldExit: true, reason: "stop" });
  });

  it("returns timeout when elapsed >= timeoutMs", () => {
    const r = evaluateExitConditions({
      ...base,
      currentPrice: 0.3,
      openedAt: 1_000_000,
      now: 1_000_000 + DEFAULT_EXIT_TIMEOUT_MS,
      timeoutMs: DEFAULT_EXIT_TIMEOUT_MS,
    });
    expect(r).toEqual({ shouldExit: true, reason: "timeout" });
  });

  it("uses default 60s timeout when timeoutMs omitted", () => {
    const r = evaluateExitConditions({
      ...base,
      currentPrice: 0.3,
      openedAt: 0,
      now: DEFAULT_EXIT_TIMEOUT_MS,
    });
    expect(r.reason).toBe("timeout");
  });

  it("returns no exit when between stop and exit and before timeout", () => {
    const r = evaluateExitConditions({
      ...base,
      currentPrice: 0.3,
      openedAt: 1_000_000,
      now: 1_000_000 + 10_000,
      timeoutMs: 60_000,
    });
    expect(r).toEqual({ shouldExit: false, reason: null });
  });

  it("prefers profit over timeout when both apply", () => {
    const r = evaluateExitConditions({
      ...base,
      currentPrice: 0.6,
      openedAt: 0,
      now: DEFAULT_EXIT_TIMEOUT_MS + 1,
    });
    expect(r.reason).toBe("profit");
  });

  it("prefers profit over stop when both apply (misconfigured thresholds)", () => {
    const r = evaluateExitConditions({
      currentPrice: 0.6,
      exitPrice: 0.5,
      stopLoss: 0.7,
      openedAt: base.openedAt,
      now: base.now,
    });
    expect(r.reason).toBe("profit");
  });

  it("returns no exit for non-finite inputs", () => {
    expect(
      evaluateExitConditions({
        ...base,
        currentPrice: Number.NaN,
      }).shouldExit
    ).toBe(false);
  });
});

describe("computeExitDiagnosticsFlags", () => {
  it("reports independent target/stop/timeout booleans", () => {
    const d = computeExitDiagnosticsFlags({
      currentPrice: 0.3,
      exitPrice: 0.5,
      stopLoss: 0.1,
      openedAt: 1_000_000,
      now: 1_000_000 + DEFAULT_EXIT_TIMEOUT_MS,
      timeoutMs: DEFAULT_EXIT_TIMEOUT_MS,
    });
    expect(d.inputsValid).toBe(true);
    expect(d.targetHit).toBe(false);
    expect(d.stopHit).toBe(false);
    expect(d.timeoutReached).toBe(true);
    expect(d.elapsedMs).toBe(DEFAULT_EXIT_TIMEOUT_MS);
  });

  it("returns inputsValid false for NaN mark", () => {
    const d = computeExitDiagnosticsFlags({
      currentPrice: Number.NaN,
      exitPrice: 0.5,
      stopLoss: 0.1,
      openedAt: 1_000_000,
      now: 1_000_001,
    });
    expect(d.inputsValid).toBe(false);
  });
});
