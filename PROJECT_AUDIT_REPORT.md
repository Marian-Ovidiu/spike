# Ricognizione tecnica del repository (spike-bot)

Documento di audit per un possibile **pivot verso un engine futures/microstructure**: analisi basata sul **codice reale** in `src/`, `package.json`, `.env.example`, `AGENTS.md` e script npm. **Nessuna modifica al codice** è stata effettuata in fase di ricognizione. Dove qualcosa non è deducibile dal repository, è indicato esplicitamente.

**Aggiornamento post-pivot:** lo stato operativo del nuovo stack futures e la mappa legacy sono descritti in **`docs/FUTURES_MIGRATION.md`** (entry point `monitor:futures`, `replay:futures`, isolamento `src/binary/*`).

---

## 1. Executive summary

- **Scopo attuale (dal codice e da `AGENTS.md`)**  
  Bot di **mean-reversion su “spike”** con segnale su **finestra di prezzi** (default: **Binance spot** per `MARKET_MODE=binary`) e **esecuzione paper** su **mercato binario**: per default **sintetico YES/NO** (`BinarySyntheticFeed`), opzionale **Polymarket Gamma** (`BinaryMarketFeed`). Flusso operativo principale: `npm run monitor` → `dist/liveMonitor.js`.

- **Stato architetturale**  
  C’è **separazione parziale** (interfaccia `MarketDataFeed`, doppio feed signal/execution in binary, `config` con gruppi `shared` / `binary` / `spot`), ma la **strategia “reale”** vive in un **unico pipeline** (`strategyDecisionPipeline`) e in `SimulationEngine` con **rami espliciti** spot vs binary. **Modularità “a strategie pluggabili” non c’è**: c’è un percorso unico con molte feature flag e rami `marketMode === "binary"`.

- **Accoppiamento al binary**  
  **Alto** su esecuzione, P/L, filtri quote, calibrazione probabilità, report e analisi. **Medio** sul moto spike (logica su serie di prezzi astratta ma nominata e cablata “BTC” ovunque). **`binaryOnlyRuntime`** può **vietare** proprio il ramo `spot`.

- **Fattibilità pivot futures**  
  **Media.**  
  **Riutilizzabile senza strappi**: matematica spike/range su buffer (`strategy.ts`, `entryConditions.ts`, parti di `botLoop`), adattatore WebSocket Binance (`adapters/binanceSpotFeed.ts`), schema “tick periodico”, persistenza JSONL (`monitorPersistence.ts`).  
  **Da rifare o sostituire**: modello di **book eseguibile**, **position sizing**, **exit**, **risk**, **instrument/symbol**, e tutto ciò che assume **prezzi in [0,1]**, **YES/NO**, fee paper binario. Il progetto **non** contiene futures, order flow L2/L3 serio o microstructure exchange-specific oltre spread L1 sintetizzato.

---

## 2. Mappa del repository

