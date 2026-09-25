"""Match runner against real Stockfish with the placeholder engine (short move time)."""
from __future__ import annotations

import asyncio
import json

import chess
import chess.pgn
import io

from amazing.analysis import run_engine_analysis
from amazing.service import Backend
from conftest import MATE_IN_ONE_WHITE, assert_contract, settings_with


def play(settings, **submit):
    async def run():
        b = Backend(settings, agents_mode="off")
        b.start()
        try:
            states = await b.submit(**submit)
            await b.runner.wait_all(states)
            await b.drain_analysis()
            return b, states
        finally:
            await b.shutdown()
    return asyncio.run(run())


def saved(b, st):
    m = b.store.load_match(st.id)
    assert m is not None, "every game must be saved"
    assert_contract(m, "Match")
    return m


def test_slow_engine_loses_on_time(env):
    s = settings_with(AC_ENGINE_PATH="python -m amazing.placeholder_engine --sleep-ms 700")
    b, [st] = play(s, stockfish_elo=1320, engine_color="white")
    m = saved(b, st)
    assert m["status"] == "finished"
    assert m["termination"] == "time-limit-exceeded"
    assert m["result"] == "0-1" and m["outcome"] == "loss"
    assert m["moves"] == []  # the over-time move is never played
    assert all(mv["timeMs"] <= 300 for mv in m["moves"])


def test_hanging_engine_loses_on_time(env):
    s = settings_with(AC_ENGINE_PATH="python -m amazing.placeholder_engine --hang")
    b, [st] = play(s, stockfish_elo=1320, engine_color="black")
    m = saved(b, st)
    assert m["termination"] == "time-limit-exceeded" and m["outcome"] == "loss" and m["result"] == "1-0"
    assert len(m["moves"]) == 1 and m["moves"][0]["by"] == "stockfish"


def test_illegal_move_loses(env):
    s = settings_with(AC_ENGINE_PATH="python -m amazing.placeholder_engine --illegal")
    b, [st] = play(s, stockfish_elo=1320, engine_color="white")
    m = saved(b, st)
    assert m["termination"] == "illegal-move" and m["outcome"] == "loss"


def test_crash_loses_and_is_saved(env):
    s = settings_with(AC_ENGINE_PATH="python -m amazing.placeholder_engine --crash-after 2")
    b, [st] = play(s, stockfish_elo=1320, engine_color="white")
    m = saved(b, st)
    assert m["termination"] == "engine-crash" and m["outcome"] == "loss"
    assert len([mv for mv in m["moves"] if mv["by"] == "engine"]) == 2
    assert b.store.load_pgn(st.id)


def test_alternate_colours_and_mate(env):
    s = settings_with()
    b, states = play(s, stockfish_elo=1500, engine_color="alternate", count=2, start_fen=MATE_IN_ONE_WHITE)
    m1, m2 = saved(b, states[0]), saved(b, states[1])
    assert (m1["engineColor"], m2["engineColor"]) == ("white", "black")
    # white to move mates in one: our engine wins as white, Stockfish mates us when we are black
    assert m1["termination"] == "checkmate" and m1["outcome"] == "win" and m1["result"] == "1-0"
    assert m2["termination"] == "checkmate" and m2["outcome"] == "loss"
    assert m1["moves"][0]["san"] == "Ra8#" and m1["moves"][0]["by"] == "engine"
    assert "thinking" in m1["moves"][0] and "thinking" not in m2["moves"][0]
    pgn = b.store.load_pgn(states[0].id)
    assert '[SetUp "1"]' in pgn and f'[FEN "{MATE_IN_ONE_WHITE}"]' in pgn


def test_abort_running_match_is_saved(env):
    s = settings_with(AC_ENGINE_PATH="python -m amazing.placeholder_engine --sleep-ms 250",
                      AC_MOVE_TIME_MS="400")

    async def run():
        b = Backend(s, agents_mode="off")
        b.start()
        try:
            [st] = await b.submit(stockfish_elo=1320, engine_color="white", count=1)
            while len(st.moves) < 3:
                await asyncio.sleep(0.05)
            await b.runner.abort(st.id)
            [q] = await b.submit(stockfish_elo=1320, engine_color="white", count=1)
            # a second match may still be queued if parallel slots are free; abort it anyway
            await b.runner.abort(q.id)
            return b, st, q
        finally:
            await b.shutdown()

    b, st, q = asyncio.run(run())
    m = saved(b, st)
    assert m["status"] == "aborted" and m["result"] == "*" and m["outcome"] is None
    assert m["termination"] == "aborted" and len(m["moves"]) >= 3
    assert saved(b, q)["status"] == "aborted"


def test_real_game_and_analysis(env):
    """A full game placeholder vs Stockfish 1320 at 300 ms/move, then analysis at low depth."""
    s = settings_with()
    b, [st] = play(s, stockfish_elo=1320, engine_color="white")
    m = saved(b, st)
    assert m["status"] == "finished" and m["outcome"] in ("win", "draw", "loss")
    assert m["stockfish"]["limitStrength"] is True and m["stockfish"]["elo"] == 1320
    assert m["stockfish"]["version"].startswith("Stockfish")
    assert m["engine"]["version"] == "0.0.0-placeholder" and m["engine"]["moveTimeMs"] == 300
    assert m["plyCount"] == len(m["moves"]) > 0
    assert all(mv["timeMs"] <= 300 for mv in m["moves"])
    # replaying the moves reproduces every fenAfter
    board = chess.Board(m["startFen"])
    for mv in m["moves"]:
        assert board.san(chess.Move.from_uci(mv["uci"])) == mv["san"]
        board.push_uci(mv["uci"])
        assert board.fen() == mv["fenAfter"]
    # PGN evidence headers
    game = chess.pgn.read_game(io.StringIO(b.store.load_pgn(st.id)))
    for h in ("White", "Black", "Result", "StockfishElo", "EngineColor", "EngineVersion", "TimeControl",
              "Termination", "MatchId", "UTCDate", "UTCTime"):
        assert h in game.headers, h
    assert game.headers["StockfishElo"] == "1320" and game.headers["Result"] == m["result"]
    assert len(list(game.mainline_moves())) == m["plyCount"]
    # automatic analysis ran after the game (AC_AGENTS=0 -> engine only, status ready)
    a = b.store.read_analysis(st.id)
    assert_contract(a, "Analysis")
    assert a["status"] == "ready" and len(a["moves"]) == m["plyCount"]
    assert [x["ply"] for x in a["moves"]] == list(range(1, m["plyCount"] + 1))
    assert a["reports"]["gmCoach"]["status"] == "pending"
    assert a["analyzer"]["depth"] == 6
    assert 0 <= a["summary"]["engineAccuracy"] <= 100
    # match.json is untouched by analysis (immutable); analysisStatus is derived
    raw = json.loads(b.store.match_path(st.id).read_text())
    assert raw["analysisStatus"] == "pending" and b.store.load_match(st.id)["analysisStatus"] == "ready"
    # re-run keeps history
    b.store.archive_analysis(st.id)
    a2 = run_engine_analysis(b.store, st.id, s, depth=4)
    assert a2["analyzer"]["depth"] == 4
    assert len(list((b.store.dir(st.id) / "analysis-history").iterdir())) == 1
