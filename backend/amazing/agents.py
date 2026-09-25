"""Run the two analysis sub-agents (GM coach + engine dev) via the Claude Code CLI.

    claude -p "/analyze-game <matchId> --agents-only" --permission-mode bypassPermissions

runs with cwd = repo root and logs to games/<id>/agents.log. The skill merges each AgentReport
into analysis.json (scripts/save_agent_report.py). When claude exits we finalise: any report that
is still pending/running is marked failed and the top-level status becomes `ready`.

Concurrency across processes (server + CLI) is limited with flock'ed slot files.
"""
from __future__ import annotations

import fcntl
import logging
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import IO, List, Optional

from amazing.config import Settings
from amazing.store import GameStore, pending_report
from amazing.util import iso

log = logging.getLogger("amazing.agents")

REPORT_KEYS = (("gmCoach", "gm-coach"), ("engineDev", "engine-dev"))


def claude_available(settings: Settings) -> bool:
    exe = settings.claude_command[0]
    return bool(shutil.which(exe) or os.path.isfile(exe))


def agents_wanted(settings: Settings) -> bool:
    return settings.agents and claude_available(settings)


def _lock_dir() -> Path:
    d = Path(tempfile.gettempdir()) / "amazing-chess-agent-slots"
    d.mkdir(exist_ok=True)
    return d


def acquire_slot(slots: int, poll_s: float = 2.0) -> IO[str]:
    """Block until one of `slots` global slots is free; returns the open (locked) file."""
    d = _lock_dir()
    while True:
        for i in range(slots):
            fh = open(d / f"slot-{i}.lock", "w")
            try:
                fcntl.flock(fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
                return fh
            except OSError:
                fh.close()
        time.sleep(poll_s)


def build_command(settings: Settings, match_id: str) -> List[str]:
    return [*settings.claude_command, "-p", f"/analyze-game {match_id} --agents-only",
            "--permission-mode", "bypassPermissions"]


def finalize(store: GameStore, match_id: str, exit_code: Optional[int]) -> dict:
    """After the agents ran: close out any report that never arrived, set status ready."""
    return store.update_analysis(match_id, lambda a: _finalize(a, match_id, exit_code)) or {}


def _finalize(a: dict, match_id: str, exit_code: Optional[int]) -> dict:
    reports = dict(a.get("reports") or {})
    for key, agent in REPORT_KEYS:
        rep = dict(reports.get(key) or pending_report(agent))
        if rep.get("status") in ("pending", "running"):
            rep["status"] = "failed"
            rep["summary"] = rep.get("summary") or (
                f"The {agent} agent did not produce a report (claude exit code {exit_code}); "
                f"see games/{match_id}/agents.log. Re-run with POST /matches/{match_id}/analysis.")
            rep["createdAt"] = iso()
        reports[key] = rep
    a["reports"] = reports
    if a.get("status") in ("pending", "running"):
        a["status"] = "ready" if a.get("moves") is not None else "failed"
    return a


def mark_skipped(store: GameStore, match_id: str, reason: str) -> None:
    def fn(a: dict) -> dict:
        reports = dict(a.get("reports") or {})
        for key, agent in REPORT_KEYS:
            rep = dict(reports.get(key) or pending_report(agent))
            if rep.get("status") == "pending":
                rep.update({"status": "failed", "summary": reason, "createdAt": iso()})
            reports[key] = rep
        a["reports"] = reports
        return a
    store.update_analysis(match_id, fn)


def _mark_running(a: dict) -> dict:
    reports = dict(a.get("reports") or {})
    for key, agent in REPORT_KEYS:
        rep = dict(reports.get(key) or pending_report(agent))
        if rep.get("status") == "pending":
            rep["status"] = "running"
        reports[key] = rep
    a["reports"] = reports
    a["status"] = "running"
    return a


def run_agents(settings: Settings, store: GameStore, match_id: str) -> int:
    """Blocking: wait for a slot, run claude, finalise analysis.json. Returns claude's exit code."""
    log_path = store.dir(match_id) / "agents.log"
    slot = acquire_slot(settings.agents_parallel)
    code: Optional[int] = None
    try:
        # mark the reports as running (the skill may overwrite them as it progresses)
        store.update_analysis(match_id, _mark_running)
        cmd = build_command(settings, match_id)
        with open(log_path, "a", encoding="utf-8") as logf:
            logf.write(f"[{iso()}] $ {' '.join(cmd)}\n")
            logf.flush()
            try:
                proc = subprocess.Popen(cmd, cwd=str(settings.repo_root), stdout=logf, stderr=subprocess.STDOUT,
                                        stdin=subprocess.DEVNULL)
                try:
                    code = proc.wait(timeout=settings.agents_timeout_s)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    code = proc.wait()
                    logf.write(f"[{iso()}] killed after {settings.agents_timeout_s}s\n")
            except OSError as exc:
                logf.write(f"[{iso()}] cannot start claude: {exc}\n")
                code = -1
            logf.write(f"[{iso()}] exit code {code}\n")
    finally:
        try:
            finalize(store, match_id, code)
        finally:
            slot.close()
    return code if code is not None else -1


def spawn_detached(match_id: str, log_to: Optional[Path] = None) -> subprocess.Popen:
    """Start `python -m amazing agents <id>` in its own session (outlives the caller)."""
    return subprocess.Popen([sys.executable, "-m", "amazing", "agents", match_id],
                            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                            start_new_session=True, env=os.environ.copy())
