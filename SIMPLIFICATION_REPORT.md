# Binary-first codebase: simplification audit & refactor plan

This document audits **CLI entry points**, **runtime paths**, and **module responsibilities**, flags **overlap and accidental complexity**, and proposes a **leaner layer model** plus an **optional phased refactor**—without changing behavior in this step.

---

## 1. CLI commands and runtime paths

| npm script | Entry (`dist/` after build) | Primary role |
|------------|----------------------------|--------------|
| `monitor` | `liveMonitor.js` | **Main research loop**: dual feeds, `runLiveMonitorTick`, persistence, shutdown analytics. |
| `start` (if used) | `index.js` | **Slimmer bot**: `createSignalAndExecutionFeeds` + `startBotLoop` only—overlaps monitor’s core wiring without file I/O / session summary. |
| `backtest` | `backtestRunner.js` | **CSV replay**: default binary-first (`runBinaryBacktestFromFile`); `--spot-legacy` for legacy spot paper. |
| `replay-opportunities` | `replayOpportunities.js` | **Offline analysis**: re-evaluates stored `opportunities.jsonl` gates; no trading, no full tick loop. |
| `validate-binary-market` | `validateBinaryMarket.js` | **Gamma/CLOB diagnostics**; exits `2` when synthetic-only—optional integration path. |
| `analyze-run` | `analyzeRun.js` | **Offline**: `analyze/binaryRunAnalytics` over monitor output dir. |
| `analyze-probability-calibration` | `analyzeProbabilityCalibration.js` | **Offline**: reads `probability-calibration-events.jsonl`. |

**Observations**

- **`index.ts` vs `liveMonitor.ts`**: two “runtimes” for the same conceptual product (binary-first bot). `index` is a subset; most docs/scripts point at **monitor**. This splits mental model (“which one do I run?”) and duplicates bootstrap (config, feeds, `assertLegacySpot…`, `assertBinaryOnly…`, discovery).
- **Three offline analysis CLIs** (`replay-opportunities`, `analyze-run`, `analyze-probability-calibration`) plus **backtest `--json-out`** all touch “post-hoc reasoning” but live in separate files with slightly different argv conventions (`--` filtering vs flags).
- **`config.ts`** is loaded by virtually every path; it is large and mixes **defaults**, **env parsing**, **cross-mode warnings**, and **grouped logging**—high coupling surface for any refactor.

---

## 2. Current module map (as-is) vs desired layers

Rough mapping of today’s `src/` to the target mental model:

| Desired layer | Today (representative) | Notes |
|---------------|------------------------|--------|
| **adapters** | `adapters/binanceSpotFeed.ts` | Clear. |
| **signal** (underlying series + window features) | `rollingPriceBuffer.ts`, `strategy.ts` (stable range, spike/window math), `movementClassifier.ts`, `movementAnalysis.ts`, `entryConditions.ts` (partial) | **“strategy”** is a misnomer: it is mostly **signal geometry**, not order decisions. |
| **probability** | `binary/signal/binaryProbabilityEngine.ts`, calibration helpers, `signalMidRingBuffer.ts`, `createBinarySignalFeed.ts` | Good content; nested under `binary/signal` next to feed creation blurs **model** vs **adapter**. |
| **decision** | `strategy/strategyDecisionPipeline.ts`, `borderlineCandidate*.ts`, `strongSpikeCandidate*.ts`, `strongSpikeWatcher.ts`, `postMoveAnalyzer.ts`, `preEntryQualityGate.ts`, `hardRejectEngine.ts`, `overridePolicyEngine.ts`, `quoteQualityFilter.ts`, … | Largest grab-bag; many **gates** at repo root. |
| **venue** | `binary/venue/*`, `executionSpreadFilter.ts`, `market/marketFeedFactory.ts`, `market/types.ts` | Reasonable cluster; `executionSpreadFilter` sits at root beside legacy. |
| **paper execution** | `simulationEngine.ts`, `binary/paper/*`, `legacy/spot/spotBookQuotes.ts`, `legacy/spot/spotExitConditions.ts` | **Single engine** implements both spot and binary—clear branches, but file is very large. |
| **analytics** | `analyze/*`, `sessionEvaluator.ts`, `monitorFunnelDiagnostics.ts`, `monitorRuntimeStats.ts`, parts of `monitorPersistence.ts` / `monitorConsole.ts` | Split between **pure analytics** and **console/persistence**. |

