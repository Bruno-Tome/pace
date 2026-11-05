# 11. On pace mode: spend less while a quota runs ahead

Status: accepted, 2026-11-05. Records what pace does today.

## Context

A quota over pace runs out before its reset unless the agent spends less per turn.

## Decision

While it is on, for its session only:

- after a run, compact a heavy context while the cache is still warm;
- keep a large idle cache warm;
- lower the effort or thinking level while the rate would run a quota out.

It never changes what the agent is working on.

## Consequences

- It needs a host that can compact or change the effort: Claude Code and pi. Codex and Antigravity say they can't.
