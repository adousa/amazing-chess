"""Small helpers: timestamps and atomic file writes."""
from __future__ import annotations

import json
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def iso(dt: Optional[datetime] = None) -> str:
    dt = dt or utcnow()
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_iso(value: str) -> datetime:
    return datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)


def dumps(data: Any) -> str:
    return json.dumps(data, indent=2, ensure_ascii=False) + "\n"


def _write_temp(path: Path, text: str) -> str:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=str(path.parent))
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        fh.write(text)
        fh.flush()
        os.fsync(fh.fileno())
    return tmp


def write_atomic(path: Path, text: str) -> None:
    """Write via temp file + rename (replaces an existing file atomically)."""
    tmp = _write_temp(path, text)
    try:
        os.replace(tmp, path)
    except BaseException:
        _silent_unlink(tmp)
        raise


def write_new_atomic(path: Path, text: str) -> None:
    """Write atomically but NEVER overwrite: raises FileExistsError if `path` exists.

    Uses a hard link from the temp file, which fails atomically if the target exists.
    """
    if path.exists():
        raise FileExistsError(str(path))
    tmp = _write_temp(path, text)
    try:
        os.link(tmp, path)
    finally:
        _silent_unlink(tmp)


def _silent_unlink(p: str) -> None:
    try:
        os.unlink(p)
    except OSError:
        pass
