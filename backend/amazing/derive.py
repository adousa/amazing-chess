"""Ladder, stats and engine versions - always derived from the game store (never stored)."""
from __future__ import annotations

from typing import Any, Dict, Iterable, List, Optional


def _decided(m: Dict[str, Any]) -> bool:
    return m.get("status") == "finished" and m.get("outcome") in ("win", "draw", "loss")


def ladder(matches: Iterable[Dict[str, Any]]) -> Dict[str, Any]:
    """Every attempted Elo (any started/saved game at that level), W/D/L from finished games.
    A level is `beaten` only with >= 1 WIN (a draw is not a win)."""
    levels: Dict[int, Dict[str, Any]] = {}
    for m in matches:
        if m.get("status") == "queued":
            continue
        elo = int(m["stockfishElo"])
        lv = levels.setdefault(elo, {"elo": elo, "games": 0, "wins": 0, "draws": 0, "losses": 0,
                                     "state": "attempted", "firstWinMatchId": None, "firstWinAt": None})
        lv["games"] += 1
        if not _decided(m):
            continue
        o = m["outcome"]
        if o == "win":
            lv["wins"] += 1
            at = m.get("finishedAt") or m.get("createdAt")
            if lv["firstWinAt"] is None or (at, m["id"]) < (lv["firstWinAt"], lv["firstWinMatchId"]):
                lv["firstWinAt"] = at
                lv["firstWinMatchId"] = m["id"]
        elif o == "draw":
            lv["draws"] += 1
        else:
            lv["losses"] += 1
    highest: Optional[int] = None
    proof: Optional[str] = None
    for elo in sorted(levels):
        lv = levels[elo]
        if lv["wins"] > 0:
            lv["state"] = "beaten"
            highest, proof = elo, lv["firstWinMatchId"]
    return {"highestEloBeaten": highest, "proofMatchId": proof,
            "levels": [levels[e] for e in sorted(levels)]}


def _wdl() -> Dict[str, int]:
    return {"games": 0, "wins": 0, "draws": 0, "losses": 0}


def _add(w: Dict[str, int], outcome: str) -> None:
    w["games"] += 1
    w[{"win": "wins", "draw": "draws", "loss": "losses"}[outcome]] += 1


def stats(matches: Iterable[Dict[str, Any]], engine_version: Optional[str] = None) -> Dict[str, Any]:
    """W/D/L over finished games (aborted/error games have no outcome and are not counted)."""
    total = _wdl()
    by_elo: Dict[int, Dict[str, int]] = {}
    by_color = {"white": _wdl(), "black": _wdl()}
    by_ver: Dict[str, Dict[str, Any]] = {}
    ver_first: Dict[str, str] = {}
    for m in matches:
        if not _decided(m):
            continue
        if engine_version and m.get("engineVersion") != engine_version:
            continue
        o = m["outcome"]
        _add(total, o)
        _add(by_elo.setdefault(int(m["stockfishElo"]), _wdl()), o)
        if m.get("engineColor") in by_color:
            _add(by_color[m["engineColor"]], o)
        v = m.get("engineVersion", "unknown")
        _add(by_ver.setdefault(v, _wdl()), o)
        created = m.get("createdAt", "")
        if v not in ver_first or created < ver_first[v]:
            ver_first[v] = created
    return {
        "total": total,
        "byElo": [{"elo": e, **by_elo[e]} for e in sorted(by_elo)],
        "byColor": by_color,
        "byEngineVersion": [{"engineVersion": v, **by_ver[v]}
                            for v in sorted(by_ver, key=lambda x: ver_first.get(x, ""), reverse=True)],
    }


def engine_versions(matches: Iterable[Dict[str, Any]], current: Optional[Dict[str, Any]] = None) -> List[Dict[str, Any]]:
    """Versions seen in saved games plus the current binary, newest first."""
    seen: Dict[str, Dict[str, Any]] = {}
    for m in matches:
        if m.get("status") == "queued":
            continue
        eng = m.get("engine") or {}
        v = eng.get("version") or m.get("engineVersion")
        if not v:
            continue
        created = m.get("startedAt") or m.get("createdAt")
        if v not in seen or created < seen[v]["createdAt"]:
            seen[v] = {"version": v, "name": eng.get("name", "AmazingChess"), "createdAt": created,
                       "estimatedElo": None}
    if current:
        v = current["version"]
        if v in seen:
            seen[v]["createdAt"] = min(seen[v]["createdAt"], current["createdAt"])
        else:
            seen[v] = {"estimatedElo": None, **current}
    return sorted(seen.values(), key=lambda e: e["createdAt"], reverse=True)
