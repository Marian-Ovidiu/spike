import { describe, expect, it } from "vitest";
import { BalanceEngine } from "./BalanceEngine.js";

describe("BalanceEngine", () => {
  it("keeps fixed stake until the balance crosses the compounding threshold", () => {
    const eng = new BalanceEngine({
      enabled: true,
      startingBalance: 110,
      reserveBalance: 10,
      fixedStakeUntilBalance: 120,
      minBalanceToContinue: 100,
      fixedStakeQuote: 100,
    });

    expect(eng.currentBalance).toBe(110);
    expect(eng.activeStake).toBe(100);
    expect(eng.stakeMode).toBe("fixed");

    eng.applyRealizedNetPnlQuote(11);
    expect(eng.currentBalance).toBe(121);
    expect(eng.activeStake).toBe(111);
    expect(eng.stakeMode).toBe("compounding");
  });

  it("requests a clean stop when the balance drops below the minimum after a close", () => {
    const eng = new BalanceEngine({
      enabled: true,
      startingBalance: 110,
      reserveBalance: 10,
      fixedStakeUntilBalance: 120,
      minBalanceToContinue: 100,
      fixedStakeQuote: 100,
    });

    const snapshot = eng.applyRealizedNetPnlQuote(-11);
    expect(snapshot.currentBalance).toBe(99);
    expect(snapshot.stopRequested).toBe(true);
    expect(snapshot.stopReason).toContain("balance_below_minimum_after_close");
  });

  it("tracks equity with unrealized pnl", () => {
    const eng = new BalanceEngine({
      enabled: true,
      startingBalance: 110,
      reserveBalance: 10,
      fixedStakeUntilBalance: 120,
      minBalanceToContinue: 100,
      fixedStakeQuote: 100,
    });

    eng.setUnrealizedPnlQuote(7.5);
    expect(eng.currentEquity).toBe(117.5);
  });
});
