Report tecnico del repository **spike-bot**: documento interno di audit.  
Analisi basata sul codice TypeScript in `src/`, `package.json`, `.env.example`, `AGENTS.md` e script npm. Dove qualcosa non è implementato o non è ricavabile dal codice, è indicato esplicitamente.

---

# 1. Executive Summary

Il progetto è un **bot di paper trading** orientato ai **mercati binari YES/NO** (stile Polymarket), con **segnale di movimento da mid BTC spot** (default: Binance via WebSocket) e **venue di esecuzione** separata: per default un **libro sintetico** (`BinarySyntheticFeed`), opzionalmente **quote pubbliche Gamma** (`BinaryMarketFeed`) senza ordini reali verso exchange.

La logica core documentata in `AGENTS.md` è **mean-reversion su spike**: finestra relativamente stabile, spike sul prezzo spot, ingresso **contrarian** (direzione opposta al movimento), uscita su TP/SL/timeout su **prezzo del token comprato** (non sul BTC).

Il codice mostra **maturità da framework di ricerca / laboratorio**: pipeline articolata (`strategyDecisionPipeline.ts`), osservabilità ricca (JSONL, summary, funnel, reason codes), **test unitari estesi** (Vitest su decine di moduli), **backtest/replay** su CSV. Non risulta integrato un **client di trading live** che invii ordini firmati; l’esecuzione è **simulata** (`SimulationEngine`).

**Punti di forza:** separazione netta signal vs execution feed in modalità binary; moduli dedicati per edge semantico (`binaryEdgeSemantics.ts`, `edgeEntryDecision.ts`); paper execution con fee/slippage e diagnostica; script di analisi post-sessione (`analyzeRun`, `analyzeSessions`, `analyzeProbabilityCalibration`).

**Lacune principali:** la “probabilità” BTC è **euristica** (`binaryProbabilityEngine.ts`), non un modello di mercato calibrato; **non c’è scelta del lato migliore** tra YES e NO per massimo edge — il lato deriva solo dalla direzione contrarian allo spike; **nessun database** e **nessun frontend** nel repo; strategia “alpha” fuori dal micro-loop spike+gate non è modellata.

---

# 2. Repository Overview

### Struttura ad alto livello

| Percorso | Ruolo | Importanza |
|----------|--------|------------|
| `src/` | Tutta la logica applicativa TypeScript | **Critica** |
| `src/binary/` | Signal BTC, venue (synthetic/Gamma), entry/exit paper, monitor | **Critica** |
| `src/adapters/` | Feed Binance spot (`binanceSpotFeed.ts`) | Alta |
| `src/monitor/` | Orchestrazione tick live (`runLiveMonitorTick.ts`), debug | Alta |
| `src/strategy/` | Pipeline decisionale (`strategyDecisionPipeline.ts`) | **Critica** |
| `src/analyze/` | Analytics run/session (`binaryRunAnalytics.ts`, `binaryMultiSessionAggregate.ts`) | Media |
| `src/legacy/spot/` | Modalità deprecata `MARKET_MODE=spot` (un solo feed Binance) | Bassa / legacy |
| `dist/` | Output `tsc` (non versionare per audit logico; è build) | Derivato |
| `output/monitor/` | Artefatti runtime default (`MONITOR_OUTPUT_DIR`) | Runtime |
| `.env` / `.env.example` | Configurazione | **Critica** |
| `package.json` | Script npm, dipendenze | **Critica** |
| `AGENTS.md` | Obiettivo prodotto in 15 righe | Contesto |

**Monorepo / packages:** no — progetto **singolo package** npm (`spike-bot`).

**Root rilevanti:** `package.json`, `tsconfig` (presenza standard), `.env.example`, `PROJECT_AUDIT_REPORT.md`, `AGENTS.md`, `vitest.config.ts`.

### Script npm (`package.json`)

