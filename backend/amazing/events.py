"""In-process per-match event logs for the SSE stream (contracts/events.md)."""
from __future__ import annotations

import asyncio
from typing import Any, Dict, List, Optional

from amazing.util import iso


class MatchEventLog:
    def __init__(self, match_id: str, next_seq: int = 0):
        self.match_id = match_id
        self.events: List[Dict[str, Any]] = []
        self.next_seq = next_seq
        self._cond: Optional[asyncio.Condition] = None

    def _condition(self) -> asyncio.Condition:
        if self._cond is None:
            self._cond = asyncio.Condition()
        return self._cond

    @property
    def last_seq(self) -> int:
        return self.next_seq - 1

    def append(self, type_: str, **payload: Any) -> Dict[str, Any]:
        event = {"type": type_, "matchId": self.match_id, "seq": self.next_seq, "at": iso(), **payload}
        self.next_seq += 1
        self.events.append(event)
        self._notify()
        return event

    def _notify(self) -> None:
        cond = self._cond
        if cond is None:
            return

        async def _wake() -> None:
            async with cond:
                cond.notify_all()

        try:
            asyncio.get_running_loop()
            asyncio.ensure_future(_wake())
        except RuntimeError:
            pass

    def after(self, seq: int) -> List[Dict[str, Any]]:
        return [e for e in self.events if e["seq"] > seq]

    def find(self, type_: str) -> Optional[Dict[str, Any]]:
        for e in reversed(self.events):
            if e["type"] == type_:
                return e
        return None

    async def wait_for_new(self, seq: int, timeout: float) -> None:
        cond = self._condition()
        async with cond:
            if self.last_seq > seq:
                return
            try:
                await asyncio.wait_for(cond.wait(), timeout)
            except asyncio.TimeoutError:
                pass


class EventHub:
    def __init__(self) -> None:
        self.logs: Dict[str, MatchEventLog] = {}

    def get(self, match_id: str) -> Optional[MatchEventLog]:
        return self.logs.get(match_id)

    def log(self, match_id: str, next_seq: int = 0) -> MatchEventLog:
        lg = self.logs.get(match_id)
        if lg is None:
            lg = MatchEventLog(match_id, next_seq)
            self.logs[match_id] = lg
        return lg

    def emit(self, match_id: str, type_: str, **payload: Any) -> Dict[str, Any]:
        return self.log(match_id).append(type_, **payload)
