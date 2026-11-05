# 15. The fleet: every quota side by side, work sent where there is room

Status: accepted, 2026-11-05. Records what pace does today.

## Context

With several harnesses and agents running, the question becomes where the next piece of work should go.

## Decision

- `fleetOf` and `fleetModel` (pure) join pace's and ql's feeds to Herdr's agents. Each provider gets one row, with its
  5-hour and weekly use, the room left, and its agents.
- Views by provider, by repo (two agents on one branch clash) and by urgency.
- **Send work** opens a new Herdr tab after a second click. The fleet never types into a running agent.

## Consequences

- Rows are per provider today, so two accounts of one provider would show as one. See
  [0017](0017-quota-is-provider-and-account.md).