| Script | Comando effettivo | Ruolo |
|--------|-------------------|--------|
| `build` | `tsc` | Compila `src/` → `dist/` |
| `dev` | `tsc --watch` | Watch build |
| `monitor` | `npm run build && node dist/liveMonitor.js` | **Monitor live** (default produzione osservativa) |
| `backtest` | `npm run build && node dist/backtestRunner.js` | Replay CSV + summary JSON |
| `replay-opportunities` | `npm run build && node dist/replayOpportunities.js` | Riesame opportunità JSONL |
| `validate-binary-market` | build + `validateBinaryMarket.js` | Validazione mercato binario |
| `analyze-run` / `analyze-sessions` / `analyze-probability-calibration` | build + rispettivo `dist/*.js` | Analytics offline |
| `test` | `vitest run` | Test automatici |

**Entrypoint runtime principali:** `src/liveMonitor.ts` (monitor), `src/index.ts` (loop paper con `paper: true` sui feed), `src/backtestRunner.ts`, `src/replayOpportunities.ts`.

---

# 3. Stack tecnico reale

| Area | Cosa si usa | Dove si vede |
|------|-------------|----------------|
| **Runtime** | Node.js (ESM `"type": "module"`) | `package.json` |
| **Linguaggio** | TypeScript → JS compilato | `package.json`, `src/*.ts`, `dist/*.js` |
| **HTTP client** | `axios` | `binary/venue/binaryMarketFeed.ts`, discovery Gamma |
| **WebSocket** | `ws` | `adapters/binanceSpotFeed.ts` |
| **Config env** | `dotenv` | `config.ts` (`dotenv.config()`) |
| **Logging** | `console` (+ helper dedicati in `monitorConsole.ts`, `monitorDebugLog.ts`) | Tutto il progetto; nessun Winston/pino |
| **Database** | *Assente* nel codice analizzato | — |
| **Frontend / dashboard** | *Assente* | `package.json` non ha React/Vite/etc. |
| **Test** | Vitest | `package.json`, `vitest.config.ts`, `src/**/*.test.ts` |
| **Build** | TypeScript compiler | `typescript`, script `build` |

---

# 4. Come gira il sistema end-to-end

### 4.1 Bootstrap

1. **`liveMonitor.ts`** (script `npm run monitor`): importa `config` (che esegue `dotenv.config()`), `logConfig()`, assert su modalità (`assertLegacySpotMarketModeAcknowledged`, `assertBinaryOnlyRuntime` opzionale), eventuale auto-discovery mercato (`ensureAutoDiscoveredBinaryMarketSlug`).
2. **`createSignalAndExecutionFeeds(config.marketMode, …)`** (`market/marketFeedFactory.ts`): in `binary` crea **due feed** — segnale BTC (`createBinarySignalDataFeed`) e venue (`createBinaryExecutionFeed`: sintetico o Gamma).
3. Avvio WebSocket/REST: `bootstrapRest()` poi `start()` sui feed (logica in `liveMonitor.ts` con gestione same-instance vs dual feed).

### 4.2 Config

- **`loadConfig()`** in `config.ts` → oggetto **`AppConfig`** + **`configMeta`** per provenienza env. Chiavi canoniche in `ENV_KEYS`; alias deprecati in `DEPRECATED_CONFIG_ENV_ALIASES`.

### 4.3 Tick operativo (monitor)

1. **`runLiveMonitorTick`** (`monitor/runLiveMonitorTick.ts`) chiama **`runStrategyTick`** (`botLoop.ts`).
2. **`runStrategyTick`**: aggiorna **`RollingPriceBuffer`** con mid dal **signal feed**; se `marketMode === "binary"` calcola **`estimateProbabilityUpFromPriceBuffer`** (`binary/signal/binaryProbabilityEngine.ts`); se execution è **`BinarySyntheticFeed`**, applica probabilità al venue sintetico (`applySignalProbability`).
3. Legge **top of book** dal **execution feed**; costruisce **`evaluateEntryConditions`** (`entryConditions.ts`) — spike/window, range, spread execution.

### 4.4 Spike / movement

