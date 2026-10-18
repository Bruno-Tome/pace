# pace roadmap

Worked top to bottom, one step per turn. Each step follows [`.agents/README.md`](.agents/README.md): a failing test
first, then the change, then `claude plugin test .`, `claude plugin validate .` and `tsc -p .` green, the
changelog updated, and the step ticked here. Steps marked **(needs you)** wait for the user: stop and say so.

## 1. Bug fixes

- [x] **Stale reading after a reset.** Once a window's reset time passes and no new reading has arrived, the band
      and status line still show the old window's percent (`5h 65%` minutes after the reset). Show the new window
      as started (0%, or `—` until a reading) from the moment its reset passes.
- [x] **Too fast with nothing to say.** A quota over pace with no per-prompt cost yet reads `→ — at reset too
      fast`. Say something a person can act on, e.g. `over pace · cost after 3 prompts`, and keep the red flash
      only for a rate that is known to run the quota out, or decide with a test what `fast` without a cost means.

## 2. Code polish

- [x] **Type the hooks module.** Replace `$: any` in `register.tsx` with the engine's types. Splitting
      `register.tsx` further is limited by two engine rules: a `$.state` atom must be read in the file that
      defines it, and `$` is followed across files only into `function` declarations.
- [x] **Say a burst is the recent rate.** `11% Under pace … ▲ out in 2h51m burst` reads as a contradiction: the
      status is the window so far, the rate is the last 30 minutes. Draw it `▲ burst · out in 2h51m at this rate`.
- [x] **A lighter model in a burst.** When the rate would run a quota out before its reset, move the session to
      a smaller model or a lower reasoning effort to bring it back on pace, and back once the rate is steady.
      Done as one effort level lighter in on pace mode; a model switch would rewrite the cache.
- [x] **One compact layout.** The status-line row and `lineText` drawn from `bandLines`, so the band, the row and
      the entry cannot disagree.
- [x] **File paths in one place.** One constants block for `pace-row.txt`, `pace-state.json`, `pace-keys.json`
      and `pace-view.command`, shared with `bin/viewer.ts`.

## 3. Release

- [x] **CI.** A GitHub Actions workflow running `tsc -p .`, and `claude plugin validate .` and
      `claude plugin test .` if the CLI runs headless there. Write the workflow; pushing it is **(needs you)**.
      Done as validate and test on a pinned Claude Code; `tsc` stays local, since the engine lays its types only
      when a session loads the plugin.
- [ ] **1.0.0.** Bump `plugin.json`, move *Unreleased* in `CHANGELOG.md` under `1.0.0`, tag `v1.0.0`.
      **(needs you)** for the tag and the push.

## 4. Docs

- [x] **Platform table** in both READMEs: the band, the status line and the pane work anywhere Claude Code runs;
      the tmux split needs tmux and Node 23.6+; `/pace window` is macOS-only.

## 5. Next

- [ ] **Spend pace can't see.** Usage from claude.ai or another machine moves quotas with no spend recorded,
      which makes a dollar look dearer. Detect quota movement with no local spend and leave those spans out of
      the ratio.
- [ ] **Auto mode in a live session.** Run it on a real plan, watch the handoffs and holds, and tune the
      thresholds (heavy at 60%, cold-and-large at 100k tokens, 15-minute pacing holds). **(needs you)** to watch.

## 6. Ultra pace

Auto mode given a goal instead of a checklist: the agent owns the plan, works until the goal's check passes, and
spends the quota at the pace it allows. The design, every rule and the contract are in
[`.agents/ultra-pace.md`](.agents/ultra-pace.md); read it before any step here.

- [x] **The goal block.** `goalOf(markdown)` in `plan.ts` answers `{ text, criteria, check } | null` from `## Goal`;
      `stepsOf` skips `Goal` and `Revisions`, and reads `(parallel)` on a step.
- [x] **Plan changes and the lock.** `planChanges(before, after)` and `lockBroken(changes, revisionsGrew)` in
      `plan.ts`: a ticked step unticked, rewritten or dropped with no new revision line breaks the lock.
- [x] **Two new markers.** `PACE: GOAL` and `PACE: REPLAN <why>` in `markerOf`.
- [x] **The contract.** `PaceUltra` and `PaceGear` in `types/index.d.ts`, additive, read back safely from prefs
      without them; the changelog under *Unreleased*.
- [x] **Headroom.** `headroomOf(snap, model)` in a new `throttle.ts`: `push`, `cruise`, `ease` or `hold` from the
      tightest quota the model draws on, read from the existing status and rate verdicts.
- [x] **The gear.** `gearFor(headroom, bounds, current)`: model, effort, subagents, subagent model and fan-out per
      headroom, inside the user's floor and ceiling, with hysteresis (2 decisions to go up, one notch at a time; down
      at once), and the model held until the cache is cold.
- [x] **The ultra decision.** `decideUltra` in a new `ultra.ts`: defers to `decide()`, then the phases (`plan`, `work`,
      `review`, `verify`), the review triggers, `check` and its result, the three guards, the gear carried forward.
- [x] **Fan-out in the decision.** `fanout` for `(parallel)` steps in `push`, `wait` until every subagent reported,
      then `integrate`.
- [x] **Prompts and protocol.** `planPrompt`, `reviewPrompt(reason, tail)`, `verifyPrompt`, `integratePrompt`,
      `fanoutPrompt(goal, step)`, the gear line beside `pacingNote`, and `ultraProtocol()` as fixed text.
- [x] **The shell: start and stop.** `/pace ultra [plan] [turns] [floor..ceiling]` and `/pace ultra resume`; no start
      without a goal; the check captured at start; the onboarding pane's ultra lines; the system section swapped.
- [ ] **The shell: carry out decisions.** `check` through `$.process.run` with a timeout, `fanout` through
      `$.agent.spawn`, the handoff carrying goal, phase and gear. Extend `tests/world.ts` where it lacks a fake.
- [ ] **The shell: apply the gear.** `turn.step` sets the main thread's model (cold cache only) and effort;
      `agent.spawn` sets subagent models and denies spawns beyond the gear's count.
- [ ] **Surfaces.** The goal and phase on the timeline, steps out on subagents marked; the band and status-line
      entry (`ultra · push · opus xhigh · 3 agents`).
- [ ] **Docs.** A README section on ultra pace (the goal block, the check, the throttle, what it costs) and the
      changelog.
- [ ] **A live run.** Ultra pace on a small real goal over one 5-hour window: watch the gear move, the reviews, a
      failed check and a fan-out, then tune `REVIEW_EVERY`, the guard limits and the headroom thresholds.
      **(needs you)**

## Later

- **Overlay of past windows** in the charts.
- **Smarter warm mode.** Learn when you usually come back and keep the cache warm only when a return inside the
  TTL is likely.
- **Other terminals** for the window: detect iTerm, Ghostty and kitty; `x-terminal-emulator` on Linux.
- **Subagent models.** Let on pace mode move subagents to a lighter model when a model's week is over pace,
  rather than only asking Claude to.
