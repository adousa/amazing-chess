"""Helpers for the /analyze-game skill (read-only on the game store).

  python .claude/skills/analyze-game/scripts/briefing.py resolve <matchId|latest>
      -> prints the match id (latest = most recently finished game with a match.json)
  python .claude/skills/analyze-game/scripts/briefing.py status <matchId>
      -> prints "engine=<ready|missing|...> gmCoach=<status> engineDev=<status> overall=<status>";
         exit 0 if the engine part of analysis.json is ready, 3 otherwise
  python .claude/skills/analyze-game/scripts/briefing.py build <matchId> [--out FILE]
      -> writes a compact Markdown briefing for the gm-coach / engine-dev sub-agents
         (default: $TMPDIR/amazing-chess/<matchId>/briefing.md) and prints its path

Environment: AC_GAMES_DIR (default <repo>/games).
"""
from __future__ import annotations

import argparse
import json
import os
import pathlib
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[4]
CRITICAL = {"inaccuracy", "mistake", "blunder"}


def games_dir() -> pathlib.Path:
    return pathlib.Path(os.environ.get("AC_GAMES_DIR") or ROOT / "games")


def work_dir(match_id: str) -> pathlib.Path:
    d = pathlib.Path(tempfile.gettempdir()) / "amazing-chess" / match_id
    d.mkdir(parents=True, exist_ok=True)
    return d


def load_json(path: pathlib.Path):
    return json.loads(path.read_text()) if path.exists() else None


def resolve(ref: str) -> str:
    gd = games_dir()
    if ref != "latest":
        if not (gd / ref / "match.json").exists():
            sys.exit(f"✗ no game {ref} in {gd}")
        return ref
    best = None
    for mj in gd.glob("*/match.json"):
        try:
            m = json.loads(mj.read_text())
        except json.JSONDecodeError:
            continue
        if m.get("status") not in ("finished", "aborted", "error"):
            continue
        key = (m.get("finishedAt") or m.get("createdAt") or "", mj.stat().st_mtime)
        if best is None or key > best[0]:
            best = (key, mj.parent.name)
    if best is None:
        sys.exit(f"✗ no finished games in {gd}")
    return best[1]


def status(match_id: str) -> int:
    a = load_json(games_dir() / match_id / "analysis.json") or {}
    engine = "ready" if a.get("moves") else ("missing" if not a else a.get("status", "missing"))
    reps = a.get("reports") or {}
    parts = [f"engine={engine}"] + [f"{k}={(reps.get(k) or {}).get('status', 'missing')}"
                                    for k in ("gmCoach", "engineDev")]
    print(" ".join(parts + [f"overall={a.get('status', 'missing')}"]))
    return 0 if engine == "ready" else 3


def pov(cp, color: str):
    """White-POV centipawns -> our engine's POV."""
    if cp is None:
        return None
    return cp if color == "white" else -cp


def fmt_eval(cp, mate) -> str:
    if mate is not None:
        return f"M{mate}" if mate >= 0 else f"-M{-mate}"
    if cp is None:
        return "?"
    return f"{cp / 100:+.2f}"


