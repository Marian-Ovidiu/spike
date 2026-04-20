import { debugMonitor } from "../config.js";

/** All verbose monitor diagnostics (spike, quality gate, strategy reasons, venue quotes). */
export function logMonitorDebug(
  first: unknown,
  ...rest: unknown[]
): void {
  if (!debugMonitor) return;
  if (rest.length === 0) {
    console.log(first);
  } else {
    console.log(first, ...rest);
  }
}
