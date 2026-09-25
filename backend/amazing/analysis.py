"""Post-game engine analysis with full-strength Stockfish -> contract `Analysis`.

Per ply: eval after the move (White's POV), best move in the position before it, cp loss for
the mover and a classification (docs/06-analysis-and-agents.md). Summary: accuracy per side
(lichess formula), decisive ply and opening.
"""
from __future__ import annotations

import math
import statistics
from typing import Any, Dict, List, Optional, Tuple

import chess
import chess.engine

from amazing.config import Settings
from amazing.openings import classify
from amazing.store import GameStore, pending_report
from amazing.util import iso

CP_CLIP = 1500      # clip evals for cp-loss so "+12 vs +20" does not look like a blunder
MATE_CP = 10000


# ----- classification ------------------------------------------------------------------------
def classify_loss(cp_loss: int) -> str:
    if cp_loss <= 10:
        return "best"
    if cp_loss <= 25:
        return "excellent"
    if cp_loss <= 50:
        return "good"
    if cp_loss <= 100:
        return "inaccuracy"
    if cp_loss <= 250:
        return "mistake"
    return "blunder"


def win_percent(cp: float) -> float:
    """lichess: win% for the side whose POV `cp` is."""
    return 50 + 50 * (2 / (1 + math.exp(-0.00368208 * cp)) - 1)


def move_accuracy(win_before: float, win_after: float) -> float:
    """lichess per-move accuracy from the mover's win% before/after."""
    if win_after >= win_before:
        return 100.0
    raw = 103.1668 * math.exp(-0.04354 * (win_before - win_after)) - 3.1669 + 1  # +1 uncertainty bonus
    return max(0.0, min(100.0, raw))


def _harmonic(xs: List[float]) -> float:
    xs = [max(x, 0.001) for x in xs]
    return len(xs) / sum(1.0 / x for x in xs)


