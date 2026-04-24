# Legacy Modules

This directory contains compatibility and non-futures modules that are still kept
in the tree for temporary backward compatibility.

Active futures spike-monitor path:
- `src/core/runtime/*`
- `src/core/market/futuresFeed.ts`
- `src/core/market/bybitFuturesFeed.ts`
- `src/core/execution/liveSafetyGuard.ts`
- `src/core/exchange/futuresOrderValidator.ts`
- `src/exchanges/shared/*`
- `src/config/env.ts`

Legacy compatibility path:
- `src/legacy/exchange/*`
- `src/legacy/spot/*`
- `src/legacy/binary/*`
- `src/legacy/adapters/*`

Current policy:
- Do not delete legacy modules yet.
- Keep temporary reexports in the original paths until all call sites are migrated.
- Do not wire live order execution here.

