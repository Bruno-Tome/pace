# 6. Feeds: one file per session, one contract for every host

Status: accepted, 2026-11-05. Records what pace does today.

## Context

The fleet, the Herdr mod and `bin/band.ts` have to read every host's sessions without importing any host's code.

## Decision

- Each session writes `~/.local/state/pace/feeds/<host>-<session>.json`: a `PaceFeed`
  (`{version, host, provider, session, terminal?, cwd, at, snapshot, context?}`). It is written atomically, read
  defensively and dropped once stale.
- `types/index.d.ts` is the contract. A change to it is additive, recorded in the CHANGELOG, and read back safely
  from older feeds.
- A feed carries its harness's whole history, not just its session's. Writers merge, and readers only pick the
  newest reading of each provider.

## Consequences

- Readers stay within Herdr's render budget, because they never merge.
- A feed names its provider, so two hosts' `five_hour` never mix. Today it doesn't name the account: see
  [0017](0017-quota-is-provider-and-account.md).
