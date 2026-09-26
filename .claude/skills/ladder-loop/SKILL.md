---
name: ladder-loop
description: One iteration of the Amazing Chess competition loop — read the Elo ladder, play games at the frontier Stockfish Elo, wait for post-game analysis, implement the top backlog item in the engine, verify it against the previous build, accept only if better, and raise the Elo after a win. Designed to be driven by `/loop /ladder-loop` (self-paced) under a `/goal`. Use when asked to "climb the ladder", "run the loop", or improve the engine from game analysis.
argument-hint: "[--games N] [--elo X] [--no-improve]"
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, Agent
---

# /ladder-loop — play → save → analyse → improve → raise Elo

Competition rule (CLAUDE.md §7, docs/03-roadmap.md "Driving it with Claude Code"): the cycle is
driven with `/goal`, `/loop` or a dynamic workflow. This skill is **one iteration**; `/loop` repeats it.

```text
/goal Beat Stockfish at UCI_Elo 2400 with a saved, replayable proof game (docs/05-testing.md ladder)
/loop /ladder-loop --games 6            # self-paced: each run is one iteration
/loop 30m /ladder-loop --games 4        # or on a fixed interval
```
`/goal` holds the durable objective (raise the target once reached: 2400 → 2600 → …); the loop
stops being useful when the goal is met — say so and stop scheduling further iterations.

Arguments `$ARGUMENTS`: `--games N` (default 6, alternate colours), `--elo X` (override the frontier),
`--no-improve` (just play + analyse).

## Invariants (never break these)
- **Games are evidence** — never edit/delete anything in `games/`. Test games from verification go to
  `/tmp`, never `games/`.
- **≤ 5 s per move** for both sides; the backend enforces it — don't change time settings to win.
- **Never run engine tests (h2h/SPRT) while ladder games are playing** — CPU contention causes
  time forfeits that are not real results (docs/decisions/0005). Run ladder games off a frozen copy:
  `AC_ENGINE_PATH=$PWD/engine/target/versions/amazing-chess-<V>`, so a rebuild can't race them.
- **A draw is not a win.** Opponent time-forfeits under load are not proof either (ADR 0005). A level is beaten only by an actual `win` saved in `games/`.
- **Never use Stockfish (or any existing engine/net) as our player.** Stockfish is only opponent/analyser.
- **Test before you climb:** no engine change is kept without a measured improvement.
- Keep `CLAUDE.md` current: behaviour/capability changes → update it + its Changelog in the same change.
- Don't commit/push unless the user asked; if committing, never on `main`.

## 1. Where are we?
```bash
.venv/bin/python -m amazing ladder            # levels, W/D/L, beaten levels, highest beaten
.venv/bin/python scripts/backlog.py list --limit 10
```
Frontier Elo = `--elo` if given, else **highest beaten + 100** (start at **1320**; use **+50** once
within ~200 of the best-known frontier or after two failed rounds at +100). Clamp to 1320–3190.
If the backend CLI differs, check `.venv/bin/python -m amazing --help` (or read `games/*/match.json`).

## 2. Play at the frontier
```bash
.venv/bin/python -m amazing play --elo <X> --count <N>      # alternate colours; check --help for flags
```
Every game is saved (`games/<id>/`) and the backend then runs the engine analysis (free, no tokens).

> **Agents are currently OFF** (`AC_AGENTS=0`, the backend default, to save tokens). Unless the
> environment sets `AC_AGENTS=1`, **skip the wait and the backlog refresh below**: the reports stay
> `pending`. Work from the existing backlog and the engine analysis (`analysis.json` per-ply evals,
> mistakes/blunders) instead. To backfill a game later: `.venv/bin/python -m amazing analyze <id> --with-agents`.

