"""Match runner: our engine vs Elo-limited Stockfish, enforcing the 5 s/move rule."""
from __future__ import annotations

import asyncio
import logging
import os
import random
import time
import traceback
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Dict, List, Optional, Tuple

import chess

from amazing.config import ELO_MAX, ELO_MIN, Settings
from amazing.events import EventHub
from amazing.pgnio import build_pgn
from amazing.store import TERMINAL, GameExistsError, GameStore
from amazing.uci import (Aborted, EngineCrashed, EngineTimeout, UciEngine, probe_id,
                         split_engine_name, thinking_from)
from amazing.util import iso, utcnow

log = logging.getLogger("amazing.runner")

INFO_INTERVAL_S = 0.25  # engine.info throttle: <= 4 events/s per match


class InvalidRequest(Exception):
    def __init__(self, code: str, message: str, details: Optional[Dict[str, Any]] = None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.details = details


class AlreadyFinished(Exception):
    pass


def outcome_for(result: str, engine_color: str) -> Optional[str]:
    """PGN result -> outcome from OUR engine's point of view."""
    if result == "1/2-1/2":
        return "draw"
    if result == "1-0":
        return "win" if engine_color == "white" else "loss"
    if result == "0-1":
        return "win" if engine_color == "black" else "loss"
    return None


def pick_colors(choice: str, count: int, rng: Optional[random.Random] = None) -> List[str]:
    rng = rng or random.Random()
    if choice == "white":
        return ["white"] * count
    if choice == "black":
        return ["black"] * count
    if choice == "random":
        return [rng.choice(["white", "black"]) for _ in range(count)]
    if choice == "alternate":
        return ["white" if i % 2 == 0 else "black" for i in range(count)]
    raise InvalidRequest("invalid_color", f"engineColor must be white, black, random or alternate, got {choice!r}")


def normal_termination(board: chess.Board) -> Optional[Tuple[Optional[bool], str]]:
    """(winner colour or None for draw, contract termination) if the game is over."""
    if board.is_checkmate():
        return (not board.turn, "checkmate")
    if board.is_stalemate():
        return (None, "stalemate")
    if board.is_insufficient_material():
        return (None, "insufficient-material")
    if board.is_repetition(3):
        return (None, "threefold-repetition")
    if board.halfmove_clock >= 100:
        return (None, "fifty-move-rule")
    return None


@dataclass
class MatchState:
    id: str
    stockfish_elo: int
    engine_color: str
    engine_version: str
    created_at: str
    start_fen: str
    stockfish: Dict[str, Any]
    engine: Dict[str, Any]
    status: str = "queued"
    started_at: Optional[str] = None
    finished_at: Optional[str] = None
    result: str = "*"
    outcome: Optional[str] = None
    termination: Optional[str] = None
    moves: List[Dict[str, Any]] = field(default_factory=list)
    error: Optional[str] = None
    abort_event: asyncio.Event = field(default_factory=asyncio.Event)
    done_event: asyncio.Event = field(default_factory=asyncio.Event)
    saved: bool = False

    def summary(self, analysis_status: str = "pending") -> Dict[str, Any]:
        return {
            "id": self.id,
            "status": self.status,
            "stockfishElo": self.stockfish_elo,
            "engineColor": self.engine_color,
            "engineVersion": self.engine_version,
            "result": self.result,
            "outcome": self.outcome,
            "termination": self.termination,
            "plyCount": len(self.moves),
            "createdAt": self.created_at,
            "startedAt": self.started_at,
            "finishedAt": self.finished_at,
            "analysisStatus": analysis_status,
        }

    def to_match(self, analysis_status: str = "pending") -> Dict[str, Any]:
        m = self.summary(analysis_status)
        m.update({
            "stockfish": dict(self.stockfish),
            "engine": dict(self.engine),
            "startFen": self.start_fen,
            "moves": list(self.moves),
            "pgnUrl": f"/matches/{self.id}/pgn",
        })
        return m


OnSaved = Callable[[Dict[str, Any]], Awaitable[None]]


class MatchRunner:
    def __init__(self, settings: Settings, store: GameStore, hub: EventHub,
                 on_saved: Optional[OnSaved] = None):
        self.settings = settings
        self.store = store
        self.hub = hub
        self.on_saved = on_saved
        self.active: Dict[str, MatchState] = {}
        self.queue: "asyncio.Queue[MatchState]" = asyncio.Queue()
        self.workers: List[asyncio.Task] = []
        self._id_cache: Dict[Tuple[Tuple[str, ...], float], Dict[str, str]] = {}

    # ----- lifecycle ---------------------------------------------------------------------
    def start(self) -> None:
        if not self.workers:
            self.workers = [asyncio.ensure_future(self._worker(i)) for i in range(self.settings.parallel)]

    async def shutdown(self) -> None:
        """Abort running matches (saved as aborted) and drop never-started queued ones."""
        for st in list(self.active.values()):
            if st.status == "queued":
                st.status = "dropped"
                try:
                    os.rmdir(self.store.dir(st.id))
                except OSError:
                    pass
                self.active.pop(st.id, None)
            elif st.status == "running":
                st.abort_event.set()
        running = [st.done_event.wait() for st in self.active.values() if st.status == "running"]
        if running:
            await asyncio.wait([asyncio.ensure_future(r) for r in running], timeout=15)
        for w in self.workers:
            w.cancel()
        self.workers = []

    # ----- identities --------------------------------------------------------------------
    async def _probe(self, command: List[str]) -> Dict[str, str]:
        exe = command[0]
        try:
            mtime = os.path.getmtime(exe)
        except OSError:
            mtime = 0.0
        key = (tuple(command), mtime)
        if key not in self._id_cache:
            self._id_cache[key] = await probe_id(command, cwd=str(self.settings.repo_root))
        return self._id_cache[key]

    async def engine_identity(self) -> Tuple[str, str]:
        ident = await self._probe(self.settings.engine_command)
        return split_engine_name(ident.get("name"))

    async def stockfish_version(self) -> str:
        ident = await self._probe(self.settings.stockfish_command)
        return ident.get("name", "Stockfish")

    # ----- queueing ----------------------------------------------------------------------
    async def submit(self, stockfish_elo: int, engine_color: str = "alternate", count: int = 1,
                     start_fen: Optional[str] = None, engine_version: Optional[str] = None,
                     rng: Optional[random.Random] = None) -> List[MatchState]:
        if not isinstance(stockfish_elo, int) or not (ELO_MIN <= stockfish_elo <= ELO_MAX):
            raise InvalidRequest("invalid_elo", f"stockfishElo must be between {ELO_MIN} and {ELO_MAX}",
                                 {"min": ELO_MIN, "max": ELO_MAX, "got": stockfish_elo})
        if not isinstance(count, int) or not (1 <= count <= 100):
            raise InvalidRequest("invalid_count", "count must be between 1 and 100")
        fen = chess.STARTING_FEN
        if start_fen:
            try:
                b = chess.Board(start_fen)
            except ValueError as exc:
                raise InvalidRequest("invalid_fen", f"startFen is not a valid FEN: {exc}")
            if not b.is_valid() or b.is_game_over():
                raise InvalidRequest("invalid_fen", "startFen is not a legal, playable position")
            fen = b.fen()
        colors = pick_colors(engine_color, count, rng)
        try:
            name, version = await self.engine_identity()
        except (EngineCrashed, EngineTimeout) as exc:
            raise InvalidRequest("engine_unavailable", f"our engine cannot be started: {exc}")
        if engine_version and engine_version != version:
            raise InvalidRequest("unknown_engine_version",
                                 f"engine version {engine_version!r} is not available (current: {version!r})",
                                 {"available": [version]})
        try:
            sf_version = await self.stockfish_version()
        except (EngineCrashed, EngineTimeout) as exc:
            raise InvalidRequest("stockfish_unavailable", f"Stockfish cannot be started: {exc}")

        s = self.settings
        now = utcnow()
        date = now.strftime("%Y%m%d")
        out = []
        for color in colors:
            mid = self.store.reserve_id(date, stockfish_elo, set(self.active))
            st = MatchState(
                id=mid, stockfish_elo=stockfish_elo, engine_color=color, engine_version=version,
                created_at=iso(now), start_fen=fen,
                stockfish={"version": sf_version, "elo": stockfish_elo, "limitStrength": True,
                           "moveTimeMs": s.move_time_ms, "threads": s.sf_threads, "hashMb": s.sf_hash_mb},
                engine={"name": name, "version": version, "color": color, "moveTimeMs": s.move_time_ms,
                        "options": self._planned_engine_options()},
            )
            self.active[mid] = st
            self.hub.log(mid)
            out.append(st)
        for st in out:
            self.queue.put_nowait(st)
        return out

    def _planned_engine_options(self) -> Dict[str, Any]:
        opts: Dict[str, Any] = {"Hash": self.settings.engine_hash_mb}
        opts.update(self.settings.engine_options)
        return opts

    async def abort(self, match_id: str) -> MatchState:
        st = self.active.get(match_id)
        if st is None or st.status in TERMINAL:
            raise AlreadyFinished(match_id)
        if st.status == "queued":
            st.status = "aborted"
            st.termination = "aborted"
            st.finished_at = iso()
            await self._save(st)
            return st
        st.abort_event.set()
        try:
            await asyncio.wait_for(st.done_event.wait(), 15)
        except asyncio.TimeoutError:
            pass
        return st

    async def wait_all(self, states: List[MatchState]) -> None:
        for st in states:
            await st.done_event.wait()

    # ----- playing -----------------------------------------------------------------------
    async def _worker(self, idx: int) -> None:
        while True:
            st = await self.queue.get()
            if st.status != "queued":
                continue
            try:
                await self._play(st)
            except asyncio.CancelledError:
                raise
            except Exception:  # never lose a game to a runner bug
                log.exception("match %s crashed the runner", st.id)
                if not st.saved:
                    st.status = "error"
                    st.error = traceback.format_exc()
                    st.finished_at = st.finished_at or iso()
                    await self._save(st)

    def _finish(self, st: MatchState, winner: Optional[bool], termination: str) -> None:
        st.status = "finished"
        st.termination = termination
        st.result = "1/2-1/2" if winner is None else ("1-0" if winner == chess.WHITE else "0-1")
        st.outcome = outcome_for(st.result, st.engine_color)
        st.finished_at = iso()

    def _fail(self, st: MatchState, message: str) -> None:
        log.error("match %s error: %s", st.id, message)
        st.status = "error"
        st.error = message
        st.result = "*"
        st.outcome = None
        st.termination = None
        st.finished_at = iso()

    def _abort_state(self, st: MatchState) -> None:
        st.status = "aborted"
        st.result = "*"
        st.outcome = None
        st.termination = "aborted"
        st.finished_at = iso()

    async def _play(self, st: MatchState) -> None:
        s = self.settings
        engine: Optional[UciEngine] = None
        sf: Optional[UciEngine] = None
        evlog = self.hub.log(st.id)
        st.status = "running"
        st.started_at = iso()
        try:
            try:
                engine = await UciEngine.start(s.engine_command, "engine", cwd=str(s.repo_root))
                sf = await UciEngine.start(s.stockfish_command, "stockfish")
                # Stockfish: always strength-limited
                await sf.set_option("UCI_LimitStrength", True)
                await sf.set_option("UCI_Elo", st.stockfish_elo)
                await sf.set_option("Threads", s.sf_threads)
                await sf.set_option("Hash", s.sf_hash_mb)
                if sf.has_option("Ponder"):
                    await sf.set_option("Ponder", False)
                used_opts: Dict[str, Any] = {}
                for k, v in self._planned_engine_options().items():
                    if engine.has_option(k):
                        await engine.set_option(k, v)
                        used_opts[k] = v
                await engine.new_game()
                await sf.new_game()
            except (EngineCrashed, EngineTimeout) as exc:
                self._fail(st, f"setup failed: {exc}")
                return
            name, version = split_engine_name(engine.id.get("name"))
            st.engine_version = version
            st.engine.update({"name": name, "version": version, "options": used_opts})
            st.stockfish["version"] = sf.id.get("name", st.stockfish.get("version", "Stockfish"))
            evlog.append("match.started", match=st.to_match())

            board = chess.Board(st.start_fen)
            engine_turn = chess.WHITE if st.engine_color == "white" else chess.BLACK
            limit_ms = s.move_time_ms
            hard_deadline = limit_ms / 1000.0 + 0.5
            last_info_emit = [0.0]

            def on_info_for(side: str) -> Callable[[Dict[str, Any]], None]:
                def cb(info: Dict[str, Any]) -> None:
                    now = time.monotonic()
                    if now - last_info_emit[0] >= INFO_INTERVAL_S:
                        last_info_emit[0] = now
                        evlog.append("engine.info", side=side, thinking=thinking_from(info))
                return cb

            start_cmd = "position startpos" if st.start_fen == chess.STARTING_FEN else f"position fen {st.start_fen}"
            while True:
                if st.abort_event.is_set():
                    self._abort_state(st)
                    return
                ours = board.turn == engine_turn
                side_name = "engine" if ours else "stockfish"
                player = engine if ours else sf
                moves_uci = [m.uci() for m in board.move_stack]
                pos = start_cmd + (" moves " + " ".join(moves_uci) if moves_uci else "")
                try:
                    res = await player.go(pos, s.go_movetime_ms, hard_deadline,
                                          on_info=on_info_for(side_name), abort=st.abort_event)
                except Aborted:
                    await player.stop_and_drain()
                    self._abort_state(st)
                    return
                except EngineTimeout:
                    self._finish(st, not board.turn, "time-limit-exceeded")
                    return
                except EngineCrashed as exc:
                    if ours:
                        self._finish(st, not board.turn, "engine-crash")
                    else:
                        self._fail(st, f"Stockfish failed: {exc}")
                    return
                if res.elapsed_ms > limit_ms:
                    self._finish(st, not board.turn, "time-limit-exceeded")
                    return
                move = None
                if res.bestmove and res.bestmove not in ("(none)", "0000", "NULL"):
                    try:
                        cand = chess.Move.from_uci(res.bestmove)
                        if cand in board.legal_moves:
                            move = cand
                    except ValueError:
                        move = None
                if move is None:
                    if ours:
                        self._finish(st, not board.turn, "illegal-move")
                    else:
                        self._fail(st, f"Stockfish returned an illegal move {res.bestmove!r}")
                    return
                ply = len(board.move_stack) + 1
                color = "white" if board.turn == chess.WHITE else "black"
                san = board.san(move)
                board.push(move)
                mv: Dict[str, Any] = {
                    "ply": ply, "color": color, "by": side_name, "san": san, "uci": move.uci(),
                    "fenAfter": board.fen(), "timeMs": res.elapsed_ms,
                }
                if ours and res.info:
                    mv["thinking"] = thinking_from(res.info)
                st.moves.append(mv)
                evlog.append("move.played", move=mv)
                over = normal_termination(board)
                if over is not None:
                    self._finish(st, over[0], over[1])
                    return
        finally:
            for e in (engine, sf):
                if e is not None:
                    await e.quit()
            if st.status == "running":  # defensive: should not happen
                self._fail(st, "runner ended without a result")
            if not st.saved:
                await self._save(st)

    async def _save(self, st: MatchState) -> None:
        if st.saved:
            return
        match = st.to_match("pending")
        try:
            self.store.save_game(match, build_pgn(match))
        except GameExistsError:
            log.error("refusing to overwrite saved game %s", st.id)
        st.saved = True
        evlog = self.hub.log(st.id)
        if st.status == "finished":
            evlog.append("match.finished", result=st.result, outcome=st.outcome, termination=st.termination)
        else:
            evlog.append("match.snapshot", match=self.store.load_match(st.id) or st.to_match())
        # engine.info is decoration: drop it from the replay log once the game is over
        evlog.events = [e for e in evlog.events if e["type"] != "engine.info"]
        self.active.pop(st.id, None)
        st.done_event.set()
        if self.on_saved is not None:
            try:
                await self.on_saved(match)
            except Exception:
                log.exception("on_saved hook failed for %s", st.id)
