"""Pure logic: outcome, colours, termination, ladder/stats, store immutability, parsing."""
from __future__ import annotations

import json
import random

import chess
import pytest

from amazing.analysis import classify_loss, game_accuracy, win_percent
from amazing.derive import engine_versions, ladder, stats
from amazing.openings import classify
from amazing.runner import normal_termination, outcome_for, pick_colors
from amazing.store import GameExistsError, GameStore
from amazing.uci import parse_info, split_engine_name
from conftest import assert_contract


def test_outcome_from_engine_pov():
    assert outcome_for("1-0", "white") == "win"
    assert outcome_for("1-0", "black") == "loss"
    assert outcome_for("0-1", "black") == "win"
    assert outcome_for("0-1", "white") == "loss"
    assert outcome_for("1/2-1/2", "white") == "draw"
    assert outcome_for("1/2-1/2", "black") == "draw"
    assert outcome_for("*", "white") is None


def test_colour_choices():
    assert pick_colors("alternate", 5) == ["white", "black", "white", "black", "white"]
    assert pick_colors("white", 3) == ["white"] * 3
    assert pick_colors("black", 2) == ["black"] * 2
    rnd = pick_colors("random", 50, random.Random(1))
    assert set(rnd) == {"white", "black"}


@pytest.mark.parametrize("fen,moves,expected", [
    ("7k/5Q2/6K1/8/8/8/8/8 b - - 0 1", [], (None, "stalemate")),
    ("6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1", ["a1a8"], (chess.WHITE, "checkmate")),
    ("8/8/8/4k3/8/8/4K3/8 w - - 0 1", [], (None, "insufficient-material")),
    ("8/8/8/4k3/8/8/4K3/7R w - - 99 80", ["h1h2"], (None, "fifty-move-rule")),
    (chess.STARTING_FEN, ["g1f3", "g8f6", "f3g1", "f6g8", "g1f3", "g8f6", "f3g1", "f6g8"],
     (None, "threefold-repetition")),
])
def test_normal_terminations(fen, moves, expected):
    b = chess.Board(fen)
    for m in moves:
        b.push_uci(m)
    assert normal_termination(b) == expected


def test_no_early_threefold_claim():
    # 7 plies: a repetition is only *claimable after the next move*; the game must go on
    b = chess.Board()
    for m in ["g1f3", "g8f6", "f3g1", "f6g8", "g1f3", "g8f6", "f3g1"]:
        b.push_uci(m)
    assert normal_termination(b) is None


def _m(i, elo, outcome, status="finished", color="white", ver="0.1.0", finished=None):
    return {"id": f"m_20260925_{elo}_{i:03d}", "status": status, "stockfishElo": elo, "engineColor": color,
            "engineVersion": ver, "outcome": outcome, "createdAt": f"2026-09-25T10:{i:02d}:00Z",
            "finishedAt": finished or f"2026-09-25T10:{i:02d}:30Z",
            "engine": {"name": "AmazingChess", "version": ver}}


def test_ladder_draw_is_not_a_win():
    matches = [
        _m(1, 1320, "win"), _m(2, 1320, "loss"),
        _m(3, 1400, "draw"), _m(4, 1400, "draw"),
        _m(5, 1500, "loss"), _m(6, 1500, None, status="aborted"),
        _m(7, 1600, None, status="running"),
        _m(8, 1700, None, status="queued"),
    ]
    lad = ladder(matches)
    assert_contract(lad, "Ladder")
    by = {lv["elo"]: lv for lv in lad["levels"]}
    assert by[1320]["state"] == "beaten" and by[1320]["firstWinMatchId"] == "m_20260925_1320_001"
    assert by[1400]["state"] == "attempted" and by[1400]["draws"] == 2 and by[1400]["wins"] == 0
    assert by[1500]["games"] == 2 and by[1500]["losses"] == 1
    assert by[1600]["state"] == "attempted"
    assert 1700 not in by  # queued, not attempted yet
    assert lad["highestEloBeaten"] == 1320 and lad["proofMatchId"] == "m_20260925_1320_001"
    assert [lv["elo"] for lv in lad["levels"]] == sorted(by)


