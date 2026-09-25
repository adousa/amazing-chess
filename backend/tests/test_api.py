"""HTTP API: every endpoint, responses validated against contracts/openapi.yaml."""
from __future__ import annotations

import json
import time

import pytest
from fastapi.testclient import TestClient

from amazing.api import create_app
from conftest import MATE_IN_ONE_WHITE, assert_contract


@pytest.fixture
def client(env):
    with TestClient(create_app(agents_mode="off")) as c:
        yield c


def wait_for(client, mid, pred, timeout=60):
    t0 = time.time()
    while time.time() - t0 < timeout:
        m = client.get(f"/api/matches/{mid}").json()
        if pred(m):
            return m
        time.sleep(0.2)
    raise AssertionError(f"timeout waiting for {mid}: {m}")


def read_sse(client, url, headers=None, limit=500):
    events = []
    with client.stream("GET", url, headers=headers or {}) as r:
        assert r.status_code == 200
        assert r.headers["content-type"].startswith("text/event-stream")
        block = {}
        for line in r.iter_lines():
            if line == "":
                if "data" in block:
                    ev = json.loads(block["data"])
                    assert ev["type"] == block["event"] and str(ev["seq"]) == block["id"]
                    events.append(ev)
                block = {}
                if len(events) >= limit:
                    break
                continue
            if line.startswith(":"):
                continue
            k, _, v = line.partition(": ")
            block[k] = v
    for ev in events:
        assert_contract(ev, "MatchEvent")
    return events


def test_health_and_engines(client):
    h = client.get("/api/health").json()
    assert_contract(h, "Health")
    assert h["status"] == "ok" and h["apiVersion"] == "0.1.0"
    assert h["stockfishVersion"].startswith("Stockfish") and h["latestEngineVersion"] == "0.0.0-placeholder"
    e = client.get("/api/engines").json()
    assert_contract(e, "EngineVersion", array=True)
    assert e[0]["version"] == "0.0.0-placeholder"


def test_errors(client):
    for elo in (1319, 3191, "x", None):
        r = client.post("/api/matches", json={"stockfishElo": elo})
        assert r.status_code == 400, elo
        assert_contract(r.json(), "Error")
        assert r.json()["code"] == "invalid_elo"
    r = client.post("/api/matches", json={"stockfishElo": 1500, "count": 101})
    assert r.status_code == 400 and r.json()["code"] == "invalid_count"
    r = client.post("/api/matches", json={"stockfishElo": 1500, "engineColor": "green"})
    assert r.status_code == 400
    r = client.post("/api/matches", json={"stockfishElo": 1500, "startFen": "nonsense"})
    assert r.status_code == 400 and r.json()["code"] == "invalid_fen"
    r = client.post("/api/matches", json={"stockfishElo": 1500, "engineVersion": "9.9.9"})
    assert r.status_code == 400 and r.json()["code"] == "unknown_engine_version"
    for path in ("/api/matches/nope", "/api/matches/nope/pgn", "/api/matches/nope/analysis",
                 "/api/matches/nope/events"):
        r = client.get(path)
        assert r.status_code == 404 and r.json()["code"] == "match_not_found"
        assert_contract(r.json(), "Error")
    assert client.post("/api/matches/nope/abort").status_code == 404
    r = client.get("/api/matches?limit=0")
    assert r.status_code == 400 and and_contract(r.json())
    assert client.get("/api/matches?stockfishElo=100").json()["code"] == "invalid_elo"
    assert client.get("/api/matches?cursor=%%%").status_code == 400


def and_contract(body):
    assert_contract(body, "Error")
    return True


