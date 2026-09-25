"""Quick head-to-head between two UCI engine builds (new vs previous) with python-chess.

  .venv/bin/python .claude/skills/ladder-loop/scripts/h2h.py NEW_BINARY PREV_BINARY \
      [--games 200] [--movetime 100] [--concurrency 4] [--sprt 0,10] [--pgn out.pgn]

A cheap stand-in for fastchess/cutechess SPRT when those aren't installed. Each opening from a
small built-in balanced set is played twice with colours swapped. Stops early when the SPRT
(trinomial approximation, alpha = beta = 0.05, bounds elo0,elo1) accepts H0 or H1.
Prints W/D/L from NEW's point of view, score, Elo ± 95% error, LLR, and a verdict line:
  VERDICT: accept | reject | inconclusive
Exit code: 0 accept, 1 reject, 2 inconclusive. Never writes into games/ (these are test games,
not competition evidence).
"""
from __future__ import annotations

import argparse
import concurrent.futures as cf
import math
import sys
import threading

import chess
import chess.engine
import chess.pgn

# Balanced, varied openings (UCI from the start position): open, semi-open, closed, flank.
OPENINGS = [
    "e2e4 e7e5 g1f3 b8c6 f1b5 a7a6",          # Ruy Lopez
    "e2e4 e7e5 g1f3 b8c6 f1c4 f8c5",          # Italian
    "e2e4 c7c5 g1f3 d7d6 d2d4 c5d4 f3d4 g8f6",  # Open Sicilian
    "e2e4 c7c5 b1c3 b8c6 g2g3",               # Closed Sicilian
    "e2e4 e7e6 d2d4 d7d5 b1c3 g8f6",          # French
    "e2e4 c7c6 d2d4 d7d5 e4e5 c8f5",          # Caro-Kann advance
    "e2e4 d7d6 d2d4 g8f6 b1c3 g7g6",          # Pirc
    "d2d4 d7d5 c2c4 e7e6 b1c3 g8f6",          # QGD
    "d2d4 d7d5 c2c4 c7c6 g1f3 g8f6",          # Slav
    "d2d4 g8f6 c2c4 g7g6 b1c3 f8g7 e2e4 d7d6",  # King's Indian
    "d2d4 g8f6 c2c4 e7e6 b1c3 f8b4",          # Nimzo-Indian
    "d2d4 g8f6 c2c4 c7c5 d4d5 e7e6",          # Benoni
    "c2c4 e7e5 b1c3 g8f6 g2g3",               # English
    "g1f3 d7d5 g2g3 g8f6 f1g2 c7c6",          # Réti
    "d2d4 f7f5 g2g3 g8f6 f1g2 e7e6",          # Dutch
    "e2e4 e7e5 f2f4 e5f4 g1f3",               # King's Gambit
]


def play_game(new: str, prev: str, opening: str, new_white: bool, movetime: float, max_plies: int):
    board = chess.Board()
    for uci in opening.split():
        board.push_uci(uci)
    engines = {}
    try:
        engines[True] = chess.engine.SimpleEngine.popen_uci(new if new_white else prev)
        engines[False] = chess.engine.SimpleEngine.popen_uci(prev if new_white else new)
        while not board.is_game_over(claim_draw=True) and board.ply() < max_plies:
            result = engines[board.turn].play(board, chess.engine.Limit(time=movetime))
            if result.move is None or result.move not in board.legal_moves:
                # illegal / no move = loss for the side to move
                return (0.0 if board.turn == new_white else 1.0), board, "illegal-move"
            board.push(result.move)
    except (chess.engine.EngineError, chess.engine.EngineTerminatedError) as exc:
        side_new = board.turn == new_white
        return (0.0 if side_new else 1.0), board, f"crash: {exc}"
    finally:
        for e in engines.values():
            try:
                e.quit()
            except Exception:  # noqa: BLE001
                pass
    if board.ply() >= max_plies and not board.is_game_over(claim_draw=True):
        return 0.5, board, "adjudicated-draw (max plies)"
    outcome = board.outcome(claim_draw=True)
    if outcome.winner is None:
        return 0.5, board, outcome.termination.name.lower()
    return (1.0 if outcome.winner == new_white else 0.0), board, outcome.termination.name.lower()


def elo_from_score(s: float) -> float:
    s = min(max(s, 1e-6), 1 - 1e-6)
    return -400 * math.log10(1 / s - 1)