| Percorso | Ruolo | Dipendenze principali | Classificazione |
|---------|--------|-------------------------|-----------------|
| `src/liveMonitor.ts` | Entry **monitor** prod/research: bootstrap feed, tick, shutdown, JSONL | `botLoop`, `monitor/runLiveMonitorTick`, `config`, `binary/*`, `monitorPersistence` | **Entry / runtime core** |
| `src/index.ts` | Entry alternativo: loop semplificato senza persistence monitor | `startBotLoop`, stessi feed factory | **Entry spot/binary paper** |
| `src/backtestRunner.ts`, `src/backtest.ts` | Replay CSV / summary JSON | `strategyDecisionPipeline`, `SimulationEngine`, synthetic binary | **Simulation / backtest** |
| `src/config.ts` | Caricamento env, defaults, grouping, alias Gamma, `DEBUG_MONITOR` | dotenv | **Config core** |
| `src/config/monitorNormalizedConfigSummary.ts`, `binarySideGating.ts` | Snapshot JSON per sessione + gating YES/NO | `config`, `binaryMarketSelector` | **Config / reporting** |
| `src/botLoop.ts` | Tick strategia: buffer, probabilità binary, book execution, `runStrategyTick` | `entryConditions`, `binaryProbabilityEngine`, feed | **Strategy + orchestration** |
| `src/strategy/strategyDecisionPipeline.ts` | Gate borderline/strong spike, quote binary, spread, qualità | molti moduli root + `binary/entry/*` | **Strategy (fortemente binary-aware)** |
| `src/simulationEngine.ts` | Apertura/chiusura paper, spot vs binary, audit exit | `binary/paper/*`, `legacy/spot/*` | **Execution paper (core accoppiato)** |
| `src/market/types.ts`, `marketFeedFactory.ts` | Contratto feed, factory signal/execution | `adapters`, `binary/venue`, `binary/signal` | **Adapter boundary** |
| `src/adapters/binanceSpotFeed.ts` | WS + REST Binance spot, book normalizzato | `ws` | **Adapter exchange (spot)** |
| `src/binary/venue/*` | Synthetic feed, Gamma, discovery, pricing sintetico | axios, env massiccio | **Adapter + lab binary** |
| `src/binary/signal/*` | Probabilità da buffer, calibration, ring buffer mids | — | **Signal binary-specific** |
| `src/binary/paper/*`, `binary/exit/*`, `binary/monitor/*`, `binary/entry/*` | Paper YES/NO, exit Δ prezzo, log, audit | — | **Binary domain** |
| `src/legacy/spot/*` | Exit bps, book quote spot per paper legacy | — | **Legacy spot execution** |
| `src/monitorPersistence.ts`, `monitorConsole.ts`, `monitorRuntimeStats.ts` | JSONL, banner, statistiche | — | **Reporting / observability** |
| `src/analyze/*.ts`, `analyzeRun.ts`, `analyzeSessions.ts`, `analyzeProbabilityCalibration.ts` | Analytics post-run su sessioni/trades | output JSON | **Reporting / offline** |
| `src/validateBinaryMarket.ts` | CLI diagnostica Gamma | — | **Script / integration** |
| `src/replayOpportunities.ts` | Re-analisi JSONL opportunità | — | **Script analisi** |
| `src/legacy/btcPriceService.ts` | REST ticker Binance | axios | **Archiviata** — nessun import in `src/`; spostata da `src/btcPriceService.ts` |
| `src/binaryOnlyRuntime.ts` | Guard `BINARY_ONLY_RUNTIME` | — | **Config guard** |
| `AGENTS.md` | Intent document | — | **Doc** |
| `package.json` | Scripts: `monitor`, `backtest`, analyze, `validate-binary-market`, `test` | — | **Build entry** |
| `dist/` | Output `tsc` | — | **Build artifact** |

**Nota:** `package.json` ha `"main": "index.js"` mentre TypeScript emette in `dist/` — il punto di ingresso reale degli script è `node dist/...`, non necessariamente `main`.

---

## 3. Entry points e runtime flow

### Entry points reali

- **`npm run monitor`** → `tsc` → `node dist/liveMonitor.js` — **percorso principale**.
- **`node dist/index.js`** (dopo build) — `src/index.ts`: avvio `startBotLoop` con paper flag.
- **`npm run backtest`** → `dist/backtestRunner.js`.
- **`npm run replay-opportunities`**, **`validate-binary-market`**, **`analyze-run`**, **`analyze-sessions`**, **`analyze-probability-calibration`** — tool offline.
- **`npm test`** → `vitest run` (`tsconfig` **esclude** `*.test.ts` dalla compilazione ma vitest usa i sorgenti).

### Flusso principale monitor (file/funzioni)

