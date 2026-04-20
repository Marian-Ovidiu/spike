import { describe, expect, it } from "vitest";

import { SignalMidRingBuffer } from "./signalMidRingBuffer.js";

describe("SignalMidRingBuffer", () => {
  it("returns first mid at or after target time", () => {
    const r = new SignalMidRingBuffer(60_000);
    r.record(1000, 100);
    r.record(2000, 101);
    r.record(3000, 105);
    expect(r.midAtOrAfter(1500)).toBe(101);
    expect(r.midAtOrAfter(3000)).toBe(105);
  });

  it("drops samples older than maxAge", () => {
    const r = new SignalMidRingBuffer(1_000);
    r.record(0, 1);
    r.record(2_000, 3);
    expect(r.midAtOrAfter(100)).toBe(3);
  });
});
