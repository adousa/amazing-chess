# 03 · Roadmap — the steps to take

Tracks run **in parallel** from Phase 1 onwards thanks to the contract.
Tick items here (or link issues) as they land, and update the status in `CLAUDE.md`.

## Phase 0 — Foundation ✅ (this commit)
- [x] Repo, `CLAUDE.md`, docs
- [x] Backend ↔ frontend contract v0.1.0 + examples + validator

## Phase 1 — Qualify end-to-end (hours, not days) — ✅ 1320 beaten (`m_20260925_1320_002`), agent reports pending
Goal: every competition rule satisfied with a trivial player.

| Track | Steps |
|---|---|
| Backend | Match runner with `python-chess`: local Stockfish, `UCI_LimitStrength`/`UCI_Elo`, 5 s limit, save `game.pgn` + `match.json`. Placeholder player = random/1-ply. API serving `GET /matches`, `/matches/{id}`, `/pgn`, `/ladder`. |
| Frontend | Against the Prism mock: match list, replay page with chessground (controls, move list, header), ladder page. |
| Analysis | `.claude/skills/analyze-game/SKILL.md` (full-strength Stockfish per-move eval → `analysis.json`), `.claude/agents/gm-coach.md`, `.claude/agents/engine-dev.md`, wired to run after each game. |
| Engine | Repo skeleton, board representation, move generation, **perft** passing. |

✅ Exit: play one game at 1320 → saved → replay in browser → analysis + both reports visible.

## Phase 2 — Classical engine (roadmap items 1–12 in [04-engine](04-engine.md))
- Negamax alpha-beta, iterative deepening, quiescence, TT, move ordering, PeSTO eval,
  PVS, null-move, LMR, pruning, time management.
- UCI compliance; replace the placeholder player in the runner.
- ✅ Exit: beats Stockfish 1320 → ~2000.

## Phase 3 — Harden and climb (target 2200–2500)
- Opening book, Syzygy tablebases, contempt / anti-draw, SPRT-tuned parameters.
- Ladder automation: batches at the frontier Elo, parallel games.

## Phase 4 — NNUE (target 2700–3190)
- Generate self-play data (millions of positions) with our own engine.
- Train a small net (e.g. 768→256×2→1) with **bullet**; embed; SPRT vs handcrafted.
- Iterate: more data, bigger net, retrain.

## Phase 5 — Polish (in parallel with 2–4)
- UX bonus items from [07-ux](07-ux.md): eval bar/graph, move badges, arrows, sounds,
  live mode, confetti on win, ladder page with proof games.

## Driving it with Claude Code (competition rule R2)

- **`/goal`** — the durable objective, e.g. `/goal Beat Stockfish at UCI_Elo 2400 with a saved, replayable proof game`.
- **`/loop`** — the ladder cycle, self-paced:
  ```text
  /loop  play N games at the current frontier Elo → save → /analyze-game each →
         collect suggestions → implement the top one → SPRT vs previous version →
         if accepted: new engine version; if any win: raise Elo by 100 (50 near the frontier)
  ```
- **Dynamic workflow** — fan out the two analysis agents in parallel per game, and run several
  candidate engine patches in isolated worktrees, keeping the one that wins its SPRT.
