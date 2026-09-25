"""Probe a position with a UCI engine (full-strength Stockfish by default, or our engine build).

  .venv/bin/python .claude/skills/analyze-game/scripts/probe.py "<FEN>" [--depth 20 | --movetime 2000]
        [--multipv 3] [--engine /opt/homebrew/bin/stockfish] [--moves e2e4 e7e5 ...]

Prints one line per PV: rank, score (side to move's view, and White's view), depth, nodes, SAN PV.
Use --engine engine/target/release/<binary> to see what OUR engine finds (use --movetime, ≤ 5000).
(Don't pipe commands into stockfish directly: it quits at EOF and aborts the search.)
"""
from __future__ import annotations

import argparse
import os
import shutil
import sys

import chess
import chess.engine


def fmt(score: chess.engine.Score) -> str:
    if score.is_mate():
        return f"M{score.mate()}"
    return f"{score.score() / 100:+.2f}"


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("fen")
    p.add_argument("--moves", nargs="*", default=[], help="UCI moves to play from the FEN first")
    p.add_argument("--depth", type=int)
    p.add_argument("--movetime", type=int, help="milliseconds")
    p.add_argument("--multipv", type=int, default=1)
    p.add_argument("--engine", default=os.environ.get("STOCKFISH_PATH") or shutil.which("stockfish")
                   or "/opt/homebrew/bin/stockfish")
    p.add_argument("--threads", type=int, default=2)
    args = p.parse_args()

    board = chess.Board(args.fen)
    for uci in args.moves:
        board.push_uci(uci)
    limit = chess.engine.Limit(depth=args.depth, time=args.movetime / 1000 if args.movetime else None)
    if limit.depth is None and limit.time is None:
        limit = chess.engine.Limit(depth=20)
    with chess.engine.SimpleEngine.popen_uci(args.engine) as eng:
        with_opts = {k: v for k, v in {"Threads": args.threads}.items() if k in eng.options}
        eng.configure(with_opts)
        infos = eng.analyse(board, limit, multipv=args.multipv)
        name = eng.id.get("name", args.engine)
    print(f"{name} · {board.fen()} · {'white' if board.turn else 'black'} to move")
    for i, info in enumerate(infos if isinstance(infos, list) else [infos], 1):
        pv = info.get("pv") or []
        san = board.variation_san(pv[:12]) if pv else "(no pv)"
        score = info.get("score")
        print(f"{i}. {fmt(score.relative) if score else '?'} (white {fmt(score.white()) if score else '?'}) "
              f"depth {info.get('depth')} nodes {info.get('nodes')} :: {san}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
