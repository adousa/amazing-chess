# 04 · Engine — approach and feature roadmap

## Approach comparison

| Approach | Realistic strength | Verdict |
|---|---|---|
| Python minimax with `python-chess` | ~1200–1600 | ❌ Too slow (~10k nodes/s). Fine as Phase 1 placeholder only |
| LLM picks the moves | < 1200, illegal moves | ❌ Demo only |
| **Rust/C++ bitboard alpha-beta + PeSTO eval** | **~2300–2700** | ✅ **Step 1** |
| **Same + self-trained NNUE** (bullet) | **~2900–3300** | ✅ **Step 2 — wins the contest** |
| Lc0-style MCTS + big net | Needs GPU + weeks | ⚠️ Overkill |
| Wrap/fork Stockfish or Lc0 | 3500+ | 🚫 Not our own player — likely disqualifying |

**Why alpha-beta:** at 5 s/move a fast compiled engine searches millions of nodes/s and reaches
depth 15–25. Limited Stockfish injects random mistakes; deep tactical search punishes them.

## Interface
- The engine is a standalone binary speaking **UCI** (`uci`, `isready`, `ucinewgame`,
  `position`, `go movetime|wtime|btime|depth`, `stop`, `quit`, `info …`, `bestmove`).
- It must **never** exceed the time given; target a hard stop at ~4.8 s for `movetime 5000`.
- Report `info depth … score cp|mate … nodes … nps … pv …` — the runner stores it in
  `Move.thinking` and the frontend shows it.
- Version string (`id name AmazingChess <version>`) is recorded with every game.

## Feature roadmap (build in this order)
Typical Elo gains for hobby engines (Chess Programming Wiki / community experience):

1. **Bitboards + legal move generation**, verified with **perft** — correctness first
2. **Negamax alpha-beta + iterative deepening** → ~1500
3. **Quiescence search** (captures) — fixes the horizon effect: **+300**
4. **Transposition table** (Zobrist): **+150**
5. **Move ordering**: TT move → MVV-LVA → killers → history: **+200**
6. **PeSTO tapered piece-square tables**: **+200–300**
7. **PVS + aspiration windows**: +50
8. **Null-move pruning**: +100
9. **Late move reductions**: +100–150
10. **Reverse futility, futility, late-move and SEE pruning**: +100
11. **Check extensions, countermove heuristic**
12. **Time management**: soft limit ~2.5–3 s, hard stop 4.8 s
13. **Opening book** (Polyglot `.bin`) — variety and fast, sound openings
14. **Syzygy 5-piece tablebases** — convert won endgames
15. **NNUE** (768→256×2→1) trained with **bullet** on our self-play data: **+300–500**
16. **Contempt / anti-draw** — a draw counts as a loss for us

## NNUE in short
A small neural network replaces the handcrafted evaluation. Its first layer is updated
incrementally on make/unmake (only 2–4 features change per move), so it runs at millions of
evals/s on a CPU. Steps: handcrafted engine → self-play data → train (bullet / nnue-pytorch) →
embed quantised weights → SPRT. Don't use Stockfish's `.nnue` files — train our own.

## Resources
- [Chess Programming Wiki](https://www.chessprogramming.org/) (search, pruning, NNUE pages)
- [bullet NNUE trainer](https://github.com/jw1912/bullet)
- [Chess engine blog series, search → NNUE](https://www.dogeystamp.com/chess0/)
- Sebastian Lague — "Coding Adventure: Chess" (videos)
