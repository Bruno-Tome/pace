# 14. One `/pace` grammar, read once for every host

Status: accepted, 2026-11-05. Records what pace does today.

## Context

Every host takes the same `/pace` arguments. Parsing them in each adapter let them drift apart.

## Decision

`commandOf(args)` in `core/command.ts` turns the arguments into a `PaceCommand`, with the defaults and usage text.
Each adapter maps the command to what it can do (`codexAction`, `piAction`, Antigravity's own) and says plainly what
it can't. [0001](0001-herdr-first.md) has the table of every command by host.

## Consequences

- A new argument is added once, and every host either carries it out or says it can't.
- [0018](0018-core-api-acp-ports.md) proposes taking "says it can't" from the host's declared capabilities, so it
  stops being written into each adapter.
