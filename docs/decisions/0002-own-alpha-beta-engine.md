# 0002 · Our own alpha-beta engine, NNUE later

**Status:** Proposed · 2026-09-25

## Context
We must beat Stockfish at the highest `UCI_Elo` (max 3190) with **our own** player at
≤ 5 s/move. Python search is ~100× too slow; LLM play is too weak; forking an existing engine
is likely not allowed.

## Decision
Write a bitboard alpha-beta engine in **Rust or C++** (team's choice), speaking UCI.
Handcrafted PeSTO evaluation first, then a self-trained NNUE (bullet). See `docs/04-engine.md`.

## Consequences
- Needs perft and SPRT discipline from day one.
- Phase 1 uses a Python placeholder player so the pipeline qualifies before the engine is ready.
