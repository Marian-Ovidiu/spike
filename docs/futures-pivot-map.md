# Mappa pivot futures (struttura target + classificazione moduli)

**Stato:** preparazione repository. **Nessun file applicativo è stato spostato**; le directory sotto `src/core/*` e `src/legacy/binary` contengono solo segnaposto (`.gitkeep`).  
`src/legacy/spot` **esisteva già** (`assertLegacySpotMarketMode.ts`, `spotBookQuotes.ts`, `spotExitConditions.ts`, `README.md`); non è stato sovrascritto.

Obiettivo: definire dove atterrerà il **nuovo core** e cosa resta **legacy** (binary + spot) in vista di un motore futures, **senza** aver ancora alterato import o runtime.

---

## 1. Moduli da migrare per primi nel nuovo core (per area target)

I path sono quelli **attuali** nel repo; la destinazione indicata è la cartella `src/core/<area>/` quando si farà lo spostamento fisico.

### `src/core/signal` — rilevazione movimento / spike su serie di prezzi

| Path attuale | Nota sintetica |
|----------------|----------------|
| `src/strategy.ts` | Range stabile, spike, finestra dominante vs chop |
| `src/entryConditions.ts` | Valutazione ingresso da prezzi + spread execution |
| `src/rollingPriceBuffer.ts` | Buffer rolling dei mid segnale |
| `src/movementClassifier.ts` | Classificazione mossa |
| `src/movementAnalysis.ts` | Analisi movimento/struttura |
| `src/spikeQualityClassifier.ts` | Profili qualità spike |
| `src/rangeNoiseFilter.ts` | Filtri rumore range |
| `src/quoteQualityFilter.ts` | Gate qualità quote (generico spread/livelli) |
| `src/postMoveAnalyzer.ts` | Post-movimento (borderline continuation/reversion) |
| `src/postSpikeConfirmationEngine.ts` | Conferme post-spike |
| `src/spikeDebugTracker.ts` | Telemetria spike (diagnostica) |

### `src/core/domain` — gates, contesto, stato candidati (senza venue binario)

| Path attuale | Nota sintetica |
|----------------|----------------|
| `src/stableRangeQuality.ts` | Qualità fascia stabile |
| `src/rangeQualityEvaluator.ts` | Valutazione qualità range |
| `src/preEntryQualityGate.ts` | Gate qualità pre-entry |
| `src/hardRejectEngine.ts` | Hard reject contesto instabile |
| `src/borderlineCandidate.ts` | Modello candidato borderline |
| `src/borderlineCandidateStore.ts` | Store candidati borderline |
| `src/borderlineWatcher.ts` | Logica watch borderline |
| `src/strongSpikeCandidate.ts` | Modello candidato strong spike |
| `src/strongSpikeCandidateStore.ts` | Store strong spike |
| `src/strongSpikeWatcher.ts` | Watch strong spike |
| `src/decisionReasonBuilder.ts` | Normalizzazione reason/rejection |
| `src/rejectionReasons.ts` | Reason codes |
| `src/paperEntryPath.ts` | Tipi path entry paper (da generalizzare) |
| `src/exitConditions.ts` | Modulo unificato exit (oggi orchestrator; dipende da rami legacy) |
| `src/holdExitAudit.ts` | Audit uscita in hold |

*Nota:* `src/preEntryQualityGate.ts` / `src/hardRejectEngine.ts` importano concetti usati anche dal pipeline binary; in migrazione si taglieranno gli import verso `binary/`.*

### `src/core/market` — astrazioni feed / book eseguibile

| Path attuale | Nota sintetica |
|----------------|----------------|
| `src/market/types.ts` | `MarketDataFeed`, `ExecutableTopOfBook`, `MarketMode`, tipi quote |
| `src/market/marketFeedFactory.ts` | Factory signal/execution (oggi agganciata a binary) |
| `src/market/marketDiagnostics.ts` | Diagnostica shutdown feed |
| `src/adapters/binanceSpotFeed.ts` | Adapter Binance spot (REST + WS) |
| `src/executionSpreadFilter.ts` | Filtro spread su book eseguibile (`spreadBps` vs soglia); dipendenze minime |

*Nota:* `src/market/binaryQuoteTypes.ts` è **specifico binary** → non va nel core neutro; resta legacy fino a refactor tipi.*

### `src/core/risk` — sizing / risk

| Path attuale | Nota sintetica |
|----------------|----------------|
| `src/riskPositionSizing.ts` | Dimensionamento posizione da rischio |
| `src/riskSizing.ts` | Helper sizing rischio |
| `src/stakeSizing.ts` | Moltiplicatori stake / qualità |

