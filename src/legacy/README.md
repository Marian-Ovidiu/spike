# Legacy layout

Codice **fuori dal core futures** (`src/core/`) mantenuto per compatibilità con il prodotto **binary-first** e con la modalità spot documentata nel README principale.

| Path | Contenuto |
|------|-----------|
| `legacy/spot/` | Gate `LEGACY_SPOT_MARKET_MODE`, exit/quote spot bps |
| `legacy/binary/` | Placeholder (spostamenti futuri da `src/binary/` se si fa quarantena esplicita) |
| `legacy/btcPriceService.ts` | REST ticker `/ticker/price` — **nessun import** nel resto di `src/`; vedi commento in cima al file |

I moduli **`src/binary/**`**, **`liveMonitor.ts`**, **`botLoop.ts`**, **`simulationEngine.ts`**, **`strategy/**` non sono stati spostati: restano **entry e pipeline del prodotto legacy** ancora referenziati da `npm run monitor` e test.