def test_full_flow(client):
    r = client.post("/api/matches", json={"stockfishElo": 1500, "engineColor": "alternate", "count": 3,
                                          "startFen": MATE_IN_ONE_WHITE})
    assert r.status_code == 202
    queued = r.json()
    assert_contract(queued, "MatchSummary", array=True)
    assert [q["engineColor"] for q in queued] == ["white", "black", "white"]
    ids = [q["id"] for q in queued]
    assert ids == sorted(ids) and len(set(ids)) == 3
    assert all(q["id"].startswith("m_") and "_1500_" in q["id"] for q in queued)

    # live stream of the first match: runs until analysis is ready, then closes
    events = read_sse(client, f"/api/matches/{ids[0]}/events")
    types = [e["type"] for e in events]
    assert "match.finished" in types
    assert types[-1] == "analysis.updated" and events[-1]["analysisStatus"] == "ready"
    seqs = [e["seq"] for e in events]
    assert seqs == sorted(seqs)
    fin = next(e for e in events if e["type"] == "match.finished")
    assert fin["outcome"] == "win" and fin["termination"] == "checkmate"

    for mid in ids:
        wait_for(client, mid, lambda m: m["analysisStatus"] == "ready")

    m = client.get(f"/api/matches/{ids[0]}").json()
    assert_contract(m, "Match")
    assert m["outcome"] == "win" and m["pgnUrl"] == f"/matches/{ids[0]}/pgn"
    assert client.get(f"/api/matches/{ids[1]}").json()["outcome"] == "loss"

    pgn = client.get(f"/api/matches/{ids[0]}/pgn")
    assert pgn.status_code == 200 and pgn.headers["content-type"].startswith("application/x-chess-pgn")
    assert '[StockfishElo "1500"]' in pgn.text and "Ra8#" in pgn.text

    a = client.get(f"/api/matches/{ids[0]}/analysis").json()
    assert_contract(a, "Analysis")
    assert a["status"] == "ready" and len(a["moves"]) == 1

    # stream of a completed match: snapshot + finished, then closes
    ev = read_sse(client, f"/api/matches/{ids[0]}/events")
    assert [e["type"] for e in ev][:2] == ["match.snapshot", "match.finished"]
    assert ev[0]["match"]["id"] == ids[0]

    # list + filters + pagination
    page = client.get("/api/matches").json()
    assert_contract(page, "MatchPage")
    assert [i["id"] for i in page["items"]] == sorted(ids, reverse=True)
    assert page["nextCursor"] is None
    p1 = client.get("/api/matches?limit=2").json()
    assert len(p1["items"]) == 2 and p1["nextCursor"]
    p2 = client.get(f"/api/matches?limit=2&cursor={p1['nextCursor']}").json()
    assert_contract(p2, "MatchPage")
    assert [i["id"] for i in p1["items"] + p2["items"]] == sorted(ids, reverse=True) and p2["nextCursor"] is None
    assert len(client.get("/api/matches?outcome=win").json()["items"]) == 2
    assert len(client.get("/api/matches?outcome=loss&status=finished").json()["items"]) == 1
    assert len(client.get("/api/matches?stockfishElo=1320").json()["items"]) == 0
    assert len(client.get("/api/matches?engineVersion=0.0.0-placeholder").json()["items"]) == 3

    # abort a finished match -> 409
    r = client.post(f"/api/matches/{ids[0]}/abort")
    assert r.status_code == 409 and r.json()["code"] == "match_already_finished"

    # ladder + stats derived from the store
    lad = client.get("/api/ladder").json()
    assert_contract(lad, "Ladder")
    assert lad["highestEloBeaten"] == 1500 and lad["proofMatchId"] == ids[0]
    assert lad["levels"][0]["wins"] == 2 and lad["levels"][0]["losses"] == 1
    st = client.get("/api/stats").json()
    assert_contract(st, "Stats")
    assert st["total"] == {"games": 3, "wins": 2, "draws": 0, "losses": 1}
    assert client.get("/api/stats?engineVersion=other").json()["total"]["games"] == 0
    engines = client.get("/api/engines").json()
    assert_contract(engines, "EngineVersion", array=True)

    # re-run analysis -> 202 pending, history kept, then ready again
    r = client.post(f"/api/matches/{ids[0]}/analysis")
    assert r.status_code == 202
    assert_contract(r.json(), "Analysis")
    wait_for(client, ids[0], lambda m: m["analysisStatus"] == "ready")
    hist = client.app.state.backend.store.dir(ids[0]) / "analysis-history"
    assert len(list(hist.iterdir())) == 1


