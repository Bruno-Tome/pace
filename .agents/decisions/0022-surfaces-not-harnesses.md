# 22. The core draws for surfaces, not for harnesses

Status: accepted, 2026-11-05. Being built.

## Context

Each adapter decides today what to draw where: Claude Code's band and status line, pi's widget, footer and overlay,
Codex's answer text, tmux splits, Herdr panes. Each also writes its own "this host has no …" answers. Adding a host
means writing its UI rules again.

## Decision

- **A host declares surfaces, not a harness name.** At `initialize` ([0018](0018-core-api-acp-ports.md)) each host
  lists the surfaces it can show, each by kind and size: `band` (lines above the input), `status` (one line),
  `toast` (a short notice), `overlay` (lines over the TUI), `answer` (text the user reads in place of a reply),
  `split` (a terminal beside it: tmux, a macOS window) and `herdr` (a Herdr pane). Each has its width when known.
- **The core picks the surface.** For each view and notice the core picks the best surface the host has, in one
  ordered rule (Herdr first, [0001](0001-herdr-first.md)), and returns `_pace/draw {surface, lines}` or
  `_pace/open {view, surface}`. The lines are `view.ts`'s segments, as now.
- **The adapter only renders.** It turns segments into its host's elements or ANSI and puts them on the named
  surface. It holds no rule about what goes where, and no harness-specific text.

## Consequences

- The command-by-host table in [0001](0001-herdr-first.md) becomes an output of the core, tested once per surface
  set instead of once per adapter.
- A new harness needs a renderer for its surfaces and its event translation, nothing else.
