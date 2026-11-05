# 12. Auto mode: a checklist worked through at the quota's pace

Status: accepted, 2026-11-05. Records what pace does today.

## Context

Long runs stall when nobody is at the keyboard, or when they hit a spent quota.

## Decision

- `/pace auto [plan] [turns]` works through a plan's checklist (`ROADMAP.md` by default) one turn after another.
- After each turn, `decide()` returns `continue`, `hold` (wait for room in the quota), `handoff` (start fresh from the
  plan), `stop` or `pause`. The adapter carries it out.
- It stops when the agent waits on the user. `burst` lifts the pacing for a while. `resume` picks a paused run back up
  with more turns when they ran out (`resumed()` in `core/auto.ts`).
- The run belongs to its session, and it lives in the feed's `snapshot.auto`.

## Consequences

- Each host carries it out its own way:
  - Claude Code: every decision.
  - pi: a handoff compacts instead of clearing.
  - Codex: from the Stop hook, where a hold longer than nine minutes pauses the run.
