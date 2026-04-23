/**
 * Fixed-capacity FIFO buffer of scalar samples (e.g. mid prices): newest at the end.
 */
export class RollingPriceBuffer {
  private readonly capacity: number;
  private readonly buffer: number[] = [];

  constructor(capacity: number) {
    const n = Math.trunc(capacity);
    if (!Number.isFinite(n) || n < 1) {
      throw new Error(
        `RollingPriceBuffer: capacity must be a finite integer >= 1, got ${capacity}`
      );
    }
    this.capacity = n;
  }

  addPrice(price: number): void {
    if (!Number.isFinite(price)) return;
    this.buffer.push(price);
    while (this.buffer.length > this.capacity) {
      this.buffer.shift();
    }
  }

  /** Snapshot, oldest first. */
  getPrices(): readonly number[] {
    return [...this.buffer];
  }

  getLast(): number | undefined {
    const n = this.buffer.length;
    if (n === 0) return undefined;
    return this.buffer[n - 1]!;
  }

  getPrevious(): number | undefined {
    const n = this.buffer.length;
    if (n < 2) return undefined;
    return this.buffer[n - 2]!;
  }
}
