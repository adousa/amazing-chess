"""Validate a sub-agent report and merge it into games/<matchId>/analysis.json.

Usage:
  python scripts/save_agent_report.py <matchId> <gm-coach|engine-dev> <report.json|->
  python scripts/save_agent_report.py <matchId> <agent> --status running
  python scripts/save_agent_report.py <matchId> <agent> --status failed --summary "why it failed"
  python scripts/save_agent_report.py <matchId> <agent> <report.json> --check   # validate only

The report must match the contract `AgentReport` schema (contracts/openapi.yaml). The input may be
raw JSON or a Markdown answer containing a ```json fenced block. Keys that are not in the
contract are stripped (the frontend must never see anything outside the contract), `agent` is
forced to the given agent, `status` defaults to "ready" and `createdAt` is set to now (UTC).
A "ready" report must contain at least one suggestion (CLAUDE.md §5: actionable suggestions).

Safety:
  * Only ever writes games/<id>/analysis.json (temp file + fsync + atomic rename) and, when a
    ready report is replaced, archives the previous file to games/<id>/analysis-history/.
    game.pgn and match.json are never opened for writing.
  * Writers are serialised with an advisory lock (outside the games dir) so the two agents can
    save concurrently without lost updates.

Top-level `status` after a merge (the engine part is "ready" when `moves` is non-empty):
  * engine part not ready          -> unchanged (pending becomes running if a report is running)
  * any report running             -> running
  * both reports ready/failed      -> ready  (a failed agent is visible in its own report)
  * otherwise (a report pending)   -> unchanged

Environment: AC_GAMES_DIR overrides the game store (default: <repo>/games).
"""
from __future__ import annotations

import argparse
import contextlib
import datetime as dt
import fcntl
import hashlib
import json
import os
import pathlib
import re
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
CONTRACT = ROOT / "contracts" / "openapi.yaml"
AGENTS = {"gm-coach": "gmCoach", "engine-dev": "engineDev"}
PROTECTED = {"game.pgn", "match.json"}

REPORT_KEYS = {"agent", "status", "summary", "keyMoments", "suggestions", "createdAt"}
SUGGESTION_KEYS = {"title", "detail", "priority", "category", "relatedPlies"}
MOMENT_KEYS = {"ply", "comment"}


def games_dir() -> pathlib.Path:
    return pathlib.Path(os.environ.get("AC_GAMES_DIR") or ROOT / "games").resolve()


def now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).strftime("%Y-%m-%dT%H:%M:%SZ")


# --------------------------------------------------------------------------- contract validation
_SPEC = None


def validator(component: str):
    """jsonschema validator for a contract component (same approach as contracts/validate_examples.py)."""
    global _SPEC
    import yaml
    from jsonschema import Draft202012Validator
    from referencing import Registry, Resource

    if _SPEC is None:
        _SPEC = yaml.safe_load(CONTRACT.read_text())
    registry = Registry().with_resource("urn:api", Resource.opaque(_SPEC))
    return Draft202012Validator({"$ref": f"urn:api#/components/schemas/{component}"}, registry=registry)


def contract_errors(instance, component: str) -> list[str]:
    errs = sorted(validator(component).iter_errors(instance), key=lambda e: list(e.path))
    return [f"{component}: {'/'.join(map(str, e.path)) or '<root>'}: {e.message}" for e in errs]


# --------------------------------------------------------------------------- report parsing
def extract_json(text: str):
    """Accept raw JSON, or the last ```json fenced block / outermost {...} in a Markdown answer."""
    text = text.strip()
    with contextlib.suppress(json.JSONDecodeError):
        return json.loads(text)
    fences = re.findall(r"```(?:json)?\s*\n(.*?)```", text, flags=re.S)
    for block in reversed(fences):
        with contextlib.suppress(json.JSONDecodeError):
            return json.loads(block)
    start, end = text.find("{"), text.rfind("}")
    if start != -1 and end > start:
        return json.loads(text[start : end + 1])
    raise ValueError("no JSON object found in report input")


