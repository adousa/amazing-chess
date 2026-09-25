"""Runtime configuration, read from environment variables (with defaults)."""
from __future__ import annotations

import json
import os
import shlex
import shutil
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List

REPO_ROOT = Path(__file__).resolve().parents[2]

#: The competition rule: at most 5 s of thinking time per move.
RULE_MOVE_LIMIT_MS = 5000
ELO_MIN = 1320
ELO_MAX = 3190


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    return int(raw)


def placeholder_command() -> List[str]:
    return [sys.executable, "-m", "amazing.placeholder_engine"]


@dataclass
class Settings:
    repo_root: Path
    games_dir: Path
    engine_command: List[str]
    engine_is_placeholder: bool
    stockfish_command: List[str]
    move_time_ms: int
    parallel: int
    sf_threads: int
    sf_hash_mb: int
    engine_hash_mb: int
    engine_options: Dict[str, Any] = field(default_factory=dict)
    analysis_depth: int = 18
    analysis_threads: int = 1
    analysis_hash_mb: int = 128
    agents: bool = True
    agents_parallel: int = 1
    agents_timeout_s: int = 1800
    claude_command: List[str] = field(default_factory=lambda: ["claude"])

    @property
    def go_movetime_ms(self) -> int:
        """`go movetime` sent to both sides: the limit minus a 100 ms safety margin."""
        return max(self.move_time_ms - 100, 50)


def load_settings() -> Settings:
    repo_root = Path(os.environ.get("AC_REPO_ROOT", str(REPO_ROOT)))
    games_dir = Path(os.environ.get("AC_GAMES_DIR", str(repo_root / "games")))

    engine_env = os.environ.get("AC_ENGINE_PATH")
    placeholder = False
    if engine_env:
        engine_command = shlex.split(engine_env)
        if engine_command[:3] == ["python", "-m", "amazing.placeholder_engine"]:
            engine_command[0] = sys.executable
    else:
        default_bin = repo_root / "engine" / "target" / "release" / "amazing-chess"
        if default_bin.exists():
            engine_command = [str(default_bin)]
        else:
            engine_command = placeholder_command()
            placeholder = True
    if "amazing.placeholder_engine" in engine_command:
        placeholder = True

    sf_env = os.environ.get("AC_STOCKFISH_PATH")
    if sf_env:
        stockfish_command = shlex.split(sf_env)
    else:
        stockfish_command = [shutil.which("stockfish") or "stockfish"]

    move_time_ms = _env_int("AC_MOVE_TIME_MS", RULE_MOVE_LIMIT_MS)
    if move_time_ms > RULE_MOVE_LIMIT_MS:
        raise ValueError(f"AC_MOVE_TIME_MS={move_time_ms} exceeds the {RULE_MOVE_LIMIT_MS} ms rule limit")

    opts_raw = os.environ.get("AC_ENGINE_OPTIONS", "").strip()
    engine_options = json.loads(opts_raw) if opts_raw else {}

    claude_env = os.environ.get("AC_CLAUDE_PATH")
    claude_command = shlex.split(claude_env) if claude_env else [shutil.which("claude") or "claude"]

    return Settings(
        repo_root=repo_root,
        games_dir=games_dir,
        engine_command=engine_command,
        engine_is_placeholder=placeholder,
        stockfish_command=stockfish_command,
        move_time_ms=move_time_ms,
        parallel=max(1, _env_int("AC_PARALLEL", 2)),
        sf_threads=_env_int("AC_SF_THREADS", 1),
        sf_hash_mb=_env_int("AC_SF_HASH_MB", 64),
        engine_hash_mb=_env_int("AC_ENGINE_HASH_MB", 64),
        engine_options=engine_options,
        analysis_depth=_env_int("AC_ANALYSIS_DEPTH", 18),
        analysis_threads=_env_int("AC_ANALYSIS_THREADS", 1),
        analysis_hash_mb=_env_int("AC_ANALYSIS_HASH_MB", 128),
        agents=_env_int("AC_AGENTS", 1) == 1,
        agents_parallel=max(1, _env_int("AC_AGENTS_PARALLEL", 1)),
        agents_timeout_s=_env_int("AC_AGENTS_TIMEOUT_S", 1800),
        claude_command=claude_command,
    )
