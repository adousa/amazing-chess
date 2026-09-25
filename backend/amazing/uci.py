"""Minimal asyncio UCI client with exact control over timing (used by the match runner).

We deliberately do not use python-chess's engine layer for matches: we need to send exactly
`go movetime <ms>`, measure wall time from `go` to `bestmove`, keep the raw bestmove string
(to adjudicate illegal moves ourselves) and distinguish crashes from time-outs.
"""
from __future__ import annotations

import asyncio
import os
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional


class EngineCrashed(Exception):
    """The engine process exited or stopped responding to protocol commands."""


class EngineTimeout(Exception):
    """The engine did not answer `go` within the hard deadline."""


class Aborted(Exception):
    """The match was aborted while a side was thinking."""


@dataclass
class GoResult:
    bestmove: Optional[str]
    elapsed_ms: int
    info: Dict[str, Any] = field(default_factory=dict)


def parse_info(line: str) -> Optional[Dict[str, Any]]:
    """Parse a UCI `info` line into EngineThinking-like fields (None if uninteresting)."""
    tokens = line.split()
    if not tokens or tokens[0] != "info":
        return None
    out: Dict[str, Any] = {}
    i = 1
    n = len(tokens)
    while i < n:
        tok = tokens[i]
        if tok == "string":
            break
        if tok in ("depth", "seldepth", "nodes", "nps", "multipv", "time", "hashfull", "tbhits") and i + 1 < n:
            try:
                out[tok] = int(tokens[i + 1])
            except ValueError:
                pass
            i += 2
            continue
        if tok == "score" and i + 2 < n:
            kind, val = tokens[i + 1], tokens[i + 2]
            try:
                if kind == "cp":
                    out["scoreCp"] = int(val)
                    out["mateIn"] = None
                elif kind == "mate":
                    out["mateIn"] = int(val)
                    out["scoreCp"] = None
            except ValueError:
                pass
            i += 3
            while i < n and tokens[i] in ("lowerbound", "upperbound"):
                i += 1
            continue
        if tok == "pv":
            out["pv"] = tokens[i + 1:]
            break
        if tok in ("currmove", "currmovenumber", "refutation", "currline", "cpuload", "wdl", "sbhits"):
            # skip value(s) we do not use
            i += 2 if tok not in ("wdl",) else 4
            continue
        i += 1
    if "multipv" in out and out["multipv"] != 1:
        return None
    if not any(k in out for k in ("scoreCp", "mateIn", "pv")):
        return None
    out.pop("multipv", None)
    return out


THINKING_KEYS = ("scoreCp", "mateIn", "depth", "seldepth", "nodes", "nps", "pv")


def thinking_from(info: Dict[str, Any]) -> Dict[str, Any]:
    return {k: info[k] for k in THINKING_KEYS if k in info}


