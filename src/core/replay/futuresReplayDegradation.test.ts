import { describe, expect, it } from "vitest";
import { createReplayFailureInjector } from "./futuresReplayDegradation.js";

describe("ReplayFailureInjector", () => {
  it("emits a forced degradation burst and then reconnects", () => {
    const injector = createReplayFailureInjector({
      profile: "off",
      seed: 42,
      forceExitDisruption: true,
      stepMs: 5_000,
      exitGracePeriodMs: 5_000,
    });

    injector.armExitDisruption();

    const first = injector.planTick({
      atMs: 1_000,
      mid: 100,
      spreadBps: 3,
      previousMid: null,
      feedStaleMaxAgeMs: 0,
    }).condition;
    const second = injector.planTick({
      atMs: 6_000,
      mid: 100,
      spreadBps: 3,
      previousMid: 100,
      feedStaleMaxAgeMs: 0,
    }).condition;
    const third = injector.planTick({
      atMs: 11_000,
      mid: 100,
      spreadBps: 3,
      previousMid: 100,
      feedStaleMaxAgeMs: 0,
    }).condition;

    expect(first.degraded).toBe(true);
    expect(first.kind === "missing_book" || first.kind === "invalid_book").toBe(true);
    expect(second.degraded).toBe(true);
    expect(third.reconnect).toBe(true);
    expect(third.degraded).toBe(false);
    expect(third.book).not.toBeNull();
  });

  it("is deterministic for the same seed and profile", () => {
    const a = createReplayFailureInjector({
      profile: "stress",
      seed: 7,
      forceExitDisruption: false,
      stepMs: 5_000,
      exitGracePeriodMs: 5_000,
    });
    const b = createReplayFailureInjector({
      profile: "stress",
      seed: 7,
      forceExitDisruption: false,
      stepMs: 5_000,
      exitGracePeriodMs: 5_000,
    });

    const seqA = Array.from({ length: 6 }, (_, i) =>
      a.planTick({
        atMs: 1_000 + i * 5_000,
        mid: 100 + i,
        spreadBps: 3,
        previousMid: i === 0 ? null : 100 + i - 1,
        feedStaleMaxAgeMs: 0,
      }).condition.kind
    );
    const seqB = Array.from({ length: 6 }, (_, i) =>
      b.planTick({
        atMs: 1_000 + i * 5_000,
        mid: 100 + i,
        spreadBps: 3,
        previousMid: i === 0 ? null : 100 + i - 1,
        feedStaleMaxAgeMs: 0,
      }).condition.kind
    );

    expect(seqA).toEqual(seqB);
  });
});
