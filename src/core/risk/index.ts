/**
 * Operational risk gating (feeds, spread, cooldown, size bounds).
 *
 * ## Lineage (legacy repo — not imported here)
 *
 * | Concept | Typical source today |
 * |---------|----------------------|
 * | Execution feed stale + block | `botLoop.ts` `feedPossiblyStaleForRole`, `applyFeedStaleEntryBlock` in `runLiveMonitorTick.ts`, `blockEntriesOnStaleFeed` / `feedStaleMaxAgeMs` in `config.ts` |
 * | Spread cap | `executionSpreadFilter.ts` `evaluateExecutionSpreadFilter`, `maxEntrySpreadBps` |
 * | Cooldown | `entryCooldownMs`, strategy pipeline `active_position_or_cooldown`, `strongSpikeCandidate.ts` |
 * | Min/max stake | `config` `minTradeSize` / `maxTradeSize`, `riskPositionSizing.ts` / `simulationEngine.ts` clamps |
 * | One position | implicit in `SimulationEngine` single open position |
 *
 * Signal-only gates (spike quality, borderline, binary quotes) **do not** belong in `RiskEngine`.
 */

export { RiskEngine } from "./RiskEngine.js";
export type { RiskEngineConfig } from "./riskConfig.js";
export type {
  RiskGateResult,
  RiskEvaluationInput,
} from "./riskTypes.js";
export { RISK_REJECTION_CODES } from "./riskTypes.js";
