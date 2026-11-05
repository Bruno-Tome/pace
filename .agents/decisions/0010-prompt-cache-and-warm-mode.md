# 10. The prompt cache is tracked, and kept warm on request

Status: accepted, 2026-11-05. Records what pace does today.

## Context

A cold cache bills the whole context again. Whether the next prompt is cheap depends on a timer the harness doesn't
show.

## Decision

- Each reply that reads or writes the cache restarts its timer. Its time to live is 5 minutes or 1 hour, as the host
  reports it. pi reports none, so pace assumes 1 hour there.
- The band shows the timer, the context and the next prompt's likely cost.
- Warm mode, per session: `ping` sends one word before the cache expires, and `compact` compacts a large idle
  context instead.
- A host that reports no cache (Codex, Antigravity) sets `noCache`, and the band leaves the row out.

## Consequences

- The ping is one of the only two calls off the machine ([0004](0004-local-only.md)).
