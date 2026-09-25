"""Command line: serve | play | analyze | ladder | agents."""
from __future__ import annotations

import argparse
import asyncio
import json
import logging
import sys
from typing import List, Optional

from amazing.config import load_settings


def _print_ladder(lad: dict) -> None:
    print(f"Highest Stockfish Elo beaten: {lad['highestEloBeaten'] or 'none yet'}"
          + (f"  (proof: {lad['proofMatchId']})" if lad.get("proofMatchId") else ""))
    print(f"{'Elo':>5} {'games':>5} {'W':>3} {'D':>3} {'L':>3}  state      first win")
    for lv in lad["levels"]:
        print(f"{lv['elo']:>5} {lv['games']:>5} {lv['wins']:>3} {lv['draws']:>3} {lv['losses']:>3}  "
              f"{lv['state']:<9}  {lv['firstWinMatchId'] or ''}")


def cmd_serve(args: argparse.Namespace) -> None:
    import uvicorn

    from amazing.api import create_app

    uvicorn.run(create_app(), host=args.host, port=args.port, log_level="info")


def cmd_play(args: argparse.Namespace) -> int:
    from amazing.service import Backend

    async def run() -> int:
        mode = "off" if args.no_agents else ("wait" if args.wait_agents else "detached")
        settings = load_settings()
        if args.parallel:
            settings.parallel = args.parallel
        b = Backend(settings, agents_mode=mode)
        if settings.engine_is_placeholder:
            print("! engine binary not found - using the Python placeholder player", file=sys.stderr)
        b.start()
        try:
            states = await b.submit(stockfish_elo=args.elo, engine_color=args.color, count=args.count,
                                    start_fen=args.fen)
        except Exception as exc:  # InvalidRequest etc.
            print(f"error: {getattr(exc, 'message', exc)}", file=sys.stderr)
            await b.shutdown()
            return 2
        print(f"queued {len(states)} match(es) at Stockfish Elo {args.elo} "
              f"(move limit {settings.move_time_ms} ms, parallel {settings.parallel}, engine "
              f"{states[0].engine['name']} {states[0].engine_version})", flush=True)
        pending = {st.id: st for st in states}
        try:
            while pending:
                done = [st for st in pending.values() if st.done_event.is_set()]
                for st in done:
                    pending.pop(st.id)
                    print(f"{st.id}  engine={st.engine_color:<5} {st.result:<7} "
                          f"{(st.outcome or st.status):<7} {st.termination or '-':<22} "
                          f"{len(st.moves):>3} plies", flush=True)
                if pending:
                    await asyncio.sleep(0.5)
            if not args.no_analysis:
                print("running engine analysis ...", flush=True)
                await b.drain_analysis()
                for st in states:
                    print(f"{st.id}  analysis: {b.store.analysis_status(st.id)}", flush=True)
                if mode == "wait":
                    print("waiting for the agents ...", flush=True)
                    await b.drain_agents()
        except KeyboardInterrupt:
            pass
        finally:
            await b.shutdown()
        wins = sum(1 for st in states if st.outcome == "win")
        draws = sum(1 for st in states if st.outcome == "draw")
        losses = sum(1 for st in states if st.outcome == "loss")
        other = len(states) - wins - draws - losses
        print(f"result vs Stockfish {args.elo}: +{wins} ={draws} -{losses}" + (f" ({other} aborted/error)" if other else ""))
        if args.json:
            print(json.dumps([b.store.load_match(st.id) and {k: v for k, v in b.store.load_match(st.id).items()
                                                               if k != "moves"} for st in states], indent=2))
        return 0

    return asyncio.run(run())