- Implementazione detection in **`strategy.ts`** (nome file **fuorviante**: contiene `detectWindowSpike`, `detectStableRange`, `isMoveDominantVsChop`, non un layer “strategy” alto livello).
- **`evaluateEntryConditions`**: classificazione `strong_spike` / `borderline` / `no_signal`; gate range; direzione **contrarian** (spike UP → `direction: "DOWN"`, ecc.).

### 4.5 Validation / gating (pipeline)

- **`runStrategyDecisionPipeline`** (`strategy/strategyDecisionPipeline.ts`): qualità pre-entry, hard reject, borderline / strong-spike watch, cooldown, override eccezionali, integrazione filtri quote binari (`binaryQuoteEntryFilter.ts`). Allinea paper a decisioni con **`entryEvaluationForPipelinePaperExecution`**.

### 4.6 Execution (solo paper)

- **`SimulationEngine.onTick` / binary branch** (`simulationEngine.ts`): richiede **`entryModelEdge > 0`** da **`computeBinaryEntryEdge`** (mapping contrarian `binaryEdgeSemantics.ts`); opzionale **`MIN_EDGE_THRESHOLD`** via **`shouldEnterTrade`**; fill **`binaryOutcomeBuyFillPrice`**; posizione **`binaryPaperPosition.ts`**.

### 4.7 Exit

- Binary: **`evaluateBinaryExitConditions`** (`binary/exit/binaryExitConditions.ts`) — Δ assoluto su prezzo outcome, timeout.

### 4.8 Reporting

- **`MonitorFilePersistence`** (`monitorPersistence.ts`): JSONL opportunità/trades, summary sessione, calibration events, diagnostica sintetica, ecc. sotto **`MONITOR_OUTPUT_DIR`** (default `output/monitor`).
- Shutdown: report console, **`buildMonitorSessionSummary`**, analytics **`computeBinaryRunAnalytics`**, interpretazione sessione.

### Passaggi **non** presenti come codice dedicato

- Invio ordini firmati a Polymarket/CLOB (**non trovato**): solo REST pubblico Gamma + paper.
- Motore ML esterno / feature store / DB storico (**non presenti**).

---

# 5. Configurazione ed environment variables

### 5.1 Chiavi centrali in `AppConfig` (`config.ts` + `ENV_KEYS`)

Lette tramite **`loadConfig()`** / **`canonicalEnvKeyFor`**. Esempi (non esaustivo ma copre il grosso):

- **Shared / signal:** `SPIKE_THRESHOLD`, `TRADABLE_SPIKE_MIN_PERCENT`, `RANGE_THRESHOLD`, `SPIKE_MIN_RANGE_MULT`, `EXCEPTIONAL_SPIKE_PERCENT`, `ENABLE_BORDERLINE_MODE`, `BORDERLINE_*`, `FEED_STALE_MAX_AGE_MS`, `BLOCK_ENTRIES_ON_STALE_FEED`, `PRICE_BUFFER_SIZE`, `ENTRY_COOLDOWN_MS`, `MAX_ENTRY_SPREAD_BPS`, …
- **Binary signal:** `BINARY_SIGNAL_SOURCE` (solo `binance_spot` supportato nel parser), `BINARY_SIGNAL_SYMBOL`; alias deprecato **`SIGNAL_MODE`**.
- **Binary paper / risk sizing:** `MIN_EDGE_THRESHOLD`, `INITIAL_CAPITAL`, `RISK_PERCENT_PER_TRADE`, `STAKE_PER_TRADE`, `MAX_TRADE_SIZE`, `MIN_TRADE_SIZE`, `BINARY_PAPER_SLIPPAGE_BPS`, `PAPER_FEE_ROUND_TRIP_BPS`, alias `PAPER_SLIPPAGE_BPS` deprecato verso `BINARY_PAPER_SLIPPAGE_BPS`.
- **Binary exits:** `BINARY_TAKE_PROFIT_PRICE_DELTA`, `BINARY_STOP_LOSS_PRICE_DELTA`, `BINARY_EXIT_TIMEOUT_MS`.
- **Binary quote gates:** `BINARY_MAX_ENTRY_PRICE`, `BINARY_MAX_OPPOSITE_SIDE_ENTRY_PRICE`, banda neutra, **`BINARY_HARD_MAX_SPREAD_BPS`**, YES mid extreme filter, side-specific gating (`BINARY_ENABLE_SIDE_SPECIFIC_GATING`, soglie YES/NO).
- **Probability heuristic:** `PROBABILITY_WINDOW_SIZE`, `PROBABILITY_TIME_HORIZON_MS`, `PROBABILITY_SIGMOID_K`.
- **Spot-only (legacy):** `TAKE_PROFIT_BPS`, `STOP_LOSS_BPS`, `EXIT_TIMEOUT_MS` — in binary sono solo per confronto/warning (`warnCrossModeEnvAmbiguities`).

