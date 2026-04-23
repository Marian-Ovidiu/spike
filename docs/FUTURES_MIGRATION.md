# Migrazione: core futures vs prodotto binary/spot legacy

Questo documento fissa l’architettura **dopo** l’introduzione dello stack **futures-oriented** sotto `src/core/`, senza rimuovere il prodotto **binary-first** esistente.

## Entry point attuali

| Uso | Comando / file | Descrizione |
|-----|------------------|-------------|
| **Futures live (consigliato per il nuovo stack)** | `npm run monitor:futures` → `src/core/runtime/runFuturesMonitor.js` | Config (env) → `BinanceSpotCoreFeed` → segnale neutro → `RiskEngine` → `FuturesPaperEngine` → log JSON. **Nessun** `SimulationEngine` / `strategyDecisionPipeline`. |
| **Futures offline** | `npm run replay:futures` → `src/core/replay/runFuturesReplay.js` | CSV/JSONL di mid → stessa pipeline (`futuresStackStep`) con book sintetico. |
| **Prodotto legacy (default repo precedente)** | `npm run monitor` → `src/liveMonitor.js` | Binary + Polymarket opzionale o book sintetico YES/NO, `SimulationEngine`, `opportunityTracker`, JSONL `output/monitor/`. |
| **Index / loop semplificato** | `npm start` / `node dist/index.js` | `botLoop` + doppio feed da `marketFeedFactory` (non il core futures). |
| **Backtest / analisi JSONL binary** | `npm run backtest`, `npm run analyze-run`, `npm run analyze-sessions`, `npm run analyze-probability-calibration`, `npm run replay-opportunities` | Riferiscono `backtest.ts`, `opportunityTracker`, reportistica 0–1. **Non** sostituiti dal core futures. |

**Config condivisa:** `src/config.ts` + `.env` alimentano **sia** i path legacy **sia** `futuresBootstrap` (es. `SPIKE_*`, stake, fee/slippage tramite chiavi anche se il nome è “binary”). Il nuovo runtime non richiede `MARKET_MODE=binary`.

## Cosa è stato sostituito concettualmente

| Prima (legacy) | Dopo (core futures) |
|----------------|---------------------|
| Segnale BTC + probability / YES/NO (`binaryProbabilityEngine`, quote filter) | `evaluateSignalConditions` (`src/core/signal/`) su buffer rolling |
| `SimulationEngine` ramo binary/spot | `FuturesPaperEngine` (`src/core/execution/`) |
| Gate quote binary (`binaryQuoteEntryFilter`) | `RiskEngine` operativo (`src/core/risk/`) |
| `monitorPersistence` + campi YES/NO | `src/core/reporting/` schema neutro (`futures-events.jsonl`, …) |

Il **binary monitor** resta valido per chi usa Polymarket/sintetico 0–1; non è “deprecato” nel senso di rimozione imminente, ma è **isolato** dal core futures.

## Albero cartelle — ruolo

- **`src/core/`** — dominio neutro: signal, domain, market adapter, execution paper futures, risk, runtime, replay, reporting.
- **`src/binary/`** — venue Polymarket/sintetico, paper outcome-token, diagnostiche binary.
- **`src/legacy/spot/`** — esecuzione spot bps (`LEGACY_SPOT_MARKET_MODE`).
- **`src/legacy/binary/`** — placeholder (`.gitkeep`) per eventuale quarantena file binary.
- **`src/adapters/binanceSpotFeed.ts`** — ancora **condiviso** (adapter WS); il core espone `BinanceSpotCoreFeed`.

## Script npm — tassonomia

| Script | Fascia |
|--------|--------|
| `monitor:futures`, `replay:futures` | **Nuovo stack** |
| `monitor`, `start` (via `main`), `backtest`, `replay-opportunities`, `validate-binary-market`, `analyze-*` | **Legacy / binary product & tooling** — restano necessari finché il prodotto binary è supportato |

Nessuno script npm è stato rimosso per evitare rotture ai flussi esistenti.

## Dipendenze residue del legacy nel nuovo stack

- **`createFuturesMonitorRuntime`** (`futuresBootstrap.ts`) importa **`src/config.ts`** e costruisce il feed tramite **`createBinanceSpotCoreFeed`** → `BinanceSpotFeed` in `src/adapters/`. Non è “binary logic”, ma è **codice app condiviso** fuori da `src/core/` puro.

## File archiviati / candidate

Vedi **`src/legacy/ARCHIVE_CANDIDATES.md`** e lo storico audit in `PROJECT_AUDIT_REPORT.md` (alcune righe si riferiscono al path precedente di `btcPriceService`).

## Documentazione correlata

- `README.md` — panoramica prodotto (ancora orientata binary-first); sezione futures in header.
- `docs/futures-pivot-map.md` — mappa pivot tecnica originaria.
- `src/core/reporting/LEGACY_EXCLUSIONS.md` — campi binary esclusi dal reporting neutro.
