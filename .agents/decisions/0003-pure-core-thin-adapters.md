# 3. A pure core and thin adapters

Status: accepted, 2026-11-05. Records what pace does today.

## Context

pace runs under hosts that share nothing: Claude Code's plugin engine, Codex's hooks, pi's extensions, a Herdr mod,
Antigravity's hooks. The rules have to be the same everywhere, and testable in milliseconds.

## Decision

- **`core/` is pure:** values in, values out. No I/O, no `$` and no `Date.now()`: time comes in as `now`.
- **Decisions, not actions.** Logic that would act returns what to do instead (`decide()`'s `Decision`, `piStep`,
  `stopStep`, `codexAction`, `piAction`), and the adapter carries it out.
- **One rule, one owner.** Each rule lives in one function, and every surface reads it from there.
- **Model, then view.** `model.ts` decides what is true; `view.ts` returns styled segments. Each host turns them into
  elements, ANSI or Herdr's divs.
- **Adapters are thin.** Each one reads its host's events, calls the core and carries out the answer. Each keeps its
  own parsing pure (`rollout.ts`, `pi/feed.ts`, `antigravity/status.ts`).

## Consequences

- A new host is a new adapter. It never forks a rule.
- The core's entry points have grown host by host (`decide`, `piStep`, `stopStep`, two `*Action`s).
  [0018](0018-core-api-acp-ports.md) proposes one stable surface in their place.
