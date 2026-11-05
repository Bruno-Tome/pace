# 7. Shared data merges, never overwrites

Status: accepted, 2026-11-05. Records what pace does today.

## Context

Parallel sessions share samples, prompts and spend, and they write at the same time.

## Decision

Every merge is free of order and only grows. A session's bucket keeps the larger of two copies, so no session undoes
another's. New shared data follows the same pattern: capacities learned, alerts already said, auto mode's runs.

## Consequences

- No locks across sessions, except a hook's lock over its own files.
- Sharing windows across harnesses ([0017](0017-quota-is-provider-and-account.md)) can reuse this merge as it is.
