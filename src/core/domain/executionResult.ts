import type { Fill } from "./fill.js";

/**
 * Outcome of submitting an order through a broker / sim (not the same as “trade idea”).
 */
export type ExecutionStatus =
  | "accepted"
  | "partially_filled"
  | "filled"
  | "rejected"
  | "cancelled";

export interface ExecutionResult {
  readonly status: ExecutionStatus;
  readonly clientOrderId?: string;
  readonly venueOrderId?: string;
  readonly fills: readonly Fill[];
  readonly rejectReason?: string;
}