1. **Config** — `config.ts`: `dotenv.config()`, `loadConfig()`, export `config` / `configMeta`; `liveMonitor.ts` chiama `logConfig()`.
2. **Guard / discovery** — `assertLegacySpotMarketModeAcknowledged`, `assertBinaryOnlyRuntime`, `ensureAutoDiscoveredBinaryMarketSlug`.
3. **Market data** — `createSignalAndExecutionFeeds` (`marketFeedFactory.ts`): in binary, **signal** = `createBinarySignalDataFeed` → `BinaryBtcSpotSignalFeed` + `BinanceSpotFeed`; **execution** = `createBinaryExecutionFeed` → `BinarySyntheticFeed` **o** `BinaryMarketFeed` (Gamma).
4. **Context** — `RollingPriceBuffer`, `SimulationEngine`, `OpportunityTracker`, `BotContext` in `liveMonitor.ts`.
5. **Tick** — `setInterval` → `runLiveMonitorTick` (`monitor/runLiveMonitorTick.ts`) → `runStrategyTick` (`botLoop.ts`) → `evaluateEntryConditions` → pipeline `runStrategyDecisionPipeline` → aggiornamento `SimulationEngine` / opportunità.
6. **Execution paper** — `SimulationEngine`: entrate/uscite binary (`binary/paper`, `binary/exit`) o spot legacy.
7. **Reporting** — append JSONL (`monitorPersistence`), shutdown: `printShutdownReport`, `buildMonitorSessionSummary`, analytics/calibration.

**Divergenza importante:** `startBotLoop` (`botLoop.ts`) usa `runBotTick` che chiama `simulation.onTick` **senza** il pipeline monitor completo — **due runtime** (monitor vs `index`) **non equivalenti**.

---

## 4. Analisi config/env

### Lette da `src/config.ts` (`loadConfig` + meta)

Tutte le chiavi in `ENV_KEYS` / `AppConfig` (es. `SPIKE_THRESHOLD`, `MARKET_MODE`, `BINARY_*`, `TAKE_PROFIT_BPS`, …). Extra nello stesso modulo:

- **`DEBUG_MONITOR`** → `debugMonitor` (non è campo di `AppConfig`).
- **`TEST_MODE_SOFT_UNSTABLE`** (solo con `TEST_MODE=true`).
- Alias **`SIGNAL_MODE`** → `BINARY_SIGNAL_SOURCE`.
- Alias legacy (`PAPER_SLIPPAGE_BPS`, `MAX_OPPOSITE_SIDE_ENTRY_PRICE`, ecc. — vedere `DEPRECATED_CONFIG_ENV_ALIASES`).
- **`hydrateBinaryGammaEnvAliases`**: copia `BINARY_*` → `POLYMARKET_*` quando il target è vuoto.

### Lette altrove (non tutte in `AppConfig`)

