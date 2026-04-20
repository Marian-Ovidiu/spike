/**
 * Recent (timeMs, Binance signal mid) samples for forward-horizon calibration labels.
 */
export type SignalMidSample = { timeMs: number; mid: number };

export class SignalMidRingBuffer {
  private readonly samples: SignalMidSample[] = [];
  private readonly maxAgeMs: number;

  constructor(maxAgeMs: number) {
    this.maxAgeMs = Math.max(10_000, Math.trunc(maxAgeMs));
  }

  record(timeMs: number, mid: number): void {
    if (!Number.isFinite(timeMs) || !Number.isFinite(mid) || mid <= 0) return;
    this.samples.push({ timeMs, mid });
    const cutoff = timeMs - this.maxAgeMs;
    while (this.samples.length > 0 && this.samples[0]!.timeMs < cutoff) {
      this.samples.shift();
    }
  }

  /** First sample at or after `targetMs` (inclusive). */
  midAtOrAfter(targetMs: number): number | null {
    for (const s of this.samples) {
      if (s.timeMs >= targetMs) return s.mid;
    }
    return null;
  }

  /** Newest sample at or before `targetMs`, or null. */
  midAtOrBefore(targetMs: number): number | null {
    let last: number | null = null;
    for (const s of this.samples) {
      if (s.timeMs <= targetMs) last = s.mid;
      else break;
    }
    return last;
  }

  lastMid(): number | null {
    const n = this.samples.length;
    return n > 0 ? this.samples[n - 1]!.mid : null;
  }
}