### 5.2 Chiavi lette fuori da `AppConfig` (file dedicati)

| Chiave | Significato | Dove |
|--------|-------------|------|
| `DEBUG_MONITOR` | Verbosità debug monitor | `config.ts` → `debugMonitor` |
| `MONITOR_OUTPUT_DIR` | Directory output artifact | `monitorPersistence.ts` |
| `SYNTHETIC_*`, `SYNTHETIC_MARKET_*`, `MAX_LIQUIDITY_PER_TRADE`, `SYNTHETIC_MARKET_PROFILE` | Venue sintetico | `syntheticBinaryMarket.ts`, `syntheticVenuePricing.ts`, `syntheticMarketProfile.ts`, `binarySyntheticFeed.ts` |
| `BINARY_UP_PRICE`, `BINARY_DOWN_PRICE`, `UP_SIDE_PRICE`, `DOWN_SIDE_PRICE` | Seed prezzi sintetici | `binarySyntheticFeed.ts` |
| `BINARY_SYMBOL` | Simbolo sintetico | `binarySyntheticFeed.ts` |
| `BINARY_MARKET_*`, `POLYMARKET_*`, `AUTO_DISCOVER_BINARY_MARKET` | Selezione mercato Gamma | `binaryMarketSelector.ts`, `discoverBtc5mUpDownMarket.ts` |
| `BINARY_POLL_INTERVAL_MS`, `BINARY_QUOTE_STALE_MAX_MS`, … (alias POLYMARKET_) | Polling Gamma | `binaryMarketFeed.ts`, hydrate in `config.ts` |
| `BINARY_GAMMA_BOOTSTRAP_LOG` | Log bootstrap | `binaryMarketFeed.ts` |
| `SYNTHETIC_VENUE_PRICE_LOG` | Log prezzi venue | `runLiveMonitorTick.ts` |
| `BINARY_COMPARE_DIAG` | Diagnostica confronto signal×binary | `liveMonitor.ts` |
| `BINARY_ONLY_RUNTIME` | Rifiuta `MARKET_MODE=spot` | `binaryOnlyRuntime.ts` |
| `LEGACY_SPOT_MARKET_MODE` | Ack uso spot | `legacy/spot/assertLegacySpotMarketMode.ts` |
| `BINANCE_SYMBOL` | Simbolo spot legacy / fallback signal | `binanceSpotFeed.ts`, `config.ts` |
| `BINANCE_FEED_DEBUG_LOG_EVERY_N`, `BINANCE_FEED_WARN_UNCHANGED_MID_AFTER` | Debug feed | `binanceSpotFeed.ts` |
| `BTC_SYMBOL` | Alt simbolo (servizio prezzo) | `btcPriceService.ts` |

### 5.3 Osservazioni su pulizia / duplicazioni

- **`DEPRECATED_CONFIG_ENV_ALIASES`** e **`POLYMARKET_*` vs `BINARY_*`**: convivenza documentata; startup stampa warning incrociati (`warnCrossModeEnvAmbiguities`).
- **`POLYMARKET_DISCOVERY_*`**: dichiarati deprecati e ignorati (`warnDeprecatedPolymarketEnv`).
- **`strategy.ts`** come nome file per la detection: **confuso** rispetto a `strategy/strategyDecisionPipeline.ts`.

### 5.4 Env dichiarate ma non wired (esplicito nel codice)

- Chiavi discovery Polymarket deprecate → **ignorate**.

