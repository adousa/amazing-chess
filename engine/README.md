# engine/

Our chess engine **AmazingChess** — a standalone Rust binary that speaks **UCI**. Owned by the engine developers.

- What it must do: [CLAUDE.md](../CLAUDE.md) · How: [docs/04-engine.md](../docs/04-engine.md)
- Testing (perft, SPRT, stockfish.online): [docs/05-testing.md](../docs/05-testing.md)
- Hard rule: never think longer than the time given (≤ 5 s per move).

## Build and run

```bash
cargo build --release                 # → target/release/amazing-chess (target-cpu=native, see .cargo/config.toml)
cargo test --release                  # perft + board + search tests (deep perft: -- --ignored)
./target/release/amazing-chess perft 6 [fen]
./target/release/amazing-chess bench  # fixed-depth search on a few positions, prints nodes + nps
./target/release/amazing-chess        # UCI mode
```

UCI options: `Hash` (MB, default 64), `Threads` (Lazy SMP helpers), `Contempt`, `Move Overhead`.
Supports `go movetime | wtime/btime/winc/binc/movestogo | depth | nodes | infinite | perft`, `stop`.

## Features (v0.1.0)

Bitboards with magic sliders, legal movegen, Zobrist · negamax **PVS** + iterative deepening +
aspiration windows · quiescence with SEE · TT · move ordering (TT → captures → killers →
countermove → history) · null-move, reverse futility, futility, late-move and SEE pruning · LMR ·
check extensions · repetition/50-move/insufficient-material draws with **contempt** · PeSTO
tapered eval + passed pawns, mobility, king safety, bishop pair · time management with a hard stop.

## Measured (Apple M-series, 2026-09-25)

| Check | Result |
|---|---|
| perft startpos d6 | 119,060,324 ✅ (0.7 s) |
| perft Kiwipete d5 | 193,690,690 ✅ |
| `bench` | ~2.9 M nps |
| `go movetime 5000` on 11 positions (`scripts/timing_check.py`) | max **4294 ms** go→bestmove ✅ |

Not yet measured: strength vs limited Stockfish (`scripts/sanity_vs_stockfish.py --elo 1800 --games 10 --movetime 200`),
SPRT vs previous version.

## Scripts

- `scripts/timing_check.py` — wall-time check of the 5 s rule.
- `scripts/sanity_vs_stockfish.py` — quick W/D/L vs `UCI_Elo`-limited Stockfish at short movetime.
