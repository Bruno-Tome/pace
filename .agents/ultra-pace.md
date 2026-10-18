# Ultra pace

The design behind *6. Ultra pace* in [`ROADMAP.md`](../ROADMAP.md). Read [`README.md`](README.md) first: every rule
there applies here, above all the pure core, decisions not actions, and one rule with one owner.

## What it is

Auto mode works through a checklist someone else wrote. Ultra pace is given a **goal** instead and owns the plan:
it writes the steps, revises them, adds, splits, drops and reorders them, reopens a step when it has to, and stops
only when the goal is **verified**. On top of that it **spends the quota at the pace the quota allows**: a stronger
model, more thinking and parallel subagents while a quota is under pace; a lighter model, less thinking and no
fan-out while one is over.

## The plan file

```md
## Goal
pace ships 1.0 with CI green.
Done when:
- CI runs tsc, validate and test on every push
- CHANGELOG has a 1.0.0 section
Check: `tsc -p . && claude plugin validate . && claude plugin test .`

## Steps
- [x] Write the CI workflow
- [ ] Pin Node in CI
- [ ] Bump plugin.json (parallel)
- [ ] Move Unreleased under 1.0.0 (parallel)

## Revisions
- turn 7 · added "Pin Node in CI": the workflow failed on Node 20
- turn 9 · reopened "Write the CI workflow": the check failed on the cache key
```

- *Done when* lines are plain bullets, never checkboxes, so they never count as steps. `stepsOf` skips the `Goal`
  and `Revisions` sections.
