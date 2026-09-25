# 0003 · stockfish.online for testing only

**Status:** Accepted · 2026-09-25

## Context
`https://stockfish.online/api/s/v2.php` (Stockfish 17.1) is available for testing. It takes
`fen` and `depth` (1–15) and returns eval, mate, best move and continuation. It does **not**
support `UCI_LimitStrength`/`UCI_Elo` and is depth-limited rather than time-limited.

## Decision
Use stockfish.online for engine sanity checks, best-move agreement tests and as a CI fallback.
Official competition games run against a **local Stockfish binary** configured with
`UCI_LimitStrength=true` and `UCI_Elo`, 5 s/move.

## Consequences
- The backend needs a local Stockfish install (documented in `backend/README.md`).
- Cache stockfish.online responses; respect rate limits.
