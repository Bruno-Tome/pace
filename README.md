# pace

**Rate-limit pacing for Claude Code, in the terminal.** pace sets your 5-hour and weekly quotas against the clock
while you work, prices each prompt, and keeps long-running sessions from getting **gassed out**: hitting a spent
quota and stalling until it resets.

```
5h       ████████████████████████░░│░░░░░░  72% Over pace   ↻ 1h41m  │  ▲▲ out in 1h04m too fast
Fable wk ███████████░░░░░░░░░░░│░░░░░░░░░░░  41% Under pace  ↻ 3d     │  ● → 64% at reset
cache    ██████████████████████████░░░░░░░░   55m 120k ctx   next ≈12k tk · $0.04
```

Inspired by [weektoken](https://github.com/3dnow/claude-mods/tree/main/weektoken), a quota-pace chart for Claude
Code. pace is its own take on the idea: a terminal-first port with its own quota model, pacing across parallel
sessions, and modes that keep a long run on pace with no one at the keyboard.

## Contents

- [Quick start](#quick-start)
- [What it shows](#what-it-shows)
- [Statuses and rates](#statuses-and-rates)
- [Pacing across parallel sessions](#pacing-across-parallel-sessions)
- [On pace mode](#on-pace-mode)
- [Auto mode](#auto-mode)
- [Ultra pace](#ultra-pace)
- [Commands](#commands)
- [Options](#options)
- [For other mods](#for-other-mods)
- [Where the numbers come from](#where-the-numbers-come-from)
- [How it is built](#how-it-is-built)
- [Development](#development)
- [License](#license)

## Quick start

```
/plugin install pace --marketplace Bruno-Tome/pace
```

The band appears above the prompt after the first reply. Then:

- `/pace` opens the burn-up charts for every quota.
- `/pace on` keeps a long session on pace.
- `/pace auto PLAN.md` works through a plan unattended.

### Where it runs

| Feature | Needs |
| --- | --- |
| The band, the status line, `/pace pane`, on pace mode and auto mode | Anywhere Claude Code runs |
| `/pace` in a split beside Claude | tmux, and Node 23.6 or later (it runs TypeScript directly) on your `PATH` |
| `/pace window` | macOS, and Node 23.6 or later on your `PATH` |

Outside tmux, `/pace` opens the pane instead.

## What it shows

- **A band above the prompt:** the 5-hour and weekly bars, each with its pace status and the rate against it,
  then the prompt cache's countdown and what the next prompt costs.
- **A status-line entry,** or with `placement: status`, a full row your status line prints.
- **`/pace`:** burn-up charts for every quota. Inside tmux it opens full-screen in a split beside Claude (two
  columns on wide splits; keys: `1`–`9` shows one quota alone, `w` cycles warm mode, `r` refreshes, `q` quits).
  The split also shows auto mode's run or on pace mode under its title, with `effort a level lighter` while the
  rate would run a quota out, and the plan's timeline under the charts when the plan has a checklist.
  Outside tmux it opens a pane inside Claude Code, docked full-height beside the transcript in fullscreen mode.
  `/pace pane` always opens the pane; `/pace window` opens the full-screen view in a macOS terminal window.

`/pace` runs at once, even mid-turn, and answers in a toast. Nothing lands in the conversation, so it never costs
context.

## Statuses and rates

Each quota has a **status**: where its usage stands against the time gone in its window.

| Status | Meaning |
| --- | --- |
| Under pace | Using less than the time gone |
| On pace | Within a few points of even pace |
| Over pace | Using faster than the clock |
| **Gassed out** | The quota is spent: prompts fail until it resets |

Each quota also shows **where your rate takes it**: the percent it lands at by its reset if you keep prompting
this way (`→ 71% at reset`), or, if it would run out first, when (`out in 38m`). As the reset nears, the landing
point closes in on what is already used, so it stays readable to the last minute. A quota whose per-prompt cost is
not known yet shows `→ —`.

A model's own week counts only the prompts and spend that went to that model: prompting Opus never moves the
Fable week's rate. Prompts from before pace knew the model count everywhere, so pace errs toward warning.

| Mark | Meaning |
| --- | --- |
| `·` idle | No prompt in the last 15 minutes |
| `●` steady | Well inside the budget |
| `▲` brisk | Near the budget |
| `▲` burst | Would run out early if it keeps up, though the average is on pace: `▲ burst · out in 2h51m at this rate` |
| **`▲▲` too fast** | Runs out before the reset, and the quota is already over pace |

**Too fast** is the only warning that flashes red, and only while you are prompting. A quota over pace with no
prompt in the last 15 minutes reads idle: its status still says *Over pace*, but nothing flashes, because nothing
you are doing is making it worse. Before a prompt's cost is known, a quota over pace you are prompting reads
`▲ over pace · no cost yet`, also without flashing: nothing yet says the rate runs it out.

## Pacing across parallel sessions

Every session records what it spends in a store all sessions share. Pacing is judged in dollars an hour across all
of them against what each quota has left, so five sessions at once read as one budget. A prompt's cost comes from
how much of a quota a dollar uses (learned from the last week of readings) times recent dollars per prompt, so it
is there from the first prompt.

Once a quota's own readings measure it, they set the rate instead: the points an hour its percentage moved, fitted
through its readings over the last 15 minutes for the 5-hour window and the last 3 hours for a week. Where it
lands at the reset, when it runs out, and burst or too fast all follow from that, so a heavy stretch that has
ended stops counting within a quarter of an hour. The estimate from dollars and prompts fills in until there are
readings enough.

pace warns once per window, in a toast and a notification: at 80% and 95% of a quota, when the rate would get it
gassed out before it resets, and when it is gassed out.

## On pace mode

`/pace on` keeps a long-running session on pace:

- compacts a heavy context (60% of the window) after a turn, while its cache is still warm and compacting is cheap
- keeps an idle cache from lapsing: compacting a large context, pinging a small one
- thinks one effort level lighter (`high` to `medium`) while the rate would run a quota out before its reset, and
  back as soon as it is steady. It lowers the effort rather than switching to a smaller model: a new model starts
  with a cold cache, which can cost more than the burst
- warns before a quota gets gassed out

`/pace off` turns it off.

## Auto mode

`/pace auto [plan file] [turns]` works through a plan or roadmap with no one at the keyboard, `ROADMAP.md` when no
file is given. The first time, a
pane says what it does and that it spends quota on its own; it starts when you press Start.

- After each turn pace sends the next prompt, until Claude ends a turn with `PACE: DONE` or `PACE: BLOCKED`, or the
  turn cap (40 by default) is reached.
- It stops when Claude is waiting on you. Claude ends a turn with `PACE: BLOCKED <what it needs>` when it hands you a
  task or needs your feedback, and a turn that ends on a question with no `PACE:` line reads the same way: pace
  stops prompting and notifies you with the question.
- Its last turn, done or blocked, ends with a report for when you are back: what got done, why it stopped, what
  needs you (each with its reason and urgency, most urgent first) and how to do it, and the plan's checklist as it
  now stands.
- It never prompts a turn that would only wait. When Claude is waiting on background work (a test run, a
  subagent, CI), it ends the turn with `PACE: WAITING <what>` and pace sends nothing: Claude Code starts the next
  turn when the work reports, and pace checks in after 15 minutes in case it hung. Two turns in a row that change
  neither the plan nor `.pace/handoff.md` count as no progress: pace stops prompting and waits 5 minutes, then 10,
  20 and 30, until a turn moves the plan again.
- `/pace auto burst` is for when you would rather spend the quota now: auto mode stops holding for pacing (a hold
  under way ends at once) and only waits out a quota that is already gassed out. `/pace auto burst off` undoes it.
- It answers Claude's questions with the recommended option.
- It has Claude hand searches and routine edits to subagents on lighter models, and keep `.pace/handoff.md` up to
  date. When the context gets heavy, or is cold and large, pace clears it and resumes from that file.
- It holds while the rate would get a quota gassed out, and while one is gassed out, until it resets. It counts
  only the quotas the session's model draws on: the 5-hour window, the all-models week and that model's own week.
  An Opus session never waits on the Fable week.
- It turns on on pace mode.

Auto mode, on pace mode and warm mode belong to the session you turn them on in. Another session never runs your
plan, and `claude --resume` picks the run back up. The band and the status-line entry are yours everywhere, and the
quotas, prompts and spend are shared, so every session paces against the same budget.

Its instructions are a fixed system-prompt section, so the prompt cache keeps them. Live pacing notes ride in each
prompt instead. `/pace auto off` stops it; an interrupt pauses it until `/pace auto resume`.

### The plan's timeline

`/pace plan [file]` opens the plan as a timeline in a sidebar, so a long run reads at a glance. Starting auto mode
opens it too. Inside tmux it is a narrow split on the right of Claude (Node 23.6 or later on your `PATH`; q there
closes it); elsewhere it is a pane, docked beside the transcript in fullscreen from 110 columns. It shows the steps done (`✔`), the step under way (`◉`) and the step up next (`○`), read from the
plan's checklist (`- [ ]` and `- [x]` items) each time a turn ends. The header gives how many steps are done, a
progress bar and what auto mode is doing: its turn, a hold, a wait or a pause. A long step wraps under its own text,
the timeline's line running on beside it, so each step reads whole in a narrow sidebar. A long plan scrolls, and opens
on the step under way. The pane scrolls with the mouse wheel, or the arrows once it has focus. The tmux sidebar
follows the step under way until you scroll it: the arrows or j/k, PgUp/PgDn or space, Home/End or g/G, the mouse
wheel; f follows again.

It is animated: the steps come in from the top, a dot runs down the line into the step under way while its marker
spins, and a step that gets ticked off pops into a check.

```
ROADMAP.md  ·  12 of 20 steps done
━━━━━━━━━━━━━━━━━━━━━━━━──────────────── 60%  ·  turn 14 of 40

  ✔  10 earlier steps done
  │
  ✔  Draw the timeline
  │
  │
  ◉  Animate the steps · under way
  ┆
  ○  Ship it · up next
  ┆
  ○  6 more steps
```

## Ultra pace

Auto mode works through a checklist you wrote. Ultra pace is given a **goal** and owns the plan: Claude writes the
steps, works them, reviews them against the goal, and stops only once the goal is verified. On top of that it spends
the quota at the pace the quota allows.

```md
## Goal
pace ships 1.0 with CI green.
Done when:
- CI runs tsc, validate and test on every push
- CHANGELOG has a 1.0.0 section
Check: `tsc -p . && claude plugin validate . && claude plugin test .`

## Steps
- [x] Write the CI workflow
- [ ] Bump plugin.json (parallel)
- [ ] Move Unreleased under 1.0.0 (parallel)

## Revisions
- turn 7 · added "Pin Node in CI": the workflow failed on Node 20
```

`/pace ultra PLAN.md` starts it; a plan with no `## Goal` does not start. The first turn writes the steps; after that
each turn is one step of work (red first), a review of the plan (every 5 steps, after a failed check, a stalled turn
or a `PACE: REPLAN <why>`), or a turn integrating subagents' work.

- **The check.** When Claude ends a turn with `PACE: GOAL`, pace runs the `Check:` command itself, as it read it when
  the run started: editing the line later changes nothing, and pace says so. A pass stops the run with a closing
  report; a failure becomes a review carrying the last 40 lines of its output. With no `Check:` line, Claude verifies
  each *Done when* line against the code, and a second claim stops the run.
- **The lock.** A ticked step stays ticked. Unticking, rewording or dropping one needs a line under `## Revisions`, or
  the next turn is a review that restores it or logs why.
- **It stops** after 3 failed checks in a row, 3 reviews in a row with no new step done, a turn waiting on you, or 80
  turns (`/pace ultra resume` gives it more).
- **The throttle.** The tightest quota the session's model draws on sets the gear:

  | Room | When | Gear |
  | --- | --- | --- |
  | push | under pace at a steady rate | the ceiling model at `xhigh` effort, 3 subagents on sonnet, `(parallel)` steps fanned out |
  | cruise | on pace, or a brisk rate | your model and effort, 2 subagents on sonnet |
  | ease | over pace, or a burst | the floor model, one effort lighter, 1 subagent on haiku |
  | hold | too fast, or gassed out | auto mode holds |

  It drops a gear at once but climbs one gear at a time, after two decisions in a row. The main model changes only on
  a cold cache, at a handoff, since a new model starts with the cache cold. `sonnet..opus` after the turn count sets
  the floor and the ceiling; by default it ranges from sonnet up to the model you run.
- **Subagents.** The Agent tool's subagents run on the gear's model when Claude names none or a heavier one, and no
  more of them run at once than the gear allows. In push, `(parallel)` steps go to background subagents that write
  a report to `.pace/fanout/<n>.md`; a turn then integrates them and ticks what holds.
- **Where it shows.** Under the band and in the status-line entry, `ultra ▶ push · opus xhigh · 3 agents · turn
  4/80`, in the warning color while it eases or after a failed check. The timeline gives the goal, the phase of the
  step under way and the steps out on subagents.

**What it costs.** Ultra pace spends quota on its own, and in push it spends it faster on purpose: a stronger model,
more thinking, subagents in parallel. The point is to end each window close to its quota, not under it, and never
gassed out. The onboarding pane says so before the first run.

## Commands

| Command | Does |
| --- | --- |
| `/pace` | The charts, the modes and the plan's timeline in a tmux split beside Claude, or a pane outside tmux |
| `/pace pane` | The charts in a pane |
| `/pace window` | The charts in a macOS terminal window of their own |
| `/pace refresh` | Reads every source again |
| `/pace on`, `/pace off` | On pace mode |
| `/pace auto [plan] [turns]`, `auto off`, `auto resume` | Auto mode; the plan defaults to `ROADMAP.md` |
| `/pace auto burst`, `auto burst off` | Auto mode stops holding for pacing; only a gassed-out quota holds |
| `/pace ultra [plan] [turns] [floor..ceiling]`, `ultra off`, `ultra resume` | Ultra pace: works toward the plan's goal until its check passes |
| `/pace plan [file]` | The plan's timeline in a sidebar (a tmux split, or a pane): auto mode's plan, the file named, or `ROADMAP.md` |
| `/pace warm ping \| compact \| off` | Keeps an idle cache warm |
| `/pace hide`, `/pace show` | The band |
| `/pace line on \| off` | The status-line entry |

## Options

| Option | Values | Default |
| --- | --- | --- |
| `placement` | `above` (band above the prompt) or `status` (a row in `~/.claude/pace-row.txt` for your status line) | `above` |
| `cacheTtl` | `auto`, `1h`, `5m` | `auto` |
| `terminal` | The macOS app `/pace window` opens in | `Terminal` |

## For other mods

pace adds `$.pace` to the engine. List `pace` under `dependencies` in your `plugin.json`, and Claude Code lays its
types into your mod.

```ts
const snap = await $.pace.snapshot()
snap.quotas        // [{ key, name, percent, status, resetsAt, runOutAt, rate: { level, percentAtReset, emptyIn, percentPerHour, usdPerHour, … } }]
snap.cache         // { tokens, secondsLeft, nextWarm, nextCold, nextWarmUsd, … } or null
snap.spend         // { usdPerHour, sessions, usdPerPrompt }
snap.gassedOut     // a quota is spent
snap.modes         // { onPace, auto }; auto.ultra while ultra pace runs: goal, phase, gear, …
snap.advice        // [{ level, text }]
```

The snapshot is as of `snap.at`: pace refreshes it after every reply, reading and minute. The full contract is in
[`types/index.d.ts`](types/index.d.ts).

## Where the numbers come from

- **Quotas:** the session's rate-limit readings after each reply, Claude Code's usage cache in `~/.claude.json`,
  and Anthropic's usage endpoint (for per-model quotas), called with Claude Code's own login. pace never sees the
  credential.
- **Spend:** the session's cost ledger, what `/cost` totals.
- **Limits:** usage pace can't see (claude.ai, another machine) moves a quota with no spend recorded, which makes
  a dollar look dearer. Readings are whole points, so a quota's price waits for 8 points of movement.

pace has no telemetry. Its only requests are the usage-endpoint call (the one `/usage` makes) and, in warm mode
`ping`, a one-word model call that reads the cache.

Files it writes in `~/.claude`: `pace-row.txt` (status-line row), `pace-state.json` and `pace-keys.json` (the
window's feed and keys), `pace-view.command` (the window's launcher). Auto mode asks Claude to keep
`.pace/handoff.md` in your project.

## How it is built

One hooks module keeps the data and talks to the engine. Everything else is a pure function of a snapshot and a
clock, so every rule is tested without a live session.

```
hooks/register.tsx     the only module that touches `$`: hooks, commands, state, the shared store
   │  builds a Snapshot: samples, prompts, spend, cache, modes
   ▼
hooks/model.ts         what is drawn: each quota's row, the rate against it, advice, $.pace's snapshot
   ├─ quota.ts         readings, windows, statuses, names
   ├─ rate.ts          the prompting rate, bars and sparklines
   ├─ spend.ts         the shared spend, and pacing in dollars an hour
   └─ cache.ts         the prompt cache's timer and what the next prompt costs
   ▼
hooks/view.ts          every drawing as lines of styled segments: band, status line, pane, window
   ├─ chart.ts         braille burn-up charts
   ├─ band-client.tsx  the band's animation on the surface's frame clock
   ├─ timeline.ts      the plan timeline's animation, as frames
   ├─ plan-client.tsx  the timeline in a pane, on the surface's frame clock
   ├─ bin/plan-viewer.ts the timeline as a tmux sidebar, run by Node
   └─ bin/viewer.ts    the full-screen window, run by Node in a tmux split or a terminal window
hooks/auto.ts          auto mode and on pace mode, as decisions
hooks/plan.ts          the plan's checklist as steps: done, under way, next
hooks/alerts.ts        the once-per-window warnings
hooks/files.ts         the files pace writes in ~/.claude, shared with the viewer
types/index.d.ts       the public contract: stored shapes and $.pace
```

Guidelines for contributors and coding agents (architecture rules, the test-first workflow, the definition of
done) are in [`.agents/README.md`](.agents/README.md).

## Development

```
claude --plugin-dir .        # run it from this folder
claude plugin test .         # the tests
claude plugin validate .     # what the engine would refuse
tsc -p .                     # the types
```

Every change is made test first: a failing test that shows the behavior or the bug, then the smallest change that
turns it green, then cleanup with the suite still green.

What is next is in [`ROADMAP.md`](ROADMAP.md); what changed is in [`CHANGELOG.md`](CHANGELOG.md).

## License

MIT. See [LICENSE](LICENSE).