### `src/core/runtime` — orchestrazione tick (solo quando spezzato dal binary)

| Path attuale | Nota sintetica |
|----------------|----------------|
| `src/botLoop.ts` | `runStrategyTick`, `BotContext`, `runBotTick` — **oggi** contiene rami `marketMode === "binary"` e probabilità; va suddiviso prima di “solo core” |

*Ordine suggerito (fuori scope di questa PR): estrarre prima il ramo signal puro, poi agganciare futures.*

### `src/core/reporting` — persistenza e schema osservabilità

| Path attuale | Nota sintetica |
|----------------|----------------|
| `src/monitorPersistence.ts` | JSONL, session summary — **schema oggi densamente binary**; va ridisegnato per futures in una seconda ondata |
| `src/config/monitorNormalizedConfigSummary.ts` | Snapshot config normalizzato (oggi include selettori Gamma / exit binary) |

### Config condiviso (resta temporaneamente in `src/config.ts`; subset futures)

| Path attuale | Nota sintetica |
|----------------|----------------|
| `src/config.ts` | Loader env unico — contiene chiavi binary/spot/shared; il **loader** è riuso utile; la **lista chiavi** andrà partizionata in migrazione |

---

## 2. Moduli da isolare in legacy

### Destinazione logica: `src/legacy/binary` (oggi il codice vive ancora in `src/binary/**`)

Tutto l’albero attuale **`src/binary/`** è dominio prediction market / YES-NO / Gamma / sintetico:

- `src/binary/venue/` — synthetic feed, Gamma, discovery, selector, pricing sintetico  
- `src/binary/signal/` — probabilità momentum, calibration, `createBinarySignalFeed`, wrapper BTC  
- `src/binary/entry/`, `src/binary/exit/`, `src/binary/paper/`, `src/binary/monitor/`

**Script / tool binary-only:**

- `src/validateBinaryMarket.ts`
- `src/binaryOnlyRuntime.ts`
- `src/config/binarySideGating.ts` (gating YES/NO)

**Analyze post-run binary:**

- `src/analyze/binaryRunAnalytics.ts`
- `src/analyze/binaryMultiSessionAggregate.ts`
- `src/analyzeProbabilityCalibration.ts`
- `src/analyzeRun.ts`, `src/analyzeSessions.ts` — **dipendono** da output/sessioni binary; vanno ridefiniti o tenuti in legacy fino a nuovo schema

**Monitor / interpretazione binary:**

- `src/monitor/binarySessionInterpretation.ts`
- Parti di `src/monitor/runLiveMonitorTick.ts`, `src/monitorConsole.ts`, `src/monitorRuntimeStats.ts`, `src/monitorFunnelDiagnostics.ts` legate a quote YES/NO e funnel strong-spike binary

**Pipeline e simulazione fortemente accoppiate:**

- `src/strategy/strategyDecisionPipeline.ts` (import massicci da `binary/entry/*`)
- `src/simulationEngine.ts` (paper binary + spot legacy nello stesso file)
- `src/tradeEntryOpenDiagnosis.ts` — motivazioni apertura legate al pipeline attuale

### Destinazione: `src/legacy/spot` (già presente nel repo)

| Path attuale | Ruolo |
|----------------|--------|
| `src/legacy/spot/assertLegacySpotMarketMode.ts` | Ack `LEGACY_SPOT_MARKET_MODE` |
| `src/legacy/spot/spotBookQuotes.ts` | Mark/fill paper spot |
| `src/legacy/spot/spotExitConditions.ts` | Exit in bps spot |

### Altri file “radice” che restano orchestrazione legacy fino al nuovo entry futures

- `src/liveMonitor.ts` — entry monitor attuale (`npm run monitor`)
- `src/index.ts` — loop semplificato senza pipeline monitor completo
- `src/backtest.ts`, `src/backtestRunner.ts` — replay CSV legato a `SimulationEngine` e modalità binary/spot legacy
- `src/replayOpportunities.ts` — replay JSONL opportunità (formato binary-centric)
- `src/opportunityTracker.ts` — modello opportunità con campi binary (`yesPrice`, `estimatedProbabilityUp`, …)

---

## 3. Moduli candidati alla rimozione (dopo conferma uso)

| Path | Motivo |
|------|--------|
| `src/legacy/btcPriceService.ts` | Spostato qui da `src/btcPriceService.ts`; nessun `import` da altri moduli `src/` — REST ticker duplicato rispetto a `BinanceSpotFeed`. **Archive candidate.** |

