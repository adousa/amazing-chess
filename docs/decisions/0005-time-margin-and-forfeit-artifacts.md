# 0005 · 250 ms movetime margin; opponent time-forfeits are not proof

**Status:** Accepted · 2026-09-26

## Context
Both sides were sent `go movetime <limit − 100 ms>`. On 2026-09-25 the four games at Stockfish Elo
2600 (`m_20260925_2600_001`–`004`) all ended `time-limit-exceeded` in our favour. Three of them ended
after only 2–6 plies. Stockfish had spent about 4.9 s per move, and a head-to-head engine test was
running on the same machine at the same time. That CPU contention pushed Stockfish's wall-clock time
over 5 s. These results come from our setup, not from the chess.

## Decision
- `go movetime` is now the limit **minus 250 ms** for both sides (`backend/amazing/config.py`). The
  5 s rule is unchanged and still enforced on measured wall time.
- A level only counts as beaten by a **win on the board** (checkmate, or Stockfish running out of
  time on an idle machine in a long game). The 2600 time-forfeit games stay in `games/` untouched
  (games are evidence), but they are **not** claimed as proof that 2600 is beaten.
- `/ladder-loop` never runs engine tests (h2h/SPRT) while ladder games are being played.

## Consequences
- The ladder CLI still lists 2600 as "beaten" from those games. `CLAUDE.md` "Current status" is the
  authoritative claim, and it only cites on-board wins.
