# 06 · Post-game analysis — skill + two sub-agents

Competition rules R7 and R8: after **each** game a **skill** analyses it, and **two
sub-agents** review it and give concrete improvement suggestions.

## Flow

```text
game finished → games/<id>/match.json + game.pgn
      │
      ▼
/analyze-game <id>   (skill: .claude/skills/analyze-game/SKILL.md)
  1. Load PGN
  2. Full-strength Stockfish, depth ~20, every ply → evalCp, bestMove, cpLoss, classification
  3. Summary: accuracy per side, decisive ply, opening
  4. Spawn in parallel (dynamic workflow):
       ├─ gm-coach   (.claude/agents/gm-coach.md)
       └─ engine-dev (.claude/agents/engine-dev.md)
  5. Write games/<id>/analysis.json (contract `Analysis` schema)
  6. Append suggestions to the improvement backlog
```

## Move classification (cp loss vs best move, from the mover's side)

| Class | cp loss |
|---|---|
| best | 0–10 |
| excellent | 10–25 |
| good | 25–50 |
| inaccuracy | 50–100 |
| mistake | 100–250 |
| blunder | > 250 or a missed/allowed mate |
| book | in opening book |
| brilliant | best move that is a sacrifice, only good move |

## Agent 1 — `gm-coach` (world-class player, Magnus Carlsen-level)
- Persona: plays and explains like a 2850 super-GM; practical, concrete, no hedging.
- Looks at: opening choice, pawn structure, plans, piece activity, king safety, where the game
  turned, how to steer limited Stockfish into positions it handles badly.
- Output: `summary`, `keyMoments[{ply, comment}]`, `suggestions[]` in the contract
  `AgentReport` shape (categories: opening / middlegame / endgame).

## Agent 2 — `engine-dev` (chess-engine specialist)
- Persona: author of a top open-source engine.
- Maps mistakes to engine causes: horizon effect, pruning too aggressive, bad move ordering,
  missing eval term (king safety, passed pawns, mobility), time management, TT bugs.
- Uses `Move.thinking` (depth, nodes, score, pv) to diagnose.
- Output: `AgentReport` with **code-level** suggestions and **how to verify** (SPRT, test
  position) (categories: search / evaluation / time-management / tablebases).

## Rules for both agents
- Every suggestion must be **concrete and actionable** (what to change, why, how to test).
- Reference plies so the UI can link comments to moves.
- Don't repeat suggestions already in the backlog; upvote them instead.

## Backlog
Suggestions accumulate in `docs/backlog.md` (or GitHub issues labelled `from-analysis`),
ranked by how often they recur and expected Elo gain. The `/loop` picks the top item next.
