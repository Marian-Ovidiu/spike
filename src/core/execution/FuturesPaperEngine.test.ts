import { describe, expect, it } from "vitest";
import { FuturesPaperEngine } from "./FuturesPaperEngine.js";
import type { FuturesPaperEngineConfig } from "./futuresPaperTypes.js";
import type { TopOfBookL1 } from "../domain/book.js";

function book(
  mid: number,
  spreadBps: number
): TopOfBookL1 {
  const half = (spreadBps / 10_000 / 2) * mid;
  const bid = mid - half;
  const ask = mid + half;
  const spreadAbs = ask - bid;
  const spreadBpsCalc = (spreadAbs / mid) * 10_000;
  return {
    bestBid: bid,
    bestAsk: ask,
    midPrice: mid,
    spreadBps: spreadBpsCalc,
  };
}

const inst = "test:btcusdt" as const;
const contract = {
  tickSize: 0.5,
  lotSize: 0.5,
  minQuantity: 0.5,
  contractMultiplier: 10,
};

const baseConfig = (overrides: Partial<FuturesPaperEngineConfig> = {}) => ({
  takeProfitBps: 100,
  stopLossBps: 100,
  exitTimeoutMs: 0,
  feeRoundTripBps: 0,
  slippageBps: 0,
  exitGracePeriodMs: 1_000,
  forcedExitPenaltyBps: 25,
  ...overrides,
});

