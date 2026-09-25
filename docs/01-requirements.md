# 01 · Functional requirements

Numbered so issues, PRs and tests can reference them (e.g. "implements FR-3.2").
These expand the "What the application must do" section of [`CLAUDE.md`](../CLAUDE.md) with
acceptance criteria. Keep the two in sync.

## FR-1 Play matches
| ID | Requirement | Acceptance criteria |
|---|---|---|
| FR-1.1 | Start a match: our engine vs Stockfish at a chosen Elo | `POST /matches` with `stockfishElo` queues a match; it runs to completion |
| FR-1.2 | Stockfish is limited with `UCI_LimitStrength=true` and `UCI_Elo=<elo>` | Saved `stockfish.limitStrength` is `true` and `stockfish.elo` equals the request |
| FR-1.3 | Elo range 1320–3190 | Values outside are rejected with 400 `invalid_elo` |
| FR-1.4 | Engine colour: white / black / random / alternate | Saved `engineColor` matches; `alternate` flips across a batch |
| FR-1.5 | Max 5 s per move for both sides | Every saved `move.timeMs ≤ 5000`; a side that exceeds it loses with `time-limit-exceeded` |
| FR-1.6 | Normal chess termination rules | Checkmate, stalemate, threefold, 50-move, insufficient material all end the game correctly |
| FR-1.7 | Illegal move or crash by our engine loses the game | Termination `illegal-move` / `engine-crash`, game still saved |
| FR-1.8 | Queue many matches, optionally run in parallel | `count` up to 100; parallelism configurable in the backend |
| FR-1.9 | Abort a match | `POST /matches/{id}/abort` → status `aborted`, game saved |

## FR-2 Outcome
| ID | Requirement | Acceptance criteria |
|---|---|---|
| FR-2.1 | Outcome from our engine's POV | `outcome ∈ {win, draw, loss}` consistent with `result` and `engineColor` |
| FR-2.2 | Draw ≠ win | Ladder marks a level `beaten` only if ≥ 1 `win` |

## FR-3 Save every game
| ID | Requirement | Acceptance criteria |
|---|---|---|
| FR-3.1 | Every game saved (incl. losses, draws, aborted, errors) | Count of saved games = count of started matches |
| FR-3.2 | PGN with evidence headers | PGN has `White`, `Black`, `Result`, `StockfishElo`, `EngineColor`, `EngineVersion`, `TimeControl`, `Termination`, `MatchId`, `UTCDate/Time` |
| FR-3.3 | Structured record matching the contract `Match` schema | `match.json` validates against `openapi.yaml#/components/schemas/Match` |
| FR-3.4 | Games are immutable after finishing | Analysis is stored in a separate file; game files are never rewritten |
| FR-3.5 | Stockfish settings recorded | version, elo, threads, hash, moveTimeMs saved |

## FR-4 Replay
| ID | Requirement | Acceptance criteria |
|---|---|---|
| FR-4.1 | Graphical board replay, first → last move | Every ply can be shown; start and final positions match the game |
| FR-4.2 | Controls: start, back, forward, end, jump to move, autoplay (+ speed), keyboard arrows | All controls work on the example game |
| FR-4.3 | Header shows players, Stockfish Elo, result, termination | Visible on the replay page |
| FR-4.4 | Download PGN | Link to `/matches/{id}/pgn` |

## FR-5 Analysis
| ID | Requirement | Acceptance criteria |
|---|---|---|
| FR-5.1 | Analysis skill runs automatically after each game | `analysisStatus` goes `pending → running → ready` without manual steps |
| FR-5.2 | Per-move evaluation and classification | `analysis.moves` has one entry per ply |
| FR-5.3 | GM-coach sub-agent report (Carlsen-level persona) | `reports.gmCoach` with summary, key moments, ≥ 1 concrete suggestion |
| FR-5.4 | Engine-developer sub-agent report | `reports.engineDev` with summary, key moments, ≥ 1 concrete, engine-level suggestion |
| FR-5.5 | Reports viewable next to the replay | Replay page shows both reports, linked to plies |
| FR-5.6 | Re-run analysis keeps history | Previous analysis archived, not overwritten |

## FR-6 Progress
| ID | Requirement | Acceptance criteria |
|---|---|---|
| FR-6.1 | Elo ladder with W/D/L per level and state | `GET /ladder` + ladder page |
| FR-6.2 | Highest Elo beaten + link to proof game | `highestEloBeaten`, `proofMatchId` → opens replay |
| FR-6.3 | Stats by Elo, colour, engine version | `GET /stats` + stats page |
| FR-6.4 | (Nice to have) live match view | SSE stream rendered on a live board |

## FR-7 Improvement loop
| ID | Requirement | Acceptance criteria |
|---|---|---|
| FR-7.1 | Agent suggestions collected into a backlog | Suggestions are aggregated (e.g. `docs/backlog.md` or issues) |
| FR-7.2 | Engine changes measured before merge | SPRT/match result recorded in the PR |
| FR-7.3 | Loop driven by `/goal`, `/loop` or a workflow | Documented in [03-roadmap](03-roadmap.md) and used in practice |

## Non-functional
| ID | Requirement |
|---|---|
| NFR-1 | Runs locally on a laptop (macOS/Linux) with one command per component |
| NFR-2 | Reproducible matches: all engine/Stockfish settings recorded |
| NFR-3 | Frontend works against the contract mock with no backend running |
| NFR-4 | Replay page loads a game in < 1 s locally |