| Variabile | Dove | Uso |
|-----------|------|-----|
| `MONITOR_OUTPUT_DIR` | `monitorPersistence.ts` | Directory output JSONL |
| `BINARY_COMPARE_DIAG` | `liveMonitor.ts` | Diagnostica |
| `SYNTHETIC_VENUE_PRICE_LOG` | `runLiveMonitorTick.ts` | Log pricing sintetico |
| `BINARY_ONLY_RUNTIME` | `binaryOnlyRuntime.ts` | Blocco `MARKET_MODE=spot` |
| `LEGACY_SPOT_MARKET_MODE` | `legacy/spot/assertLegacySpotMarketMode.ts`, `backtestRunner.ts` | Acknowledgment spot / backtest legacy |
| `AUTO_DISCOVER_BINARY_MARKET`, `BINARY_MARKET_*`, `POLYMARKET_*`, `POLYMARKET_GAMMA_API_BASE`, `POLYMARKET_CLOB_API_BASE`, `BINARY_GAMMA_BOOTSTRAP_LOG`, `VITEST` | `discoverBtc5mUpDownMarket.ts`, `binaryMarketFeed.ts`, `binaryMarketSelector.ts` | Discovery / Gamma |
| `POLYMARKET_POLL_INTERVAL_MS`, `POLYMARKET_QUOTE_STALE_MAX_MS`, `POLYMARKET_POLL_SILENCE_MAX_MS`, `POLYMARKET_SYNTHETIC_SPREAD_BPS` | `binaryMarketFeed.ts` | Polling Gamma (nomi POLYMARKET_* anche se `config` idrata da `BINARY_*`) |
| `BINANCE_SYMBOL`, `BINANCE_FEED_DEBUG_LOG_EVERY_N`, `BINANCE_FEED_WARN_UNCHANGED_MID_AFTER` | `binanceSpotFeed.ts` | Spot feed |
| `BINARY_SYMBOL`, `BINARY_UP_PRICE`, `UP_SIDE_PRICE`, `BINARY_DOWN_PRICE`, `DOWN_SIDE_PRICE` | `binarySyntheticFeed.ts` | Synthetic venue |
| `SYNTHETIC_SPREAD_BPS`, `BINARY_SYNTHETIC_SPREAD_BPS`, `SYNTHETIC_MARKET_MAX_SPREAD_BPS`, `SYNTHETIC_SLIPPAGE_BPS`, `MAX_LIQUIDITY_PER_TRADE`, `SYNTHETIC_MID_SMOOTH_NEW_WEIGHT`, `SYNTHETIC_QUOTE_LOG` | `syntheticBinaryMarket.ts` | Book sintetico |
| `SYNTHETIC_MARKET_PROFILE`, `SYNTHETIC_MARKET_LAG_TICKS`, `SYNTHETIC_MARKET_REACTION_ALPHA`, `SYNTHETIC_MARKET_NOISE_BPS`, `SYNTHETIC_MARKET_BIAS_BPS`, `SYNTHETIC_MARKET_NOISE_SEED`, `SYNTHETIC_MARKET_WIDEN_ON_VOLATILITY` | `syntheticMarketProfile.ts`, `syntheticVenuePricing.ts`, `binarySyntheticFeed.ts` | Venue model |
| `BTC_SYMBOL` | `legacy/btcPriceService.ts` | REST (**nessun import riscontrato altrove in `src/`** → effetto morto per il resto dell’app) |
| `POLYMARKET_DISCOVERY_QUERY`, `POLYMARKET_DISCOVERY_MIN_CONFIDENCE` | `config.ts` | Solo **warning**, valori ignorati |

### Classificazione

- **Solo binary / synthetic lab:** quasi tutto `BINARY_*`, `SYNTHETIC_*`, quote YES/NO, calibration, analytics in `analyze/binary*`, env Gamma/Polymarket.
- **Solo spike / shared (serie prezzi + soglie):** `SPIKE_*`, `RANGE_*`, `BORDERLINE_*`, `EXCEPTIONAL_*`, `STRONG_SPIKE_*`, `PRICE_BUFFER_SIZE`, `MAX_ENTRY_SPREAD_BPS`, `ENTRY_COOLDOWN_MS`, risk sizing generico, `FEED_STALE_*`, `BLOCK_ENTRIES_ON_STALE_FEED`.
- **Solo legacy spot:** `TAKE_PROFIT_BPS`, `STOP_LOSS_BPS`, `EXIT_TIMEOUT_MS` come exit spot quando `MARKET_MODE=spot`; in binary sono “reference” nel print.
- **Condivise ma naming BTC-centric:** `PROBABILITY_*` usata **solo** con `marketMode === "binary"` nel tick (`botLoop.ts`).
- **Morta / fuorviante:** `legacy/btcPriceService.ts` + `BTC_SYMBOL` se il modulo resta senza import; `POLYMARKET_DISCOVERY_*` deprecate ignorate.
- **Mismatch:** **`BINARY_POLL_INTERVAL_MS`** documentato in `config` vs **`POLYMARKET_POLL_INTERVAL_MS`** letto in `BinaryMarketFeed` — coerenza tramite idratazione env quando `config.ts` è caricato per primo.

---

## 5. Accoppiamento a binary/spike

