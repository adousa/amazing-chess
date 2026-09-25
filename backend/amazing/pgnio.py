"""Build the evidence PGN for a finished/aborted match."""
from __future__ import annotations

from typing import Any, Dict

import chess
import chess.pgn

from amazing.util import parse_iso

STANDARD_FEN = chess.STARTING_FEN


def _emt(ms: int) -> str:
    s = ms / 1000.0
    h = int(s // 3600)
    m = int((s % 3600) // 60)
    sec = s - h * 3600 - m * 60
    return f"{h}:{m:02d}:{sec:05.2f}"


def build_pgn(match: Dict[str, Any]) -> str:
    board = chess.Board(match["startFen"])
    game = chess.pgn.Game()
    if match["startFen"] != STANDARD_FEN:
        game.setup(board)

    sf = match["stockfish"]
    eng = match["engine"]
    started = match.get("startedAt") or match["createdAt"]
    dt = parse_iso(started)
    engine_name = f"{eng.get('name', 'AmazingChess')} {eng['version']}"
    sf_name = f"{sf.get('version', 'Stockfish')} (Elo {sf['elo']})"
    white, black = (engine_name, sf_name) if match["engineColor"] == "white" else (sf_name, engine_name)
    secs = match["engine"]["moveTimeMs"] / 1000.0
    tc = f"{secs:g}s/move"

    h = game.headers
    h["Event"] = "Amazing Chess vs Stockfish"
    h["Site"] = "local"
    h["Date"] = dt.strftime("%Y.%m.%d")
    h["Round"] = "-"
    h["White"] = white
    h["Black"] = black
    h["Result"] = match.get("result") or "*"
    h["StockfishElo"] = str(sf["elo"])
    if match["engineColor"] == "white":
        h["BlackElo"] = str(sf["elo"])
    else:
        h["WhiteElo"] = str(sf["elo"])
    h["EngineColor"] = match["engineColor"]
    h["EngineVersion"] = eng["version"]
    h["StockfishVersion"] = sf.get("version", "unknown")
    h["StockfishSettings"] = (
        f"UCI_LimitStrength=true UCI_Elo={sf['elo']} Threads={sf.get('threads')} Hash={sf.get('hashMb')}"
    )
    h["TimeControl"] = tc
    h["MoveTime"] = str(eng["moveTimeMs"])
    h["Termination"] = match.get("termination") or match.get("status", "unterminated")
    h["MatchId"] = match["id"]
    h["UTCDate"] = dt.strftime("%Y.%m.%d")
    h["UTCTime"] = dt.strftime("%H:%M:%S")

    node: chess.pgn.GameNode = game
    for mv in match["moves"]:
        move = chess.Move.from_uci(mv["uci"])
        node = node.add_variation(move)
        node.comment = f"[%emt {_emt(mv['timeMs'])}]"
        board.push(move)

    exporter = chess.pgn.StringExporter(headers=True, variations=False, comments=True)
    return game.accept(exporter) + "\n"
