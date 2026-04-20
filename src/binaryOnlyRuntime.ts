/**
 * Optional strict mode: fail fast when the repo is configured for binary-first
 * but `MARKET_MODE` is still `spot` (use `LEGACY_SPOT_MARKET_MODE=1` if you intentionally run that legacy path). Does not affect Binance **signal** usage in binary mode.
 */

export function readBinaryOnlyRuntimeFlag(): boolean {
  const raw = process.env.BINARY_ONLY_RUNTIME?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

/** Call once after config load (e.g. from `liveMonitor` / `index` entry). */
export function assertBinaryOnlyRuntime(mode: "spot" | "binary"): void {
  if (!readBinaryOnlyRuntimeFlag()) return;
  if (mode === "spot") {
    console.error(
      "[binary-only] BINARY_ONLY_RUNTIME=1 but MARKET_MODE=spot — refusing to start. Set MARKET_MODE=binary or unset BINARY_ONLY_RUNTIME."
    );
    process.exit(1);
  }
}
