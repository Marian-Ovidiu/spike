# Archive candidates (non eliminati automaticamente)

File o aree che **potrebbero** essere rimossi o compressi dopo review esplicita. In caso di dubbio, preferire **deprecazione in commento** + questo elenco.

| Path | Nota |
|------|------|
| `src/legacy/btcPriceService.ts` | Spostato da `src/btcPriceService.ts` (2026-04). **Zero import** in `src/`. Eliminabile se nessuno script esterno dipende dal path. |
| `dist/**` (generated) | Artefatti build; non versionare se la policy è git-clean su `dist/`. |

## Non candidati alla cancellazione senza progetto dedicato

- **`src/binary/**`** — ancora entry del `npm run monitor` default nel README storico.
- **`src/liveMonitor.ts`**, **`src/botLoop.ts`**, **`src/simulationEngine.ts`** — pipeline binary/spot completa.
- **`src/backtest.ts`** — replay CSV binary-first; non sostituito da `replay:futures` (scopo diverso).

Aggiornare questo file quando si archiviano o ripristinano moduli.
