"""A tiny UCI placeholder player (2-ply material search) for tests and as a stand-in while the
real engine (engine/target/release/amazing-chess) is not built.

    python -m amazing.placeholder_engine [--depth 2] [--sleep-ms N] [--illegal] [--crash-after N]
                                         [--hang] [--version X]

Test knobs: `--sleep-ms` ignores `movetime` and sleeps (a slow engine), `--illegal` answers with
an illegal move, `--crash-after N` exits after N `go` commands, `--hang` never answers `go`.
"""
from __future__ import annotations

import argparse
import random
import sys
import time
from typing import List, Optional, Tuple

import chess

VALUES = {chess.PAWN: 100, chess.KNIGHT: 320, chess.BISHOP: 330, chess.ROOK: 500, chess.QUEEN: 900, chess.KING: 0}
MATE = 100000


def evaluate(board: chess.Board) -> int:
    """Material + a pinch of centralisation, from the side to move's point of view."""
    score = 0
    for sq, piece in board.piece_map().items():
        v = VALUES[piece.piece_type]
        if piece.piece_type in (chess.KNIGHT, chess.BISHOP, chess.PAWN):
            f, r = chess.square_file(sq), chess.square_rank(sq)
            v += 6 - int(abs(3.5 - f) + abs(3.5 - r))
        score += v if piece.color == board.turn else -v
    return score


def ordered(board: chess.Board) -> List[chess.Move]:
    moves = list(board.legal_moves)
    random.shuffle(moves)
    moves.sort(key=lambda m: (not board.is_capture(m), not m.promotion))
    return moves


class Searcher:
    def __init__(self) -> None:
        self.nodes = 0

    def negamax(self, board: chess.Board, depth: int, alpha: int, beta: int, ply: int) -> int:
        self.nodes += 1
        if board.is_checkmate():
            return -MATE + ply
        if board.is_stalemate() or board.is_insufficient_material() or board.is_repetition(2):
            return 0
        if depth == 0:
            return evaluate(board)
        best = -MATE * 2
        for move in ordered(board):
            board.push(move)
            score = -self.negamax(board, depth - 1, -beta, -alpha, ply + 1)
            board.pop()
            if score > best:
                best = score
            if best > alpha:
                alpha = best
            if alpha >= beta:
                break
        return best

    def search(self, board: chess.Board, depth: int) -> Tuple[Optional[chess.Move], int]:
        best_move, best = None, -MATE * 2
        alpha, beta = -MATE * 2, MATE * 2
        for move in ordered(board):
            board.push(move)
            score = -self.negamax(board, depth - 1, -beta, -alpha, 1)
            board.pop()
            if score > best:
                best, best_move = score, move
            alpha = max(alpha, best)
        return best_move, best


def main(argv: Optional[List[str]] = None) -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--depth", type=int, default=2)
    ap.add_argument("--sleep-ms", type=int, default=0)
    ap.add_argument("--illegal", action="store_true")
    ap.add_argument("--crash-after", type=int, default=-1)
    ap.add_argument("--hang", action="store_true")
    ap.add_argument("--version", default="0.0.0-placeholder")
    args = ap.parse_args(argv)

    board = chess.Board()
    gos = 0

    def out(line: str) -> None:
        sys.stdout.write(line + "\n")
        sys.stdout.flush()

    for raw in sys.stdin:
        line = raw.strip()
        if not line:
            continue
        cmd = line.split()[0]
        if cmd == "uci":
            out(f"id name AmazingChess {args.version}")
            out("id author Amazing Chess team (placeholder)")
            out("option name Hash type spin default 16 min 1 max 1024")
            out("uciok")
        elif cmd == "isready":
            out("readyok")
        elif cmd == "ucinewgame":
            board = chess.Board()
        elif cmd == "position":
            tokens = line.split()
            if len(tokens) > 1 and tokens[1] == "startpos":
                board = chess.Board()
                rest = tokens[2:]
            elif len(tokens) > 1 and tokens[1] == "fen":
                fen_parts = []
                rest = []
                for j, t in enumerate(tokens[2:]):
                    if t == "moves":
                        rest = tokens[2 + j:]
                        break
                    fen_parts.append(t)
                board = chess.Board(" ".join(fen_parts))
            else:
                continue
            if rest and rest[0] == "moves":
                for mv in rest[1:]:
                    board.push_uci(mv)
        elif cmd == "go":
            gos += 1
            if args.crash_after >= 0 and gos > args.crash_after:
                sys.exit(3)
            if args.hang:
                continue
            t0 = time.monotonic()
            if args.illegal:
                out("bestmove a1a1")
                continue
            searcher = Searcher()
            move, score = searcher.search(board, max(1, args.depth))
            if args.sleep_ms:
                time.sleep(args.sleep_ms / 1000.0)
            ms = max(1, int((time.monotonic() - t0) * 1000))
            if move is None:
                out("bestmove 0000")
                continue
            if abs(score) >= MATE - 100:
                plies = MATE - abs(score)
                mate = (plies + 1) // 2 if score > 0 else -((plies + 1) // 2)
                score_str = f"mate {mate}"
            else:
                score_str = f"cp {score}"
            out(f"info depth {args.depth} score {score_str} nodes {searcher.nodes} "
                f"nps {searcher.nodes * 1000 // ms} time {ms} pv {move.uci()}")
            out(f"bestmove {move.uci()}")
        elif cmd == "quit":
            break
        # stop / setoption / others: ignored (we answer go synchronously)


if __name__ == "__main__":
    main()
