# Contracts — backend ↔ frontend

This folder is the **only** agreement between the backend and the frontend. If it is not in here,
it does not exist for the other side.

| File | What it defines |
|---|---|
| [`openapi.yaml`](openapi.yaml) | REST API (OpenAPI 3.1) — endpoints, request/response schemas |
| [`events.md`](events.md) | Live match events over Server-Sent Events (schemas live in `openapi.yaml` → `MatchEvent`) |
| [`examples/`](examples/) | Realistic payloads (a real, legal game) for building UI and tests without a backend |
| [`validate_examples.py`](validate_examples.py) | Checks every example against the schemas |

Current version: **0.1.0** (`info.version` in `openapi.yaml`).

## Resources at a glance

| Endpoint | Purpose |
|---|---|
| `GET /health` | Liveness + implemented contract version |
| `GET /engines` | Our engine versions |
| `GET /matches` · `POST /matches` | List matches · queue matches at a Stockfish Elo |
| `GET /matches/{id}` | Full game incl. every move and FEN (replay) |
| `GET /matches/{id}/pgn` | PGN with `StockfishElo` header (evidence) |
| `POST /matches/{id}/abort` | Abort (the game is still saved) |
| `GET /matches/{id}/events` | Live SSE stream |
| `GET/POST /matches/{id}/analysis` | Engine analysis + GM-coach + engine-dev reports · re-run |
| `GET /ladder` | Elo ladder, highest Elo beaten + proof game |
| `GET /stats` | W/D/L by Elo, colour, engine version |

## Working against the contract

```bash
# Frontend: run a mock backend generated from the contract (http://127.0.0.1:4010)
npx @stoplight/prism-cli mock contracts/openapi.yaml

# Lint the contract
npx @redocly/cli lint contracts/openapi.yaml

# Check the examples still match
pip install jsonschema pyyaml && python contracts/validate_examples.py

# Browse it as docs
npx @redocly/cli preview-docs contracts/openapi.yaml
```

Frontend: generate TypeScript types from the contract (e.g. `openapi-typescript`) rather than
hand-writing them. Backend: validate responses against the schemas in tests.

## Change rules

1. **Contract first.** Change `openapi.yaml` / `events.md` in the same PR as (or before) the
   code that implements it. Never ship a field or endpoint that is not in the contract.
2. **Additive = minor, breaking = major** (while `0.x`, breaking bumps the minor and must be
   called out). Adding optional fields/endpoints is non-breaking. Renaming/removing fields,
   tightening types or changing meaning is breaking.
3. **Consumers must ignore unknown fields** so additive changes never break them.
4. Update `examples/` so `validate_examples.py` passes, and bump `info.version`.
5. Update the contract version and changelog line in [`CLAUDE.md`](../CLAUDE.md).
6. A contract PR needs a 👍 from **one backend and one frontend** developer.

## Conventions

- JSON is camelCase; timestamps are ISO-8601 UTC.
- Positions are FEN; every move carries both SAN and UCI plus `fenAfter` so the frontend never
  needs to replay moves to draw a position.
- `outcome` (`win`/`draw`/`loss`) is from **our engine's** point of view; only `win` beats a level.
- `evalCp` in analysis is from **White's** point of view; `thinking.scoreCp` is from the mover's.
- Errors are `{ "code": "...", "message": "..." }`.
