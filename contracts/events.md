# Live match events (Server-Sent Events)

`GET /api/matches/{matchId}/events` → `Content-Type: text/event-stream`

Each message:

```
id: <seq>
event: <type>
data: <JSON MatchEvent>
```

Payload schemas: `components.schemas.MatchEvent` in [`openapi.yaml`](openapi.yaml).
A full sample stream: [`examples/events.sse`](examples/events.sse).

## Event types

| `type` | When | Payload (besides `type`, `matchId`, `seq`, `at`) |
|---|---|---|
| `match.snapshot` | First message when connecting to a match that already started (or finished) | `match`: full `Match` so far |
| `match.started` | The match begins | `match`: `Match` with no moves |
| `engine.info` | While a side is thinking (throttled, ≤ 4/s) | `side`, `thinking` (depth, score, pv…) |
| `move.played` | After every move | `move`: `Move` |
| `match.finished` | Game over | `result`, `outcome`, `termination` |
| `analysis.updated` | Analysis progress after the game | `analysisStatus`, optional `part` (`engine`/`gm-coach`/`engine-dev`) |

## Rules

- `seq` is monotonic per match and used as the SSE `id`. On reconnect the browser sends
  `Last-Event-ID`; the server resumes after it, or sends a fresh `match.snapshot`.
- The stream closes after `analysis.updated` with `status: ready|failed`, or after
  `match.finished` if the client does not care about analysis (clients can just close).
- Clients must ignore unknown event types (new types are a non-breaking change).
- The frontend must be able to render everything from `match.snapshot` + `move.played` alone;
  `engine.info` is decoration (eval bar, "thinking…" arrows).
