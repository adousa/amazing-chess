"""Fallback engine analysis for /analyze-game when the backend CLI (`python -m amazing analyze`)
is not available. Runs a local full-strength Stockfish over every ply with python-chess and writes
the engine part of games/<id>/analysis.json (contract `Analysis`).

  .venv/bin/python .claude/skills/analyze-game/scripts/engine_analysis.py <matchId> [--depth 18]
        [--stockfish /opt/homebrew/bin/stockfish] [--threads 4] [--hash 256]

* Reads match.json (never writes it or game.pgn).
* Keeps any existing agent reports; archives a previous analysis.json with moves to
  analysis-history/ (FR-5.6). Writes atomically.
* Classification follows docs/06-analysis-and-agents.md (cp loss vs best move, mover's view).
  "book" / "brilliant" are not assigned by this fallback.

Environment: AC_GAMES_DIR (default <repo>/games), STOCKFISH_PATH.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import math
import os
import pathlib
import shutil
import sys

import chess
import chess.engine

ROOT = pathlib.Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT / "scripts"))
import save_agent_report as sar  # noqa: E402  (contract validation, atomic write, lock, archive)

MATE = 10_000


def classify(cp_loss: int, missed_or_allowed_mate: bool) -> str:
    if missed_or_allowed_mate or cp_loss > 250:
        return "blunder"
    if cp_loss > 100:
        return "mistake"
    if cp_loss > 50:
        return "inaccuracy"
    if cp_loss > 25:
        return "good"
    if cp_loss > 10:
        return "excellent"
    return "best"


def win_pct(cp: int) -> float:
    return 50 + 50 * (2 / (1 + math.exp(-0.00368208 * cp)) - 1)


def move_accuracy(before_cp: int, after_cp: int) -> float:
    """Lichess-style accuracy from the mover's win% drop."""
    drop = max(0.0, win_pct(before_cp) - win_pct(after_cp))
    return max(0.0, min(100.0, 103.1668 * math.exp(-0.04354 * drop) - 3.1669))


def analyse(match: dict, sf_path: str, depth: int, threads: int, hash_mb: int) -> dict:
    board = chess.Board(match.get("startFen") or chess.STARTING_FEN)
    moves = match["moves"]
    infos = []  # one per position: before ply 1, after ply 1, ...
    with chess.engine.SimpleEngine.popen_uci(sf_path) as sf:
        sf.configure({"Threads": threads, "Hash": hash_mb})
        name = sf.id.get("name", "Stockfish")

        def info_for(b: chess.Board) -> dict:
            if b.is_game_over(claim_draw=True):
                if b.is_checkmate():
                    return {"score": chess.engine.PovScore(chess.engine.Mate(0), b.turn), "pv": []}
                return {"score": chess.engine.PovScore(chess.engine.Cp(0), b.turn), "pv": []}
            return sf.analyse(b, chess.engine.Limit(depth=depth))

        infos.append(info_for(board))
        for m in moves:
            board.push_uci(m["uci"])
            infos.append(info_for(board))

    board = chess.Board(match.get("startFen") or chess.STARTING_FEN)
    out, acc = [], {"engine": [], "stockfish": []}
    for i, m in enumerate(moves):
        mover = board.turn
        before, after = infos[i]["score"], infos[i + 1]["score"]
        best_pv = infos[i].get("pv") or []
        b_cp = before.pov(mover).score(mate_score=MATE)
        a_cp = after.pov(mover).score(mate_score=MATE)
        cp_loss = max(0, min(2000, b_cp - a_cp))
        white = after.white()
        mate_after = white.mate()
        # allowed a forced mate against us, or had a forced mate and let it go
        mate_blunder = (after.pov(mover).is_mate() and after.pov(mover).mate() < 0
                        and not (before.pov(mover).is_mate() and before.pov(mover).mate() < 0)) or \
                       (before.pov(mover).is_mate() and before.pov(mover).mate() > 0
                        and not after.pov(mover).is_mate() and cp_loss > 250)
        entry = {
            "ply": m["ply"],
            "evalCp": None if white.is_mate() else white.score(),
            "mateIn": mate_after if white.is_mate() else None,
            "cpLoss": int(cp_loss),
            "classification": classify(cp_loss, mate_blunder),
        }
        if best_pv:
            entry["bestMoveUci"] = best_pv[0].uci()
            entry["bestMoveSan"] = board.san(best_pv[0])
        out.append(entry)
        acc[m.get("by", "engine")].append(move_accuracy(max(-MATE, min(MATE, b_cp)), max(-MATE, min(MATE, a_cp))))
        board.push_uci(m["uci"])

    outcome = match.get("outcome")
    loser = {"win": "stockfish", "loss": "engine"}.get(outcome)
    candidates = [e for e, m in zip(out, moves) if loser is None or m.get("by") == loser]
    worst = max(candidates, key=lambda e: e["cpLoss"], default=None)
    summary = {
        "engineAccuracy": round(sum(acc["engine"]) / len(acc["engine"]), 1) if acc["engine"] else 0.0,
        "stockfishAccuracy": round(sum(acc["stockfish"]) / len(acc["stockfish"]), 1) if acc["stockfish"] else 0.0,
        "decisivePly": worst["ply"] if worst and worst["cpLoss"] >= 100 else None,
    }
    return {"analyzer": {"engine": name, "depth": depth}, "moves": out, "summary": summary}


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("match_id")
    p.add_argument("--depth", type=int, default=18)
    p.add_argument("--stockfish", default=os.environ.get("STOCKFISH_PATH") or shutil.which("stockfish")
                   or "/opt/homebrew/bin/stockfish")
    p.add_argument("--threads", type=int, default=max(1, (os.cpu_count() or 2) // 2))
    p.add_argument("--hash", type=int, default=256)
    args = p.parse_args()

    match_dir = sar.games_dir() / args.match_id
    match = json.loads((match_dir / "match.json").read_text())  # read-only
    engine_part = analyse(match, args.stockfish, args.depth, args.threads, args.hash)

    analysis_path = match_dir / "analysis.json"
    with sar.locked(match_dir):
        analysis = json.loads(analysis_path.read_text()) if analysis_path.exists() else {}
        if analysis.get("moves"):
            print(f"archived previous analysis -> {sar.archive(match_dir, analysis_path)}", file=sys.stderr)
        reports = analysis.get("reports") or {}
        for agent, key in sar.AGENTS.items():
            reports.setdefault(key, {"agent": agent, "status": "pending"})
        new = {
            "matchId": args.match_id,
            "status": "ready",
            **engine_part,
            "reports": reports,
            "createdAt": dt.datetime.now(dt.timezone.utc).replace(microsecond=0).strftime("%Y-%m-%dT%H:%M:%SZ"),
        }
        if (analysis.get("summary") or {}).get("opening"):
            new["summary"]["opening"] = analysis["summary"]["opening"]
        new["status"] = sar.top_level_status(new)
        errors = sar.contract_errors(new, "Analysis")
        if errors:
            print("✗ analysis violates the contract:\n  " + "\n  ".join(errors), file=sys.stderr)
            return 1
        sar.atomic_write_json(analysis_path, new)
    s = new["summary"]
    print(f"✓ engine analysis written to {analysis_path}: {len(new['moves'])} plies, accuracy ours "
          f"{s['engineAccuracy']} / Stockfish {s['stockfishAccuracy']}, decisive ply {s['decisivePly']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