def cmd_analyze(args: argparse.Namespace) -> int:
    """Engine analysis only by default (the agents are launched by the post-game worker or by
    the /analyze-game skill). --with-agents also runs them."""
    from amazing import agents as agents_mod
    from amazing.analysis import run_engine_analysis
    from amazing.store import GameStore

    settings = load_settings()
    store = GameStore(settings.games_dir)
    ids = list(args.match_ids)
    if args.missing:
        ids += [mid for mid in sorted(store.list_ids()) if store.read_analysis(mid) is None]
    if not ids:
        print("nothing to analyse", file=sys.stderr)
        return 1
    rc = 0
    for mid in ids:
        if store.load_raw(mid) is None:
            print(f"{mid}: no such saved game", file=sys.stderr)
            rc = 1
            continue
        existing = store.read_analysis(mid)
        if existing and existing.get("status") not in ("pending",):
            archived = store.archive_analysis(mid)
            if archived:
                print(f"{mid}: previous analysis archived to {archived}")
        try:
            a = run_engine_analysis(store, mid, settings, depth=args.depth)
        except Exception as exc:
            print(f"{mid}: analysis failed: {exc}", file=sys.stderr)
            rc = 1
            continue
        s = a.get("summary", {})
        print(f"{mid}: {a['status']}  depth {a['analyzer']['depth']}  opening {s.get('opening')}  "
              f"engine acc {s.get('engineAccuracy')}  stockfish acc {s.get('stockfishAccuracy')}  "
              f"decisive ply {s.get('decisivePly')}")
        if args.with_agents and not args.no_agents:
            if agents_mod.claude_available(settings):
                print(f"{mid}: running agents (log: {store.dir(mid) / 'agents.log'}) ...", flush=True)
                code = agents_mod.run_agents(settings, store, mid)
                print(f"{mid}: agents finished (exit {code}), analysis {store.analysis_status(mid)}")
            else:
                print(f"{mid}: claude CLI not found; agents skipped", file=sys.stderr)
    return rc


def cmd_agents(args: argparse.Namespace) -> int:
    from amazing import agents as agents_mod
    from amazing.store import GameStore

    settings = load_settings()
    store = GameStore(settings.games_dir)
    if store.load_raw(args.match_id) is None:
        print(f"{args.match_id}: no such saved game", file=sys.stderr)
        return 1
    return agents_mod.run_agents(settings, store, args.match_id)


def cmd_ladder(args: argparse.Namespace) -> int:
    from amazing.derive import ladder
    from amazing.store import GameStore

    store = GameStore(load_settings().games_dir)
    lad = ladder(store.list_matches())
    if args.json:
        print(json.dumps(lad, indent=2))
    else:
        _print_ladder(lad)
    return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="python -m amazing", description="Amazing Chess backend")
    sub = p.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("serve", help="run the HTTP API (contracts/openapi.yaml) on /api")
    s.add_argument("--host", default="127.0.0.1")
    s.add_argument("--port", type=int, default=8000)
    s.set_defaults(func=cmd_serve)

    s = sub.add_parser("play", help="play matches headless vs limited Stockfish (saved to the game store)")
    s.add_argument("--elo", type=int, required=True, help="Stockfish UCI_Elo (1320-3190)")
    s.add_argument("--color", default="alternate", choices=["white", "black", "random", "alternate"])
    s.add_argument("--count", type=int, default=1, help="number of matches (1-100)")
    s.add_argument("--parallel", type=int, default=None, help="matches in parallel (default AC_PARALLEL)")
    s.add_argument("--fen", default=None, help="optional start position (testing)")
    s.add_argument("--no-analysis", action="store_true", help="do not wait for the engine analysis")
    s.add_argument("--no-agents", action="store_true", help="do not launch the Claude agents")
    s.add_argument("--wait-agents", action="store_true", help="wait for the agents to finish")
    s.add_argument("--json", action="store_true", help="print the match summaries as JSON")
    s.set_defaults(func=cmd_play)

    s = sub.add_parser("analyze", help="(re-)run the engine analysis of saved games (engine-only by default)")
    s.add_argument("match_ids", nargs="*")
    s.add_argument("--depth", type=int, default=None, help="Stockfish depth (default AC_ANALYSIS_DEPTH)")
    s.add_argument("--missing", action="store_true", help="also analyse every game without analysis.json")
    s.add_argument("--no-agents", action="store_true", help="engine analysis only (the default)")
    s.add_argument("--with-agents", action="store_true", help="also run the Claude agents afterwards (blocking)")
    s.set_defaults(func=cmd_analyze)

    s = sub.add_parser("agents", help="run the GM-coach + engine-dev agents for one game (blocking)")
    s.add_argument("match_id")
    s.set_defaults(func=cmd_agents)

    s = sub.add_parser("ladder", help="print the Elo ladder")
    s.add_argument("--json", action="store_true")
    s.set_defaults(func=cmd_ladder)
    return p


def main(argv: Optional[List[str]] = None) -> None:
    logging.basicConfig(level=logging.WARNING, format="%(levelname)s %(name)s: %(message)s")
    args = build_parser().parse_args(argv)
    rc = args.func(args)
    sys.exit(rc or 0)