**Legacy / optional (already partially isolated)**

- `legacy/spot/*` — spot execution quotes + exits; good naming.
- `validateBinaryMarket.ts`, Gamma resolver stack — **optional integration**, not core lab loop.

---

## 3. Overlapping or redundant functionality

1. **Two bot entrypoints** (`index.ts`, `liveMonitor.ts`)  
   - Shared: config, feed factory, discovery guard, `BotContext`, loop start.  
   - Risk: behavior drift (e.g. one path gets a guard the other does not).

2. **`strategy.ts` name vs `strategy/strategyDecisionPipeline.ts`**  
   - Imports mix `from "./strategy.js"` (math) and `from "./strategy/strategyDecisionPipeline.js"` (orchestration). New readers assume “strategy” = decisions; half the time it means **window/spike primitives**.

3. **Monitor tick orchestration duplication**  
   - `botLoop.runStrategyTick` vs `monitor/runLiveMonitorTick` vs `backtest.runBinaryBacktestReplay` all recompose: buffer → probability (binary) → book → entry → pipeline → simulation. The **shapes are aligned** but code is **not one shared “tick builder”**—so parity fixes (e.g. optional fields / `exactOptionalPropertyTypes`) must be applied in multiple places.

4. **Spread / executable book**  
   - `executionSpreadFilter.ts`, `market/types.ts` (`toExecutableTopOfBook`), venue feeds each participate in “what is the book this tick?”—coherent but scattered.

5. **Offline tooling overlap**  
   - `replay-opportunities` reimplements slices of pipeline (hard reject, quality gate, binary quote filter) vs full `runStrategyDecisionPipeline`—intentional for analysis, but **duplicated gate logic** can drift from live.

6. **`dist/` in repo** (from git status)  
   - Built artifacts tracked or half-tracked increases noise and review surface; prefer **gitignore** + CI build (operational simplification, not TypeScript structure).

---

## 4. Proposed leaner structure (target layers)

A **research-engine** layout that keeps **binary-first** obvious and pushes **legacy / optional** to the edges:

```text
src/
  apps/                          # thin CLIs only (or cli/)
    liveMonitor.ts
    paperBot.ts                  # optional rename from index.ts
    backtestRunner.ts
    replayOpportunities.ts
    validateBinaryMarket.ts
    analyzeRun.ts
    analyzeProbabilityCalibration.ts

  config/
    ...                          # keep; consider splitting parse vs defaults later

  adapters/
    binanceSpotFeed.ts
    ...

  signal/                        # rename from scattered "strategy" + classifiers
    rollingPriceBuffer.ts
    windowMath.ts                # ex strategy.ts: stable range, spike, window spike
    movementClassifier.ts
    movementAnalysis.ts
    entryConditions.ts           # or signal/entryFeatures.ts if you want pure "features"

  probability/
    binaryProbabilityEngine.ts
    binaryProbabilityCalibration.ts
    probabilityCalibrationResolve.ts
    signalMidRingBuffer.ts

  decision/
    strategyDecisionPipeline.ts
    borderlineCandidate.ts
    borderlineCandidateStore.ts
    strongSpikeCandidate.ts
    strongSpikeCandidateStore.ts
    strongSpikeWatcher.ts
    postMoveAnalyzer.ts
    preEntryQualityGate.ts
    hardRejectEngine.ts
    spikeQualityClassifier.ts
    ...                            # other entry/gate modules

  venue/
    marketTypes.ts                 # or keep market/types + re-export
    marketFeedFactory.ts
    executionSpreadFilter.ts
    binary/                        # merge binary/venue/* here OR venue/binary/*
      syntheticBinaryMarket.ts
      binarySyntheticFeed.ts
      binaryMarketFeed.ts
      ...

  paper/
    simulationEngine.ts
    binary/
      binaryPaperPosition.ts
      ...

  analytics/
    binaryRunAnalytics.ts
    sessionEvaluator.ts
    monitorFunnelDiagnostics.ts
    monitorRuntimeStats.ts

  monitor/                         # I/O boundary: persistence + console formatting
    monitorPersistence.ts
    monitorConsole.ts
    runLiveMonitorTick.ts

  legacy/
    spot/
      ...
```

