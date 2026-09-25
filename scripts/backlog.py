"""Engine improvement backlog fed by the post-game analysis agents (CLAUDE.md §7).

docs/backlog.json is the source of truth; docs/backlog.md is rendered from it (never edit the md).

Usage:
  python scripts/backlog.py add <matchId>        # merge both agent reports' suggestions (idempotent)
  python scripts/backlog.py list [--all] [--limit N] [--json]
  python scripts/backlog.py top [--json]         # highest-ranked open item (for /ladder-loop)
  python scripts/backlog.py titles [--limit N]   # open titles, for the agents' "upvote, don't repeat"
  python scripts/backlog.py set-status <id> <open|in-progress|done|rejected> [--note "..."]
  python scripts/backlog.py render               # re-render docs/backlog.md from the json

Dedupe: titles are normalised (case, punctuation, stop words, simple plural stripping). A
suggestion upvotes an existing item when the normalised titles are equal, or their similarity
(max of token Jaccard, 0.85 x token containment, and difflib ratio when >= 0.9) is >= 0.75 —
or >= 0.6 within the same category.
Each (matchId, agent) pair counts once per item, so re-running `add` never inflates counts.

Ranking (open items first): score = priority weight (high 3, medium 2, low 1) x times suggested.

Environment: AC_GAMES_DIR (default <repo>/games), AC_BACKLOG_JSON / AC_BACKLOG_MD (default docs/).
"""
from __future__ import annotations

import argparse
import contextlib
import datetime as dt
import fcntl
import hashlib
import difflib
import json
import os
import pathlib
import re
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
PRIORITY = {"high": 3, "medium": 2, "low": 1}
STATUSES = ("open", "in-progress", "done", "rejected")
STATUS_ORDER = {"in-progress": 0, "open": 1, "done": 2, "rejected": 3}
REPORT_KEYS = {"gm-coach": "gmCoach", "engine-dev": "engineDev"}
STOP = {"a", "an", "the", "to", "of", "for", "and", "or", "in", "on", "with", "our", "use",
        "add", "implement", "improve", "better", "engine", "s", "against", "is", "be", "when", "by"}


def paths() -> tuple[pathlib.Path, pathlib.Path, pathlib.Path]:
    games = pathlib.Path(os.environ.get("AC_GAMES_DIR") or ROOT / "games")
    bj = pathlib.Path(os.environ.get("AC_BACKLOG_JSON") or ROOT / "docs" / "backlog.json")
    bm = pathlib.Path(os.environ.get("AC_BACKLOG_MD") or ROOT / "docs" / "backlog.md")
    return games, bj, bm


def now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).strftime("%Y-%m-%dT%H:%M:%SZ")


# --------------------------------------------------------------------------- similarity
def tokens(title: str) -> list[str]:
    words = re.sub(r"[^a-z0-9+]+", " ", title.lower()).split()
    out = []
    for w in words:
        if w in STOP:
            continue
        if len(w) > 3 and w.endswith("s") and not w.endswith("ss"):
            w = w[:-1]  # crude plural stripping: "tables" -> "table"
        out.append(w)
    return out


def normalise(title: str) -> str:
    return " ".join(tokens(title))


def similarity(a: str, b: str) -> float:
    na, nb = normalise(a), normalise(b)
    if not na or not nb:
        return 0.0
    if na == nb:
        return 1.0
    ta, tb = set(na.split()), set(nb.split())
    jaccard = len(ta & tb) / len(ta | tb)
    # one title's keywords fully/mostly inside the other's ("Syzygy tablebases" ⊂ "Syzygy 5-piece
    # tablebases"); discounted so it only merges within a category
    containment = 0.85 * len(ta & tb) / min(len(ta), len(tb)) if min(len(ta), len(tb)) >= 2 else 0.0
    # character similarity only for near-identical spellings (typos, word order is not enough)
    ratio = difflib.SequenceMatcher(None, na, nb).ratio()
    return max(jaccard, containment, ratio if ratio >= 0.9 else 0.0)


def find_match(items: list[dict], title: str, category: str) -> dict | None:
    best, best_score = None, 0.0
    for item in items:
        score = similarity(item["title"], title)
        threshold = 0.6 if item["category"] == category else 0.75
        if score >= threshold and score > best_score:
            best, best_score = item, score
    return best


