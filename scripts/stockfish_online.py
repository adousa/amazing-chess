"""Query stockfish.online (Stockfish 17.1 REST API) for a position — for engine testing only.

Usage:
  python scripts/stockfish_online.py "<FEN>" [--depth 12]
  python scripts/stockfish_online.py --file positions.epd [--depth 12]   # one FEN per line

No Elo limiting and depth-limited (1-15): never use this for official competition games.
Standard library only.
"""
import argparse
import json
import sys
import time
import urllib.parse
import urllib.request

API = "https://stockfish.online/api/s/v2.php"


def query(fen: str, depth: int = 12) -> dict:
    if not 1 <= depth <= 15:
        raise ValueError("depth must be 1-15")
    url = f"{API}?{urllib.parse.urlencode({'fen': fen, 'depth': depth}, quote_via=urllib.parse.quote)}"
    # The API rejects the default Python-urllib user agent with 403
    request = urllib.request.Request(url, headers={"User-Agent": "amazing-chess-tests/0.1"})
    with urllib.request.urlopen(request, timeout=30) as resp:
        data = json.load(resp)
    if not data.get("success"):
        raise RuntimeError(f"stockfish.online error for {fen!r}: {data}")
    # "bestmove e7e5 ponder g1f3" -> "e7e5"
    data["bestmoveUci"] = data["bestmove"].split()[1]
    return data


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("fen", nargs="?")
    parser.add_argument("--file")
    parser.add_argument("--depth", type=int, default=12)
    args = parser.parse_args()
    if args.file:
        fens = [line.split(";")[0].strip() for line in open(args.file) if line.strip()]
    elif args.fen:
        fens = [args.fen]
    else:
        parser.error("give a FEN or --file")
    for i, fen in enumerate(fens):
        if i:
            time.sleep(0.5)  # be polite to the free API
        print(json.dumps({"fen": fen, **query(fen, args.depth)}))


if __name__ == "__main__":
    sys.exit(main())