class UciEngine:
    def __init__(self, command: List[str], label: str):
        self.command = command
        self.label = label
        self.proc: Optional[asyncio.subprocess.Process] = None
        self.lines: "asyncio.Queue[Optional[str]]" = asyncio.Queue()
        self.id: Dict[str, str] = {}
        self.options: Dict[str, str] = {}
        self._reader: Optional[asyncio.Task] = None
        self.dead = False

    @classmethod
    async def start(cls, command: List[str], label: str, cwd: Optional[str] = None,
                    handshake_timeout: float = 15.0) -> "UciEngine":
        eng = cls(command, label)
        try:
            eng.proc = await asyncio.create_subprocess_exec(
                *command,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL,
                cwd=cwd,
                env=os.environ.copy(),
            )
        except (OSError, ValueError) as exc:
            raise EngineCrashed(f"{label}: cannot start {command!r}: {exc}") from exc
        eng._reader = asyncio.ensure_future(eng._read_loop())
        await eng.send("uci")
        while True:
            line = await eng._next_line(handshake_timeout)
            if line.startswith("id "):
                parts = line.split(None, 2)
                if len(parts) == 3:
                    eng.id[parts[1]] = parts[2].strip()
            elif line.startswith("option name "):
                rest = line[len("option name "):]
                name = rest.split(" type ")[0].strip()
                eng.options[name.lower()] = name
            elif line.strip() == "uciok":
                break
        return eng

    async def _read_loop(self) -> None:
        assert self.proc and self.proc.stdout
        try:
            while True:
                raw = await self.proc.stdout.readline()
                if not raw:
                    break
                self.lines.put_nowait(raw.decode("utf-8", "replace").rstrip("\r\n"))
        except Exception:
            pass
        finally:
            self.dead = True
            self.lines.put_nowait(None)

    async def _next_line(self, timeout: Optional[float]) -> str:
        try:
            if timeout is None:
                line = await self.lines.get()
            else:
                line = await asyncio.wait_for(self.lines.get(), timeout)
        except asyncio.TimeoutError:
            raise EngineTimeout(f"{self.label}: no response within {timeout}s")
        if line is None:
            self.lines.put_nowait(None)  # keep the EOF marker for later readers
            raise EngineCrashed(f"{self.label}: engine process exited")
        return line

    async def send(self, line: str) -> None:
        if self.proc is None or self.proc.stdin is None or self.dead:
            raise EngineCrashed(f"{self.label}: not running")
        try:
            self.proc.stdin.write((line + "\n").encode())
            await self.proc.stdin.drain()
        except (BrokenPipeError, ConnectionResetError, RuntimeError) as exc:
            raise EngineCrashed(f"{self.label}: pipe closed: {exc}") from exc

    def has_option(self, name: str) -> bool:
        return name.lower() in self.options

    async def set_option(self, name: str, value: Any) -> None:
        real = self.options.get(name.lower(), name)
        if isinstance(value, bool):
            value = "true" if value else "false"
        await self.send(f"setoption name {real} value {value}")

    async def isready(self, timeout: float = 15.0) -> None:
        await self.send("isready")
        while True:
            line = await self._next_line(timeout)
            if line.strip() == "readyok":
                return

    async def new_game(self) -> None:
        await self.send("ucinewgame")
        await self.isready()

    async def go(self, position_cmd: str, movetime_ms: int, hard_deadline_s: float,
                 on_info: Optional[Callable[[Dict[str, Any]], None]] = None,
                 abort: Optional[asyncio.Event] = None) -> GoResult:
        """Search the position; return the raw bestmove and the measured wall time.

        Raises EngineTimeout if no bestmove arrives before `hard_deadline_s` after `go`,
        EngineCrashed if the process dies, Aborted if `abort` is set meanwhile.
        """
        await self.send(position_cmd)
        await self.isready()
        last: Dict[str, Any] = {}
        await self.send(f"go movetime {movetime_ms}")
        t0 = time.monotonic()
        while True:
            remaining = hard_deadline_s - (time.monotonic() - t0)
            if remaining <= 0:
                raise EngineTimeout(f"{self.label}: no bestmove within {hard_deadline_s:.1f}s")
            get = asyncio.ensure_future(self._next_line(remaining))
            waiters = {get}
            abort_wait = None
            if abort is not None:
                abort_wait = asyncio.ensure_future(abort.wait())
                waiters.add(abort_wait)
            done, _ = await asyncio.wait(waiters, return_when=asyncio.FIRST_COMPLETED)
            if abort_wait is not None and abort_wait in done:
                get.cancel()
                raise Aborted()
            if abort_wait is not None:
                abort_wait.cancel()
            line = get.result()  # may raise EngineTimeout / EngineCrashed
            if line.startswith("bestmove"):
                elapsed_ms = int(round((time.monotonic() - t0) * 1000))
                parts = line.split()
                best = parts[1] if len(parts) > 1 else None
                return GoResult(bestmove=best, elapsed_ms=elapsed_ms, info=last)
            if line.startswith("info"):
                parsed = parse_info(line)
                if parsed:
                    last = {**last, **parsed}
                    if on_info:
                        on_info(dict(last))

    async def stop_and_drain(self, timeout: float = 1.0) -> None:
        """Send `stop` and swallow output until bestmove (best effort)."""
        try:
            await self.send("stop")
            while True:
                line = await self._next_line(timeout)
                if line.startswith("bestmove"):
                    return
        except (EngineTimeout, EngineCrashed):
            return

    async def quit(self) -> None:
        if self.proc is None:
            return
        try:
            if not self.dead:
                await self.send("quit")
            await asyncio.wait_for(self.proc.wait(), 2.0)
        except Exception:
            try:
                self.proc.kill()
            except ProcessLookupError:
                pass
            try:
                await asyncio.wait_for(self.proc.wait(), 2.0)
            except Exception:
                pass
        if self._reader:
            self._reader.cancel()


async def probe_id(command: List[str], cwd: Optional[str] = None, timeout: float = 10.0) -> Dict[str, str]:
    """Start an engine, read its `id` lines and quit."""
    eng = await UciEngine.start(command, "probe", cwd=cwd, handshake_timeout=timeout)
    try:
        return dict(eng.id)
    finally:
        await eng.quit()


def split_engine_name(id_name: Optional[str]) -> "tuple[str, str]":
    """`AmazingChess 0.1.0` -> ("AmazingChess", "0.1.0")."""
    if not id_name:
        return "unknown", "unknown"
    parts = id_name.strip().split(None, 1)
    if len(parts) == 2:
        return parts[0], parts[1].strip()
    return parts[0], "unknown"
