import { describe, expect, it } from "vitest";
import { contractsFromRiskBudget, riskPerContractAtStop } from "./riskSizing.js";

describe("riskPerContractAtStop", () => {
  it("returns distance to stop for a long", () => {
    expect(riskPerContractAtStop(0.22, 0.085)).toBeCloseTo(0.135, 6);
  });

  it("returns 0 when stop is not below entry", () => {
    expect(riskPerContractAtStop(0.08, 0.09)).toBe(0);
  });
});

describe("contractsFromRiskBudget", () => {
  it("caps size so planned stop loss stays within risk %", () => {
    const equity = 10_000;
    const riskPct = 1;
    const rpc = 0.135;
    const c = contractsFromRiskBudget(equity, riskPct, rpc);
    expect(c * rpc).toBeLessThanOrEqual(100 + 1e-6);
    expect(c).toBe(740);
  });
});