def test_abort_via_api(client, monkeypatch):
    r = client.post("/api/matches", json={"stockfishElo": 1320, "engineColor": "white", "count": 3})
    ids = [q["id"] for q in r.json()]
    wait_for(client, ids[0], lambda m: m["plyCount"] >= 2)
    # parallel=2: the third match is still queued
    third = client.get(f"/api/matches/{ids[2]}").json()
    assert third["status"] == "queued"
    assert_contract(third, "Match")
    r = client.post(f"/api/matches/{ids[2]}/abort")
    assert r.status_code == 200
    assert_contract(r.json(), "MatchSummary")
    assert r.json()["status"] == "aborted"
    for mid in ids[:2]:
        r = client.post(f"/api/matches/{mid}/abort")
        assert r.status_code == 200 and r.json()["status"] == "aborted", r.json()
    for mid in ids:
        m = client.get(f"/api/matches/{mid}").json()
        assert_contract(m, "Match")
        assert m["status"] == "aborted" and m["result"] == "*" and m["termination"] == "aborted"
        assert client.get(f"/api/matches/{mid}/pgn").status_code == 200
    # aborted games are on the ladder as attempts but never as wins
    lad = client.get("/api/ladder").json()
    assert lad["levels"][0]["games"] == 3 and lad["levels"][0]["state"] == "attempted"
    # analysis re-run while still queued/in progress -> 409 or 202 depending on timing; never 500
    r = client.post(f"/api/matches/{ids[2]}/analysis")
    assert r.status_code in (202, 409)


@pytest.mark.parametrize("only_gm", [False, True])
def test_agents_pipeline(env, monkeypatch, only_gm):
    """AC_AGENTS=1 with a fake claude: reports merged via scripts/save_agent_report.py, SSE emits
    gm-coach/engine-dev parts, missing reports are finalised as failed, status ends ready."""
    import sys
    from pathlib import Path

    fake = Path(__file__).with_name("fake_claude.py")
    monkeypatch.setenv("AC_AGENTS", "1")
    monkeypatch.setenv("AC_CLAUDE_PATH", f"{sys.executable} {fake}")
    if only_gm:
        monkeypatch.setenv("FAKE_CLAUDE_ONLY_GM", "1")
    with TestClient(create_app(agents_mode="async")) as client:
        [q] = client.post("/api/matches", json={"stockfishElo": 1600, "engineColor": "white",
                                                "startFen": MATE_IN_ONE_WHITE}).json()
        events = read_sse(client, f"/api/matches/{q['id']}/events")
        parts = [(e.get("part"), e["analysisStatus"]) for e in events if e["type"] == "analysis.updated"]
        assert ("gm-coach", "running") in parts or ("gm-coach", "ready") in parts, parts
        assert parts[-1][1] == "ready"
        a = client.get(f"/api/matches/{q['id']}/analysis").json()
        assert_contract(a, "Analysis")
        log = client.app.state.backend.store.dir(q["id"]) / "agents.log"
        t0 = time.time()
        while "exit code" not in log.read_text() and time.time() - t0 < 30:
            time.sleep(0.2)
        time.sleep(0.3)
        assert "fake claude done" in log.read_text() and "exit code 0" in log.read_text()
        a = client.get(f"/api/matches/{q['id']}/analysis").json()
        assert_contract(a, "Analysis")
        assert a["status"] == "ready"
        assert a["reports"]["gmCoach"]["status"] == "ready"
        assert a["reports"]["engineDev"]["status"] == ("failed" if only_gm else "ready")
        # resume with Last-Event-ID: only the events after it are replayed
        again = read_sse(client, f"/api/matches/{q['id']}/events", headers={"Last-Event-ID": str(events[-3]["seq"])})
        assert [e["seq"] for e in again] == [e["seq"] for e in events[-2:]]
