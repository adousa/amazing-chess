"""HTTP API implementing contracts/openapi.yaml (mounted under /api) + SSE (contracts/events.md)."""
from __future__ import annotations

import asyncio
import base64
import json
import os
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Any, AsyncIterator, Dict, List, Optional

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, PlainTextResponse, Response, StreamingResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from amazing import API_VERSION
from amazing.config import ELO_MAX, ELO_MIN, Settings
from amazing.derive import engine_versions, ladder, stats
from amazing.runner import AlreadyFinished, InvalidRequest
from amazing.service import Backend, to_summary
from amazing.store import MATCH_ID_RE, TERMINAL, pending_analysis
from amazing.uci import EngineCrashed, EngineTimeout
from amazing.util import iso

ANALYSIS_KEYS = ("matchId", "status", "analyzer", "moves", "summary", "reports", "createdAt")
STATUSES = ("queued", "running", "finished", "aborted", "error")
OUTCOMES = ("win", "draw", "loss")
COLOR_CHOICES = ("white", "black", "random", "alternate")
KEEPALIVE_S = 15.0


def error(status: int, code: str, message: str, details: Optional[Dict[str, Any]] = None) -> JSONResponse:
    body: Dict[str, Any] = {"code": code, "message": message}
    if details:
        body["details"] = details
    return JSONResponse(body, status_code=status)


def not_found(match_id: str) -> JSONResponse:
    return error(404, "match_not_found", f"No match with id {match_id!r}")


def _encode_cursor(item: Dict[str, Any]) -> str:
    raw = json.dumps([item["createdAt"], item["id"]]).encode()
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def _decode_cursor(cursor: str) -> List[str]:
    pad = "=" * (-len(cursor) % 4)
    val = json.loads(base64.urlsafe_b64decode(cursor + pad).decode())
    if not (isinstance(val, list) and len(val) == 2 and all(isinstance(v, str) for v in val)):
        raise ValueError("bad cursor")
    return val


def clean_analysis(a: Dict[str, Any]) -> Dict[str, Any]:
    """Serve only contract fields (analysis.json may be touched by other tools)."""
    return {k: a[k] for k in ANALYSIS_KEYS if k in a}


def sse(event: Dict[str, Any]) -> str:
    return f"id: {event['seq']}\nevent: {event['type']}\ndata: {json.dumps(event, ensure_ascii=False)}\n\n"