- `(parallel)` marks a step that does not depend on its neighbours and touches its own files: pace may hand it to a
  subagent (see [Fan-out](#fan-out)).
- **The check command is captured when the user starts the run** and kept in prefs. pace runs only that copy, outside
  Claude Code's permission prompts, so an agent that edits the `Check:` line changes nothing; pace says so.
- A plan with no `## Goal` does not start. The goal comes from the user.

## Phases

`decideUltra` in `hooks/ultra.ts` (pure) first defers to `decide()` in `auto.ts` for what it already owns: an abort,
a gassed-out quota, a rate that would gas one out, a wait, a handoff, the turn cap. Then:

| Phase       | The turn's prompt asks for                                                       | Next |
|-------------|----------------------------------------------------------------------------------|------|
| `plan`      | Read the goal; write or revise the steps; log it. No production code.            | `work` |
| `work`      | One step, red first, then tick it.                                               | `work`, `fanout` or `review` |
| `fanout`    | (pace spawns subagents, no turn) one subagent per `(parallel)` step the gear allows | `integrate` once they report |
| `integrate` | Read each subagent's report, run the suite, tick what holds, reopen what does not. | `work` |
| `review`    | Re-read the goal and the plan; add, split, drop or reorder; log each change.     | `work` |
| `verify`    | (no check command) Each *Done when* line against the code, with evidence.        | stop on a second `GOAL`, else `work` |

**Review triggers:** every `REVIEW_EVERY = 5` work turns, a failed check, a stall (auto mode's count), `PACE: REPLAN`,
a broken lock.

**Markers:** `PACE: GOAL` claims the goal; `PACE: REPLAN <why>` asks for a review. In ultra pace `PACE: DONE` reads as
`GOAL`.

**The goal check:** on `GOAL`, `decideUltra` returns `{ kind: 'check'; command }`. The shell runs the stored command
with a timeout and decides again with `{ ok, tail }`: ok stops with *Goal reached*; a failure starts a `review` whose
prompt carries the last ~40 lines of output, so the failure becomes steps.

**Guards,** each a stop with its reason: 3 failed checks in a row; 3 reviews in a row with no new tick; the turn cap
(`ULTRA_TURNS = 80`, `/pace ultra resume` extends it).

## The lock

Ticked steps are locked. `planChanges(before, after)` in `plan.ts` returns `{ added, dropped, reopened,
rewrittenDone }` between the plan before and after a turn (the shell keeps the before in `progressMark`). A ticked
step unticked, rewritten or removed with no new line under `Revisions` breaks the lock: the next turn is a `review`
naming the step, to restore it or log why.

## The throttle: spend what the pace allows

The point is to end each window close to its quota, not under it and never gassed out. Under pace is quota you will
lose at the reset; over pace is quota you will run out of before it.

### Headroom → gear

`hooks/throttle.ts` (pure) owns the rule. `headroomOf(snap, model)` reads the quotas the session's model draws on
(`forModel`) and takes the **tightest**: the one with the least room. It is the same verdict every other surface
reads (status from `quota.ts`, rate level from `rateOf`), never a second opinion.

| Headroom  | When (the tightest quota)                        | Gear |
|-----------|--------------------------------------------------|------|
| `push`    | status `early` or `under`, rate `idle` or `ok`   | ceiling model, effort `xhigh`, up to 3 subagents on `sonnet`, fan-out on |
| `cruise`  | `onPace`, or rate `brisk`                        | the user's model and effort, up to 2 subagents on `sonnet`, fan-out off |
| `ease`    | `over`, or rate `burst`                          | floor model, effort one lighter, 1 subagent on `haiku`, fan-out off |
| `hold`    | rate `fast`, or `gassedOut`                      | nothing: `decide()` already holds |

`gearFor(headroom, bounds, current)` returns a `PaceGear = { model, effort, subagents, subagentModel, fanout }`.

- **Bounds are the user's.** `models: { floor, ceiling }` defaults to `sonnet` up to the model the session runs at
  start: ultra pace never climbs above what you chose unless you say so (`/pace ultra plan.md 80 sonnet..opus`).
- **Hysteresis.** A gear changes only after the new headroom has held for 2 decisions in a row, and goes up at most
  one notch per decision; it goes down at once on `ease`. Flapping costs more than either gear.
- **A model switch only where the cache is cold.** Switching the main model rewrites the prompt cache. The gear's
  model applies at the next handoff (`/clear`), or when the cache has lapsed (`secondsLeft === 0`). Until then only
  effort and subagents move. On pace mode's rule (a lighter effort, not a lighter model) stays true for a warm
  cache.

### Where the gear is applied

- **The main thread:** the `turn.step` hook rewrites `model` (cold cache only) and `effort` on main-loop requests from
  the gear. This replaces `effortFor` while ultra pace runs; `effortFor` stays on pace mode's rule.
- **The Agent tool:** the `agent.spawn` hook sets the subagent's `model` to the gear's `subagentModel` when the
  caller gave none or a heavier one, and denies a spawn beyond `subagents` running (counted with `$.agent.list()`),
  with a reason telling the agent to wait or do it inline.
- **The prompt:** each continue, review or handoff prompt says the gear in one line ("Pace allows 3 subagents on
  sonnet: delegate searches, reads and independent steps"), next to `pacingNote`. Never the system prompt, which
  stays cached.

### Fan-out

In `push`, when the next unticked steps include `(parallel)` ones and the main thread has just finished a step,
`decideUltra` returns `{ kind: 'fanout'; steps }`, up to `gear.subagents`. The shell calls `$.agent.spawn` for each,
in the background, with a prompt that holds the goal, that step alone, the rule to touch only the files the step needs,
red first, and to write a report to `.pace/fanout/<n>.md` without ticking the plan. The main thread does not sit idle
waiting: the decision is `wait` until every subagent has reported (a subagent ending starts a turn), then an
`integrate` turn. Only the main thread ticks the plan, so the lock and the revision log stay in one hand.

### Contract

`PaceAuto` gains `ultra?: PaceUltra`, additive and read defensively (older prefs read as plain auto mode):

```ts
type PaceGear = { model: string; effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max'; subagents: number; subagentModel: string; fanout: boolean }
type PaceUltra = {
  goal: string; check: string | null
  phase: 'plan' | 'work' | 'fanout' | 'integrate' | 'review' | 'verify'
  sinceReview: number; quietReviews: number; checkFails: number
  models: { floor: string; ceiling: string }
  gear: PaceGear; headroomStreak: number
  fanout?: { agentIds: string[]; steps: string[] }
}
```

`snapshot().modes.auto.ultra` exposes it to other plugins.

## Surfaces

- The timeline: the goal on the first line, the phase beside the step under way, dropped steps dimmed, steps out on
  subagents marked.
- The band and the status line: `ultra · push · opus xhigh · 3 agents`, `ultra · ease · sonnet medium`,
  `ultra · check failed 2×`. Calm colors; only `ease` and a failed check use `warning`.
