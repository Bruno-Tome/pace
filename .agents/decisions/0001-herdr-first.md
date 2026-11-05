# 1. Herdr first: every command goes through Herdr, the harness's own UI is the fallback

Status: accepted, 2026-11-05.

## Context

pace runs on harnesses (Claude Code, Codex, pi, Antigravity), each with its own UI, or none: Codex has no pane or
status line for a plugin, pi has a widget, a footer and overlays, Claude Code has panes and a band. Herdr is not one
more harness: it is the terminal that wraps them, and it can open a view beside any of them, the same view whichever
harness asked. Each adapter also has to run every `/pace` command (`core/command.ts`), some of which only a harness can
carry out: auto mode sends the next prompt, on pace mode changes the effort, warm mode compacts.

## Decision

Herdr is the exception among the adapters. When the harness runs inside Herdr (`HC_TERMINAL_ID` is set), every
`/pace` command goes through Herdr first: Herdr carries out what it can, and only what Herdr cannot do, or what fails
there, falls back to the harness's own UI or to the harness itself.

- **What Herdr carries out:** every view. `/pace`, `split`, `pane` and `window` open the harness's charts in a Herdr
  pane beside the session, `band` its band under it, `fleet` the fleet panel; a view already open is focused.
- **What falls back to the harness:** what drives the agent or changes the harness: on pace mode, auto mode, ultra
  pace, warm mode, the band's and the status line's preferences, refresh, and a plan's timeline where Herdr shows none.
- **When Herdr fails** (no `herdr-app`, a pane it cannot open), the view opens in the harness's own UI as it would
  outside Herdr, and the answer says why.
- **Outside Herdr** each harness uses its own UI, and says plainly what it cannot do.

## Every command by host

Outside Herdr. In Herdr, every view in this table opens in Herdr instead.

| Command | Claude Code | Codex | pi |
| --- | --- | --- | --- |
| `/pace`, `split` | tmux split, else the pane | tmux split with the charts, else answered as text | the charts over pi; `split` in tmux: the band in a split |
| `pane` | the pane | the charts answered as text | the charts over pi |
| `window` | a macOS terminal window | a macOS terminal window | the charts over pi, saying pi has no window |
| `band` | the band is above the prompt | tmux split with the band, else the band as text | the band is above the editor |
| `fleet` | the pane's fleet | tmux split with the fleet, else as text | the fleet over pi |
| `refresh` | every source read again | the feed written again | every feed read again |
| `hide`, `show`, `line on/off` | the band, the status line | says Codex has no band or status line of its own | the band widget, the footer entry |
| `on`, `off` | compaction, warm cache, lower effort | says Codex's hooks cannot lower the effort or compact; warnings stay | compaction, warm cache by compacting, lower thinking level |
| `warm …` | ping or compact | says Codex reports no cache | compact; ping says pi cannot |
| `auto …` | every decision | through the Stop hook: the next prompt, a hold up to nine minutes, a longer one pauses the run | every decision; a handoff compacts |
| `ultra …` | every decision | says Codex's hooks cannot change the model or effort | a plan with gears: pi's models and thinking levels (ADR 0021) |
| `plan`, `timeline` | tmux sidebar or pane | tmux split, else as text | tmux split, else over pi |

## Consequences

- One rule for every adapter: `adapters/herdr/open.ts` decides what a view opens in Herdr, and each adapter tries it
  before its own UI. Claude Code's `pane` and `window` go through Herdr too when it runs there.
- The Herdr mod never types into an agent; the agent's own adapter carries out what drives it.
- Each adapter's tests cover both paths: in Herdr (a fake `herdr-app` on the `PATH`) and outside it, and a failed
  Herdr falling back.
