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
- [Codex, pi and Herdr](#codex-pi-and-herdr)
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
| `/pace` as the split in a pane, with native buttons | The Claude desktop app (or VS Code) |
| `/pace window` | macOS, and Node 23.6 or later on your `PATH` |

Outside tmux, `/pace` opens the pane instead; in the Claude desktop app that pane is the split itself.

The same core paces Codex CLI and pi too, and draws every agent side by side in [Herdr](#codex-pi-and-herdr).

## What it shows

- **A band above the prompt:** the 5-hour and weekly bars, each with its pace status and the rate against it,
  then the prompt cache's countdown and what the next prompt costs.
- **A status-line entry,** or with `placement: status`, a full row your status line prints.
- **`/pace`:** the whole mod in one view. Inside tmux it opens full-screen in a split beside Claude: a command bar
  under the title, then the run under way (its plan, turn, gear, goal, phase and check), burn-up charts for every
  quota (two columns on wide splits), the plans' timelines (the roadmap beside an ultra run's own plan), the
  prompting rate, the cache and the suggestions. What does not fit scrolls under the bar (↑ ↓, PgUp PgDn, the
  mouse wheel); the charts are never squeezed to make room.
  Every `/pace` command is a button there: press its key or click it. The bar has three rows: `on` lists the
  modes that are on, lit, each with its key (`nothing` when none is); `off` lists the ones you can turn on; `do`
  holds the rest. The modes are `[p] on pace`, `[w] warm` (stepping off → compact → ping), `[b] band`,
  `[l] status line`, and a run: with none, `[a] auto…` and `[u] ultra…` list the plans the session knows to start
  one on (`t` types another path); while one runs, `[a] auto` or `[u] ultra` stops it and `[s] burst` flips its
  burst; a paused run offers `[a] resume` and `[x] stop`. Under `do`: `[r]` refreshes, `[t] timeline` opens the
  plans' timelines in a second split carved out of the Pace split, under it, where they scroll and animate on
  their own (`t` again closes it, and quitting the split closes it too), `[f] plan…` picks the plan whose
  timeline shows (`/pace plan`), `[v]` previews ultra pace on the band, `[i]` opens the pane inside Claude Code,
  `[m]` the window, `1`–`9` shows one quota alone, `q` quits. A command's answer shows under the
  title for 10 seconds. Outside tmux it opens a pane inside Claude Code, docked full-height beside the transcript
  in fullscreen mode. In the Claude desktop app (and VS Code) that pane is the split, its charts drawn as
  pictures with a point per reading, and the same bar as native buttons, lit while on, each key its hotkey once the pane has focus; `auto…`, `ultra…` and `plan…` swap the bar
  for a list of the plans the session knows and a field for a path; a digit button per quota shows it alone. The
  pane scrolls and closes itself, so it has no `q` or `[i]`, and answers come in a toast. `/pace split` opens it
  there too. `/pace pane` always opens the pane; `/pace window` opens the full view in a macOS terminal
  window.

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
Fable week's rate. pace reads the plan's quotas from the usage endpoint, and a model with a week of its own is
paced by that week alone: on such a plan the shared 5-hour window's rate, run-out time and notices come from the
other models, by their share of the dollars (else the prompts) over the last 15 minutes. A Fable burst still fills
the window's bar and sets its pace status, since every model stops when it is full, but it is not called too fast
there. Prompts from before pace knew the model count everywhere, so pace errs toward warning.

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
  4/80`, in the warning color while it eases or after a failed check. The band powers up with the gear: in push a
  wide gold sheen sweeps the bars, the filled cells crackle and the `▶` flickers through sparks. The timeline gives the goal, the phase of the
  step under way and the steps out on subagents.

**What it costs.** Ultra pace spends quota on its own, and in push it spends it faster on purpose: a stronger model,
more thinking, subagents in parallel. The point is to end each window close to its quota, not under it, and never
gassed out. The onboarding pane says so before the first run.

## Commands

| Command | Does |
| --- | --- |
| `/pace` | The charts, the modes and the plan's timeline in a tmux split beside Claude, or a pane outside tmux (the split itself, with buttons, in the desktop app) |
| `/pace pane` | The charts in a pane |
| `/pace window` | The charts in a macOS terminal window of their own |
| `/pace refresh` | Reads every source again |
| `/pace on`, `/pace off` | On pace mode |
| `/pace auto [plan] [turns]`, `auto off`, `auto resume` | Auto mode; the plan defaults to `ROADMAP.md` |
| `/pace auto burst`, `auto burst off` | Auto mode stops holding for pacing; only a gassed-out quota holds |
| `/pace ultra [plan] [turns] [floor..ceiling]`, `ultra off`, `ultra resume` | Ultra pace: works toward the plan's goal until its check passes |
| `/pace timeline` | The plans' timelines in a split under the Pace split while one is open (again: closes it), else as `/pace plan` opens them; the split's `[t]` button |
| `/pace plan [file] [file]` | The plan's timeline in a sidebar (a tmux split, or a pane): the files named, side by side for two; else the roadmap beside an ultra run's plan, auto mode's plan, or `ROADMAP.md` |
| `/pace ultra preview` | Plays ultra pace's push animation on the band for 20 seconds |
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

## Codex, pi and Herdr

pace's core is host-agnostic. Each host session writes a **feed**,
`~/.local/state/pace/feeds/<host>-<session>.json`: its readings, prompts, spend and context, where it runs, and
under Herdr the terminal it runs in (`HC_TERMINAL_ID`). Every Claude Code session writes one. A feed not written for
6 hours counts as a session gone.

**Codex CLI.** Codex has no prompt area or pane for a plugin to draw in, so pace reads it from the outside: a hook
reads the session's rollout as Codex writes it (`rate_limits.primary` is the 5-hour window, `secondary` the week;
the last reply's tokens are the context) and counts each prompt submitted. Codex reports no dollars or prompt
cache, so its band paces on readings and prompts alone and leaves the cache's row out. Add the hook to
`~/.codex/config.toml`, with the path to your clone of pace, then trust it in Codex's `/hooks`:

```toml
[[hooks.SessionStart]]
[[hooks.SessionStart.hooks]]
type = "command"
command = "node /path/to/pace/adapters/codex/hook.ts"
timeout = 10

[[hooks.UserPromptSubmit]]
[[hooks.UserPromptSubmit.hooks]]
type = "command"
command = "node /path/to/pace/adapters/codex/hook.ts"
timeout = 10

[[hooks.PostToolUse]]
[[hooks.PostToolUse.hooks]]
type = "command"
command = "node /path/to/pace/adapters/codex/hook.ts"
async = true
timeout = 10

[[hooks.Stop]]
[[hooks.Stop.hooks]]
type = "command"
command = "node /path/to/pace/adapters/codex/hook.ts"
timeout = 600

[[hooks.Interrupt]]
[[hooks.Interrupt.hooks]]
type = "command"
command = "node /path/to/pace/adapters/codex/hook.ts"
timeout = 3
```

The Stop hook runs synchronously, with up to ten minutes: auto mode keeps Codex going from it and waits out a short
hold in it. The hook needs Node 23.6 or later and never fails a turn. It says nothing to the model; a warning shows
in Codex's UI, once per window. It reads the rollouts Codex 0.161 to 0.166 write; the rollout is not a stable
interface, so a line it cannot read is skipped.

**`/pace` in Codex.** Codex refuses an unknown slash command, so `/pace` comes as the custom prompt `/prompts:pace`
or the skill `$pace` (`node scripts/codex.ts install`), and the hook answers it: the answer shows in place of the
prompt, which never reaches the model. In Herdr every view opens there first. Elsewhere `/pace` opens the charts in
a tmux split, `band` and `fleet` likewise, `window` in a macOS terminal window; outside tmux they are drawn into the
answer. `/pace plan [file] [file]` and `timeline` show the plan's timeline the same way. Auto mode runs in Codex:
`/pace auto [plan] [turns]` sends the prompt on with auto mode's instructions, and at each turn's end the Stop hook
sends the next prompt, ends the run when the plan is done or blocked, waits out a hold of up to nine minutes, and
pauses a longer one until `/pace auto resume`; an interrupt pauses it too. `auto off`, `auto resume` and `auto burst
[off]` work as in Claude Code. What Codex's hooks cannot do is said plainly: ultra pace (it changes the model and the
effort turn by turn), on pace mode (it lowers the effort and compacts), warm mode (Codex reports no cache), and the
band's and the status line's preferences (Codex has neither).

**pi.** pace runs inside [pi](https://pi.dev) as an extension: the band above pi's editor and the quotas in its
footer. Install it with `node scripts/pi.ts install`, which puts a one-line `~/.pi/agent/extensions/pace.ts` that
loads this repo's `adapters/pi/extension.ts`, then restart pi or `/reload`. A pi session paces a quota only on a
subscription sign-in: ChatGPT spends Codex's quota, Claude spends Claude's, so in the fleet pi's agents count under
that provider. On an API key pi has no quota to pace, and pace stays out of the way.

`/pace` is a pi command and answers in a notification, never in the conversation. In Herdr every view opens beside
pi first, and over pi when Herdr cannot; elsewhere `/pace` opens the charts over pi (q or Escape
closes them), `/pace fleet` the fleet, and `/pace split` in tmux the band in a split. `/pace hide` and `show`,
`/pace line on` and `off` (the footer entry) and `/pace refresh` work as in Claude Code, shared by every pi session.
`/pace on` turns on pace mode: it compacts a heavy context after a run while its cache is warm, keeps a large idle
cache warm, and while the rate would gas a quota out each run goes one thinking level lower, the level coming back when
the run ends. pi's cache is read from its replies: a reply that reads or writes it starts its hour. `/pace warm
compact` compacts an idle cache with under ten minutes left; pi cannot ping its cache, so `warm ping` says so.
Warnings are said once per window, as in Claude Code. Auto mode runs in pi as in Claude Code: `/pace auto [plan]
[turns]` sends the first prompt with auto mode's instructions in the system prompt, and after each run sends the next,
holds, pauses or stops as the plan and the quotas say; a handoff compacts, where Claude Code clears. `/pace plan` and
`timeline` show the plan's timeline in a tmux split beside pi, or over it. Ultra pace is not in pi yet.

pi is told nothing of the quotas, so pace estimates them from what pi spends (each reply's cost at pi's prices). A
window opens with the first prompt after the last one ended and resets 5 hours (or a week) later; its use is what was
spent in it over what it holds. What it holds is learned: when pi reaches a usage limit, the window held what was
spent in it; when a Codex or Claude session is live beside pi, its real readings say it too. Until then the band
shows each window's spend, its reset and the dollars an hour, with `% after a limit is reached`. Once learned, an
estimate shows with a `~` (`5h ~42%`), and a real reading from the last ten minutes stands in its place. What is
learned is kept for every pi session in `~/.local/state/pace/pi/<provider>.json`. Usage pace does not see (Codex on
another machine, chatgpt.com) moves the real quota without moving the estimate, so a limit reached sooner than the
estimate says resets what a window holds.

**`/pace` in Herdr.** In a session running in Herdr, `/pace` opens the harness's charts in a Herdr pane beside
it, ahead of tmux; `/pace band` opens the session's band under it and `/pace fleet` the fleet panel. Claude Code's
`/pace` does it itself. Codex has no commands of its own, so the hook catches a prompt that is exactly `/pace`,
`/pace band` or `/pace fleet`, opens the view and stops the prompt before the model. A view already open in a pane
is focused rather than opened again: each pace pane records its view in Herdr's shared state (`pace.panes`). Codex's TUI refuses a slash
command it does not know, so `node scripts/codex.ts install` adds two that send one: the custom prompt
`/prompts:pace` and the skill `$pace`, each with `band` or `fleet` after it if you like. The hook catches either
with no model turn; if the hook is not trusted yet, the skill runs `node adapters/codex/open.ts` itself.

**The band in any terminal.** `node bin/band.ts` draws the newest live feed's band, live; `--terminal <id>` draws
the agent in that Herdr terminal; a feed file's path draws that feed; `--fleet` draws the fleet. Put it in a pane
beside Codex.

**Herdr.** `node scripts/herdr.ts install` builds the mod into `~/.config/herdr-app/mods/pace/` and checks it. Open
it with `herdr-app do pane.split --direction right --mod pace`. Its panel shows the **fleet**: every harness's quotas
with their pace, the one with the most room first (`room to push`, `on pace`, `ease off`, `hold off`), and the
agents on each, a line each: harness, repo, terminal, context use and what it is doing, by Herdr's status of its
terminal (`working`, `blocked`, `done`, `idle`: what the agent reports to Herdr, ql's included). Click an agent to go
to it. Two buttons open more of pace as Herdr panes:

- `band ⇥` beside an agent: its band in a pane under it, as Claude Code draws it above the prompt.
- `charts ⇥` beside a harness: its `/pace` pane, its charts, rates and suggestions, fed by every
  live session of that harness together. A harness has no one prompt cache, so its pane leaves the cache out.

**The fleet across hosts.** The same install builds a second mod, `fleet`, into `~/.config/herdr-app/mods/fleet/`
(docked right; open it with `herdr-app do mod.open --name fleet`). It joins every agent Herdr runs, by its terminal,
to pace's feeds (quotas and context) and ql's (`~/.local/state/ql/feeds/`: repo, how long it has held its state, files
edited and read), with the `ctx=<percent>` terminal label as a fallback for context. A host pace doesn't read, such as
Gemini, shows under *No quotas*. Three views, by the tabs at the top:

- **By provider:** each provider's quotas as pace draws them, the most room first, with its agents under it.
- **By repo:** which agents work on each repo and branch; two on one tree are flagged.
- **By urgency:** blocked first, then a context at 80% or more, then done, working and idle.

Above them, the recommendation: the live provider with the most room, ties to the one with fewer agents working,
and why in a line (`Send work to Codex: 62% of the week left, 0 agents working`). A provider whose newest reading is
older than the 5-hour window is marked stale and never recommended. **Send work ⇥** opens a dialog with the
recommended host picked: choose the host and folder, write the task, and Start asks once more before it opens a new
tab running `claude` or `codex --no-daemon` with the task. It never types into an agent already running.

## Where the numbers come from

- **Quotas:** the session's rate-limit readings after each reply, Claude Code's usage cache in `~/.claude.json`,
  and Anthropic's usage endpoint (for per-model quotas), called with Claude Code's own login. pace never sees the
  credential.
- **Spend:** the session's cost ledger, what `/cost` totals.
- **Codex:** the `token_count` events in the session's rollout (`~/.codex/sessions/…`), read by the hook.
- **pi:** estimates from each reply's cost, learned from a usage limit reached or a live feed's real readings (see
  [pi](#codex-pi-and-herdr)). pi makes no request for pace.
- **Limits:** usage pace can't see (claude.ai, another machine) moves a quota with no spend recorded, which makes
  a dollar look dearer. Readings are whole points, so a quota's price waits for 8 points of movement.

pace has no telemetry. Its only requests are the usage-endpoint call (the one `/usage` makes) and, in warm mode
`ping`, a one-word model call that reads the cache.

Files it writes in `~/.claude`: `pace-row.txt` (status-line row), and for each session `pace-state-<session>.json`
and `pace-keys-<session>.json` (the window's feed and keys), `pace-view-<session>.command` (the window's launcher)
and `pace-plan-<session>.json` (the plan sidebar's feed). Auto mode asks Claude to keep
`.pace/handoff.md` in your project. In `~/.local/state/pace/`: `feeds/<host>-<session>.json` (each session's feed)
and, for Codex, `codex/<session>.json` (how far into its rollout the hook has read); for pi, `pi/<provider>.json`
(what a window holds, as learned).

## How it is built

One hooks module keeps the data and talks to the engine. Everything else is a pure function of a snapshot and a
clock, so every rule is tested without a live session.

```
hooks/register.tsx     the Claude Code adapter, the only module that touches `$`: hooks, commands, state, the store
   │  builds a Snapshot: samples, prompts, spend, cache, modes
   ▼
core/model.ts          what is drawn: each quota's row, the rate against it, advice, $.pace's snapshot
   ├─ quota.ts         readings, windows, statuses, names
   ├─ rate.ts          the prompting rate, bars and sparklines
   ├─ spend.ts         the shared spend, and pacing in dollars an hour
   └─ cache.ts         the prompt cache's timer and what the next prompt costs
   ▼
core/view.ts           every drawing as lines of styled segments: band, status line, pane, window, fleet
   ├─ chart.ts         braille burn-up charts
   ├─ hooks/band-client.tsx  the band's animation on the surface's frame clock
   ├─ timeline.ts      the plan timeline's animation, as frames
   ├─ hooks/plan-client.tsx  the timeline in a pane, on the surface's frame clock
   ├─ bin/plan-viewer.ts the timeline as a tmux sidebar, run by Node
   ├─ bin/viewer.ts    the full-screen window, run by Node in a tmux split or a terminal window
   └─ bin/band.ts      the band or the fleet, live, in any terminal
core/host.ts           the feed every host writes, and the fleet: providers side by side
core/fleet.ts          the fleet across hosts: Herdr's agents joined to pace's and ql's feeds, three views, a pick
core/auto.ts           auto mode and on pace mode, as decisions
core/plan.ts           the plan's checklist as steps: done, under way, next
core/alerts.ts         the once-per-window warnings
hooks/usage.ts         Claude Code's usage readings: the usage endpoint and ~/.claude.json
hooks/files.ts         the files pace writes in ~/.claude, shared with the viewer
adapters/codex/        the Codex adapter: rollout.ts reads the rollout and hook input, hook.ts writes the feed
adapters/herdr/        the Herdr mod, built to plain JS by scripts/herdr.ts; fleet/, the fleet across hosts
testing/               claude-code/testing's describe, test and expect on Node and inside Herdr
types/index.d.ts       the public contract: stored shapes and $.pace
```

Guidelines for contributors and coding agents (architecture rules, the test-first workflow, the definition of
done) are in [`.agents/README.md`](.agents/README.md).

## Development

```
claude --plugin-dir .        # run it from this folder
claude plugin test .         # the tests, in Claude Code's engine
claude plugin validate .     # what the engine would refuse
tsc -p .                     # the types

# the core suite and the adapters' tests on Node
node --import ./testing/register.ts --test tests/*.test.ts adapters/*/*.test.ts
node --test testing/*.node-test.ts scripts/*.node-test.ts adapters/codex/*.node-test.ts adapters/pi/*.node-test.ts bin/*.node-test.ts

node scripts/herdr.ts check  # the Herdr mod, and the core suite inside Herdr's runtime
```

A `*.test.ts` runs on every host, so it imports only its own relative files and `claude-code/testing`. A test that
needs Node (files, processes) is a `*.node-test.ts`, which Claude Code does not load.

Every change is made test first: a failing test that shows the behavior or the bug, then the smallest change that
turns it green, then cleanup with the suite still green.

What is next is in [`ROADMAP.md`](ROADMAP.md); what changed is in [`CHANGELOG.md`](CHANGELOG.md).

## License

MIT. See [LICENSE](LICENSE).
