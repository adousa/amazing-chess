# backend/

Match runner (our engine vs Elo-limited Stockfish) + append-only game store + post-game analysis +
HTTP API implementing [`contracts/openapi.yaml`](../contracts/openapi.yaml) (v0.1.0) and the SSE
stream in [`contracts/events.md`](../contracts/events.md).

- Architecture and game-store layout: [docs/02-architecture.md](../docs/02-architecture.md)
- Requirements with acceptance criteria: [docs/01-requirements.md](../docs/01-requirements.md)

## Setup

```bash
brew install stockfish                       # local binary: UCI_LimitStrength + UCI_Elo
python3 -m venv .venv && .venv/bin/pip install -e 'backend[test]'
```

Python ≥ 3.9. Our engine is `engine/target/release/amazing-chess` (`cargo build --release` in
`engine/`). If it is missing (and `AC_ENGINE_PATH` is unset), a Python placeholder player
(`python -m amazing.placeholder_engine`, 2-ply material search) is used and recorded as version
`0.0.0-placeholder`.

## Commands (run from the repo root)

| Command | What |
|---|---|
| `.venv/bin/python -m amazing serve [--port 8000]` | API on `http://localhost:8000/api` (CORS for `localhost:5173`) |
| `.venv/bin/python -m amazing play --elo 1320 --color alternate --count 2 [--parallel 2]` | Headless matches (used by the `/loop` ladder); prints each result, then waits for the engine analysis. Agents are launched detached (`--wait-agents` waits, `--no-agents` skips) |
| `.venv/bin/python -m amazing analyze <matchId>… [--depth N] [--missing]` | (Re-)run the engine analysis only; the old `analysis.json` goes to `analysis-history/`. `--with-agents` also runs the agents |
| `.venv/bin/python -m amazing agents <matchId>` | Run the GM-coach + engine-dev agents for one game (blocking) |
| `.venv/bin/python -m amazing ladder [--json]` | Print the Elo ladder |
| `cd backend && ../.venv/bin/python -m pytest -q` | Tests (need `stockfish` on PATH; use a temp game store, never `games/`) |

## Configuration (environment variables)

| Var | Default | Meaning |
|---|---|---|
| `AC_GAMES_DIR` | `<repo>/games` | Game store |
| `AC_ENGINE_PATH` | `<repo>/engine/target/release/amazing-chess` | Our engine; may be a command with args (e.g. `python -m amazing.placeholder_engine --depth 2`) |
| `AC_STOCKFISH_PATH` | `stockfish` on PATH | Opponent + analyser |
| `AC_MOVE_TIME_MS` | `5000` | Per-move limit for both sides (never above 5000). Both get `go movetime <limit − 100>` |
| `AC_PARALLEL` | `2` | Matches played in parallel |
| `AC_SF_THREADS` / `AC_SF_HASH_MB` | `1` / `64` | Limited Stockfish settings |
| `AC_ENGINE_HASH_MB` | `64` | Our engine's `Hash` |
| `AC_ENGINE_OPTIONS` | – | Extra UCI options for our engine as JSON, e.g. `{"Threads": 1}` (only advertised options are set; recorded in `engine.options`) |
| `AC_ANALYSIS_DEPTH` | `18` | Full-strength Stockfish depth for the per-ply analysis |
| `AC_ANALYSIS_THREADS` / `AC_ANALYSIS_HASH_MB` | `1` / `128` | Analysis Stockfish settings |
| `AC_AGENTS` | `0` | `1` = run the Claude agents after the engine analysis. **Off by default for now** (token cost); with `0` the reports stay `pending` and can be backfilled later |
| `AC_AGENTS_PARALLEL` / `AC_AGENTS_TIMEOUT_S` | `1` / `1800` | Concurrent `claude` runs (global, across processes) / kill after |
| `AC_CLAUDE_PATH` | `claude` on PATH | Claude Code CLI command |

## How it works

- **Match** (`amazing/runner.py`, own asyncio UCI client in `uci.py`): per match both engines are
  started; Stockfish gets `UCI_LimitStrength=true`, `UCI_Elo`, `Threads`, `Hash`. Each move: `position …`,
  `isready`, then `go movetime 4900`. The runner measures wall time from `go` to `bestmove`.
  More than 5000 ms (or no answer by 5.5 s) → that side loses by `time-limit-exceeded`. Illegal move
  by our engine → `illegal-move`, crash → `engine-crash` (both losses); a Stockfish failure or a setup
  failure → status `error`. Normal endings (checkmate, stalemate, threefold, 50-move, insufficient
  material) are adjudicated by python-chess on the actual position (no "claim on next move").
  `engine.info` events are throttled to 4/s. Our engine's last `info` becomes `Move.thinking`.
- **Store** (`store.py`): `games/<matchId>/game.pgn` + `match.json` are written once when the game
  ends (finished, aborted or error) with atomic, no-overwrite writes. Ids are `m_<yyyymmdd>_<elo>_<nnn>`,
  reserved by creating the directory. `analysisStatus` is derived from `analysis.json` at read time.
  Ladder, stats and engine versions are derived from the store (`derive.py`).
- **Analysis** (`analysis.py`): after every game a worker runs full-strength Stockfish on every
  position → `analysis.json` (`pending → running → ready|failed`). Classification per
  docs/06-analysis-and-agents.md, lichess accuracy formula, decisive ply, small ECO lookup.
  With `AC_AGENTS=1` and `claude` available it then runs
  `claude -p "/analyze-game <id> --agents-only" --permission-mode bypassPermissions` (cwd = repo
  root, log in `games/<id>/agents.log`); the skill merges the reports via
  `scripts/save_agent_report.py` (same lock file as the backend). When claude exits, reports that
  never arrived are marked `failed` and the status becomes `ready`. The backend watches
  `analysis.json` and emits `analysis.updated` (`part: gm-coach|engine-dev`).
- **Re-run** (`POST /matches/{id}/analysis`): the current `analysis.json` is moved to
  `analysis-history/<timestamp>.json` first.
- **SSE**: snapshot on connect (or replay after `Last-Event-ID`), then live events; the stream closes
  after `analysis.updated` with `ready|failed`, or right away for completed matches with no analysis
  work pending. Aborted/errored matches end with a final `match.snapshot` (see note below).

## Contract notes (not changed here — to discuss)

- `MatchFinishedEvent.outcome`/`termination` are non-nullable, so aborted/error matches cannot send
  `match.finished`; the backend sends a final `match.snapshot` (status `aborted`/`error`) instead.
- `Termination` has no value for a Stockfish/setup failure; such matches have status `error` and
  `termination: null`.
