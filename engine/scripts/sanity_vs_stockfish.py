#!/usr/bin/env python3
"""Strength sanity check: our engine vs Elo-limited Stockfish.

Plays N games (alternating colours, short movetime for both sides) in parallel
processes and prints W/D/L from our engine's point of view.

  .venv/bin/python engine/scripts/sanity_vs_stockfish.py --elo 1320 --games 10 --movetime 200

This is a developer sanity tool, NOT the competition match runner (that lives in
backend/ and uses 5 s/move). PGNs are written to --pgn-dir (default /tmp).
"""
import argparse
import datetime
import os
import random
import sys
from concurrent.futures import ProcessPoolExecutor, as_completed

import chess
import chess.engine
import chess.pgn

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_ENGINE = os.path.join(HERE, "..", "target", "release", "amazing-chess")

# Short, sound opening lines for variety (UCI moves).
OPENINGS = [
    "",
    "e2e4 e7e5",
    "d2d4 d7d5",
    "e2e4 c7c5",
    "d2d4 g8f6 c2c4 e7e6",
    "e2e4 e7e6 d2d4 d7d5",
    "c2c4 e7e5",
    "g1f3 d7d5 g2g3",
    "e2e4 c7c6 d2d4 d7d5",
    "d2d4 d7d5 c2c4 c7c6",
    "e2e4 e7e5 g1f3 b8c6 f1b5",
    "e2e4 e7e5 g1f3 b8c6 f1c4",
]


def play_game(idx, args):
    ours_white = idx % 2 == 0
    opening = OPENINGS[(idx // 2) % len(OPENINGS)].split()
    board = chess.Board()
    for mv in opening:
        board.push_uci(mv)
    ours = chess.engine.SimpleEngine.popen_uci(args.engine)
    sf = chess.engine.SimpleEngine.popen_uci(args.stockfish)
    try:
        ours.configure({"Hash": args.hash, "Threads": args.threads})
        sf.configure({"UCI_LimitStrength": True, "UCI_Elo": args.elo, "Threads": 1, "Hash": 16})
        limit = chess.engine.Limit(time=args.movetime / 1000.0)
        max_ms = 0.0
        while not board.is_game_over(claim_draw=True):
            our_turn = (board.turn == chess.WHITE) == ours_white
            eng = ours if our_turn else sf
            t0 = datetime.datetime.now()
            res = eng.play(board, limit)
            dt = (datetime.datetime.now() - t0).total_seconds() * 1000
            if our_turn:
                max_ms = max(max_ms, dt)
            if res.move is None or res.move not in board.legal_moves:
                raise RuntimeError(f"illegal/null move from {'ours' if our_turn else 'sf'}: {res.move} in {board.fen()}")
            board.push(res.move)
        outcome = board.outcome(claim_draw=True)
        if outcome.winner is None:
            result = "draw"
        elif (outcome.winner == chess.WHITE) == ours_white:
            result = "win"
        else:
            result = "loss"
        game = chess.pgn.Game.from_board(board)
        game.headers["Event"] = f"sanity vs Stockfish UCI_Elo={args.elo}"
        game.headers["White"] = "AmazingChess" if ours_white else f"Stockfish-{args.elo}"
        game.headers["Black"] = f"Stockfish-{args.elo}" if ours_white else "AmazingChess"
        game.headers["Termination"] = outcome.termination.name
        os.makedirs(args.pgn_dir, exist_ok=True)
        with open(os.path.join(args.pgn_dir, f"sanity_{args.elo}_{idx:03d}.pgn"), "w") as f:
            print(game, file=f)
        return idx, result, ours_white, len(board.move_stack), outcome.termination.name, max_ms
    finally:
        ours.quit()
        sf.quit()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--engine", default=DEFAULT_ENGINE)
    ap.add_argument("--stockfish", default="/opt/homebrew/bin/stockfish")
    ap.add_argument("--elo", type=int, default=1320)
    ap.add_argument("--games", type=int, default=10)
    ap.add_argument("--movetime", type=int, default=200, help="ms per move for both sides")
    ap.add_argument("--concurrency", type=int, default=max(1, (os.cpu_count() or 2) // 2 - 1))
    ap.add_argument("--hash", type=int, default=32)
    ap.add_argument("--threads", type=int, default=1)
    ap.add_argument("--pgn-dir", default="/tmp/amazing-chess-sanity")
    args = ap.parse_args()

    w = d = l = 0
    with ProcessPoolExecutor(max_workers=args.concurrency) as ex:
        futs = [ex.submit(play_game, i, args) for i in range(args.games)]
        for fut in as_completed(futs):
            idx, result, white, plies, term, max_ms = fut.result()
            w += result == "win"
            d += result == "draw"
            l += result == "loss"
            print(f"game {idx:3d} ours={'W' if white else 'B'} {result:4s} plies={plies:3d} "
                  f"{term:22s} max_think={max_ms:.0f}ms", flush=True)
    print(f"\nElo {args.elo} @ {args.movetime}ms: W {w}  D {d}  L {l}  (score {(w + d / 2) / max(1, w + d + l):.2f})")
    return 0 if l == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