def game_accuracy(white_wins: List[float], start_white: bool) -> Tuple[Optional[float], Optional[float]]:
    """lichess game accuracy: mean of volatility-weighted mean and harmonic mean per colour.

    `white_wins` = White's win% for every position (initial position + after each ply).
    """
    n_moves = len(white_wins) - 1
    if n_moves <= 0:
        return None, None
    window = max(2, min(8, n_moves // 10))
    windows = []
    for i in range(n_moves):
        # lichess: (windowSize - 2) copies of the first window, then a sliding window
        lo = max(0, i - (window - 2))
        windows.append(white_wins[lo:lo + window])
    weights = [max(0.5, min(12.0, statistics.pstdev(w) if len(w) > 1 else 0.5)) for w in windows]
    per = {True: [], False: []}  # colour -> [(accuracy, weight)]
    white_to_move = start_white
    for i in range(n_moves):
        before, after = white_wins[i], white_wins[i + 1]
        if not white_to_move:
            before, after = 100 - before, 100 - after
        per[white_to_move].append((move_accuracy(before, after), weights[i]))
        white_to_move = not white_to_move

    def acc(items: List[Tuple[float, float]]) -> Optional[float]:
        if not items:
            return None
        wsum = sum(w for _, w in items)
        weighted = sum(a * w for a, w in items) / wsum
        harmonic = _harmonic([a for a, _ in items])
        return round((weighted + harmonic) / 2, 1)

    return acc(per[True]), acc(per[False])


# ----- helpers ---------------------------------------------------------------------------------
def _white_cp(score: chess.engine.PovScore) -> int:
    return score.white().score(mate_score=MATE_CP)


def _clip(v: int) -> int:
    return max(-CP_CLIP, min(CP_CLIP, v))


def _eval_fields(score: chess.engine.PovScore) -> Tuple[Optional[int], Optional[int]]:
    w = score.white()
    if w.is_mate():
        return None, w.mate()
    return w.score(), None


def _is_sacrifice(board_before: chess.Board, move: chess.Move) -> bool:
    """Cheap heuristic: a minor/major piece moves to a square attacked by a cheaper enemy piece,
    or to an attacked, undefended square (and it's not simply winning material)."""
    piece = board_before.piece_at(move.from_square)
    if piece is None or piece.piece_type in (chess.PAWN, chess.KING):
        return False
    values = {chess.PAWN: 1, chess.KNIGHT: 3, chess.BISHOP: 3, chess.ROOK: 5, chess.QUEEN: 9, chess.KING: 100}
    captured = board_before.piece_at(move.to_square)
    gain = values[captured.piece_type] if captured else 0
    after = board_before.copy(stack=False)
    after.push(move)
    attackers = after.attackers(not piece.color, move.to_square)
    if not attackers:
        return False
    cheapest = min(values[after.piece_at(sq).piece_type] for sq in attackers)
    defended = bool(after.attackers(piece.color, move.to_square))
    my_value = values[piece.piece_type]
    if cheapest < my_value and my_value - gain >= 2:
        return True
    return (not defended) and my_value - gain >= 2


# ----- main entry ------------------------------------------------------------------------------
def analyse_match(match: Dict[str, Any], settings: Settings, depth: Optional[int] = None,
                  previous_reports: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Run full-strength Stockfish over every ply. Returns a contract `Analysis` (status ready)."""
    depth = depth or settings.analysis_depth
    board = chess.Board(match["startFen"])
    moves = [chess.Move.from_uci(m["uci"]) for m in match["moves"]]
    start_white = board.turn == chess.WHITE

    eng = chess.engine.SimpleEngine.popen_uci(settings.stockfish_command, timeout=30)
    try:
        opts = {}
        if "Threads" in eng.options:
            opts["Threads"] = settings.analysis_threads
        if "Hash" in eng.options:
            opts["Hash"] = settings.analysis_hash_mb
        if "UCI_LimitStrength" in eng.options:
            opts["UCI_LimitStrength"] = False  # full strength for analysis
        eng.configure(opts)
        sf_name = eng.id.get("name", "Stockfish")

        # evaluate every position p0..pn (p_i = after ply i)
        scores: List[chess.engine.PovScore] = []
        bests: List[Optional[chess.Move]] = []
        positions: List[chess.Board] = []
        b = board.copy()
        for i in range(len(moves) + 1):
            positions.append(b.copy(stack=False))
            if b.is_checkmate():
                # side to move is mated
                scores.append(chess.engine.PovScore(chess.engine.Mate(0), b.turn))
                bests.append(None)
            elif b.is_game_over(claim_draw=False) and not b.is_checkmate():
                scores.append(chess.engine.PovScore(chess.engine.Cp(0), b.turn))
                bests.append(None)
            else:
                info = eng.analyse(b, chess.engine.Limit(depth=depth), game=match["id"])
                scores.append(info["score"])
                pv = info.get("pv") or []
                bests.append(pv[0] if pv else None)
            if i < len(moves):
                b.push(moves[i])
    finally:
        eng.quit()

    sans = [m["san"].rstrip("+#") for m in match["moves"]]
    opening, book_plies = classify(match["startFen"], sans)

    analyzed: List[Dict[str, Any]] = []
    for i, move in enumerate(moves):
        ply = i + 1
        before, after = scores[i], scores[i + 1]
        mover = positions[i].turn
        b_cp = _clip(before.pov(mover).score(mate_score=MATE_CP))
        a_cp = _clip(after.pov(mover).score(mate_score=MATE_CP))
        best = bests[i]
        played_best = best is not None and best == move
        cp_loss = 0 if played_best else max(0, b_cp - a_cp)
        bm = before.pov(mover)
        am = after.pov(mover)
        missed_mate = bm.is_mate() and (bm.mate() or 0) > 0 and not (am.is_mate() and (am.mate() or 0) >= 0) and not played_best
        allowed_mate = am.is_mate() and (am.mate() or 0) < 0 and not (bm.is_mate() and (bm.mate() or 0) < 0)
        if am.is_mate() and am.mate() == 0:
            # after the move the opponent is checkmated (Mate(0) from opponent POV is mate for us)
            allowed_mate = False
            missed_mate = False
        if ply <= book_plies:
            cls = "book"
        elif missed_mate or allowed_mate:
            cls = "blunder"
        else:
            cls = classify_loss(cp_loss)
            if played_best and cls == "best" and b_cp < 500 and a_cp >= -50 and _is_sacrifice(positions[i], move):
                cls = "brilliant"
        eval_cp, mate_in = _eval_fields(after)
        if positions[i + 1].is_checkmate():
            eval_cp, mate_in = None, 0
        item: Dict[str, Any] = {"ply": ply, "evalCp": eval_cp, "mateIn": mate_in, "cpLoss": int(cp_loss),
                                "classification": cls}
        if best is not None:
            item["bestMoveUci"] = best.uci()
            item["bestMoveSan"] = positions[i].san(best)
        analyzed.append(item)

    white_wins = [win_percent(_clip(_white_cp(s))) for s in scores]
    white_acc, black_acc = game_accuracy(white_wins, start_white)
    engine_white = match["engineColor"] == "white"
    summary: Dict[str, Any] = {
        "decisivePly": decisive_ply(match, scores),
        "opening": opening or "Non-standard start position",
    }
    eng_acc, sf_acc = (white_acc, black_acc) if engine_white else (black_acc, white_acc)
    if eng_acc is not None:
        summary["engineAccuracy"] = eng_acc
    if sf_acc is not None:
        summary["stockfishAccuracy"] = sf_acc

    reports = previous_reports or {}
    return {
        "matchId": match["id"],
        "status": "ready",
        "analyzer": {"engine": sf_name, "depth": depth},
        "moves": analyzed,
        "summary": summary,
        "reports": {
            "gmCoach": reports.get("gmCoach") or pending_report("gm-coach"),
            "engineDev": reports.get("engineDev") or pending_report("engine-dev"),
        },
        "createdAt": iso(),
    }


def decisive_ply(match: Dict[str, Any], scores: List[chess.engine.PovScore]) -> Optional[int]:
    """First ply after which the eventual winner stays >= +200 cp to the end of the game.
    Falls back to the loser's largest eval drop. None for draws / unfinished games."""
    result = match.get("result")
    if result not in ("1-0", "0-1") or not match["moves"]:
        return None
    winner_white = result == "1-0"
    vals = [_white_cp(s) * (1 if winner_white else -1) for s in scores]
    decisive = None
    for i in range(len(vals) - 1, 0, -1):
        if vals[i] >= 200:
            decisive = i
        else:
            break
    if decisive is not None:
        return decisive
    # fallback: biggest swing towards the winner
    best_i, best_gain = None, 0
    for i in range(1, len(vals)):
        gain = _clip(vals[i]) - _clip(vals[i - 1])
        if gain > best_gain:
            best_i, best_gain = i, gain
    return best_i


def run_engine_analysis(store: GameStore, match_id: str, settings: Settings,
                        depth: Optional[int] = None, final_status: str = "ready") -> Dict[str, Any]:
    """Blocking: mark running, analyse, write `final_status` (or failed). Returns the Analysis.

    `final_status="running"` is used when the agents run next (the top-level status becomes
    `ready` once their reports are in)."""
    match = store.load_raw(match_id)
    if match is None:
        raise KeyError(match_id)
    existing = store.read_analysis(match_id) or {}
    reports = existing.get("reports") if existing.get("status") != "failed" else None
    running = {
        "matchId": match_id,
        "status": "running",
        "reports": {
            "gmCoach": (reports or {}).get("gmCoach") or pending_report("gm-coach"),
            "engineDev": (reports or {}).get("engineDev") or pending_report("engine-dev"),
        },
        "createdAt": iso(),
    }
    store.write_analysis(match_id, running)
    try:
        result = analyse_match(match, settings, depth, previous_reports=running["reports"])
    except Exception:
        failed = dict(running)
        failed["status"] = "failed"
        store.write_analysis(match_id, failed)
        raise
    result["status"] = final_status

    def merge(current: Dict[str, Any]) -> Dict[str, Any]:
        # keep any agent report that was saved while the engine part was running
        cur_reports = current.get("reports") or {}
        for key in ("gmCoach", "engineDev"):
            if (cur_reports.get(key) or {}).get("status") in ("running", "ready", "failed"):
                result["reports"][key] = cur_reports[key]
        return result

    if store.update_analysis(match_id, merge) is None:
        store.write_analysis(match_id, result)
    return result
