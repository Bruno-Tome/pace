# 4. Local only: no telemetry, nothing off the machine

Status: accepted, 2026-11-05. Records what pace does today.

## Context

pace reads what the user's agents spend and do. It is personal data, and pace has no need of a server.

## Decision

- Everything pace knows stays in files on the machine: `~/.claude`, `~/.local/state/pace/`, each harness's folder.
- Only two calls leave the machine: the usage endpoint, with the harness's own sign-in, and warm mode's one-word ping
  that keeps the cache warm.
- Writing to a harness's configuration (Codex's `config.toml`, Antigravity's plugins), installing, committing and
  pushing all wait for the user's go-ahead.

## Consequences

- No feature depends on a service of pace's own.
- Antigravity's readings come from a server it runs on 127.0.0.1. That call never leaves the machine, but this rule
  doesn't allow it yet. [0020](0020-antigravity-cli.md) asks to amend it.