---

# 6. Architettura logica del bot

| Modulo | Scopo | File principali | Input → output | Completezza |
|--------|-------|-----------------|----------------|-------------|
| **Feed signal** | Mid BTC per buffer e spike | `binary/signal/createBinarySignalFeed.ts`, `binaryBtcSpotSignalFeed.ts`, `adapters/binanceSpotFeed.ts` | WS/REST → `NormalizedSpotBook` | **Buona** (solo Binance per signal) |
| **Feed execution** | Quote YES/NO per paper | `createBinaryExecutionFeed.ts`, `binarySyntheticFeed.ts`, `binaryMarketFeed.ts` | env → feed | **Buona** (synthetic default; Gamma opzionale) |
| **Movement / spike** | Range + window spike | `strategy.ts`, `movementClassifier.ts`, `entryConditions.ts` | prezzi → `EntryEvaluation` | **Buona** |
| **Probability (euristica)** | Score P(up) da buffer | `binaryProbabilityEngine.ts` | buffer → [0,1] | **Embrionale** (non mercato reale) |
| **Pipeline strategica** | Gate e azioni | `strategy/strategyDecisionPipeline.ts` | tick + stores → `StrategyDecision` | **Buona** (complessa, testata) |
| **Edge / fair mapping** | Contrarian vs momentum per edge | `binary/entry/binaryEdgeSemantics.ts`, `edgeEntryDecision.ts` | p_up, asks, side → edge | **Parziale** (euristica + mapping) |
| **Execution paper** | Fill, PnL, fee | `simulationEngine.ts`, `binary/paper/*` | tick → trade | **Buona** |
| **Exit** | TP/SL/timeout | `binary/exit/binaryExitConditions.ts`, spot legacy separato | mark → exit | **Buona** (binary); spot separato |
| **Opportunità / tracking** | Registro candidati | `opportunityTracker.ts` | decisioni → opportunity | **Buona** |
| **Persistenza artifact** | JSONL / JSON | `monitorPersistence.ts` | eventi → file | **Buona** |
| **Analytics** | Metriche run/session | `analyze/binaryRunAnalytics.ts`, `analyzeSessions.ts`, ecc. | file → report | **Parziale** (dipende da dati salvati) |

---

# 7. Stato reale della strategia

### Cosa decide l’ingresso

1. **Segnale primario:** spike/dettaglio movimento su **serie BTC spot** (non sul prezzo YES Polymarket per la detection).
2. **Direzione trade:** **mean-reversion** — movimento forte UP → direzione ingresso **DOWN** (e viceversa), codificato in **`evaluateEntryConditions`** (`entryConditions.ts`).
3. **Mapping outcome:** `binaryLegFromDirection` (`edgeEntryDecision.ts`) — `UP → YES`, `DOWN → NO` **per convenzione tipo “side bought”**: con spike UP si entra `direction DOWN` → lato **NO** (fade del rally).

### Mispricing / fair value

- **`estimateProbabilityUpFromPriceBuffer`** è esplicitamente **euristico / momentum**, non prezzo di mercato YES (`binaryProbabilityEngine.ts` commenti).
- Per l’edge paper si usa **`fairBuyLegProbabilityFromMomentumUp`** con semantica default **`contrarian_mean_reversion`** (`binaryEdgeSemantics.ts`): trasforma P(up) momentum in **P_model sul token comprato**, poi **`edge = P_model − ask`** (`edgeEntryDecision.ts`).
- **`SimulationEngine`** **rifiuta** ingressi con **`entryModelEdge <= 0`** (`negative_or_zero_model_edge`) — quindi serve edge positivo sul lato **già fissato** dalla direzione contrarian, non un confronto YES vs NO.

### Scelta YES vs NO

- **Non** esiste nel codice una funzione del tipo “scegli il lato con edge massimo”. Il lato è **implicato** dalla direzione contrarian allo spike.

### Strategia vs trigger

