import { describe, expect, it } from "vitest";

import {
  applyBinaryPaperVenueTick,
  binaryPaperGrossPnlUsdt,
  binaryPaperRoundTripFeeUsdt,
  binaryPaperUnrealizedPnlUsdt,
  openBinaryPaperPosition,
} from "./binaryPaperPosition.js";

describe("openBinaryPaperPosition", () => {
  it("UP opens YES with stake-sized contracts and fill above yes mid when slippage > 0", () => {
    const p = openBinaryPaperPosition({
      direction: "UP",
      quote: { yesMid: 0.48, noMid: 0.52 },
      slippageBps: 100,
      stakeUsdt: 100,
    });
    expect(p.sideBought).toBe("YES");
    expect(p.entryOutcomePrice).toBeCloseTo(0.48 * 1.01, 8);
    expect(p.contracts).toBeCloseTo(100 / p.entryOutcomePrice, 8);
    expect(p.heldOutcomeMark).toBe(0.48);
  });

  it("DOWN opens NO with mark on NO leg", () => {
    const p = openBinaryPaperPosition({
      direction: "DOWN",
      quote: { yesMid: 0.55, noMid: 0.45 },
      slippageBps: 0,
      stakeUsdt: 45,
    });
    expect(p.sideBought).toBe("NO");
    expect(p.entryOutcomePrice).toBe(0.45);
    expect(p.heldOutcomeMark).toBe(0.45);
    expect(p.contracts).toBe(100);
  });
});

describe("applyBinaryPaperVenueTick", () => {
  it("updates last mids, held mark, and hold min/max trail", () => {
    const p = openBinaryPaperPosition({
      direction: "UP",
      quote: { yesMid: 0.5, noMid: 0.5 },
      slippageBps: 0,
      stakeUsdt: 10,
    });
    const r1 = applyBinaryPaperVenueTick(
      p,
      { yesMid: 0.52, noMid: 0.48 },
      p.heldOutcomeMark,
      p.heldOutcomeMark
    );
    expect(p.yesMidLast).toBe(0.52);
    expect(p.noMidLast).toBe(0.48);
    expect(p.heldOutcomeMark).toBe(0.52);
    expect(r1.holdMarkMin).toBe(0.5);
    expect(r1.holdMarkMax).toBe(0.52);

    const r2 = applyBinaryPaperVenueTick(
      p,
      { yesMid: 0.49, noMid: 0.51 },
      r1.holdMarkMin,
      r1.holdMarkMax
    );
    expect(p.heldOutcomeMark).toBe(0.49);
    expect(r2.holdMarkMin).toBe(0.49);
    expect(r2.holdMarkMax).toBe(0.52);
  });
});

describe("binaryPaperGrossPnlUsdt", () => {
  it("matches contracts × (exit − entry) on the held leg", () => {
    const g = binaryPaperGrossPnlUsdt(100, 0.4, 0.55);
    expect(g).toBeCloseTo(15, 8);
  });
});

describe("binaryPaperRoundTripFeeUsdt", () => {
  it("applies bps to stake", () => {
    expect(binaryPaperRoundTripFeeUsdt(250, 40)).toBeCloseTo(1, 8);
  });
});

describe("binaryPaperUnrealizedPnlUsdt", () => {
  it("values NO position against fresh NO mid", () => {
    const p = openBinaryPaperPosition({
      direction: "DOWN",
      quote: { yesMid: 0.52, noMid: 0.48 },
      slippageBps: 0,
      stakeUsdt: 48,
    });
    const u = binaryPaperUnrealizedPnlUsdt(p, { yesMid: 0.5, noMid: 0.5 });
    expect(u).toBeCloseTo(p.contracts * (0.5 - 0.48), 8);
  });
});
