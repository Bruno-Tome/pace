# 16. Red before green, green on every host

Status: accepted, 2026-11-05. Records what pace does today. The full rules are in [../README.md](../README.md).

## Context

pace's rules run on four runtimes, and a rule that is only right on one of them is a bug.

## Decision

- No production code without a failing test that asks for it, and that fails for the expected reason.
- A test is never weakened to get green. A wrong test is fixed on its own, with the reason stated.
- Done means green everywhere: `claude plugin test .`, `claude plugin validate .`, tsc, the Node core suite, the
  Node-only suites and `node scripts/herdr.ts check`.

## Consequences

- Pure rules get unit tests. What the user sees gets engine tests. A host's I/O gets end-to-end tests on Node in a
  scratch home.