- Oltre ai trigger di movimento c’è una **pipeline** pesante (qualità, borderline, cooldown, quote), quindi non è “solo un if sullo spike”, ma **non** è una strategia di pricing multi-fattore sul libro reale: resta **spike mean-reversion + filtri + edge sul lato assegnato**.

**Frase secca:** *Attualmente il bot è principalmente un **motore di mean-reversion su spike BTC** con **gating multi-livello** e **controllo edge paper** sul lato outcome determinato contrarian; **non** implementa una logica di **opt-in tra YES e NO per massimo mispricing**.*

---

# 8. Stato rispetto a una roadmap di trading edge

Per ogni punto: **stato**, **motivazione**, **file**, **cosa manca**.

### 1. Pricing inefficiency exploitation
- **Stato:** **Parziale**
- **Motivazione:** Edge calcolato come model−ask su lato fisso; synthetic venue introduce lag/rumore (`syntheticVenuePricing.ts`) — utile per lab, non prova inefficienza reale.
- **File:** `edgeEntryDecision.ts`, `simulationEngine.ts`, `binarySyntheticFeed.ts`
- **Manca:** Confronto sistematico con mid/order book reale persistente e costi transazione reali.

### 2. Edge reale persistente
- **Stato:** **Assente** come validazione statistica nel repo (nessuno studio empirico versionato; solo analytics su run salvati).

### 3. Edge per lato (YES vs NO)
- **Stato:** **Assente** come ottimizzazione — side-specific gating (`config/binarySideGating.ts`) è **filtro**, non scelta dell’edge migliore.

### 4. Market microstructure understanding
- **Stato:** **Embrionale** — spread/quote stale/slippage simulati; niente depth L2, niente queue.

### 5. Execution edge
- **Stato:** **Assente** per trading reale; paper con slippage/fee configurabili.

### 6. Meta-strategy layer
- **Stato:** **Assente**

### 7. Risk & payoff optimization
- **Stato:** **Parziale** — `riskPositionSizing.ts`, moltiplicatori qualità (`stakeSizing.ts`); nessun Kelly/portfolio nel codice analizzato.

### 8. Trade outcome analysis engine
- **Stato:** **Parziale** — `analyzeRun.ts`, `binaryRunAnalytics.ts`, calibration (`probabilityCalibrationResolve.ts`); dipende da sessioni salvate.

### 9. Regime detection
- **Stato:** **Embrionale** — range quality, unstable context (`hardRejectEngine.ts`); non regime macro esplicito.

### 10. Feature engineering serio
- **Stato:** **Assente** (feature tabellari / dataset ML).

### 11. Data & backtesting serio
- **Stato:** **Parziale** — CSV replay (`backtest.ts`, `backtestRunner.ts`), confronti in test; non piattaforma dataset né walk-forward formalizzato nel codice.

### 12. Strategy evaluation framework
- **Stato:** **Parziale** — summary JSON backtest + test; non framework multi-strategy comparabile out-of-the-box.

---

# 9. Reporting, metriche e diagnostica

### Cosa produce

- **Console:** banner monitor, periodic summary, shutdown report (`monitorConsole.ts`, `liveMonitor.ts`).
- **File:** `opportunities.jsonl`, `trades.jsonl`, `session-summary.json`, `probability-calibration-events.jsonl`, diagnostica sintetica (`monitorPersistence.ts`), path sotto `MONITOR_OUTPUT_DIR`.
- **Metriche funnel:** `monitorFunnelDiagnostics.ts`, `MonitorRuntimeStats`, `StrongSpikeGateFunnel`.
- **Reason codes:** `ENTRY_REASON_CODES`, `rejectionReasons.ts`, normalizzazione `decisionReasonBuilder.ts`.

### Cosa è misurato

- Tick, spike classification, opportunità valide/rifiutate, trade paper chiusi, PnL, attributi binary (quote, stale), audit hold exit (`holdExitAudit.ts`).

### Limiti per capire “perché vinco/perdo”

- Senza mercato reale e senza storico centralizzato, il **perché** resta legato al **modello sintetico** o a sessioni Gamma puntuali.
- Distinzione per rejection reason: **sì** (campi in opportunity JSONL). Distinzione per regime macro: **limitata** ai gate interni.