*Nessun altro file è classificabile come “rimozione sicura” senza analisi import: il resto è ancora referenziato dalla pipeline o dai test.*

---

## 4. Dipendenze critiche da spezzare (ordine logico)

1. **`SimulationEngine` (`src/simulationEngine.ts`) ↔ `src/binary/paper/*`, `binary/exit/*`, `binary/monitor/*`, `legacy/spot/*`**  
   Un solo motore per due mondi (outcome 0–1 vs spot bps). Per futures serve un motore positions/contratti separato o un’interfaccia `ExecutionBackend`.

2. **`strategyDecisionPipeline` ↔ `binary/entry/binaryQuoteEntryFilter`, `binaryQuoteEntryFilter`, edge/mispricing**  
   Il gate strategico è intrecciato con quote YES/NO e soglie `binaryMax*`. Spezzare: **filtri venue** dietro interfaccia “executable quote” neutra.

3. **`marketFeedFactory` ↔ `createBinaryExecutionFeed` / `createBinarySignalDataFeed`**  
   La factory incorpora il ramo binary end-to-end. Target: factory che seleziona **instrument class** (futures vs legacy) senza import diretti da `binary/` nel cuore.

4. **`botLoop.runStrategyTick` ↔ `estimateProbabilityUpFromPriceBuffer` e `getBinaryOutcomePrices`**  
   Probabilità e outcome sono solo per il ramo binary; il tick futures deve leggere **mid/order book strumento** senza passare da `BinaryOutcomePrices`.

5. **`config.ts` ↔ centinaia di chiavi condivise**  
   Accoppiamento env: futures avrà TP/SL in tick/prezzo contratto, margine, commissioni — va un **namespace** o file config separato senza rompere i default attuali fino al cutover.

6. **`monitorPersistence` ↔ campi JSONL binary**  
   Session summary e opportunities includono slug Polymarket, `yesPrice`, calibration; serve schema versionato o file separati per futures.

---

## 5. Entry point attuale e entry point target (futures)

### Attuali (da `package.json` + sorgenti)

| Meccanismo | File sorgente | Output build | Script npm tipico |
|------------|-----------------|--------------|-------------------|
| Monitor live | `src/liveMonitor.ts` | `dist/liveMonitor.js` | `npm run monitor` |
| Loop bot CLI | `src/index.ts` | `dist/index.js` | `node dist/index.js` (nessuno script dedicato in `package.json` oltre `main` implicito) |
| Backtest CSV | `src/backtestRunner.ts` | `dist/backtestRunner.js` | `npm run backtest` |
| Validate Gamma | `src/validateBinaryMarket.ts` | `dist/validateBinaryMarket.js` | `npm run validate-binary-market` |
| Replay opportunità | `src/replayOpportunities.ts` | `dist/replayOpportunities.js` | `npm run replay-opportunities` |
| Analyze | `src/analyzeRun.ts`, `src/analyzeSessions.ts`, `src/analyzeProbabilityCalibration.ts` | `dist/*.js` | `npm run analyze-*` |

### Target (non implementato in questa fase)

- **Runtime futures:** un modulo sotto `src/core/runtime/` (es. `futuresMonitor.ts` o `runEngine.ts`) che:
  - compone **feed** (`core/market`) + **signal** (`core/signal`) + **execution sim futures** (`core/execution`) + **risk** (`core/risk`);
  - espone un **entry** dedicato (`dist/futuresMonitor.js` o nome da definire) con script npm dedicato **quando** il motore sarà pronto.

- **Legacy:** gli entry attuali continuano a puntare a `liveMonitor` / `index` / backtest **fino a deprecazione esplicita**; il codice spostato in `src/legacy/binary` sarà richiamato solo dai path legacy o da wrapper di compatibilità.

---

## Riferimento directory create in questa task

| Path | Contenuto |
|------|-----------|
| `src/core/signal/` | `.gitkeep` |
| `src/core/domain/` | `.gitkeep` |
| `src/core/market/` | `.gitkeep` |
| `src/core/execution/` | `.gitkeep` |
| `src/core/risk/` | `.gitkeep` |
| `src/core/runtime/` | `.gitkeep` |
| `src/core/reporting/` | `.gitkeep` |
| `src/legacy/binary/` | `.gitkeep` (placeholder; l’implementazione è ancora in `src/binary/`) |
| `src/legacy/spot/` | **pre-esistente** (nessun file aggiunto qui) |

Vedi anche `PROJECT_AUDIT_REPORT.md` alla radice del repo per il contesto dell’audit completo.
