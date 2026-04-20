/**
 * Structured one-line logs for borderline lifecycle (grep-friendly).
 */

export type BorderlinePipelineSignal =
  | "borderline_entered"
  | "borderline_promoted"
  | "borderline_rejected_timeout"
  | "borderline_rejected_weak";

export function logBorderlinePipelineSignal(
  signal: BorderlinePipelineSignal,
  details: Record<string, string | number | boolean | null | undefined>
): void {
  const payload = Object.fromEntries(
    Object.entries(details).filter(([, v]) => v !== undefined)
  );
  console.log(`[borderline_signal] ${signal} ${JSON.stringify(payload)}`);
}