---

# 10. Risk management e payoff

| Tema | Presente? | Dettaglio |
|------|-----------|-----------|
| **Sizing** | Sì | `getPositionSize`, stake da equity/risk%, limiti min/max (`riskPositionSizing.ts`) |
| **Stop loss / TP (binary)** | Sì | Δ prezzo outcome (`binaryExitConditions.ts`) |
| **Timeout** | Sì | `BINARY_EXIT_TIMEOUT_MS` |
| **Fee / spread / slippage** | Sì (paper) | `paperFeeRoundTripBps`, `BINARY_PAPER_SLIPPAGE_BPS`, spread gates |
| **Filtri rischio quote** | Sì | `binaryQuoteEntryFilter.ts`, opposite side cap, YES mid band |
| **Max concurrency** | Non esplicito come limite posizioni parallele nel codice letto | Il simulatore gestisce posizioni in modo sequenziale tipico single-position (verificare invarianti in `simulationEngine.ts` per overlap) |
| **Cooldown** | Sì | `entryCooldownMs`, override eccezionali (`overridePolicyEngine.ts`) |

Complessivamente il risk è **centricale per il paper**, non per un book di produzione.

---

# 11. Backtesting, replay e valutazione strategie

- **`backtestRunner.ts` + `backtest.ts`**: replay da file prezzi; modalità default **binary-first**; flag `--spot-legacy` per CSV legacy.
- **`replayOpportunities.ts`**: riesame opportunità JSONL con gating corrente (analisi, non trading).
- **Dataset / serializzazione tick storici:** non c’è un datastore; solo CSV/input file.
- **Benchmark:** nessun indice di riferimento esterno codificato.

---

# 12. Problemi tecnici e debiti del progetto

### Critici (per obiettivo “trading reale”)
- **Nessuna esecuzione ordini reali** nel percorso analizzato — solo paper e API pubbliche.
- **Nome `strategy.ts`** duplica concetto con `strategy/strategyDecisionPipeline.ts` → onboarding difficile.

### Medi
- **Due entrypoint** (`liveMonitor` vs `index.ts` con paper feeds) da documentare mentalmente.
- **Env surface ampia** (synthetic vs config centralizzato) → rischio chiavi morte o incoerenze cross-mode.

### Minori
- Dipendenza da `console` per tutto (nessun logging strutturato centralizzato).
- `dist/` non in `.gitignore` nello status iniziale — rumore repo.

---

# 13. Punti forti del progetto

- **Pipeline testabile:** `strategyDecisionPipeline.test.ts`, `simulationEngine.test.ts`, `entryConditions.test.ts`, ecc.
- **Separazione signal/execution** chiara in `marketFeedFactory.ts` / `botLoop.ts`.
- **Edge semantics documentate nel codice** (`binaryEdgeSemantics.ts`).
- **Osservabilità:** JSONL ricchi, summary sessione, normalized config (`monitorNormalizedConfigSummary.ts`).
- **Backtest e script di analisi** utilizzabili senza UI.

---

# 14. Priorità consigliate

## Priorità immediate
1. **Chiarire nel repo** (commento root o README minimo): `npm run monitor` vs `node dist/index.js` — *obiettivo:* evitare avvii sbagliati; *file:* `package.json`, `index.ts`, `liveMonitor.ts`.
2. **Rinominare o etichettare** `strategy.ts` → evitare collisione semantica; *dipendenze:* tutti gli import `./strategy.js`.

## Priorità a breve
3. **Feature “scegli lato migliore”** (opt) — max edge tra YES/NO soggetto a direzione/constraints; *file:* `edgeEntryDecision.ts`, `simulationEngine.ts`, test.
4. **Consolidare env** — tabella unica generata da script che elenca `process.env` letti vs `ENV_KEYS`; *area:* `config.ts` + venue.

## Priorità successive
5. **Storage run** (SQLite/Parquet) per analytics multi-sessione senza solo JSONL.
6. **Integrazione ordine reale** (fuori scope attuale) con layer separato da `SimulationEngine`.

