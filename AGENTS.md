# Agent: Spike Trading Bot

Goal:
Implement a mean-reversion spike trading bot for binary markets.

Default execution path: **synthetic** YES/NO lab (`BinarySyntheticFeed`). **Polymarket Gamma** is optional (`src/binary/venue/README.md`).

Core logic:
- Detect stable range
- Detect spike
- Enter opposite position
- Exit on reversion
- Apply stop loss

Constraints:
- No overtrading
- Only act on valid signals
- Keep logic deterministic