# ♟️ Amazing Chess — Beat Stockfish

Our own chess engine, a match runner against Elo-limited Stockfish, post-game analysis by a
GM-coach and an engine-dev agent, and a replay UI to prove every win.

- **Start here:** [CLAUDE.md](CLAUDE.md) — what the app must do and the rules for changing it
- **Docs:** [docs/](docs/) — overview, requirements, architecture, roadmap, engine, testing, UX
- **Backend ↔ frontend contract:** [contracts/](contracts/)

| Folder | What |
|---|---|
| `engine/` | Our UCI chess engine |
| `backend/` | Match runner + API |
| `frontend/` | Replay, ladder, stats, live view |
| `contracts/` | OpenAPI + SSE contract, examples |
| `games/` | Saved games (evidence) |
| `scripts/` | Dev helpers (e.g. `stockfish_online.py`) |
| `docs/` | How we build it |