---

# 15. Mappa dei file chiave

Ordine consigliato di lettura (dal più al meno utile per capire il sistema):

1. **`src/liveMonitor.ts`** — Bootstrap monitor, shutdown, persistence.
2. **`src/monitor/runLiveMonitorTick.ts`** — Tick live, logging, collegamento pipeline.
3. **`src/strategy/strategyDecisionPipeline.ts`** — Decisioni operative complete.
4. **`src/botLoop.ts`** — `runStrategyTick`, composizione signal/execution.
5. **`src/entryConditions.ts`** — Regole ingresso mean-reversion + spread.
6. **`src/simulationEngine.ts`** — Paper trading, edge binary, fill.
7. **`src/config.ts`** — Tutta la configurazione tipizzata.
8. **`src/binary/entry/binaryEdgeSemantics.ts`** + **`edgeEntryDecision.ts`** — Significato di edge/fair.
9. **`src/binary/venue/createBinaryExecutionFeed.ts`** — Synthetic vs Gamma.
10. **`src/monitorPersistence.ts`** — Cosa viene scritto su disco.

---

# 16. Verdict finale

**Cos’è oggi:** un **laboratorio software** per **mean-reversion su spike** con **segnale BTC spot** e **paper trading** su **mercato binario** (sintetico di default, Gamma opzionale), con **pipeline di qualità ricca** e **ottima tracciabilità** via file e test.

**Cosa NON è ancora:** un **bot di esecuzione garantita su Polymarket**, un **motore di alpha** misurato sul lungo periodo, né un sistema che **ottimizza** la scelta YES/NO per edge.

**Prossimo salto di qualità:** definire esplicitamente (e implementare) **selezione del lato** e/o **modello di probabilità** ancorato al mercato reale, oppure integrare **esecuzione** con gestione chiavi e rischio pre-ordine — a seconda dell’obiettivo prodotto.

---

# Appendix — Quick Answers

1. **Il progetto usa davvero mispricing o fair value?**  
   Usa un **edge** = probabilità di modello (euristica sui mid BTC, mappata in **fair sul lato comprato** in semantica contrarian) **meno** ask — non un fair value di mercato indipendente verificato.

2. **Il progetto sceglie davvero tra YES e NO in base all’edge?**  
   **No.** Il lato è **determinato** dalla direzione contrarian allo spike; l’edge filtra/rigetta su quel lato.

3. **Vera strategia o solo trigger + filtri + execution?**  
   **Trigger spike + filtri + pipeline + execution paper**, con layer edge **subordinato** al lato già scelto.

4. **Separazione detection / strategy / execution?**  
   **Parziale:** detection in `entryConditions.ts`/`strategy.ts`; “strategy” orchestrata in `strategyDecisionPipeline.ts`; execution in `simulationEngine.ts`. I confini sono chiari ma il naming `strategy.ts` confonde.

5. **Env pulite o confusione?**  
   **Alias e sezioni** (binary vs spot vs synthetic) — funziona ma richiede attenzione; chiavi deprecate avvisate a startup.

6. **Il reporting basta per il perché dei trade?**  
   **Parzialmente** — buono per funnel e reason codes; **non** spiega da solo l’alpha su mercato reale senza dati esterni.

7. **Base seria per backtest / replay?**  
   **Sì per replay CSV e coerenza pipeline** (`backtest.ts`); **non** come piattaforma istituzionale.

8. **Priorità: ricerca edge o engineering?**  
   Il codice è **molto orientato all’engineering** (pipeline, test, osservabilità); la **ricerca edge** è lasciata al contenuto dei parametri e del venue.

9. **Una frase tecnica sul progetto?**  
   *Pipeline TypeScript di paper trading che combina spike mean-reversion su BTC spot, gating multi-livello e simulazione di mercato binario sintetico o Gamma-only.*

10. **Primi 5 file da leggere?**  
   `liveMonitor.ts`, `runLiveMonitorTick.ts`, `strategyDecisionPipeline.ts`, `botLoop.ts`, `simulationEngine.ts`.