| Area | Moduli | Livello | Perché | Difficoltà estrazione |
|------|--------|---------|--------|------------------------|
| Quote 0–1, YES/NO | `binary/*`, `market/types.ts` (`BinaryOutcomePrices`), `simulationEngine`, `executionSpreadFilter` | **Alto** | Semantica contratto e P/L | Nuovo modello prezzo/position |
| Fair / mispricing / edge | `binary/entry/edgeEntryDecision.ts`, `binaryProbabilityEngine.ts` | **Alto** | Edge vs ask YES/NO e momentum P(up) | Riscrittura verso fair futures |
| Side UP/DOWN vs futures | `entryConditions`, pipeline | **Medio-alto** | Spike → outcome, non contratto | Mapping diverso |
| Spike stabile / borderline / strong | `strategy.ts`, `entryConditions.ts`, `strategyDecisionPipeline`, stores | **Medio** | Numerica generica ma integrata con gate binary | Spezzare pipeline |
| Calibration probabilità | `probabilityCalibration*`, `SignalMidRingBuffer`, JSONL | **Alto** | Label binary vs BTC horizon | Non trasferibile così |
| Synthetic venue / Polymarket | `binary/venue/*` | **Alto** | Lab prediction market | Isolare/eliminare |
| Legacy spot paper | `legacy/spot/*` | **Medio** | Bps su Binance spot | Parziale concettuale vs futures |

---

## 6. Moduli riutilizzabili (pivot futures)

| Modulo | Verdetto | Note |
|--------|-----------|------|
| `rollingPriceBuffer.ts`, `strategy.ts`, `movementClassifier.ts`, `movementAnalysis.ts`, `rangeQualityEvaluator.ts`, `entryConditions.ts` (nucleo spike) | **KEEP** | Serie temporale + soglie; naming “BTC” da generalizzare |
| `adapters/binanceSpotFeed.ts` | **KEEP WITH SMALL REFACTOR** | Pattern WS utile; futures richiede altro contratto/simbolo |
| `config.ts` | **KEEP WITH SMALL REFACTOR** | Grouping/provenance utili; snellire chiavi binary |
| `monitorPersistence.ts` | **KEEP WITH SMALL REFACTOR** | Pattern JSONL ok; schema oggi binary-denso |
| `botLoop.ts` | **KEEP BUT WRAP/ISOLATE** | Signal/execution separati; estrarre ramo binary |
| `simulationEngine.ts` | **ISOLATE / REWRITE** per futures | Troppo accoppiato binary+spot |
| `strategyDecisionPipeline.ts` | **ISOLATE / REWRITE** | Cuore ma non trasportabile come blocco unico |
| `market/types.ts` | **KEEP WITH SMALL REFACTOR** | Estendere con tipi Instrument / order book futures |

---

## 7. Moduli da eliminare o isolare

- **DELETE o ARCHIVE (se si abbandonano i prediction market):** `src/binary/**`, `validateBinaryMarket.ts`, `analyze/binary*.ts`, `replayOpportunities` (se non si usano JSONL binary).
- **DELETE (candidate):** `src/legacy/btcPriceService.ts` se confermato inutilizzato anche fuori repo.
- **ISOLATE:** `legacy/spot` — tenere solo per confronto storico.
- **REWRITE:** `simulationEngine.ts`, `strategyDecisionPipeline.ts`, schema `monitorPersistence`, report/shutdown fortemente binary-centrici.

---

## 8. Debito tecnico e problemi architetturali

- **Due runtime diversi:** `liveMonitor` + pipeline completa vs `index.ts` + `runBotTick` senza stesso pipeline — comportamenti divergenti possibili.
- **`strategyDecisionPipeline.ts` molto grande:** responsabilità miste (gate, quote binary, borderline, diagnostica).
- **`SimulationEngine`:** spot + binary intrecciati — difficile test/sostituzione.
- **Naming:** “BTC”, “binary”, “spot”, “signal” incrociati; `MARKET_MODE=binary` = prediction market, non opzione digitale su futures.
- **`BinarySignalSource`:** un solo valore valido `binance_spot` — estensibilità apparente, realtà monolitica.
- **`package.json` `main`:** probabilmente non allineato agli entry reali in `dist/`.
- **Test:** Vitest su molti moduli; copertura futures assente per definizione.

---

## 9. Stima refactor vs rewrite

**Raccomandazione: B — Nuovo core + migrazione pezzi sani.**

