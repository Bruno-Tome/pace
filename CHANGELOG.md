# Changelog

## Unreleased

- Auto mode stops when Claude is waiting on you. Its instructions have Claude end with `PACE: BLOCKED <what it
  needs>` when it hands you a task or needs your feedback, and a turn that ends on a question with no `PACE:` line
  reads as blocked too, the question as its reason. Before, such a turn read as `PACE: NEXT` and pace prompted on
  while you were away.
- The contract adds ultra pace's shapes, ahead of the mode itself: `PaceAuto` gains an optional `ultra: PaceUltra`
  (the goal, its check, the phase, the counters for its guards, the model bounds, the gear, any subagents out on
  a fan-out and a review owed through a hold) and `PaceGear` (model, effort, subagents, their model, fan-out). A run stored without it, or with one
  that does not parse, reads as plain auto mode.
- The plan's timeline reads no steps from a `## Goal` or `## Revisions` section, and drops a step's `(parallel)`
  mark from its text. A step in the window's state file (`~/.claude/pace-state.json`) adds an optional
  `parallel: true` when it carries the mark.
- The `/pace` split shows the new modes and the roadmap: auto mode's run or on pace mode under its title, with
  `effort a level lighter` while the rate would run a quota out, and the plan's timeline (auto mode's plan, the one
  `/pace plan` named, or `ROADMAP.md`) under the charts when it has a checklist. The window's state file
  (`~/.claude/pace-state.json`) adds an optional `plan` with the plan's name and steps.
- The modes row puts what a mode is doing before the command that turns it off, and on pace mode's row says
  `compacts heavy contexts, keeps the cache warm · /pace off`.
- The Chinese README is gone; the README is in English only.
- `/pace plan [file]` opens the plan's timeline in a sidebar, and starting auto mode opens it too: inside tmux a
  narrow split on the right of Claude, elsewhere a pane, docked beside the transcript in fullscreen. It shows the steps
  done, the step under way and the step up next, read from the plan's checklist each time a turn ends, under a
  header with the count done, a progress bar and what auto mode is doing. A long step wraps under its own text with
  the timeline's line beside it, its `· under way` or `· up next` kept on one row. A long plan folds the steps far behind and
  far ahead. It is animated: the steps come in from the top, a dot runs into the step under way, and a step ticked
  off pops into a check.
- `/pace auto` with no plan file works through `ROADMAP.md`.
- Auto mode's last turn, done or blocked, ends with a report: what got done, why it stopped, what needs you with
  its reason and urgency, how to do it, and the plan's checklist as it now stands.
- The status-line entry is built from the band's own rate cell, so the two always agree:
  `5h 60% ▲ burst · out in 20m at this rate │ Fable wk 68% ● → —`. Quotas are now separated by `│`.
- On pace mode, and so auto mode, thinks one effort level lighter while the rate would run a quota out before its
  reset (a burst, or too fast with a known run-out), and goes back to the effort you set once the rate is steady.
  It lowers the effort rather than the model, since a new model starts with a cold cache.
- A burst says it is the recent rate: `▲ burst · out in 2h51m at this rate` on the band and
  `5h 11% ▲ burst · out in 2h51m at this rate` on the status line, so it no longer reads against an `Under pace`
  status beside it.
- A quota over pace with no per-prompt cost yet reads `▲ over pace · no cost yet` in the band and the status line,
  `over pace` in the pane, instead of a red, flashing `→ — at reset too fast`. Red and flashing wait for a cost
  that shows the rate runs the quota out. Its rate level is still `fast`, so alerts and auto mode's holds are unchanged.
- A window whose reset has passed shows the new window from that moment, at 0% and counting toward its next
  reset, until a reading of it arrives. Before, the band said `Window ended` and the status line kept the old
  window's percent (`5h 65%`). `$.pace.snapshot()` reports the new window's percent and reset the same way.
- Auto mode, on pace mode and warm mode are scoped to the session that turned them on, stored under its id, so
  `claude --resume` picks a run back up. Before, they lived in prefs every session shared: an auto run started in
  one session drove any other that started or reloaded. Modes an older pace stored there are ignored. A session's
  modes are forgotten a month after it last changed them.
- Auto mode no longer prompts turns that only wait. Claude ends a turn with `PACE: WAITING <what>` while background
  work runs, and pace sends nothing until a turn of its own starts or 15 minutes pass. Two turns in a row that move
  neither the plan nor the handoff file stop the prompting, with waits of 5, 10, 20 and 30 minutes.
- A context whose window is not known reads its size alone (`context 180k`) instead of `Infinity%`, and no longer
  reads as heavy: auto mode stops handing off on every turn and on pace mode stops compacting it.
- A rate limit reported without a percent, or a stored reading of `NaN` or `Infinity`, is dropped instead of read
  as on pace.
- Auto mode's hold ending during a turn of your own sends nothing on top of it: that turn's end decides. A
  resumed session whose run was holding picks the plan back up when the hold ends.
- A subagent starting a turn of its own no longer keeps warm mode and on pace mode from keeping the cache warm.
- `/pace line off` clears the status-line entry after a hot reload too: a freshly loaded module says its entry
  once instead of assuming none is shown.
- Each quota shows where your rate takes it: the percent it lands at by its reset (`→ 71% at reset`), or when it
  runs out (`out in 38m`). It replaces the `rate of budget %/h` score, whose budget grew without bound as a
  window neared its reset. `$.pace.snapshot()` adds `percentAtReset` to each quota's rate.
- A model's own week counts only that model's prompts and spend: prompting Opus no longer makes the Fable week
  too fast. Prompts and spend record the session's model; ones recorded before still count everywhere.
- Too fast flashes red only while you are prompting: a quota with no prompt in the last 15 minutes reads idle,
  however far over pace it is or whatever a running turn still spends. Alerts and auto mode's holds follow.
- Each quota keeps its own score: the band, the status line and the pane rate every quota in points of it an hour
  against its own budget (`19 of 20%/h`, `0.3 of 0.44%/h`), instead of repeating the prompts or dollars an hour
  every quota shares. `$.pace.snapshot()` adds `percentPerHour` and `percentBudgetPerHour` to each quota's rate.
- The status-line row puts each quota's rate beside it, without the band's column padding.
- The pane's advice names the quota mid-sentence (`the week · Fable`) and says its budget in prompts or dollars.

## 0.8.0

pace, a terminal-first take on [weektoken](https://github.com/3dnow/claude-mods/tree/main/weektoken)'s idea, with
its own quota model. What differs from weektoken:

- Terminal surfaces: a band above the prompt, a status-line entry or row, and `/pace`'s full-screen window
  (two columns when wide; keys `1`–`9`, `w`, `r`, `q`).
- `/pace` runs at once, mid-turn too, and answers in a toast: nothing lands in the conversation.
- Statuses: under pace, on pace, over pace, and **gassed out** for a spent quota.
- The rate against each quota: steady, brisk, burst, too fast.
- Shared spend across parallel sessions: pacing in dollars an hour against what each quota has left, and a
  per-prompt cost from the first prompt.
- The prompt cache: a countdown and the next prompt's cost, warm vs cold, in tokens and dollars.
- Warm mode keeps an idle cache from lapsing.
- Usage warnings at 80%, 95%, a rate that gasses a quota out, and gassed out: once per window, as a toast and a
  notification.
- On pace mode (`/pace on`) for long-running sessions: compacts a heavy context while its cache is warm.
- Auto mode (`/pace auto <plan>`): works through a plan with no one at the keyboard, with handoffs, subagents on
  lighter models, holds for pacing, and an onboarding pane.
- `$.pace.snapshot()` for other mods.