def test_ladder_first_win_and_highest():
    lad = ladder([_m(3, 1500, "win", finished="2026-09-25T11:00:00Z"),
                  _m(1, 1500, "win", finished="2026-09-25T10:00:00Z"),
                  _m(2, 1400, "win")])
    assert lad["highestEloBeaten"] == 1500
    assert lad["proofMatchId"] == "m_20260925_1500_001"
    assert ladder([])["highestEloBeaten"] is None


def test_stats():
    matches = [_m(1, 1320, "win"), _m(2, 1320, "draw", color="black"), _m(3, 1400, "loss", ver="0.2.0"),
               _m(4, 1400, None, status="aborted")]
    s = stats(matches)
    assert_contract(s, "Stats")
    assert s["total"] == {"games": 3, "wins": 1, "draws": 1, "losses": 1}
    assert s["byColor"]["black"]["draws"] == 1
    assert [e["elo"] for e in s["byElo"]] == [1320, 1400]
    assert stats(matches, "0.2.0")["total"]["games"] == 1
    vers = engine_versions(matches, {"version": "0.3.0", "name": "AmazingChess", "createdAt": "2026-09-26T00:00:00Z"})
    assert_contract(vers, "EngineVersion", array=True)
    assert vers[0]["version"] == "0.3.0"


def test_store_is_append_only(tmp_path):
    store = GameStore(tmp_path)
    mid = store.reserve_id("20260925", 1320)
    assert mid == "m_20260925_1320_001"
    assert store.reserve_id("20260925", 1320) == "m_20260925_1320_002"
    match = {"id": mid, "status": "finished", "moves": []}
    store.save_game(match, "[Event \"x\"]\n\n*\n")
    before = (store.match_path(mid).read_bytes(), store.pgn_path(mid).read_bytes())
    with pytest.raises(GameExistsError):
        store.save_game({**match, "status": "aborted"}, "tampered")
    fresh = GameStore(tmp_path)  # no cache
    with pytest.raises(GameExistsError):
        fresh.save_game({**match, "status": "aborted"}, "tampered")
    assert (store.match_path(mid).read_bytes(), store.pgn_path(mid).read_bytes()) == before
    assert json.loads(store.match_path(mid).read_text())["status"] == "finished"


def test_analysis_history_on_rerun(tmp_path):
    store = GameStore(tmp_path)
    mid = store.reserve_id("20260925", 1320)
    store.write_analysis(mid, {"matchId": mid, "status": "ready"})
    assert store.analysis_status(mid) == "ready"
    dst = store.archive_analysis(mid)
    assert dst is not None and dst.parent.name == "analysis-history"
    assert json.loads(dst.read_text())["status"] == "ready"
    assert store.analysis_status(mid) == "pending"


def test_parse_info():
    i = parse_info("info depth 12 seldepth 18 multipv 1 score cp -35 nodes 12345 nps 99000 hashfull 3 time 120 pv e2e4 e7e5")
    assert i == {"depth": 12, "seldepth": 18, "scoreCp": -35, "mateIn": None, "nodes": 12345, "nps": 99000,
                 "hashfull": 3, "time": 120, "pv": ["e2e4", "e7e5"]}
    assert parse_info("info depth 5 score mate -3 lowerbound pv a1a2")["mateIn"] == -3
    assert parse_info("info string hello") is None
    assert parse_info("info depth 5 multipv 2 score cp 1 pv a2a3") is None
    assert split_engine_name("AmazingChess 0.1.0") == ("AmazingChess", "0.1.0")
    assert split_engine_name("Stockfish 19") == ("Stockfish", "19")


def test_classification_and_accuracy():
    assert [classify_loss(x) for x in (0, 10, 11, 25, 40, 90, 200, 251)] == [
        "best", "best", "excellent", "excellent", "good", "inaccuracy", "mistake", "blunder"]
    assert round(win_percent(0), 1) == 50.0
    w, b = game_accuracy([50.0] * 11, True)
    assert w == 100.0 and b == 100.0
    w, b = game_accuracy([50, 20, 20, 5, 5], True)  # white drops on its own moves
    assert w < b == 100.0
    name, n = classify(chess.STARTING_FEN, ["e4", "e5", "Nf3", "Nc6", "Bc4", "Bc5", "d3"])
    assert name == "C50 Italian Game: Giuoco Piano" and n == 6
