# 5. `/pace` answers outside the conversation

Status: accepted, 2026-11-05. Records what pace does today.

## Context

A `/pace` command is for the user, not the model. An answer that lands in the transcript costs tokens and context on
every later turn, and the model may act on it.

## Decision

`/pace` answers in toasts, panes, widgets, overlays, Herdr panes or a blocked prompt's reason, never in the
conversation. Each adapter stops the prompt before the model sees it:

- Claude Code runs it as a command.
- pi runs it as a registered command.
- Codex blocks it in `UserPromptSubmit`, with the answer as the reason.
- Antigravity terminates it in `PreInvocation`.

Only auto mode's start and resume go on to the model, carrying its instructions.

## Consequences

- A host that can't stop a prompt before the model can't run `/pace` there. It falls back to a skill that runs one
  command and says one line.
