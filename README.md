# ♟️ Amazing Chess — Beat Stockfish

Our own chess engine, a match runner against Elo-limited Stockfish, post-game analysis by a
GM-coach and an engine-dev agent, and a replay UI to prove every win.

- **Start here:** [CLAUDE.md](CLAUDE.md) — what the app must do and the rules for changing it
- **Docs:** [docs/](docs/) — overview, requirements, architecture, roadmap, engine, testing, UX
- **Backend ↔ frontend contract:** [contracts/](contracts/)

## Run the app

```bash
scripts/run.sh
```
Starts the backend (API on http://localhost:8000/api) and the frontend (http://localhost:5173)
together; open **http://localhost:5173**. Ctrl-C stops both. On first run it builds the engine and
installs the frontend packages. The engine plays with the competition setup (3 threads, Contempt 60);
override with e.g. `AC_ENGINE_OPTIONS='{"Threads":1}' scripts/run.sh`. Needs the backend `.venv`
(see [backend/README.md](backend/README.md)).

| Folder | What |
|---|---|
| `engine/` | Our UCI chess engine |
| `backend/` | Match runner + API |
| `frontend/` | Replay, ladder, stats, live view |
| `contracts/` | OpenAPI + SSE contract, examples |
| `games/` | Saved games (evidence) |
| `scripts/` | Dev helpers (`run.sh` starts the app, `stockfish_online.py`, …) |
| `docs/` | How we build it |
