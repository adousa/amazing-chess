#!/usr/bin/env python3
"""Timing check: send `go movetime N` on varied positions and measure the wall
time from sending `go` to receiving `bestmove`. Fails if any exceeds N ms.

  .venv/bin/python engine/scripts/timing_check.py --movetime 5000
"""
import argparse
import os
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_ENGINE = os.path.join(HERE, "..", "target", "release", "amazing-chess")

POSITIONS = [
    ("startpos", "startpos"),
    ("kiwipete", "fen r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1"),
    ("middlegame", "fen r1bq1rk1/pp2bppp/2n2n2/3p4/3P4/2NB1N2/PP3PPP/R1BQ1RK1 w - - 0 10"),
    ("sharp tactics", "fen r1b1kb1r/pppp1ppp/5q2/4n3/3KP3/2N3PN/PPP4P/R1BQ1B1R b kq - 0 1"),
    ("rook endgame", "fen 8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1"),
    ("pawn endgame (Fine 70)", "fen 8/k7/3p4/p2P1p2/P2P1P2/8/8/K7 w - - 0 1"),
    ("KQ vs K", "fen 8/8/8/4k3/8/8/8/KQ6 w - - 0 1"),
    ("one legal move", "fen 7k/8/8/8/8/8/6q1/7K w - - 0 1"),
    ("mate in 1 available", "fen 6k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1"),
    ("promotion race", "fen 8/P7/8/8/8/8/p7/K6k w - - 0 1"),
    ("after moves", "startpos moves e2e4 e7e5 g1f3 b8c6 f1b5 a7a6 b5a4 g8f6 e1g1 f8e7"),
]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--engine", default=DEFAULT_ENGINE)
    ap.add_argument("--movetime", type=int, default=5000)
    ap.add_argument("--threads", type=int, default=1)
    args = ap.parse_args()

    p = subprocess.Popen([args.engine], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, bufsize=1)

    def send(cmd):
        p.stdin.write(cmd + "\n")
        p.stdin.flush()

    def wait_for(prefix):
        while True:
            line = p.stdout.readline()
            if not line:
                raise RuntimeError("engine exited")
            if line.startswith(prefix):
                return line.strip()

    send("uci")
    wait_for("uciok")
    send(f"setoption name Threads value {args.threads}")
    worst = 0.0
    for name, pos in POSITIONS:
        send("ucinewgame")
        send("position " + pos)
        send("isready")
        wait_for("readyok")
        t0 = time.perf_counter()
        send(f"go movetime {args.movetime}")
        best = wait_for("bestmove")
        ms = (time.perf_counter() - t0) * 1000
        worst = max(worst, ms)
        flag = "OK " if ms < args.movetime else "OVER"
        print(f"{flag} {ms:7.1f} ms  {name:24s} {best}", flush=True)
    send("quit")
    p.wait(timeout=5)
    print(f"\nmax wall time go->bestmove: {worst:.1f} ms (limit {args.movetime} ms)")
    return 0 if worst < args.movetime else 1


if __name__ == "__main__":
    sys.exit(main())
