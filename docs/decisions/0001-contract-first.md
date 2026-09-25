# 0001 · Contract-first API between backend and frontend

**Status:** Accepted · 2026-09-25

## Context
Several developers build the backend and frontend at the same time. Without an agreed
interface the frontend waits for the backend, or both drift apart.

## Decision
- The REST API is defined in `contracts/openapi.yaml` (OpenAPI 3.1); live updates are
  Server-Sent Events defined in `contracts/events.md` with schemas in the same OpenAPI file.
- SSE instead of WebSockets: updates are one-way (server → browser), SSE reconnects
  automatically and works over plain HTTP.
- The frontend develops against a Prism mock; the backend validates responses against the
  schemas. Examples are validated in CI.

## Consequences
- Contract changes go first and need backend + frontend review.
- Consumers ignore unknown fields so additive changes are safe.