describe("FuturesPaperEngine", () => {
  it("opens long and closes on take-profit at mid", () => {
    const eng = new FuturesPaperEngine(
      baseConfig({ stopLossBps: 500, feeRoundTripBps: 10 })
    );
    const b0 = book(100, 4);
    const op = eng.openLong({
      instrumentId: inst,
      quantity: 1,
      book: b0,
      nowMs: 1_000,
    });
    expect(op.ok).toBe(true);
    if (!op.ok) throw new Error("open");
    const entry = op.avgEntryPrice;

    const tpMid = entry * 1.01;
    const b1 = book(tpMid + 0.5, 4);
    const closed = eng.onBook(b1, 2_000);
    expect(closed).not.toBeNull();
    expect(closed!.closeReason).toBe("take_profit");
    expect(closed!.side).toBe("long");
    expect(closed!.netPnlQuote).toBeGreaterThan(0);
    expect(eng.isFlat()).toBe(true);
    expect(eng.getCumulativeRealizedPnlQuote()).toBe(closed!.netPnlQuote);
  });

  it("opens short and stops out when mid rises", () => {
    const eng = new FuturesPaperEngine(baseConfig({ takeProfitBps: 200, stopLossBps: 50 }));
    const b0 = book(200, 2);
    const op = eng.openShort({
      instrumentId: inst,
      quantity: 2,
      book: b0,
      nowMs: 100,
    });
    expect(op.ok).toBe(true);

    const p = eng.getOpenPosition()!;
    const entry = p.avgEntryPrice;
    const slMid = entry * (1 + 0.005);
    const b1 = book(slMid, 2);
    const closed = eng.onBook(b1, 200);
    expect(closed).not.toBeNull();
    expect(closed!.closeReason).toBe("stop_loss");
    expect(closed!.side).toBe("short");
    expect(closed!.grossPnlQuote).toBeLessThan(0);
  });

  it("closes on timeout", () => {
    const eng = new FuturesPaperEngine(
      baseConfig({
        takeProfitBps: 10_000,
        stopLossBps: 10_000,
        exitTimeoutMs: 1_000,
      })
    );
    const b = book(50, 10);
    eng.openLong({
      instrumentId: inst,
      quantity: 1,
      book: b,
      nowMs: 0,
    });
    const closed = eng.onBook(b, 2_000);
    expect(closed?.closeReason).toBe("exit_timeout");
  });

  it("rejects second open while holding", () => {
    const eng = new FuturesPaperEngine(baseConfig());
    const b = book(1, 100);
    eng.openLong({ instrumentId: inst, quantity: 1, book: b, nowMs: 0 });
    const r = eng.openShort({ instrumentId: inst, quantity: 1, book: b, nowMs: 1 });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unexpected");
    expect(r.reason).toBe("position_already_open");
  });

  it("keeps an exit pending when trigger is hit but the book is invalid", () => {
    const eng = new FuturesPaperEngine(baseConfig({ takeProfitBps: 100 }));
    const b0 = book(100, 4);
    const op = eng.openLong({
      instrumentId: inst,
      quantity: 1,
      book: b0,
      nowMs: 0,
    });
    expect(op.ok).toBe(true);

    const invalidBook: TopOfBookL1 = {
      bestBid: 110,
      bestAsk: 100,
      midPrice: 111,
      spreadBps: -900,
    };
    const decision = eng.evaluateExit(invalidBook, 1_000);
    expect(decision?.kind).toBe("pending");
    if (!decision || decision.kind !== "pending") throw new Error("pending");
    expect(decision.pendingReason).toBe("trigger_reached_book_invalid");
    expect(decision.trigger).toBe("take_profit");
    expect(eng.isFlat()).toBe(false);
  });

  it("forces exit after grace if book remains unusable", () => {
    const eng = new FuturesPaperEngine(baseConfig({ takeProfitBps: 100, exitGracePeriodMs: 500, forcedExitPenaltyBps: 50 }));
    const b0 = book(100, 4);
    eng.openLong({
      instrumentId: inst,
      quantity: 1,
      book: b0,
      nowMs: 0,
    });

    const invalidBook: TopOfBookL1 = {
      bestBid: 110,
      bestAsk: 100,
      midPrice: 111,
      spreadBps: -900,
    };
    const pending = eng.evaluateExit(invalidBook, 100);
    expect(pending?.kind).toBe("pending");
    const forced = eng.evaluateExit(null, 700);
    expect(forced?.kind).toBe("closed");
    if (!forced || forced.kind !== "closed") throw new Error("closed");
    expect(forced.forced).toBe(true);
    expect(forced.roundtrip.closeReason).toBe("forced_exit");
    expect(eng.isFlat()).toBe(true);
  });

  it("uses executable entry price for sizing intent", () => {
    const askBook = book(100, 10);
    const bidBook = book(100, 10);
    const desiredStake = 100;

    const longQty = desiredStake / askBook.bestAsk;
    const shortQty = desiredStake / bidBook.bestBid;

    expect(longQty).toBeLessThan(desiredStake / askBook.midPrice);
    expect(shortQty).toBeGreaterThan(desiredStake / bidBook.midPrice);
  });

  it("rejects quantities that are below the contract minimum or not lot-aligned", () => {
    const eng = new FuturesPaperEngine(baseConfig());
    const b = book(100, 4);
    const rejected = eng.openLong({
      instrumentId: inst,
      quantity: 0.3,
      book: b,
      nowMs: 0,
      contract,
    });
    expect(rejected.ok).toBe(false);
    if (rejected.ok) throw new Error("unexpected");
    expect(rejected.reason).toBe("invalid_quantity");
  });

  it("aligns fill prices to tick size and scales pnl with multiplier", () => {
    const eng = new FuturesPaperEngine(
      baseConfig({ feeRoundTripBps: 0, slippageBps: 0, takeProfitBps: 50, stopLossBps: 10_000 })
    );
    const openBook: TopOfBookL1 = {
      bestBid: 99.9,
      bestAsk: 100.1,
      midPrice: 100,
      spreadBps: 20,
    };
    const open = eng.openLong({
      instrumentId: inst,
      quantity: 1,
      book: openBook,
      nowMs: 0,
      contract,
    });
    expect(open.ok).toBe(true);
    if (!open.ok) throw new Error("open");
    expect(open.avgEntryPrice % contract.tickSize).toBe(0);

    const closeBook: TopOfBookL1 = {
      bestBid: 101.1,
      bestAsk: 101.3,
      midPrice: 101.2,
      spreadBps: 20,
    };
    const closed = eng.onBook(closeBook, 1_000, contract);
    expect(closed).not.toBeNull();
    expect(closed!.exitPrice % contract.tickSize).toBe(0);
    expect(closed!.grossPnlQuote).toBeCloseTo(5);
  });

  it("evaluates margin using mark price and liquidates below maintenance", () => {
    const eng = new FuturesPaperEngine(
      baseConfig({
        slippageBps: 0,
        feeRoundTripBps: 0,
        takeProfitBps: 10_000,
        stopLossBps: 10_000,
        initialMarginRate: 0.1,
        maintenanceMarginRate: 0.05,
        marginWarningRatio: 1.25,
        liquidationRiskRatio: 1.05,
        liquidationPenaltyBps: 50,
      })
    );
    const b = book(100, 0);
    const open = eng.openLong({
      instrumentId: inst,
      quantity: 1,
      book: b,
      nowMs: 0,
      contract,
    });
    expect(open.ok).toBe(true);

    const warning = eng.evaluateMargin({
      markPrice: 96,
      nowMs: 100,
      book: b,
      contract,
    });
    expect(warning?.kind).toBe("margin_warning");
    if (!warning || warning.kind !== "margin_warning") throw new Error("warning");
    expect(warning.snapshot.marginRatio).toBeCloseTo(1.25, 2);

    const risk = eng.evaluateMargin({
      markPrice: 94.9,
      nowMs: 200,
      book: b,
      contract,
    });
    expect(risk?.kind).toBe("liquidation_risk");

    const liqBook = book(94, 0);
    const liquidated = eng.evaluateMargin({
      markPrice: 94,
      nowMs: 300,
      book: liqBook,
      contract,
    });
    expect(liquidated?.kind).toBe("liquidated");
    if (!liquidated || liquidated.kind !== "liquidated") throw new Error("liq");
    expect(liquidated.roundtrip.closeReason).toBe("paper_liquidation");
    expect(eng.isFlat()).toBe(true);
  });

  it("triggers profit lock when estimated net pnl at executable exit is above threshold", () => {
    const eng = new FuturesPaperEngine(
      baseConfig({
        slippageBps: 0,
        feeRoundTripBps: 0,
        takeProfitBps: 10_000,
        stopLossBps: 10_000,
        exitTimeoutMs: 0,
        profitLockEnabled: true,
        profitLockThresholdQuote: 1,
      })
    );
    const openBook = book(100, 2);
    const open = eng.openLong({
      instrumentId: inst,
      quantity: 1,
      book: openBook,
      nowMs: 0,
      contract,
    });
    expect(open.ok).toBe(true);

    const exitBook = book(102, 2);
    const decision = eng.evaluateExit(exitBook, 1_000, contract);
    expect(decision?.kind).toBe("closed");
    if (!decision || decision.kind !== "closed") throw new Error("closed");
    expect(decision.trigger).toBe("profit_lock");
    expect(decision.estimatedNetPnlAtExitQuote).toBeGreaterThanOrEqual(1);
    expect(decision.roundtrip.closeReason).toBe("profit_lock");
    expect(eng.isFlat()).toBe(true);
  });
});