def normalise_report(raw: dict, agent: str, ply_count: int | None) -> tuple[dict, list[str]]:
    """Strip non-contract keys, coerce obvious type slips, set agent/status/createdAt."""
    if not isinstance(raw, dict):
        raise ValueError("report must be a JSON object")
    # Some agents wrap the report: {"report": {...}} or {"gmCoach": {...}}
    for wrapper in ("report", AGENTS[agent]):
        if isinstance(raw.get(wrapper), dict) and "agent" not in raw:
            raw = raw[wrapper]
    warnings: list[str] = []
    if raw.get("agent") not in (None, agent):
        raise ValueError(f"report is for agent {raw.get('agent')!r}, expected {agent!r}")
    dropped = sorted(set(raw) - REPORT_KEYS)
    if dropped:
        warnings.append(f"dropped non-contract report keys: {dropped}")
    report = {k: v for k, v in raw.items() if k in REPORT_KEYS}
    report["agent"] = agent
    report.setdefault("status", "ready")
    report["createdAt"] = now_iso()

    def ply_ok(p) -> bool:
        return isinstance(p, int) and p >= 1 and (ply_count is None or p <= ply_count)

    moments = []
    for m in report.get("keyMoments") or []:
        if not isinstance(m, dict):
            continue
        m = {k: v for k, v in m.items() if k in MOMENT_KEYS}
        with contextlib.suppress(TypeError, ValueError):
            m["ply"] = int(m["ply"])
        if not ply_ok(m.get("ply")):
            warnings.append(f"dropped key moment with invalid ply {m.get('ply')!r}")
            continue
        moments.append(m)
    if "keyMoments" in report:
        report["keyMoments"] = moments

    suggestions = []
    for s in report.get("suggestions") or []:
        if not isinstance(s, dict):
            continue
        s = {k: v for k, v in s.items() if k in SUGGESTION_KEYS}
        for key in ("priority", "category"):
            if isinstance(s.get(key), str):
                s[key] = s[key].strip().lower().replace(" ", "-").replace("_", "-")
        if "relatedPlies" in s:
            plies = []
            for p in s["relatedPlies"] or []:
                with contextlib.suppress(TypeError, ValueError):
                    p = int(p)
                if ply_ok(p):
                    plies.append(p)
                else:
                    warnings.append(f"dropped invalid relatedPly {p!r} in {s.get('title')!r}")
            s["relatedPlies"] = sorted(set(plies))
        suggestions.append(s)
    if "suggestions" in report:
        report["suggestions"] = suggestions
    return report, warnings


def validate_report(report: dict) -> list[str]:
    errors = contract_errors(report, "AgentReport")
    if report.get("status") == "ready":
        if not report.get("suggestions"):
            errors.append("a ready report needs at least one concrete suggestion")
        if not (report.get("summary") or "").strip():
            errors.append("a ready report needs a summary")
    return errors


