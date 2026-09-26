# CLAUDE.md — Amazing Chess

> **What this file is:** the single source of truth for **what** the application must do.
> It describes behaviour and outcomes, **not implementation**. The *how* lives in [`docs/`](docs/)
> and in the code. If you are about to write "use library X" or "implement it with Y" here, it
> belongs in `docs/` instead.

---

## 🔁 Rules for every change (humans and Claude)

1. **Every change to the app updates this file.** If a PR adds, removes or changes a capability,
   rule, component boundary or contract, update the relevant section below **in the same PR**
   and add a line to the [Changelog](#changelog). A PR that changes behaviour without touching
   `CLAUDE.md` is incomplete.
2. **Describe what, not how.** Sections here state requirements and observable behaviour.
   Technical decisions go in `docs/` (and `docs/decisions/` for anything non-obvious).
3. **Contract first.** The backend ↔ frontend boundary is defined in [`contracts/`](contracts/).
   Change the contract *before* (or in the same PR as) the code on either side. Never ship an
   endpoint, field or event that is not in the contract. See [contracts/README.md](contracts/README.md).
4. **Games are evidence.** Never delete, rewrite or "clean up" a saved game. Only append.
5. **Test before you climb.** No engine change is merged without a measured result
   (see [docs/05-testing.md](docs/05-testing.md)).

---

## 🎯 The mission

Build a chess application with **our own computer chess player** that defeats **Stockfish** at the
**highest possible Elo**. The team that proves a win against the highest configured Stockfish Elo
wins the competition. A second prize goes to the best overall playing / replay experience.

Background, rules and strategy: [docs/00-overview.md](docs/00-overview.md).

---

## ✅ What the application must do

### 1. Play matches — our engine vs limited Stockfish
- Start a match between **our engine** and **Stockfish** at a chosen **Stockfish Elo**.
- Stockfish's strength is limited via its `UCI_LimitStrength` and `UCI_Elo` options
  (valid Elo range **1320–3190**).
- Our engine can play **White or Black**; colour is chosen per match (or randomly).
- **Each side has at most 5 seconds of thinking time per move.** Exceeding it is not allowed.
- A match ends by the normal rules of chess (checkmate, stalemate, repetition, 50-move rule,
  insufficient material) or by abort/error.
- Several matches can be queued and run one after another or in parallel.

### 2. Decide and record the outcome
- Outcome is recorded **from our engine's point of view**: `win`, `draw` or `loss`.
- **A draw is not a win.** A Stockfish Elo level only counts as beaten after an actual win.
- Once a level is beaten, the next attempt can use a higher Elo.

### 3. Save every game (evidence)
- **Every** game is saved, including losses, draws and aborted games.
- Each saved game contains at least: all moves, the result, **the Stockfish Elo used**, which
  colour our engine played, our engine's version, time control, date/time and the Stockfish
  settings used.
- Saved games are available as standard **PGN** and as structured data (see contract).
- Saved games are never altered after the match ends (analysis is stored alongside, not inside).

### 4. Replay games on a graphical board
- Any saved game can be replayed **from the first move to the last** on a graphical chessboard.
- The viewer can step forward/back, jump to start/end, jump to any move and autoplay.
- The replay shows the move list, the players (incl. Stockfish Elo) and the result.
- There are two 3D stages to choose from (the choice is remembered). Both play every move forward
  (replay, autoplay or live), place captured pieces beside the board, and play out castling,
  en passant and promotion:
  - **Expedition** (default): a painterly, golden-hour Belle Époque battlefield, inspired by
    *Clair Obscur: Expedition 33* but not copied from it. Our engine is **the Expedition** and
    Stockfish is **the Paintress**. Across the sea is an island city with a broken, curled-over
    iron tower, and the fractured Monolith on the horizon shows the Stockfish Elo. **Every
    piece carries a weapon, and every capture is a dramatic duel:** a cinematic camera cut, the
    strike in slow motion, and the victim dissolving into petals. The inner circle of the plaza,
    with the board on it, is a slow elevator: it keeps slowly rising while the game goes on,
    then eases back down and climbs again. Duels can be
    switched off, and autoplay waits for a duel to finish. A soundtrack (the game's battle
    themes, via YouTube's player at the bottom of the page) plays while the game plays and pauses
    with it; it can be switched off. Each match opens with a short, skippable prologue: the
    Paintress paints a number that no one in Lumière may live beyond, and every Expedition that
    beats her raises it. The prologue shows how long Lumière's people may now live (the highest
    Stockfish Elo ever beaten) and the Elo this year's Expedition sails for (this match), then asks
    "Will this be the year Lumière wins?"
  - **The Seventh Seal**: an homage in black and white, an overcast, empty stony beach with only the
    two players and the board. Our engine is **the Knight** and Stockfish is **Death**, seen from the
    Knight's side. **The two players play the moves**: the mover reaches out, picks up the piece and
    sets it down.
- Each move is also given as a subtitle in words (e.g. "Death takes the pawn on e4 with the knight",
  or on the Expedition stage "The Paintress's rook crushes the pawn on e4").
- A plain 2D board is always available as an alternative view, and is used when 3D is not supported.

### 5. Analyse every game
- After **each** game an **analysis skill** runs automatically on it.
- The analysis produces a per-move evaluation and flags mistakes/blunders for both sides.
- Every game is additionally reviewed by **two sub-agents**:
  - **GM coach** — a world-class player modelled on Magnus Carlsen's strength: strategy,
    openings, plans, where the game was won or lost.
  - **Engine developer** — a chess-engine specialist: maps weaknesses to engine causes
    (search, evaluation, time use, …).
- Both agents must produce **concrete, actionable improvement suggestions** for our engine.
- Analysis and agent reports are saved with the game and viewable in the app.

### 6. Show progress and results
- An **Elo ladder** shows every Stockfish Elo level attempted, W/D/L per level, which levels are
  beaten and the **highest Elo beaten** — each beaten level links to its winning game.
- Statistics per Elo, per colour and per engine version.
- (Nice to have) watch a match **live** while it is being played.

### 7. Improve the engine (the loop)
- Analysis suggestions flow into an improvement backlog.
- Engine changes are measured against the previous version before being accepted.
- The play → save → analyse → improve → raise Elo cycle is driven with Claude Code using
  **`/goal`, `/loop` or a dynamic workflow** (a competition requirement).

### 8. Great experience (bonus prize)
Judged on: chessboard design, animations and move visualisation, how easy a game is to follow
and replay, presentation of results and Elo, and overall "wow factor".
See [docs/07-ux.md](docs/07-ux.md).

---

## 🚫 What the application must NOT do
- Must not use Stockfish (or any other existing engine / pre-trained engine network) **as our
  player**. Stockfish is only the opponent and the analysis tool. *(Confirm borderline cases
  with the organisers and record the answer in `docs/decisions/`.)*
- Must not exceed 5 s per move for either side.
- Must not count draws as wins.
- Must not delete or modify saved games.
- Must not expose anything to the frontend that is not in the contract.

---

## 🧩 Components and ownership boundaries

| Component | Responsibility (what) | Folder | Talks to |
|---|---|---|---|
| **Engine** | Chooses a move for a position within the time limit. Speaks UCI. | `engine/` | Match runner |
| **Backend** (match runner + API) | Runs matches vs Stockfish, enforces rules, saves games, triggers analysis, serves the API. | `backend/` | Engine, Stockfish, game store, frontend (via contract) |
| **Game store** | Durable storage of games, analysis and agent reports. | `games/` | Backend |
| **Analysis** | Skill + two sub-agents that analyse each finished game. | `.claude/` | Game store |
| **Frontend** | Replay, ladder, stats, live view. | `frontend/` | Backend (via contract only) |
| **Contract** | The API + event definitions between backend and frontend. | `contracts/` | Everyone |

Details: [docs/02-architecture.md](docs/02-architecture.md).

---

## 🤝 Backend ↔ frontend contract

- REST API: [`contracts/openapi.yaml`](contracts/openapi.yaml) (OpenAPI 3.1)
- Live events: [`contracts/events.md`](contracts/events.md) (Server-Sent Events)
- Example payloads for building against without a backend: [`contracts/examples/`](contracts/examples/)
- Current contract version: **0.1.0**

Frontend developers build against the mock server generated from the contract; backend
developers implement the contract. Neither side waits for the other.
How to work in parallel: [docs/08-parallel-work.md](docs/08-parallel-work.md).

---

## 🧪 Testing the engine

- **stockfish.online** (Stockfish 17.1 REST API) is available for quick checks of our engine's
  moves and evaluations: `GET https://stockfish.online/api/s/v2.php?fen=<FEN>&depth=<1-15>`.
  It has **no Elo limiting**, so it is for testing/sanity checks only — official competition
  matches must use a Stockfish configured with `UCI_LimitStrength` + `UCI_Elo`.
  Helper: `python scripts/stockfish_online.py "<FEN>" --depth 12`.
- Full testing strategy: [docs/05-testing.md](docs/05-testing.md).

---

## 📚 Docs map

| Doc | About |
|---|---|
| [00-overview](docs/00-overview.md) | The competition, rules, and how we intend to win |
| [01-requirements](docs/01-requirements.md) | Numbered functional requirements + acceptance criteria |
| [02-architecture](docs/02-architecture.md) | Components, data flow, storage layout |
| [03-roadmap](docs/03-roadmap.md) | Phases and the steps to take, in order |
| [04-engine](docs/04-engine.md) | Engine approach and feature roadmap |
| [05-testing](docs/05-testing.md) | Perft, SPRT, stockfish.online, the Elo ladder |
| [06-analysis-and-agents](docs/06-analysis-and-agents.md) | Analysis skill + GM coach + engine-dev agents |
| [07-ux](docs/07-ux.md) | Replay / ladder / live experience |
| [08-parallel-work](docs/08-parallel-work.md) | Team workflow around the contract |
| [decisions/](docs/decisions/) | Architecture decision records |

---

## 📈 Current status

- Highest Stockfish Elo beaten: **1320** — proof game `m_20260925_1320_002` (engine White, 1-0 checkmate, 33 plies)
- Phase: **1 — qualify end-to-end**, first proof game won, saved, analysed and reviewed by both agents
  (see [roadmap](docs/03-roadmap.md)). Engine v0.1.0 (classical alpha-beta), backend, analysis
  skill + both agents exist. The frontend now has the *Seventh Seal* replay/live stage; the ladder
  and stats pages are restyled but not yet redesigned. A second, default stage, *Expedition*, has armed
  pieces that fight every capture out as a duel.

---

## Changelog

- 2026-09-26 — Frontend: *Expedition* stage, a painterly golden-hour battlefield inspired by
  *Clair Obscur: Expedition 33*, now the default next to the Seventh Seal stage. Pieces are armed
  warriors (spear, lance, staff, hammer, rapier, greatsword), and every capture is a cinematic duel
  with slow motion that ends in a petal dissolve. Adds a Duels on/off toggle, battle-style subtitles
  and a stage toggle. The backdrop has an island city with a bent Eiffel-style tower, a
  lighthouse, boats, and the Monolith in a frozen rock explosion. The world is alive: wind-blown
  grass and flowers, swaying CC0 trees (Quaternius), a wave sea with foam and glitter, and birds.
  The inner circle with the board keeps slowly rising on a gold-banded stone shaft. A soundtrack
  (YouTube embed, below the analysis) plays with Play and pauses with Pause. A skippable story
  prologue opens each match, and subtitles sit in the sky clear of the pieces. The Battle camera
  can be orbited, panned and zoomed freely, and the chosen view is remembered in the browser.
  No contract change. See [ADR 0005](docs/decisions/0005-expedition-battle-stage.md).

- 2026-09-25 — Frontend: *Seventh Seal* stage for replay/live. Black-and-white 3D beach, the Knight
  (our engine) vs Death (Stockfish), and both players physically play each move. Also move
  subtitles, title/ending cards, Shoulder/Above/2D views, and a period black-and-white style across
  the app. No contract change. See [ADR 0004](docs/decisions/0004-seventh-seal-3d-stage.md).
<!-- Newest first. One line per change: date — what changed (PR/commit). -->
- 2026-09-25 — Phase 1 build: engine v0.1.0 (Rust, UCI, perft-verified, never exceeds 5 s),
  backend (match runner vs limited Stockfish, append-only game store, analysis after every game,
  API + SSE per contract v0.1.0), `/analyze-game` skill + `gm-coach` / `engine-dev` agents,
  improvement backlog (`docs/backlog.md`), `/ladder-loop` skill, simple placeholder frontend.
  First win: Stockfish Elo 1320 beaten (`m_20260925_1320_002`).
- 2026-09-25 — Repository initialised: CLAUDE.md, docs, backend↔frontend contract v0.1.0.