# --------------------------------------------------------------------------- storage
@contextlib.contextmanager
def locked():
    """Serialise writers (several headless /analyze-game runs may finish at the same time)."""
    key = hashlib.sha1(str(paths()[1].resolve()).encode()).hexdigest()[:16]
    with open(pathlib.Path(tempfile.gettempdir()) / f"amazing-chess-backlog-{key}.lock", "w") as fh:
        fcntl.flock(fh, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(fh, fcntl.LOCK_UN)


def load() -> dict:
    _, bj, _ = paths()
    if bj.exists():
        return json.loads(bj.read_text())
    return {"version": 1, "updatedAt": now_iso(), "items": []}


def atomic_write(path: pathlib.Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=f".{path.name}-", dir=path.parent)
    with os.fdopen(fd, "w") as fh:
        fh.write(text)
    os.replace(tmp, path)


def save(data: dict) -> None:
    _, bj, bm = paths()
    data["updatedAt"] = now_iso()
    data["items"] = ranked(data["items"])
    atomic_write(bj, json.dumps(data, indent=2, ensure_ascii=False) + "\n")
    atomic_write(bm, render(data))


def score(item: dict) -> int:
    return PRIORITY.get(item["priority"], 1) * item["count"]


def ranked(items: list[dict]) -> list[dict]:
    return sorted(items, key=lambda i: (STATUS_ORDER.get(i["status"], 9), -score(i),
                                        -PRIORITY.get(i["priority"], 1), i["firstSeen"]["at"], i["id"]))


def next_id(items: list[dict]) -> str:
    n = max((int(i["id"][1:]) for i in items if re.fullmatch(r"B\d+", i["id"])), default=0)
    return f"B{n + 1:03d}"


# --------------------------------------------------------------------------- commands
def add(match_id: str) -> int:
    games, _, _ = paths()
    analysis_path = games / match_id / "analysis.json"
    if not analysis_path.exists():
        print(f"✗ {analysis_path} not found", file=sys.stderr)
        return 1
    analysis = json.loads(analysis_path.read_text())
    stockfish_elo = None
    match_path = games / match_id / "match.json"
    if match_path.exists():
        stockfish_elo = json.loads(match_path.read_text()).get("stockfishElo")

    data = load()
    added = upvoted = unchanged = 0
    for agent, key in REPORT_KEYS.items():
        report = (analysis.get("reports") or {}).get(key) or {}
        if report.get("status") != "ready":
            print(f"! {agent} report is {report.get('status', 'missing')} — skipped", file=sys.stderr)
            continue
        for s in report.get("suggestions") or []:
            seen = {"matchId": match_id, "agent": agent, "at": now_iso(),
                    "stockfishElo": stockfish_elo, "relatedPlies": s.get("relatedPlies", [])}
            item = find_match(data["items"], s["title"], s["category"])
            if item is None:
                data["items"].append({
                    "id": next_id(data["items"]),
                    "title": s["title"].strip(),
                    "category": s["category"],
                    "priority": s["priority"],
                    "status": "open",
                    "count": 1,
                    "agents": [agent],
                    "detail": s.get("detail", ""),
                    "firstSeen": seen,
                    "lastSeen": seen,
                    "games": [match_id],
                    "occurrences": [seen],
                    "notes": [],
                })
                added += 1
                continue
            if any(o["matchId"] == match_id and o["agent"] == agent for o in item["occurrences"]):
                unchanged += 1
                continue
            item["occurrences"].append(seen)
            item["count"] = len({(o["matchId"], o["agent"]) for o in item["occurrences"]})
            item["lastSeen"] = seen
            if match_id not in item["games"]:
                item["games"].append(match_id)
            if agent not in item["agents"]:
                item["agents"].append(agent)
            if PRIORITY.get(s["priority"], 1) > PRIORITY.get(item["priority"], 1):
                item["priority"] = s["priority"]
            # the upvoting agent's detail carries this game's evidence: keep it with the occurrence
            seen["title"], seen["detail"] = s["title"], s.get("detail", "")
            if item["status"] == "done":
                item["notes"].append(f"{now_iso()} re-suggested after done ({match_id}, {agent})")
            upvoted += 1
    save(data)
    print(f"✓ backlog: {added} new, {upvoted} upvoted, {unchanged} already counted "
          f"({len(data['items'])} items) -> {paths()[2]}")
    return 0


def md_cell(text: str) -> str:
    return str(text).replace("|", "\\|").replace("\n", " ").strip()


def render(data: dict) -> str:
    items = ranked(data["items"])
    lines = [
        "# Engine improvement backlog",
        "",
        "> **Generated file — do not edit by hand.** Source: [`backlog.json`](backlog.json), rendered by",
        "> `python scripts/backlog.py render`. Items come from the post-game analysis agents",
        "> (`gm-coach`, `engine-dev`; see [06-analysis-and-agents](06-analysis-and-agents.md)) via",
        "> `python scripts/backlog.py add <matchId>`, which runs after every `/analyze-game`.",
        ">",
        "> Near-identical suggestions are merged and **upvoted** (\"Times\") instead of duplicated.",
        "> Rank = priority weight (high 3 · medium 2 · low 1) × times suggested; in-progress and open",
        "> items first. `/ladder-loop` implements the top open item, measures it against the previous",
        "> engine version and marks it `done` or `rejected` with",
        "> `python scripts/backlog.py set-status <id> <status> --note \"…\"`.",
        "",
        f"_Last updated: {data.get('updatedAt', '')} · {len(items)} item(s)_",
        "",
    ]
    if not items:
        lines += ["_No suggestions yet — play a game and run `/analyze-game latest`._", ""]
        return "\n".join(lines)
    lines += [
        "| # | ID | Title | Category | Priority | Times | Status | First seen | Last seen | Games |",
        "|---|---|---|---|---|---|---|---|---|---|",
    ]
    for rank, i in enumerate(items, 1):
        games = ", ".join(f"[{g}](../games/{g}/)" for g in i["games"][-5:])
        if len(i["games"]) > 5:
            games = f"… +{len(i['games']) - 5}, " + games
        lines.append(
            f"| {rank} | {i['id']} | {md_cell(i['title'])} | {i['category']} | {i['priority']} | "
            f"{i['count']} | {i['status']} | {i['firstSeen']['matchId']} | {i['lastSeen']['matchId']} | {games} |")
    lines += ["", "## Details", ""]
    for i in items:
        if i["status"] in ("done", "rejected") and not i["notes"]:
            continue
        agents = ", ".join(i["agents"])
        lines += [
            "<details>",
            f"<summary><b>{i['id']}</b> — {md_cell(i['title'])} "
            f"(<i>{i['category']}, {i['priority']}, ×{i['count']}, {i['status']}, from {agents}</i>)</summary>",
            "",
            i["detail"].strip() or "_no detail_",
            "",
        ]
        extra = [o for o in i["occurrences"][1:] if (o.get("detail") or "").strip()]
        if extra:
            lines += ["**More evidence (latest first):**", ""]
            for o in reversed(extra[-5:]):
                text = md_cell(o["detail"])
                text = text if len(text) <= 600 else text[:600] + "…"
                lines.append(f"- [{o['matchId']}](../games/{o['matchId']}/) ({o['agent']}, "
                             f"\"{md_cell(o.get('title', ''))}\"): {text}")
            lines.append("")
        if i["notes"]:
            lines += ["**Notes:**", ""] + [f"- {md_cell(n)}" for n in i["notes"]] + [""]
        lines += ["</details>", ""]
    return "\n".join(lines)


def cmd_list(args) -> int:
    items = [i for i in ranked(load()["items"]) if args.all or i["status"] in ("open", "in-progress")]
    items = items[: args.limit] if args.limit else items
    if args.json:
        print(json.dumps(items, indent=2, ensure_ascii=False))
        return 0
    for rank, i in enumerate(items, 1):
        print(f"{rank:>3}. {i['id']} [{i['status']}] ({i['category']}, {i['priority']}, x{i['count']}, "
              f"score {score(i)}) {i['title']}")
    if not items:
        print("(backlog empty)")
    return 0


def cmd_top(args) -> int:
    items = [i for i in ranked(load()["items"]) if i["status"] == "open"]
    if not items:
        print("(no open backlog items)", file=sys.stderr)
        return 1
    top = items[0]
    if args.json:
        print(json.dumps(top, indent=2, ensure_ascii=False))
    else:
        print(f"{top['id']}: {top['title']} ({top['category']}, {top['priority']}, x{top['count']})\n")
        print(top["detail"])
        print(f"\nGames: {', '.join(top['games'])}")
    return 0


def cmd_titles(args) -> int:
    items = [i for i in ranked(load()["items"]) if i["status"] != "rejected"][: args.limit]
    for i in items:
        print(f"- {i['title']}  [{i['category']}, x{i['count']}, {i['status']}]")
    return 0


def cmd_set_status(args) -> int:
    data = load()
    item = next((i for i in data["items"] if i["id"] == args.id), None)
    if item is None:
        print(f"✗ no backlog item {args.id}", file=sys.stderr)
        return 1
    item["status"] = args.status
    if args.note:
        item["notes"].append(f"{now_iso()} {args.status}: {args.note}")
    save(data)
    print(f"✓ {args.id} -> {args.status}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("add")
    p.add_argument("match_id")
    p = sub.add_parser("list")
    p.add_argument("--all", action="store_true", help="include done/rejected")
    p.add_argument("--limit", type=int)
    p.add_argument("--json", action="store_true")
    p = sub.add_parser("top")
    p.add_argument("--json", action="store_true")
    p = sub.add_parser("titles")
    p.add_argument("--limit", type=int, default=40)
    p = sub.add_parser("set-status")
    p.add_argument("id")
    p.add_argument("status", choices=STATUSES)
    p.add_argument("--note")
    sub.add_parser("render")
    args = parser.parse_args()
    if args.cmd == "add":
        with locked():
            return add(args.match_id)
    if args.cmd == "list":
        return cmd_list(args)
    if args.cmd == "top":
        return cmd_top(args)
    if args.cmd == "titles":
        return cmd_titles(args)
    if args.cmd == "set-status":
        with locked():
            return cmd_set_status(args)
    with locked():
        save(load())
    print(f"✓ rendered {paths()[2]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