**Principles**

- **Apps** do argv + `config` + `process.exit`; no strategy math inside CLIs.
- **One tick assembly module** (new): e.g. `decision/buildStrategyTick.ts` or `signal/buildReadyTick.ts` used by **monitor**, **backtest**, and optionally **tests**—reduces triple maintenance.
- **`binary/` tree flattening**: either `venue/binary/*` + `probability/*` + `paper/binary/*` or keep `binary/` as a **bounded context folder** but **rename `binary/signal`** to **`probability`** at top level to avoid “signal adapter vs signal probability” confusion.

---

## 5. Moving legacy / optional (naming & placement)

| Item | Suggestion |
|------|------------|
| Spot execution + exits | Already under `legacy/spot/` — keep; ensure **all** spot-only helpers live there (grep for `PaperBinanceFeed` / spot paths outside `legacy` + `simulationEngine` branches). |
| Gamma validation CLI | Move to `apps/validateBinaryMarket.ts` or `optional/gamma/validateBinaryMarket.ts` if you want a literal `optional/` folder. |
| `replay-opportunities` | Label as `apps/replayOpportunities.ts` + docstring “partial pipeline replay”; consider **importing shared gate helpers** from `decision/` where possible instead of copy-paste. |
| `index.ts` | Either **delete** in favor of monitor-only, or **rename** to `paperBotMinimal.ts` and document one sentence in README: when to use which. |

---

## 6. Optional refactor plan (phased, behavior-preserving)

**Phase 0 — No logic moves**  
- Ensure `dist/` is gitignored; single source of truth for “how to run” in README.  
- Document the two entrypoints (`index` vs `liveMonitor`) and deprecate one in README if product intent is monitor-only.

**Phase 1 — Rename-only (mechanical)**  
- Rename `strategy.ts` → `signal/windowMath.ts` (or similar); update imports.  
- Optionally rename `strategy/` folder → `decision/` and `strategyDecisionPipeline.ts` → `decisionPipeline.ts` (tsconfig paths / re-exports can soften churn).

**Phase 2 — Extract tick builder**  
- Introduce `buildReadyStrategyTick(ctx): StrategyTickResult` (or async variant) that **delegates** to existing `botLoop` internals first, then switch **backtest** and **monitor** to call it—**tests must match current outputs** (golden counters on a fixed CSV slice).

**Phase 3 — Collocate CLIs**  
- Move `*Runner.ts`, `liveMonitor.ts`, `validate*.ts`, `analyze*.ts`, `replayOpportunities.ts` under `src/apps/`; adjust `tsconfig` `rootDir` / out layout or keep flat `dist/` via `outDir` + same file names (copy step optional).

**Phase 4 — `simulationEngine` split**  
- Extract `paper/spotSimulation.ts` and `paper/binarySimulation.ts` behind the same public `SimulationEngine` API to shrink files without changing trade logs.

**Phase 5 — Config decomposition** (highest risk / reward)  
- Split `config.ts` into `config/schema.ts`, `config/envParse.ts`, `config/warnings.ts` with re-export `config`—only after tests + `validate-binary-market` smoke.

**Success criteria (each phase)**  
- `npm test` green; `npx tsc --noEmit`; optional: snapshot test on **one** fixed opportunities row and **one** short CSV backtest JSON summary.

---

## 7. Summary

- The codebase is **already binary-first in naming** under `src/binary/*`, but **root-level modules** (`entryConditions`, `strategy`, gates, `executionSpreadFilter`, large `simulationEngine`, dual CLIs) create **cognitive load** for new contributors.
- Biggest wins for “research engine clarity”: **(1)** single tick builder, **(2)** rename **strategy math → signal**, **(3)** consolidate **apps**, **(4)** clarify **index vs liveMonitor**, **(5)** keep **legacy/spot** and **optional Gamma** visibly peripheral.

This file is the **deliverable report**; implementation should follow **Phase 0 → 1** first, then evaluate ROI on Phases 2–5 against active development velocity.
