# 05 · Testing — engine, contract and the Elo ladder

## Engine testing layers

| Layer | What | Tool | When |
|---|---|---|---|
| Correctness | Move generation | **perft** suite (start pos, Kiwipete, positions 3–6) | Every movegen change; CI |
| Sanity | Best move / eval on known positions | **stockfish.online** (below), tactical suites (WAC, STS) | While developing search/eval |
| Strength | New version vs previous | **SPRT** with **fastchess** or **cutechess-cli** at short TC (e.g. 10s+0.1s) | Before merging any engine change |
| Competition | Our engine vs limited Stockfish at 5 s/move | Backend match runner | Ladder runs |

## stockfish.online — quick engine checks

Stockfish 17.1 as a REST API. No install, handy for sanity checks, CI smoke tests and
comparing our engine's choice with Stockfish's.

```bash
curl "https://stockfish.online/api/s/v2.php?fen=<URL-encoded FEN>&depth=12"
```

| Param | Meaning |
|---|---|
| `fen` | Position (URL-encode spaces as `%20`) |
| `depth` | Search depth **1–15** |

Response:
```json
{ "success": true, "evaluation": 0.46, "mate": null,
  "bestmove": "bestmove e7e5 ponder g1f3",
  "continuation": "e7e5 g1f3 b8c6 b1c3 g8f6 ..." }
```
`evaluation` is in pawns from White's point of view (`null` when there is a mate); `mate` is
moves-to-mate (may arrive as a string, e.g. `"1"`) or `null`. `bestmove` may omit `ponder`.
Send a `User-Agent` header — the default Python-urllib agent gets **403**.

Helper: [`scripts/stockfish_online.py`](../scripts/stockfish_online.py)
(`python scripts/stockfish_online.py "<FEN>" --depth 12`).

**Use it for:**
- "Does our engine find the same best move?" on a position list (agreement %)
- Checking our eval sign/scale against Stockfish's
- Spot-checking blunders flagged in analysis
- A no-install fallback for the analysis skill in CI

**Do not use it for official competition games:**
- ❌ No `UCI_LimitStrength` / `UCI_Elo` — it always plays at full strength (rule R9)
- ❌ Depth-limited, not time-limited — not comparable to 5 s/move
- ⚠️ Rate limits; API keys may become required — cache results, don't hammer it

Official games use a **local Stockfish binary** configured by the match runner.

## SPRT workflow (every engine PR)
```bash
fastchess -engine cmd=engine/target/release/new name=new \
          -engine cmd=engines/prev name=prev \
          -each tc=10+0.1 -rounds 5000 -repeat -concurrency 8 \
          -openings file=books/UHO_Lichess_4852_v1.epd format=epd order=random \
          -sprt elo0=0 elo1=5 alpha=0.05 beta=0.05
```
Paste the result (Elo ± error, LLR, games) in the PR. Accept only if H1 passes.

## Ladder procedure (competition runs)
```text
elo = highest beaten + 100   (start at 1320)
loop:
  play N games at `elo` (alternate colours, 5 s/move, several in parallel)
  every game saved + analysed
  any win → level beaten (proof game) → elo += 100 (+50 near the frontier)
  no win after N → improve engine (backlog) → SPRT → retry
```
We need only **one** win per level — play many games at the frontier.

## Contract testing
- `npx @redocly/cli lint contracts/openapi.yaml`
- `python contracts/validate_examples.py`
- Backend: validate real responses against the schemas in API tests.
- Frontend: type-check against types generated from the contract.
