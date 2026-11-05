# 13. Ultra pace: a goal, a plan pace owns, gears by headroom

Status: accepted, 2026-11-05. Records what pace does today. The design is in [../ultra-pace.md](../ultra-pace.md).

## Context

Auto mode follows someone else's checklist at a fixed strength.

## Decision

- Ultra pace is given a goal. It writes and revises the plan itself, and stops only when the goal is verified by a
  check command captured at the start.
- It spends at the pace the quota allows. While the quota is under pace it shifts up: a stronger model, more thinking,
  parallel subagents. While it is over pace it shifts down.
- `core/throttle.ts` owns the gear. `core/ultra.ts` returns decisions on top of auto mode's.

## Consequences

- Its gears climb Claude's model ladder (haiku, sonnet, opus), so it runs only in Claude Code. A ladder for each
  provider is proposed in [0021](0021-ultra-gears-per-provider.md).
