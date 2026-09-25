---
name: analyze-game
description: Post-game analysis for an Amazing Chess match (our engine vs limited Stockfish). Ensures the per-ply Stockfish analysis exists in games/<id>/analysis.json, then runs the gm-coach and engine-dev sub-agents IN PARALLEL, saves their AgentReports into analysis.json and merges their suggestions into the improvement backlog (docs/backlog.md). Use after every finished game, when asked to analyse/review a game, or when the backend launches `/analyze-game <matchId> --agents-only`.
argument-hint: "<matchId|latest> [--agents-only]"
allowed-tools: Bash, Read, Write, Glob, Grep, Agent
---

# /analyze-game — analyse one saved game

Arguments: `$ARGUMENTS` → first token is the match id (or `latest`); `--agents-only` means the
backend has already written the engine part of `analysis.json` (per-ply evals) — skip step 2.

Implements CLAUDE.md §5 and [docs/06-analysis-and-agents.md](../../../docs/06-analysis-and-agents.md).
Run everything from the repo root. This may run **headless** (`claude -p ... --permission-mode
bypassPermissions`) with nobody watching: never ask questions, never stop half-way, always leave
both report statuses in a terminal state (`ready` or `failed`).

## Hard rules
- `games/<id>/game.pgn` and `games/<id>/match.json` are **evidence: never write, move or delete
  them** (CLAUDE.md rule 4). Only `scripts/save_agent_report.py` and the engine-analysis step write
  into `games/<id>/`, and only `analysis.json` (+ `analysis-history/`).
- Don't hand-edit `analysis.json`; always go through `scripts/save_agent_report.py` (it validates
  against the contract, locks, and writes atomically).
- Don't touch `engine/`, `backend/` or `frontend/` — this skill only analyses and records.

## Steps

### 1. Resolve the match
```bash
ID=$(.venv/bin/python .claude/skills/analyze-game/scripts/briefing.py resolve <matchId|latest>)
```
Stop with a clear error if it fails (no such game). Shell variables do not persist between Bash
calls — write the literal id into every later command (`"$ID"` below is a placeholder).

### 2. Ensure the engine analysis exists (skip with `--agents-only`)
```bash
.venv/bin/python .claude/skills/analyze-game/scripts/briefing.py status "$ID"   # exit 0 = engine part ready
```
If not ready (or the user explicitly asked to re-run it):
1. Preferred — the backend CLI: check `.venv/bin/python -m amazing analyze --help`. If it exists,
   run `.venv/bin/python -m amazing analyze "$ID"` with its engine-only flag if it has one
   (e.g. `--engine-only` / `--no-agents`) so it does not launch a second agent pass.
2. Fallback (backend not built yet / command fails):
   `.venv/bin/python .claude/skills/analyze-game/scripts/engine_analysis.py "$ID" --depth 18`
   (local full-strength Stockfish via python-chess; `/opt/homebrew/bin/stockfish` by default).

With `--agents-only`, if the engine part is unexpectedly missing, run the fallback anyway rather
than giving up — agents need the evals. If even that fails, continue: the briefing then says evals
are missing and the agents reason from the moves and thinking data.

### 3. Mark both reports running (so the UI shows progress)
```bash
.venv/bin/python scripts/save_agent_report.py "$ID" gm-coach --status running
.venv/bin/python scripts/save_agent_report.py "$ID" engine-dev --status running
```

### 4. Build the briefing
```bash
.venv/bin/python .claude/skills/analyze-game/scripts/briefing.py build "$ID"   # prints the path
```
It writes `<WORK>/briefing.md` where `<WORK>` is `$TMPDIR/amazing-chess/<id>` (use the printed
path; `<WORK>` below means its directory): game facts (Stockfish Elo, our colour,
version, result, termination, time use), PGN, a per-ply table (our engine's depth/seldepth ·
nodes · score · PV from `match.json` next to Stockfish's eval/best move/cpLoss/classification,
all from our engine's point of view), FENs of critical positions, and the current backlog titles.
Read it quickly yourself so you can sanity-check the agents' answers.

### 5. Spawn BOTH sub-agents in parallel — one message, two Agent tool calls
Use `subagent_type: "gm-coach"` and `subagent_type: "engine-dev"` in the **same** message.
Prompt for each (fill in the values):

> Review Amazing Chess game `<ID>` (our engine = `<colour>`, Stockfish UCI_Elo `<elo>`, result
> `<result>` = `<outcome>` for us). Briefing: `<briefing path>`. Game files (read-only):
> `games/<ID>/match.json`, `games/<ID>/game.pgn`, `games/<ID>/analysis.json`.
> Write your AgentReport JSON to `<WORK>/<agent>.json`, validate it with
> `.venv/bin/python scripts/save_agent_report.py <ID> <agent> <that file> --check`, fix any
> errors, and finish with the same JSON as your final answer.

### 6. Save each report
For each agent (`gm-coach`, `engine-dev`):
```bash
.venv/bin/python scripts/save_agent_report.py "$ID" <agent> "<WORK>/<agent>.json"
```
- If the file is missing but the agent's final answer contains the JSON, write that answer to the
  file (Write tool) and save it — the script also accepts a ```json fenced block.
- If validation fails, fix only mechanical problems (bad enum spelling, missing field, stray
  keys) and retry; never invent analysis content. You may re-prompt the agent once
  (SendMessage, if available) with the validator output.
- If an agent errored, timed out, or produced nothing usable after one retry:
  `.venv/bin/python scripts/save_agent_report.py "$ID" <agent> --status failed --summary "<short reason>"`

### 7. Update the backlog
```bash
.venv/bin/python scripts/backlog.py add "$ID"
```
(Idempotent; near-duplicate suggestions upvote existing items. Skips failed reports.)

### 8. Print a short summary
```bash
.venv/bin/python .claude/skills/analyze-game/scripts/briefing.py status "$ID"
.venv/bin/python scripts/backlog.py list --limit 5
```
Then report in ≤ 12 lines: match id, Elo, colour, outcome; accuracy ours/Stockfish and the
decisive ply; each agent's status and its top suggestion (or failure reason); backlog changes
(new / upvoted) and the current #1 item. Mention `docs/backlog.md`.

## Failure handling cheat-sheet
| Situation | Do |
|---|---|
| Unknown match id | Stop with an error; write nothing |
| Engine analysis fails both ways | Continue with agents; mention it in the summary |
| One agent fails | Save the other; mark the failed one `--status failed --summary "..."` |
| Both fail | Mark both failed; still print the summary |
| Script says contract violation | Fix mechanics, retry once, else mark failed with the error |