def create_app(settings: Optional[Settings] = None, agents_mode: str = "async") -> FastAPI:
    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        backend = Backend(settings, agents_mode=agents_mode)
        backend.start()
        app.state.backend = backend
        try:
            yield
        finally:
            await backend.shutdown()

    app = FastAPI(title="Amazing Chess API", version=API_VERSION, lifespan=lifespan,
                  docs_url="/api/docs", openapi_url="/api/openapi.json")
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
        allow_methods=["*"], allow_headers=["*"], expose_headers=["*"],
    )

    @app.exception_handler(RequestValidationError)
    async def _validation(_: Request, exc: RequestValidationError) -> JSONResponse:
        errs = [{"loc": list(e.get("loc", [])), "msg": e.get("msg")} for e in exc.errors()]
        return error(400, "invalid_request", "Request validation failed", {"errors": errs})

    @app.exception_handler(StarletteHTTPException)
    async def _http(_: Request, exc: StarletteHTTPException) -> JSONResponse:
        code = {404: "not_found", 405: "method_not_allowed"}.get(exc.status_code, "http_error")
        return error(exc.status_code, code, str(exc.detail))

    def be(request: Request) -> Backend:
        return request.app.state.backend

    # ----- health / engines --------------------------------------------------------------------
    @app.get("/api/health")
    async def get_health(request: Request) -> JSONResponse:
        b = be(request)
        body: Dict[str, Any] = {"status": "ok", "apiVersion": API_VERSION}
        try:
            body["stockfishVersion"] = await b.runner.stockfish_version()
        except (EngineCrashed, EngineTimeout, OSError):
            body["status"] = "degraded"
        try:
            body["latestEngineVersion"] = (await b.runner.engine_identity())[1]
        except (EngineCrashed, EngineTimeout, OSError):
            body["status"] = "degraded"
        return JSONResponse(body)

    @app.get("/api/engines")
    async def list_engines(request: Request) -> JSONResponse:
        b = be(request)
        current = None
        try:
            name, version = await b.runner.engine_identity()
            exe = b.settings.engine_command[0]
            created = iso() if b.settings.engine_is_placeholder or not os.path.exists(exe) else \
                iso(datetime.fromtimestamp(os.path.getmtime(exe), timezone.utc))
            current = {"version": version, "name": name, "createdAt": created}
            if b.settings.engine_is_placeholder:
                current["notes"] = "Python placeholder player (engine binary not built)"
        except (EngineCrashed, EngineTimeout, OSError):
            pass
        return JSONResponse(engine_versions(b.all_matches(), current))

    # ----- matches -------------------------------------------------------------------------------
    @app.get("/api/matches")
    async def list_matches(request: Request, status: Optional[str] = None, outcome: Optional[str] = None,
                           stockfishElo: Optional[int] = None, engineVersion: Optional[str] = None,
                           limit: int = 50, cursor: Optional[str] = None) -> JSONResponse:
        if status is not None and status not in STATUSES:
            return error(400, "invalid_status", f"status must be one of {', '.join(STATUSES)}")
        if outcome is not None and outcome not in OUTCOMES:
            return error(400, "invalid_outcome", f"outcome must be one of {', '.join(OUTCOMES)}")
        if stockfishElo is not None and not (ELO_MIN <= stockfishElo <= ELO_MAX):
            return error(400, "invalid_elo", f"stockfishElo must be between {ELO_MIN} and {ELO_MAX}")
        if not (1 <= limit <= 200):
            return error(400, "invalid_limit", "limit must be between 1 and 200")
        after = None
        if cursor:
            try:
                after = _decode_cursor(cursor)
            except (ValueError, TypeError):
                return error(400, "invalid_cursor", "cursor is not valid")
        items = [to_summary(m) for m in be(request).all_matches()]
        if status:
            items = [m for m in items if m["status"] == status]
        if outcome:
            items = [m for m in items if m.get("outcome") == outcome]
        if stockfishElo is not None:
            items = [m for m in items if m["stockfishElo"] == stockfishElo]
        if engineVersion:
            items = [m for m in items if m["engineVersion"] == engineVersion]
        items.sort(key=lambda m: (m["createdAt"], m["id"]), reverse=True)
        if after is not None:
            items = [m for m in items if (m["createdAt"], m["id"]) < (after[0], after[1])]
        page = items[:limit]
        next_cursor = _encode_cursor(page[-1]) if len(items) > limit else None
        return JSONResponse({"items": page, "nextCursor": next_cursor})

    @app.post("/api/matches")
    async def create_matches(request: Request) -> JSONResponse:
        try:
            body = await request.json()
        except ValueError:
            return error(400, "invalid_request", "Body must be JSON (CreateMatchRequest)")
        if not isinstance(body, dict):
            return error(400, "invalid_request", "Body must be a JSON object (CreateMatchRequest)")
        elo = body.get("stockfishElo")
        if not isinstance(elo, int) or isinstance(elo, bool) or not (ELO_MIN <= elo <= ELO_MAX):
            return error(400, "invalid_elo", f"stockfishElo must be an integer between {ELO_MIN} and {ELO_MAX}",
                         {"min": ELO_MIN, "max": ELO_MAX})
        color = body.get("engineColor", "alternate")
        if color not in COLOR_CHOICES:
            return error(400, "invalid_color", f"engineColor must be one of {', '.join(COLOR_CHOICES)}")
        count = body.get("count", 1)
        if not isinstance(count, int) or isinstance(count, bool) or not (1 <= count <= 100):
            return error(400, "invalid_count", "count must be an integer between 1 and 100")
        start_fen = body.get("startFen")
        if start_fen is not None and not isinstance(start_fen, str):
            return error(400, "invalid_fen", "startFen must be a string")
        version = body.get("engineVersion")
        if version is not None and not isinstance(version, str):
            return error(400, "invalid_request", "engineVersion must be a string")
        try:
            states = await be(request).submit(stockfish_elo=elo, engine_color=color, count=count,
                                              start_fen=start_fen, engine_version=version)
        except InvalidRequest as exc:
            return error(400, exc.code, exc.message, exc.details)
        return JSONResponse([st.summary() for st in states], status_code=202)

    @app.get("/api/matches/{matchId}")
    async def get_match(request: Request, matchId: str) -> JSONResponse:
        m = be(request).get_match(matchId) if MATCH_ID_RE.match(matchId) else None
        return JSONResponse(m) if m else not_found(matchId)

    @app.get("/api/matches/{matchId}/pgn")
    async def get_pgn(request: Request, matchId: str) -> Response:
        b = be(request)
        if not MATCH_ID_RE.match(matchId):
            return not_found(matchId)
        pgn = b.store.load_pgn(matchId)
        if pgn is None:
            if b.is_live(matchId):
                return error(404, "pgn_not_available", "The PGN is written when the game ends")
            return not_found(matchId)
        return PlainTextResponse(pgn, media_type="application/x-chess-pgn",
                                 headers={"Content-Disposition": f'inline; filename="{matchId}.pgn"'})

    @app.post("/api/matches/{matchId}/abort")
    async def abort_match(request: Request, matchId: str) -> JSONResponse:
        b = be(request)
        if not MATCH_ID_RE.match(matchId):
            return not_found(matchId)
        if not b.is_live(matchId):
            if b.store.exists(matchId):
                return error(409, "match_already_finished", f"Match {matchId} has already ended")
            return not_found(matchId)
        try:
            st = await b.runner.abort(matchId)
        except AlreadyFinished:
            return error(409, "match_already_finished", f"Match {matchId} has already ended")
        return JSONResponse(to_summary(b.get_match(matchId) or st.summary()))

    # ----- events ----------------------------------------------------------------------------------
    @app.get("/api/matches/{matchId}/events")
    async def stream_events(request: Request, matchId: str) -> Response:
        b = be(request)
        if not MATCH_ID_RE.match(matchId) or b.get_match(matchId) is None:
            return not_found(matchId)
        last_id: Optional[int] = None
        raw_last = request.headers.get("last-event-id")
        if raw_last is not None:
            try:
                last_id = int(raw_last.strip())
            except ValueError:
                last_id = None
        return StreamingResponse(event_stream(request, b, matchId, last_id), media_type="text/event-stream",
                                 headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

    # ----- analysis --------------------------------------------------------------------------------
    @app.get("/api/matches/{matchId}/analysis")
    async def get_analysis(request: Request, matchId: str) -> JSONResponse:
        b = be(request)
        if not MATCH_ID_RE.match(matchId) or b.get_match(matchId) is None:
            return not_found(matchId)
        a = b.store.read_analysis(matchId)
        return JSONResponse(clean_analysis(a) if a else pending_analysis(matchId))

    @app.post("/api/matches/{matchId}/analysis")
    async def rerun_analysis(request: Request, matchId: str) -> JSONResponse:
        b = be(request)
        if not MATCH_ID_RE.match(matchId):
            return not_found(matchId)
        if b.is_live(matchId):
            return error(409, "match_not_finished", "Analysis runs once the game has ended")
        if not b.store.exists(matchId):
            return not_found(matchId)
        if matchId in b.analysis_tracked:
            return error(409, "analysis_in_progress", "Analysis for this match is already queued or running")
        return JSONResponse(b.rerun_analysis(matchId), status_code=202)

    # ----- ladder / stats ------------------------------------------------------------------------
    @app.get("/api/ladder")
    async def get_ladder(request: Request) -> JSONResponse:
        return JSONResponse(ladder(be(request).all_matches()))

    @app.get("/api/stats")
    async def get_stats(request: Request, engineVersion: Optional[str] = None) -> JSONResponse:
        return JSONResponse(stats(be(request).all_matches(), engineVersion))

    return app


async def event_stream(request: Request, b: Backend, match_id: str, last_id: Optional[int]) -> AsyncIterator[str]:
    """SSE per contracts/events.md: snapshot on connect (or resume after Last-Event-ID), then live
    events; closes after analysis ready/failed, or right after the end for completed matches."""
    lg = b.event_log(match_id)
    cursor: int
    if last_id is not None and lg.events and lg.events[0]["seq"] <= last_id + 1 and last_id <= lg.last_seq:
        cursor = last_id
    else:
        match = b.get_match(match_id)
        if match is None:
            return
        status = match["status"]
        started = lg.find("match.started")
        if status in TERMINAL:
            end_evt = lg.find("match.finished") or lg.find("match.snapshot")
            base = end_evt["seq"] if end_evt else len(match.get("moves", [])) + 1
            if status == "finished":
                yield sse({"type": "match.snapshot", "matchId": match_id, "seq": base - 1, "at": iso(),
                           "match": match})
                fin = end_evt if end_evt and end_evt["type"] == "match.finished" else {
                    "type": "match.finished", "matchId": match_id, "seq": base,
                    "at": match.get("finishedAt") or iso(), "result": match["result"],
                    "outcome": match["outcome"], "termination": match["termination"]}
                yield sse(fin)
            else:
                yield sse({"type": "match.snapshot", "matchId": match_id, "seq": base, "at": iso(),
                           "match": match})
            cursor = base
            b.poll_analysis(match_id)
            if not _analysis_open(b, match_id):
                return
        elif status == "running" and started is not None:
            cursor = lg.last_seq
            yield sse({"type": "match.snapshot", "matchId": match_id, "seq": max(cursor, 0), "at": iso(),
                       "match": match})
        else:  # queued (or engines still starting): wait for match.started
            cursor = lg.last_seq

    loop = asyncio.get_running_loop()
    quiet_since = loop.time()
    last_keepalive = loop.time()
    while True:
        new = lg.after(cursor)
        closing = False
        for e in new:
            cursor = e["seq"]
            yield sse(e)
            if e["type"] == "analysis.updated" and e.get("analysisStatus") in ("ready", "failed"):
                closing = True
        if closing:
            return
        if new:
            quiet_since = loop.time()
        if await request.is_disconnected():
            return
        if not b.is_live(match_id):
            # watch analysis.json for reports saved by the agents (other processes)
            b.poll_analysis(match_id)
            if lg.after(cursor):
                continue
            # a completed match with no analysis work pending: nothing more will come
            if not _analysis_open(b, match_id) and loop.time() - quiet_since > 2.0:
                return
        await lg.wait_for_new(cursor, 1.5)
        if not lg.after(cursor) and loop.time() - last_keepalive > KEEPALIVE_S:
            last_keepalive = loop.time()
            yield ": keepalive\n\n"


def _analysis_open(b: Backend, match_id: str) -> bool:
    """Is more analysis progress expected for a completed match?"""
    if match_id in b.analysis_tracked:
        return True
    return b.store.analysis_status(match_id) == "running"
