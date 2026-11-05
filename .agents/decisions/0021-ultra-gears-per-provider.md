# 21. Ultra pace's gears, per provider

Status: accepted, 2026-11-05. Being built.

## Context

`core/throttle.ts` climbs Claude's models (haiku, sonnet, opus, with `sonnet` as the floor). pi on ChatGPT, and any
ACP agent, have other models and other thinking levels, so ultra pace is Claude Code's alone.

## Decision

- **A gear is a step on a ladder of `{model, thinking}`.** Each provider has its ladder, from weakest to strongest,
  in one table in the core.
- **The host's capabilities ([0018](0018-core-api-acp-ports.md)) narrow the ladder to what is offered.** These are
  ACP's `model` and `thought_level` options, or pi's model list and thinking levels.
- **Ordering stays in pace's table,** since neither ACP nor a harness ranks its models.
- The floor and the ceiling become rungs on the provider's ladder. Moving between gears is the
  `session/set_config_option` action.

## Consequences

- Ultra pace runs wherever a host can change the model or the thinking level: Claude Code, pi, ACP agents. Codex's
  hooks still can't, so Codex says so.