With `AC_AGENTS=1` the backend also launches `/analyze-game <id> --agents-only` headless. Wait for it:
```bash
for id in <new ids>; do .venv/bin/python .claude/skills/analyze-game/scripts/briefing.py status $id; done
```
Poll until every game shows `gmCoach` and `engineDev` as `ready`/`failed` (use the Monitor tool
or a short `until` loop; don't burn turns). If a game's analysis never started, run
`/analyze-game <id>` yourself. Then refresh the backlog:
`for id in <ids>; do .venv/bin/python scripts/backlog.py add $id; done` (idempotent).

**Any `win`?** → the level is beaten (the winning game is the proof; the ladder links it). Update
`CLAUDE.md` "Current status" (highest Elo beaten) + Changelog, and next iteration uses the higher
Elo. Still continue to step 3 if there are high-priority backlog items — strength compounds.

## 3. Improve the engine (skip with `--no-improve`)
1. **Pick** the top open item: `.venv/bin/python scripts/backlog.py top` (prefer items with
   concrete test FENs; skip ones that are blocked, e.g. need NNUE training data). Mark it:
   `.venv/bin/python scripts/backlog.py set-status <Bxxx> in-progress`.
2. **Save the baseline build** before touching code:
   ```bash
   (cd engine && cargo build --release)
   V=$(grep -m1 '^version' engine/Cargo.toml | cut -d'"' -f2)
   mkdir -p engine/target/versions && cp engine/target/release/amazing-chess engine/target/versions/amazing-chess-$V
   ```
   (`engine/target/` is git-ignored; this is the "previous version" to measure against.)
3. **Implement** the change in `engine/` — small, focused, one idea per iteration. For bigger or
   competing ideas, fan out 2–3 candidate patches in parallel Agent calls with
   `isolation: "worktree"` and keep only the one that wins step 4.
4. **Verify — all must pass:**
   - Correctness: `(cd engine && cargo test --release)` including perft (start pos, Kiwipete, …).
     Any perft mismatch = reject immediately.
   - The backlog item's own test position(s): `.venv/bin/python .claude/skills/analyze-game/scripts/probe.py "<FEN>" --engine engine/target/release/amazing-chess --movetime 4000` finds the expected move.
   - Speed sanity: the engine's `bench` (if implemented) — nps must not drop > ~5% unless the change is eval-heavy by design.
   - Time safety: no move over the limit in the games below (the h2h reports crashes/illegal moves).
   - **Strength:** SPRT if `fastchess` / `cutechess-cli` is installed (command in docs/05-testing.md,
     `-engine cmd=engine/target/release/amazing-chess name=new -engine cmd=engine/target/versions/amazing-chess-$V name=prev`),
     otherwise the quick head-to-head:
     ```bash
     .venv/bin/python .claude/skills/ladder-loop/scripts/h2h.py \
       engine/target/release/amazing-chess engine/target/versions/amazing-chess-$V \
       --games 300 --movetime 100 --concurrency 6 --sprt 0,10 --pgn /tmp/h2h-$V.pgn
     ```
     `VERDICT: accept` (exit 0) = keep; `reject` = revert; `inconclusive` = revert, or re-run with
     more games only if the idea is high-value.
5. **Accept** → bump the engine version in `engine/Cargo.toml` (patch for tuning, minor for a
   feature; the UCI `id name` must report it), rebuild, note the measured result
   (`+Elo ± err, games`) in `docs/` changelog/decisions as appropriate and in `CLAUDE.md` Changelog, then
   `.venv/bin/python scripts/backlog.py set-status <Bxxx> done --note "vX.Y.Z: +12 ± 9 Elo (h2h 300 g @100ms)"`.
   **Reject** → revert only your own edits (check `git diff engine/` first; never discard
   other people's uncommitted work with a blanket `git checkout`), then
   `.venv/bin/python scripts/backlog.py set-status <Bxxx> rejected --note "h2h -4 ± 15, reverted"`
   (or back to `open` with a note if the implementation, not the idea, was at fault).

## 4. Report (≤ 10 lines)
Elo played, games and W/D/L, any level beaten (proof game id), backlog item worked on and the
verdict with numbers, engine version now, and the plan for the next iteration (same Elo / raise /
which backlog item). This is what `/loop` shows between iterations.
