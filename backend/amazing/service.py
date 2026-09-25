"""The backend core shared by the HTTP API and the CLI: store + runner + analysis worker + events."""
from __future__ import annotations

import asyncio
import logging
import sys
from typing import Any, Dict, List, Optional, Set

from amazing import agents as agents_mod
from amazing.analysis import run_engine_analysis
from amazing.config import Settings, load_settings
from amazing.events import EventHub, MatchEventLog
from amazing.runner import MatchRunner, MatchState
from amazing.store import TERMINAL, GameStore, pending_analysis

log = logging.getLogger("amazing.service")

SUMMARY_KEYS = ("id", "status", "stockfishElo", "engineColor", "engineVersion", "result", "outcome",
                "termination", "plyCount", "createdAt", "startedAt", "finishedAt", "analysisStatus")


def to_summary(match: Dict[str, Any]) -> Dict[str, Any]:
    return {k: match.get(k) for k in SUMMARY_KEYS if k in match}


class Backend:
    """`agents_mode`: "async" (server: run agents as child processes and watch them),
    "detached" (CLI: spawn and do not wait), "wait" (CLI: spawn and wait), "off"."""

    def __init__(self, settings: Optional[Settings] = None, agents_mode: str = "async"):
        self.settings = settings or load_settings()
        self.store = GameStore(self.settings.games_dir)
        self.hub = EventHub()
        self.runner = MatchRunner(self.settings, self.store, self.hub, on_saved=self._on_saved)
        self.agents_mode = agents_mode if agents_mode == "off" or agents_mod.agents_wanted(self.settings) else "off"
        self.analysis_queue: "asyncio.Queue[str]" = asyncio.Queue()
        self.analysis_tracked: Set[str] = set()
        self._agent_tasks: Set[asyncio.Task] = set()
        self._agent_sem = asyncio.Semaphore(self.settings.agents_parallel)
        self._worker: Optional[asyncio.Task] = None
        self._analysis_seen: Dict[str, tuple] = {}

    # ----- lifecycle -----------------------------------------------------------------------
    def start(self) -> None:
        self.runner.start()
        if self._worker is None:
            self._worker = asyncio.ensure_future(self._analysis_worker())

    async def shutdown(self) -> None:
        await self.runner.shutdown()
        if self._worker:
            self._worker.cancel()
            self._worker = None
        for t in list(self._agent_tasks):
            t.cancel()

    async def drain_analysis(self) -> None:
        """Wait until the engine-analysis queue is empty (agents may still be running)."""
        while self.analysis_tracked - self._agents_running_ids():
            await asyncio.sleep(0.2)

    async def drain_agents(self) -> None:
        while self._agent_tasks:
            await asyncio.wait(list(self._agent_tasks))

    def _agents_running_ids(self) -> Set[str]:
        return {getattr(t, "match_id", "") for t in self._agent_tasks}

    # ----- events ----------------------------------------------------------------------------
    def event_log(self, match_id: str) -> MatchEventLog:
        """Per-match log; for games only on disk, seq continues after snapshot/finished."""
        lg = self.hub.get(match_id)
        if lg is None:
            raw = self.store.load_raw(match_id)
            base = (raw.get("plyCount", len(raw.get("moves", []))) + 2) if raw else 0
            lg = self.hub.log(match_id, base)
        return lg

    def emit_analysis(self, match_id: str, status: str, part: Optional[str] = None) -> None:
        payload: Dict[str, Any] = {"analysisStatus": status}
        if part:
            payload["part"] = part
        self.event_log(match_id).append("analysis.updated", **payload)
        self._analysis_seen[match_id] = self._analysis_state(match_id)

    def _analysis_state(self, match_id: str) -> tuple:
        a = self.store.read_analysis(match_id) or {}
        reps = a.get("reports") or {}
        return (self.store.analysis_status(match_id),
                *((reps.get(key) or {}).get("status", "pending") for key, _ in agents_mod.REPORT_KEYS))

    def poll_analysis(self, match_id: str) -> None:
        """Emit `analysis.updated` for changes made to analysis.json by other processes (the
        agents via scripts/save_agent_report.py). Cheap: analysis.json is cached by mtime."""
        now = self._analysis_state(match_id)
        prev = self._analysis_seen.get(match_id)
        self._analysis_seen[match_id] = now
        if prev is None or prev == now:
            return
        lg = self.event_log(match_id)
        changed = False
        for i, (_, agent) in enumerate(agents_mod.REPORT_KEYS, start=1):
            if prev[i] != now[i]:
                lg.append("analysis.updated", analysisStatus=now[0], part=agent)
                changed = True
        if not changed and prev[0] != now[0]:
            lg.append("analysis.updated", analysisStatus=now[0])

    # ----- matches ---------------------------------------------------------------------------
    def get_match(self, match_id: str) -> Optional[Dict[str, Any]]:
        st = self.runner.active.get(match_id)
        if st is not None and not st.saved:
            return st.to_match(self.store.analysis_status(match_id) if st.status in TERMINAL else "pending")
        return self.store.load_match(match_id)

    def all_matches(self) -> List[Dict[str, Any]]:
        """Saved games + in-memory queued/running matches (full Match dicts)."""
        saved = self.store.list_matches()
        ids = {m["id"] for m in saved}
        live = [st.to_match("pending") for st in list(self.runner.active.values())
                if st.id not in ids and not st.saved]
        return saved + live

    def is_live(self, match_id: str) -> bool:
        st = self.runner.active.get(match_id)
        return st is not None and not st.saved

    # ----- analysis ---------------------------------------------------------------------------
    async def _on_saved(self, match: Dict[str, Any]) -> None:
        self.enqueue_analysis(match["id"])

    def enqueue_analysis(self, match_id: str) -> None:
        if match_id in self.analysis_tracked:
            return
        self.analysis_tracked.add(match_id)
        self.analysis_queue.put_nowait(match_id)

    def rerun_analysis(self, match_id: str) -> Dict[str, Any]:
        """Archive the current analysis.json into analysis-history/ and queue a fresh run."""
        self.store.archive_analysis(match_id)
        fresh = pending_analysis(match_id)
        self.store.write_analysis(match_id, fresh)
        self.enqueue_analysis(match_id)
        self.emit_analysis(match_id, "pending")
        return fresh

    async def _analysis_worker(self) -> None:
        while True:
            mid = await self.analysis_queue.get()
            try:
                await self._analyse_one(mid)
            except asyncio.CancelledError:
                raise
            except Exception:
                log.exception("analysis of %s failed", mid)
            finally:
                if mid not in self._agents_running_ids():
                    self.analysis_tracked.discard(mid)

    async def _analyse_one(self, mid: str) -> None:
        raw = self.store.load_raw(mid)
        if raw is None:
            return
        with_agents = self.agents_mode != "off" and len(raw.get("moves", [])) > 0
        self.emit_analysis(mid, "running", "engine")
        try:
            await asyncio.get_running_loop().run_in_executor(
                None, lambda: run_engine_analysis(self.store, mid, self.settings,
                                                  final_status="running" if with_agents else "ready"))
        except Exception:
            log.exception("engine analysis of %s failed", mid)
            self.emit_analysis(mid, "failed", "engine")
            return
        if not with_agents:
            if len(raw.get("moves", [])) == 0:
                agents_mod.mark_skipped(self.store, mid, "Not run: the game has no moves.")
            self.emit_analysis(mid, "ready", "engine")
            return
        if self.agents_mode == "detached":
            agents_mod.spawn_detached(mid)
            return
        task = asyncio.ensure_future(self._run_agents(mid))
        task.match_id = mid  # type: ignore[attr-defined]
        self._agent_tasks.add(task)

        def _done(t: asyncio.Task) -> None:
            self._agent_tasks.discard(t)
            self.analysis_tracked.discard(mid)

        task.add_done_callback(_done)

    async def _run_agents(self, mid: str) -> None:
        async with self._agent_sem:
            proc = await asyncio.create_subprocess_exec(
                sys.executable, "-m", "amazing", "agents", mid,
                stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.DEVNULL, start_new_session=True)
            self.poll_analysis(mid)
            while True:
                try:
                    await asyncio.wait_for(proc.wait(), 1.5)
                    break
                except asyncio.TimeoutError:
                    self.poll_analysis(mid)
            self.poll_analysis(mid)
            last = self.event_log(mid).find("analysis.updated")
            final = self.store.analysis_status(mid)
            if not last or last.get("analysisStatus") != final:
                self.emit_analysis(mid, final)

    # ----- matches (async helpers) --------------------------------------------------------------
    async def submit(self, **kw: Any) -> List[MatchState]:
        return await self.runner.submit(**kw)
