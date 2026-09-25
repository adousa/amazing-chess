# 00 · Overview — the competition and how we intend to win

## The brief (Chess game workshop — "Beat Stockfish!")

Build a chess application with **our own computer chess player** that tries to defeat
**Stockfish**. Any technique is allowed (classical search, heuristics, ML, AI…).
**The team that proves a win against Stockfish at the highest configured Elo wins.**

### Rules we must satisfy

| # | Rule | Where we handle it |
|---|---|---|
| R1 | Any programming language | [04-engine](04-engine.md) |
| R2 | Use **`/goal`, `/loop` or a dynamic workflow** during development | [03-roadmap](03-roadmap.md), [06-analysis](06-analysis-and-agents.md) |
| R3 | Max **5 s thinking per move per player** (e.g. `chess.engine.Limit(time=5.0)`) | Backend enforces, engine respects |
| R4 | **A draw is not a win** | Outcome logic, contempt in engine |
| R5 | **Every game saved** together with the Stockfish Elo used | Game store, PGN `StockfishElo` header |
| R6 | Games **replayable on a graphical board**, first to last move | Frontend replay |
| R7 | After each game a **skill** analyses the match | `.claude/skills/analyze-game` |
| R8 | Each match analysed by **two sub-agents**: a Carlsen-level GM and a chess-engine specialist, both giving concrete improvement suggestions | `.claude/agents/` |
| R9 | Stockfish limited with **`UCI_LimitStrength` + `UCI_Elo`** | Backend match runner |
| R10 | Victory must be **verifiable** through the saved, replayable game | Ladder "proof game" |

### Prizes
- 🏆 **Main:** highest Stockfish Elo beaten (proof game required).
- ✨ **Bonus:** best playing experience — board design, animation, ease of replay, presentation
  of results/Elo, "wow factor".

### Elo reference (from the brief)
Novice 1320 · Beginner 1400 · Intermediate 1600 · Advanced 1800 · Expert 2000 · Master 2200 ·
Grandmaster 2500 · Stockfish unlimited ≫ 3000. Magnus Carlsen ≈ 2823 (peak 2882).

## Key facts from research

- `UCI_Elo` accepts **1320–3190**; values outside are clamped. It is calibrated against CCRL
  40/4-style engine ratings at ~60s+0.6s, so at **5 s/move** limited Stockfish plays a bit
  *above* its nominal Elo.
- Limited Stockfish plays weaker by **injecting random sub-optimal moves** — a tactically sharp
  engine punishes them.
- A solid hobby **alpha-beta engine** in a compiled language reaches ~2300–2700 CCRL; with a
  self-trained **NNUE** evaluation, 3000+ is realistic. The whole 1320–3190 range is reachable.

## Strategy (summary)

1. **Qualify early:** get the full pipeline working end-to-end with a trivial player (play →
   save → replay → skill → two agents). That alone satisfies R2–R10.
2. **Own engine in Rust or C++:** bitboards + alpha-beta + quiescence + TT + move ordering +
   tapered piece-square tables → pruning/reductions → time management.
3. **Climb the ladder** in steps of +100 Elo (+50 near the frontier), playing **many games at
   the frontier** — we only need **one** win per level, so variance works for us.
4. **Anti-draw:** contempt, avoid repetitions, convert endgames (tablebases).
5. **NNUE:** train our own small network on self-play data for the final push.
6. **UX in parallel** by the frontend developers, against the contract.

## Open questions for the organisers
- May we use an opening book / endgame tablebases? (We assume yes.)
- Is forking an open-source engine or using a pre-trained network allowed? (We assume **no** —
  our player must be our own.)
- Is `stockfish.online` acceptable for official games? It has no Elo limit, so we assume
  official games run on a local Stockfish binary. See [05-testing](05-testing.md).

Record answers in [`decisions/`](decisions/).