def llr(w: int, d: int, l: int, elo0: float, elo1: float) -> float:
    """Trinomial GSPRT approximation (as used by fishtest / cutechess)."""
    n = w + d + l
    if n == 0 or w == 0 or l == 0:
        return 0.0
    s = (w + d / 2) / n
    var = (w * (1 - s) ** 2 + d * (0.5 - s) ** 2 + l * (0 - s) ** 2) / n
    if var <= 0:
        return 0.0
    s0 = 1 / (1 + 10 ** (-elo0 / 400))
    s1 = 1 / (1 + 10 ** (-elo1 / 400))
    return (s1 - s0) * (2 * s - s0 - s1) / (2 * var / n)


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("new")
    p.add_argument("prev")
    p.add_argument("--games", type=int, default=200, help="maximum games (rounded up to pairs)")
    p.add_argument("--movetime", type=int, default=100, help="ms per move")
    p.add_argument("--concurrency", type=int, default=4)
    p.add_argument("--max-plies", type=int, default=300)
    p.add_argument("--sprt", default="0,10", help="elo0,elo1 (default 0,10)")
    p.add_argument("--pgn", help="write the test games to this PGN file (never into games/)")
    args = p.parse_args()
    elo0, elo1 = (float(x) for x in args.sprt.split(","))
    lower, upper = math.log(0.05 / 0.95), math.log(0.95 / 0.05)

    jobs = []
    for i in range((args.games + 1) // 2):
        op = OPENINGS[i % len(OPENINGS)]
        jobs += [(op, True), (op, False)]

    w = d = l = 0
    lock = threading.Lock()
    stop = threading.Event()
    pgn_out = open(args.pgn, "w") if args.pgn else None
    verdict = "inconclusive"

    def run(job):
        if stop.is_set():
            return None
        return job, play_game(args.new, args.prev, job[0], job[1], args.movetime / 1000, args.max_plies)

    with cf.ThreadPoolExecutor(max_workers=args.concurrency) as pool:
        futures = [pool.submit(run, j) for j in jobs]
        for fut in cf.as_completed(futures):
            res = fut.result()
            if res is None:
                continue
            (op, new_white), (score, board, why) = res
            with lock:
                if score == 1.0:
                    w += 1
                elif score == 0.0:
                    l += 1
                else:
                    d += 1
                if why.startswith(("crash", "illegal")):
                    print(f"! game ({'new' if new_white else 'prev'} white, {op}): {why}", file=sys.stderr)
                if pgn_out:
                    game = chess.pgn.Game.from_board(board)
                    game.headers.update({"Event": "h2h new vs prev", "White": "new" if new_white else "prev",
                                         "Black": "prev" if new_white else "new", "Termination": why})
                    print(game, file=pgn_out, end="\n\n")
                ratio = llr(w, d, l, elo0, elo1)
                n = w + d + l
                if n % 10 == 0:
                    print(f"  {n} games: +{w} ={d} -{l}  LLR {ratio:+.2f} [{lower:.2f}, {upper:.2f}]", file=sys.stderr)
                if ratio >= upper:
                    verdict = "accept"
                    stop.set()
                elif ratio <= lower:
                    verdict = "reject"
                    stop.set()
    if pgn_out:
        pgn_out.close()

    n = w + d + l
    s = (w + d / 2) / n if n else 0.5
    var = ((w * (1 - s) ** 2 + d * (0.5 - s) ** 2 + l * s ** 2) / n) if n else 0
    se = math.sqrt(var / n) if n else 0
    elo = elo_from_score(s)
    err = (elo_from_score(min(s + 1.96 * se, 1 - 1e-6)) - elo_from_score(max(s - 1.96 * se, 1e-6))) / 2 if n else 0
    print(f"new vs prev @ {args.movetime} ms/move: {n} games  +{w} ={d} -{l}  score {s:.3f}  "
          f"Elo {elo:+.1f} ± {err:.1f}  LLR {llr(w, d, l, elo0, elo1):+.2f} (SPRT [{elo0:g}, {elo1:g}])")
    if verdict == "inconclusive" and n and elo - err > 0:
        verdict = "accept"  # ran out of games but clearly positive at 95%
    print(f"VERDICT: {verdict}")
    return {"accept": 0, "reject": 1}.get(verdict, 2)


if __name__ == "__main__":
    sys.exit(main())
