# backend/

Match runner (our engine vs limited Stockfish) + HTTP API implementing
[`contracts/openapi.yaml`](../contracts/openapi.yaml). Owned by the backend developers.

- Architecture and game-store layout: [docs/02-architecture.md](../docs/02-architecture.md)
- Requirements with acceptance criteria: [docs/01-requirements.md](../docs/01-requirements.md)
- Requires a **local Stockfish binary** (e.g. `brew install stockfish`) — official games need
  `UCI_LimitStrength` + `UCI_Elo`, which stockfish.online does not support.

*Not started yet.*
