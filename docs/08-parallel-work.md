# 08 · Working in parallel

The contract in [`contracts/`](../contracts/) lets every track move without waiting.

| Track | Builds against | Can start | Needs from others |
|---|---|---|---|
| **Frontend** | Prism mock of `openapi.yaml` + `contracts/examples/` | Now | Nothing |
| **Backend** | `openapi.yaml` (implement it) + any UCI engine (Stockfish itself as a stand-in for "our engine" while developing the runner) | Now | Nothing |
| **Engine** | UCI protocol only | Now | Nothing |
| **Analysis** | `contracts/examples/game.pgn` + `match.json` | Now | Nothing |

## Ground rules
1. **Branch per change**, PR into `main`, small PRs.
2. **Contract changes are their own PR** (or clearly separated commits) and need one backend +
   one frontend approval. See [contracts/README.md](../contracts/README.md).
3. **Every PR updates [`CLAUDE.md`](../CLAUDE.md)** when behaviour, rules, boundaries or the
   contract change — plus a Changelog line.
4. Engine PRs include an SPRT result ([05-testing](05-testing.md)).
5. Don't touch another track's folder without a heads-up.
6. Never modify anything under `games/` except by the match runner / analysis skill.

## Folder ownership
```
engine/     engine developers
backend/    backend developers
frontend/   frontend developers
contracts/  shared — backend + frontend review
.claude/    shared — analysis skill + agents
docs/       shared
games/      written only by the runner/skill
```

## Local ports
| Service | URL |
|---|---|
| Backend API | http://localhost:8000/api |
| Prism mock | http://127.0.0.1:4010 |
| Frontend dev server | http://localhost:5173 (proxy `/api` → backend or mock) |
