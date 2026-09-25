"""Append-only game store on disk (the competition evidence).

Layout (docs/02-architecture.md):

    games/<matchId>/game.pgn          immutable, written once when the game ends
    games/<matchId>/match.json        contract `Match`, immutable, written once
    games/<matchId>/analysis.json     contract `Analysis` (mutable; agents merge reports into it)
    games/<matchId>/analysis-history/ previous analyses when re-run
"""
from __future__ import annotations

import contextlib
import fcntl
import hashlib
import json
import os
import re
import tempfile
from pathlib import Path
from typing import Any, Callable, Dict, Iterator, List, Optional, Tuple

from amazing.util import dumps, utcnow, write_atomic, write_new_atomic

MATCH_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
TERMINAL = ("finished", "aborted", "error")


class GameExistsError(Exception):
    """Refusing to overwrite a saved game (games are evidence)."""


def pending_report(agent: str) -> Dict[str, Any]:
    return {"agent": agent, "status": "pending"}


def pending_analysis(match_id: str) -> Dict[str, Any]:
    return {
        "matchId": match_id,
        "status": "pending",
        "reports": {"gmCoach": pending_report("gm-coach"), "engineDev": pending_report("engine-dev")},
    }


class GameStore:
    def __init__(self, root: Path):
        self.root = Path(root)
        self._match_cache: Dict[str, Dict[str, Any]] = {}
        self._analysis_cache: Dict[str, Tuple[Tuple[int, int], Dict[str, Any]]] = {}

    # ----- paths -------------------------------------------------------------------------
    def dir(self, match_id: str) -> Path:
        if not MATCH_ID_RE.match(match_id):
            raise ValueError(f"invalid match id {match_id!r}")
        return self.root / match_id

    def match_path(self, match_id: str) -> Path:
        return self.dir(match_id) / "match.json"

    def pgn_path(self, match_id: str) -> Path:
        return self.dir(match_id) / "game.pgn"

    def analysis_path(self, match_id: str) -> Path:
        return self.dir(match_id) / "analysis.json"

    # ----- ids ---------------------------------------------------------------------------
    def reserve_id(self, date: str, elo: int, taken: "set[str]" = frozenset()) -> str:
        """Allocate `m_<yyyymmdd>_<elo>_<nnn>` and reserve it by creating its directory."""
        self.root.mkdir(parents=True, exist_ok=True)
        prefix = f"m_{date}_{elo}_"
        highest = 0
        for entry in os.listdir(self.root):
            if entry.startswith(prefix):
                tail = entry[len(prefix):]
                if tail.isdigit():
                    highest = max(highest, int(tail))
        n = highest + 1
        while True:
            mid = f"{prefix}{n:03d}"
            if mid not in taken:
                try:
                    os.mkdir(self.root / mid)
                    return mid
                except FileExistsError:
                    pass
            n += 1

    # ----- games (write once) --------------------------------------------------------------
    def save_game(self, match: Dict[str, Any], pgn_text: str) -> None:
        mid = match["id"]
        d = self.dir(mid)
        d.mkdir(parents=True, exist_ok=True)
        mp, pp = d / "match.json", d / "game.pgn"
        if mp.exists() or pp.exists():
            raise GameExistsError(f"game {mid} already saved; refusing to overwrite evidence")
        try:
            write_new_atomic(pp, pgn_text)
            write_new_atomic(mp, dumps(match))
        except FileExistsError as exc:
            raise GameExistsError(str(exc)) from exc
        self._match_cache[mid] = json.loads(json.dumps(match))

    def exists(self, match_id: str) -> bool:
        try:
            return self.match_path(match_id).exists()
        except ValueError:
            return False

    def load_raw(self, match_id: str) -> Optional[Dict[str, Any]]:
        """match.json exactly as saved (cached: the file is immutable)."""
        if match_id in self._match_cache:
            return self._match_cache[match_id]
        try:
            p = self.match_path(match_id)
        except ValueError:
            return None
        if not p.exists():
            return None
        data = json.loads(p.read_text(encoding="utf-8"))
        self._match_cache[match_id] = data
        return data

    def load_match(self, match_id: str) -> Optional[Dict[str, Any]]:
        """match.json with `analysisStatus` derived from analysis.json."""
        raw = self.load_raw(match_id)
        if raw is None:
            return None
        out = dict(raw)
        out["analysisStatus"] = self.analysis_status(match_id)
        return out

    def load_pgn(self, match_id: str) -> Optional[str]:
        try:
            p = self.pgn_path(match_id)
        except ValueError:
            return None
        return p.read_text(encoding="utf-8") if p.exists() else None

    def list_ids(self) -> List[str]:
        if not self.root.exists():
            return []
        out = []
        for entry in os.scandir(self.root):
            if entry.is_dir() and MATCH_ID_RE.match(entry.name) and os.path.exists(os.path.join(entry.path, "match.json")):
                out.append(entry.name)
        return out

    def list_matches(self) -> List[Dict[str, Any]]:
        out = []
        for mid in self.list_ids():
            try:
                m = self.load_match(mid)
            except (OSError, ValueError):
                continue
            if m is not None:
                out.append(m)
        return out

    # ----- analysis (mutable, separate file) --------------------------------------------------
    def read_analysis(self, match_id: str) -> Optional[Dict[str, Any]]:
        try:
            p = self.analysis_path(match_id)
            st = p.stat()
        except (ValueError, FileNotFoundError):
            return None
        key = (st.st_mtime_ns, st.st_size)
        cached = self._analysis_cache.get(match_id)
        if cached and cached[0] == key:
            return cached[1]
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None
        self._analysis_cache[match_id] = (key, data)
        return data

    def analysis_status(self, match_id: str) -> str:
        a = self.read_analysis(match_id)
        if not a:
            return "pending"
        st = a.get("status")
        return st if st in ("pending", "running", "ready", "failed") else "pending"

    @contextlib.contextmanager
    def analysis_lock(self, match_id: str) -> Iterator[None]:
        """Advisory lock shared with scripts/save_agent_report.py (same lock-file naming)."""
        match_dir = (self.root / match_id).resolve()
        key = hashlib.sha1(str(match_dir).encode()).hexdigest()[:16]
        lock_path = Path(tempfile.gettempdir()) / f"amazing-chess-analysis-{key}.lock"
        with open(lock_path, "w") as fh:
            fcntl.flock(fh, fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(fh, fcntl.LOCK_UN)

    def write_analysis(self, match_id: str, data: Dict[str, Any]) -> None:
        with self.analysis_lock(match_id):
            write_atomic(self.analysis_path(match_id), dumps(data))

    def update_analysis(self, match_id: str,
                        fn: Callable[[Dict[str, Any]], Optional[Dict[str, Any]]]) -> Optional[Dict[str, Any]]:
        """Locked read-modify-write of analysis.json. `fn` gets a copy and returns the new
        document (or None to leave the file unchanged)."""
        with self.analysis_lock(match_id):
            p = self.analysis_path(match_id)
            try:
                current = json.loads(p.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                return None
            new = fn(json.loads(json.dumps(current)))
            if new is not None:
                write_atomic(p, dumps(new))
            return new

    def archive_analysis(self, match_id: str) -> Optional[Path]:
        """Move the current analysis.json into analysis-history/<timestamp>.json."""
        src = self.analysis_path(match_id)
        if not src.exists():
            return None
        hist = self.dir(match_id) / "analysis-history"
        hist.mkdir(exist_ok=True)
        with self.analysis_lock(match_id):
            return self._archive_locked(match_id, src, hist)

    def _archive_locked(self, match_id: str, src: Path, hist: Path) -> Optional[Path]:
        if not src.exists():
            return None
        stamp = utcnow().strftime("%Y%m%dT%H%M%SZ")
        dst = hist / f"{stamp}.json"
        i = 1
        while dst.exists():
            dst = hist / f"{stamp}-{i}.json"
            i += 1
        os.replace(src, dst)
        self._analysis_cache.pop(match_id, None)
        return dst