Motivo: il cuore runtime (`SimulationEngine` + pipeline + persistence + report) è **così permeato da semantica binary** che un refactor “incrementale” verso futures equivale a **reimplementare motore di esecuzione e datastore**. Conviene un **nuovo nucleo** (instrument, feed, position, execution sim, strategy interface) e importare buffer spike, helper numerici, pattern adapter dopo riduzione delle superfici.

---

## 10. Piano chirurgico preliminare

- **Fase 1 — Inventario e confini**  
  Obiettivo: tracciare dipendenze binary vs shared. Moduli: documentazione implicita, script npm. Rischio: basso.

- **Fase 2 — Estrazione “signal domain”**  
  Obiettivo: buffer + spike + entry evaluation **senza** YES/NO. Moduli: `strategy.ts`, `entryConditions.ts`, parti di `botLoop`. Rischio: medio (regressione backtest).

- **Fase 3 — Adapter isolation**  
  Obiettivo: interfaccia chiara price feed vs tradable book per futures vs legacy binary. Moduli: `market/types.ts`, `marketFeedFactory.ts`. Rischio: medio-alto.

- **Fase 4 — Nuovo execution sim futures**  
  Obiettivo: posizioni, fee, SL/TP — **parallelo** a `SimulationEngine` legacy. Rischio: alto. Dipende da Fase 3.

- **Fase 5 — Migrazione reporting**  
  Obiettivo: JSONL/schema neutri o ramificati. Moduli: `monitorPersistence`, analyze scripts. Rischio: medio.

- **Fase 6 — Rimozione binary**  
  Obiettivo: archive / pacchetto separato per `src/binary`. Rischio: basso se il nuovo core è validato.

---

## 11. Allegato — classificazione file/moduli

**KEEP**

- `src/strategy.ts`, `src/rollingPriceBuffer.ts`, `src/movementClassifier.ts`, `src/movementAnalysis.ts`, `src/rangeQualityEvaluator.ts`, `src/entryConditions.ts` (nucleo matematico)
- `src/adapters/binanceSpotFeed.ts`
- Idea struttura `src/config.ts` (non l’intera lista chiavi così com’è)

**KEEP WITH SMALL REFACTOR**

- `src/botLoop.ts`
- `src/market/types.ts`, `src/market/marketFeedFactory.ts`
- `src/monitorPersistence.ts`
- `src/config/monitorNormalizedConfigSummary.ts`

**ISOLATE**

- `src/simulationEngine.ts`
- `src/strategy/strategyDecisionPipeline.ts`
- `src/monitor/runLiveMonitorTick.ts`, `src/monitorConsole.ts`
- `src/legacy/spot/*`

**REWRITE** (per dominio futures)

- Motore esecuzione paper/sim
- Pipeline strategia come plugin con contratto chiaro
- Schema persistenza e analytics

**DELETE / ARCHIVE**

- `src/binary/**` (se si abbandona il dominio prediction market)
- `src/legacy/btcPriceService.ts` (se confermato senza referenze nel codebase)
- Script/analyze strettamente binary-only se non servono
- Valutare `src/replayOpportunities.ts`, `src/validateBinaryMarket.ts`

**NON CHIARO / DA VERIFICARE MANUALMENTE**

- Adozione effettiva degli script `analyze-*` in CI/workflow personale (non deducibile solo dal codice).
- Contenuto `.env` locale (non incluso nell’audit).

---

## Incongruenze naming / config / comportamento

- **`createBinarySignalFeed`**: solo `binance_spot` è realmente supportato senza fallback warning per altri valori di `BINARY_SIGNAL_SOURCE`.
- **`index.ts` vs `liveMonitor.ts`**: stack strategico diverso → rischio comportamenti non allineati.
- **Gamma polling:** lettura `POLYMARKET_POLL_*` in `binaryMarketFeed.ts` vs alias `BINARY_POLL_*` in `config.ts` — OK se `config` caricato per primo.
- **`legacy/btcPriceService`:** `BTC_SYMBOL` senza effetto sul resto dell’app se il modulo non è importato da nessuna parte.

---

*Documento generato come snapshot di ricognizione tecnica; aggiornarlo dopo modifiche architetturali significative.*