# --------------------------------------------------------------------------- analysis.json merge
@contextlib.contextmanager
def locked(match_dir: pathlib.Path):
    """Advisory lock kept outside the game store (nothing extra is written into games/)."""
    key = hashlib.sha1(str(match_dir).encode()).hexdigest()[:16]
    lock_path = pathlib.Path(tempfile.gettempdir()) / f"amazing-chess-analysis-{key}.lock"
    with open(lock_path, "w") as fh:
        fcntl.flock(fh, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(fh, fcntl.LOCK_UN)


def atomic_write_json(path: pathlib.Path, data: dict) -> None:
    if path.name in PROTECTED:
        raise RuntimeError(f"refusing to write protected evidence file {path}")
    fd, tmp = tempfile.mkstemp(prefix=".analysis-", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as fh:
            json.dump(data, fh, indent=2, ensure_ascii=False)
            fh.write("\n")
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, path)
    except BaseException:
        with contextlib.suppress(FileNotFoundError):
            os.unlink(tmp)
        raise


def archive(match_dir: pathlib.Path, analysis_path: pathlib.Path) -> pathlib.Path:
    """FR-5.6: a re-run keeps history. Copy the current analysis.json before replacing a report."""
    hist = match_dir / "analysis-history"
    hist.mkdir(exist_ok=True)
    # same naming as the backend's GameStore.archive_analysis: <stamp>.json, <stamp>-<n>.json
    stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    dest, i = hist / f"{stamp}.json", 1
    while dest.exists():
        dest, i = hist / f"{stamp}-{i}.json", i + 1
    dest.write_bytes(analysis_path.read_bytes())
    return dest


def top_level_status(analysis: dict) -> str:
    current = analysis.get("status", "pending")
    engine_ready = bool(analysis.get("moves"))
    reports = analysis.get("reports") or {}
    states = [(reports.get(k) or {}).get("status", "pending") for k in AGENTS.values()]
    if not engine_ready:
        return "running" if current == "pending" and "running" in states else current
    if "running" in states:
        return "running"
    if all(s in ("ready", "failed") for s in states):
        return "ready"
    return current


def merge(match_id: str, agent: str, report: dict) -> dict:
    match_dir = games_dir() / match_id
    if not match_dir.is_dir():
        raise FileNotFoundError(f"no game directory {match_dir}")
    analysis_path = match_dir / "analysis.json"
    with locked(match_dir):
        if analysis_path.exists():
            analysis = json.loads(analysis_path.read_text())
        else:
            analysis = {"matchId": match_id, "status": "pending", "createdAt": now_iso()}
        if analysis.get("matchId") != match_id:
            raise ValueError(f"analysis.json matchId {analysis.get('matchId')!r} != {match_id!r}")
        reports = analysis.setdefault("reports", {})
        key = AGENTS[agent]
        previous = reports.get(key) or {}
        if analysis_path.exists() and previous.get("status") == "ready":
            print(f"archived previous analysis -> {archive(match_dir, analysis_path)}", file=sys.stderr)
        reports[key] = report
        analysis["status"] = top_level_status(analysis)
        errors = contract_errors(analysis, "Analysis")
        if errors:
            raise ValueError("merged analysis violates the contract:\n  " + "\n  ".join(errors))
        atomic_write_json(analysis_path, analysis)
    return analysis


def ply_count_of(match_id: str) -> int | None:
    match_path = games_dir() / match_id / "match.json"
    with contextlib.suppress(FileNotFoundError, json.JSONDecodeError, KeyError, TypeError):
        match = json.loads(match_path.read_text())  # read-only
        return int(match.get("plyCount") or len(match["moves"]))
    return None


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("match_id")
    parser.add_argument("agent", choices=sorted(AGENTS))
    parser.add_argument("report", nargs="?", help="report JSON file, or - for stdin")
    parser.add_argument("--status", choices=["pending", "running", "ready", "failed"],
                        help="mark progress without a full report (running/failed/pending)")
    parser.add_argument("--summary", help="summary text, e.g. the failure reason (with --status)")
    parser.add_argument("--check", action="store_true", help="validate only, do not write anything")
    args = parser.parse_args()

    ply_count = ply_count_of(args.match_id)
    warnings: list[str] = []
    try:
        if args.report:
            text = sys.stdin.read() if args.report == "-" else pathlib.Path(args.report).read_text()
            report, warnings = normalise_report(extract_json(text), args.agent, ply_count)
            if args.status:
                report["status"] = args.status
            if args.summary:
                report["summary"] = args.summary
        elif args.status:
            if args.status == "ready":
                parser.error("--status ready needs a report")
            report = {"agent": args.agent, "status": args.status, "createdAt": now_iso()}
            if args.summary:
                report["summary"] = args.summary
            elif args.status == "running":
                report["summary"] = f"{args.agent} is reviewing the game…"
        else:
            parser.error("give a report file (or -) or --status")
    except (ValueError, OSError, json.JSONDecodeError) as exc:
        print(f"✗ could not read report: {exc}", file=sys.stderr)
        return 2

    for w in warnings:
        print(f"! {w}", file=sys.stderr)
    errors = validate_report(report)
    if errors:
        print("✗ report does not match the contract:", file=sys.stderr)
        for e in errors:
            print(f"  - {e}", file=sys.stderr)
        return 1
    if args.check:
        n = len(report.get("suggestions") or [])
        print(f"✓ valid {args.agent} report ({report['status']}, {n} suggestion(s)) — not saved (--check)")
        return 0
    try:
        analysis = merge(args.match_id, args.agent, report)
    except (ValueError, FileNotFoundError) as exc:
        print(f"✗ {exc}", file=sys.stderr)
        return 1
    n = len(report.get("suggestions") or [])
    print(f"✓ saved {args.agent} report ({report['status']}, {n} suggestion(s)) to "
          f"{games_dir() / args.match_id / 'analysis.json'}; analysis status: {analysis['status']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