def build(match_id: str, out: pathlib.Path | None) -> pathlib.Path:
    gd = games_dir() / match_id
    match = load_json(gd / "match.json")
    if match is None:
        sys.exit(f"✗ {gd / 'match.json'} not found")
    analysis = load_json(gd / "analysis.json") or {}
    pgn = (gd / "game.pgn").read_text().strip() if (gd / "game.pgn").exists() else "(no PGN)"
    color = match.get("engineColor") or match.get("engine", {}).get("color")
    by_ply = {m["ply"]: m for m in analysis.get("moves") or []}
    moves = match.get("moves") or []
    sf = match.get("stockfish") or {}
    eng = match.get("engine") or {}

    ours = [m for m in moves if m.get("by") == "engine"]
    theirs = [m for m in moves if m.get("by") == "stockfish"]

    def time_stats(ms):
        t = [m.get("timeMs", 0) for m in ms]
        if not t:
            return "n/a"
        return (f"total {sum(t) / 1000:.1f}s, avg {sum(t) / len(t) / 1000:.2f}s, max {max(t) / 1000:.2f}s, "
                f"{sum(1 for x in t if x >= 4500)} move(s) >= 4.5s")

    depths = [m["thinking"]["depth"] for m in ours if (m.get("thinking") or {}).get("depth")]
    lines = [
        f"# Briefing — {match_id}",
        "",
        "Read-only evidence. All evals are in **pawns from OUR ENGINE's point of view** unless marked",
        "(SF = full-strength Stockfish analysis after the move; Ours = the score our engine reported for",
        "the move it played, i.e. what it expected after its PV). cpLoss is from the mover's view.",
        "",
        "## Game",
        f"- Our engine: **{eng.get('name', 'AmazingChess')} {match.get('engineVersion')}** playing **{color}**"
        f" (movetime {eng.get('moveTimeMs')} ms, options {json.dumps(eng.get('options') or {})})",
        f"- Opponent: **{sf.get('version', 'Stockfish')}**, UCI_LimitStrength={sf.get('limitStrength')}, "
        f"**UCI_Elo {match.get('stockfishElo')}**, movetime {sf.get('moveTimeMs')} ms, "
        f"threads {sf.get('threads')}, hash {sf.get('hashMb')} MB",
        f"- Result: **{match.get('result')}** → outcome for us: **{match.get('outcome')}** "
        f"(termination: {match.get('termination')}), {match.get('plyCount', len(moves))} plies",
        f"- Start FEN: `{match.get('startFen')}`",
        f"- Time used — ours: {time_stats(ours)}; Stockfish: {time_stats(theirs)}",
        f"- Our search depth: {('min %d / avg %.1f / max %d' % (min(depths), sum(depths) / len(depths), max(depths))) if depths else 'no thinking data'}",
    ]
    summ = analysis.get("summary") or {}
    if summ or analysis.get("analyzer"):
        lines.append(f"- Analysis ({(analysis.get('analyzer') or {}).get('engine', '?')}, depth "
                     f"{(analysis.get('analyzer') or {}).get('depth', '?')}): accuracy ours "
                     f"{summ.get('engineAccuracy', '?')} / Stockfish {summ.get('stockfishAccuracy', '?')}, "
                     f"decisive ply {summ.get('decisivePly')}, opening {summ.get('opening', '?')}")
    if not by_ply:
        lines.append("- ⚠️ No engine analysis (per-ply evals) available — reason from the moves and thinking data.")
    lines += ["", "## PGN", "```pgn", pgn, "```", "", "## Moves",
              "| Ply | # | Side | Move | Time s | Ours: depth/sel · nodes · score · PV | SF eval | SF best | cpLoss | Class |",
              "|---|---|---|---|---|---|---|---|---|---|"]
    for m in moves:
        a = by_ply.get(m["ply"], {})
        th = m.get("thinking") or {}
        if th:
            nodes = th.get("nodes")
            nodes_s = f"{nodes / 1e6:.1f}M" if isinstance(nodes, int) and nodes >= 1e5 else str(nodes)
            ours_s = (f"d{th.get('depth')}/{th.get('seldepth')} · {nodes_s} · "
                      f"{fmt_eval(th.get('scoreCp'), th.get('mateIn'))} · {' '.join((th.get('pv') or [])[:6])}")
        else:
            ours_s = ""
        mate = a.get("mateIn")
        sf_eval = fmt_eval(pov(a.get("evalCp"), color), pov(mate, color)) if a else ""
        side = "**us**" if m.get("by") == "engine" else "SF"
        num = f"{(m['ply'] + 1) // 2}{'.' if m['color'] == 'white' else '...'}"
        lines.append(f"| {m['ply']} | {num} | {side} | {m['san']} | {m.get('timeMs', 0) / 1000:.2f} | {ours_s} | "
                     f"{sf_eval} | {a.get('bestMoveSan', '')} | {a.get('cpLoss', '')} | {a.get('classification', '')} |")

    crit = [m for m in moves if by_ply.get(m["ply"], {}).get("classification") in CRITICAL]
    if crit:
        lines += ["", "## Critical positions (FEN before the move — verify with Stockfish)"]
        fen_before = {1: match.get("startFen")}
        for m in moves:
            fen_before[m["ply"] + 1] = m["fenAfter"]
        for m in crit:
            a = by_ply[m["ply"]]
            who = "us" if m.get("by") == "engine" else "Stockfish"
            lines.append(f"- ply {m['ply']} ({who}) played **{m['san']}** — {a['classification']}, cpLoss "
                         f"{a.get('cpLoss')}, best {a.get('bestMoveSan', '?')}: `{fen_before.get(m['ply'])}`")

    try:
        titles = subprocess.run([sys.executable, str(ROOT / "scripts" / "backlog.py"), "titles", "--limit", "40"],
                                capture_output=True, text=True, timeout=30).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        titles = ""
    lines += ["", "## Existing backlog (reuse the EXACT title to upvote instead of creating a near-duplicate)",
              titles or "(backlog empty)", ""]
    if out is None:
        out = work_dir(match_id) / "briefing.md"
        for stale in ("gm-coach.json", "engine-dev.json"):  # never save a previous run's report
            (out.parent / stale).unlink(missing_ok=True)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text("\n".join(lines))
    return out


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("resolve").add_argument("ref")
    sub.add_parser("status").add_argument("match_id")
    b = sub.add_parser("build")
    b.add_argument("match_id")
    b.add_argument("--out", type=pathlib.Path)
    args = p.parse_args()
    if args.cmd == "resolve":
        print(resolve(args.ref))
        return 0
    if args.cmd == "status":
        return status(args.match_id)
    print(build(args.match_id, args.out))
    return 0


if __name__ == "__main__":
    sys.exit(main())
