# Working on pace

Guidelines for anyone changing pace, human or agent: how the code is laid out, what polished code looks like
here, and the guardrails every change goes through. Read this before writing code. The user-facing description is
in the [README](../README.md).

## Guardrails

These are not optional. A change that skips one is not done.

1. **Red first.** No production code without a failing test that asks for it. See
   [Test-driven development](#test-driven-development-red-first).
2. **Green on all three.** `claude plugin test .`, `claude plugin validate .` and `tsc -p .` pass before a change
   is called done. Run them and read the output; never claim a result you did not see.
3. **Never weaken a test to get green.** Do not delete, skip, loosen or rewrite an assertion to fit the code.
   If a test is wrong, say why in the change and fix the test on its own, red first like any other change.
4. **Small and in scope.** Change what the task asks for. Note anything else you find; do not fix it on the way.
5. **The contract moves on purpose.** A change to `types/index.d.ts` or a stored shape is additive, documented
   in `CHANGELOG.md` under *Unreleased*, and read back safely from older data.
6. **Nothing in the transcript, nothing off the machine.** `/pace` answers in toasts and panes, never in the
   conversation. No telemetry: the only network call is the usage endpoint, and warm mode's one-word ping.
7. **Ask before what can't be undone.** Commits, pushes, deleting files and anything that leaves the machine wait
   for the user.

## Test-driven development: red first

Every feature and every bug fix follows red, green, refactor, in that order.

1. **Red.** Write the test that shows the behavior you want, or that reproduces the bug as the user saw it. Run it
   and watch it fail.
   - It must fail **for the reason you expect**: the assertion that names the behavior, with the wrong value
     the bug produces. A failure from a typo, an import or a fixture that does not set up the case is not red
     yet. Fix the test until the failure message describes the bug.
   - A test that passes on the first run proves nothing. Either the behavior already exists or the test does
     not reach it. Find out which before going on.
2. **Green.** Make the smallest change in production code that turns the test green. Put the rule at the one
   layer that owns it (see [Architecture](#architecture)), not where the symptom shows.
3. **Refactor.** With the whole suite green, clean up the test and the code: names, duplication, comments. Run
   the suite again after.

Choosing the test:

- **A rule** (a level, a status, a budget, a merge) gets a unit test against the pure function that owns it:
  `tests/rate.test.ts`, `tests/spend.test.ts`, `tests/alerts.test.ts`, `tests/auto.test.ts`, and so on.
- **What the user sees** (the band, the pane, a toast, a command) gets an integration test through the engine
  with the fake world in `tests/world.ts`: submit prompts, move the clock, measure a reading, mount the surface
  and read what was drawn.
- A bug that shows on screen usually wants both: the integration test that reproduces it, and a unit test that
  pins the rule.

Writing the test:

- Name it as a sentence about behavior: `a window over pace is not too fast once the prompting stops`.
- Use the fixed clock (`NOW`, `H`, `MIN`) and build the smallest data that makes the case. Comment the numbers
  that matter: `// 80% used with two thirds of the window gone: over pace`.
- Assert on what matters to the user or the caller, not on incidental formatting.

## Architecture

pace is one hooks module around a core of pure functions.

```
register.tsx    the shell: hooks, commands, state atoms, the shared store. The only module that touches `$`.
model.ts        the core's entry: rows, the rate against each quota, advice, the public snapshot
quota.ts        readings and windows, statuses, names
rate.ts         the prompting rate; bar and sparkline primitives
spend.ts        the shared spend; pacing in dollars an hour
cache.ts        the prompt cache's timer and the next prompt's cost
auto.ts         auto mode and on pace mode, as decisions the shell carries out
alerts.ts       warnings, keyed so each is said once per window
view.ts         every drawing as lines of styled segments
chart.ts        braille burn-up charts
band-client.tsx the band's animation, on the client's frame clock
bin/viewer.ts   the full-screen window, a Node process fed through a state file
types/index.d.ts the public contract: stored shapes and `$.pace`
```

### Rules

- **A pure core and a thin shell.** Everything except `register.tsx` is pure: values in, values out, no `$`, no
  I/O, no `Date.now()`. Time comes in as `now`, data as a `Snapshot`. This is what makes every rule testable in
  milliseconds.
- **Decisions, not actions.** Logic that would act returns what to do instead: `decide()` in `auto.ts` returns a
  `Decision` (`continue`, `hold`, `handoff`, `stop`, `pause`) and the shell carries it out. Keep new behavior in
  this shape.
- **One rule, one owner.** Each rule lives in exactly one function, and every surface reads it from there.
  `rateOf` in `model.ts` owns the rate level of a quota (idle, steady, brisk, burst, too fast); the band, status
  line, pane, alerts and auto mode all read its verdict. Fix a rule at its owner, never by patching one drawing.
- **Model, then view.** `model.ts` decides *what* is true; `view.ts` decides *how it looks*. The view gets styled
  segments (`Seg`, `Line`) with semantic colors (`error`, `warning`, `success`, `subtle`), never ANSI codes or
  rules of its own. The shell turns segments into elements, ANSI or text.
- **The shared store merges, never overwrites.** Parallel sessions share samples, prompts and spend. Every merge
  is order-free and only grows: a session's bucket keeps the larger of two copies, so no session undoes another's.
  Keep any new shared data to that pattern.
- **Read defensively, write strictly.** Stored and external data may be old, partial or malformed: drop what does
  not parse, never throw over it. What pace writes always matches the types.
- **Engine constraints.** A `$.state` atom must be read in the file that defines it, and `$` is followed across
  files only into `function` declarations. That is why the shell stays in `register.tsx`. Move logic out of it
  as pure functions; do not move `$` into the core.
- **Units are fixed.** Timestamps are milliseconds. Window lengths, `emptyIn` and `resetIn` are seconds. Percents
  are 0–100. Say the unit in the name or the doc comment when it is not one of these.

## Polished code

Write code that reads like the code around it.

- **Module headers.** Every file opens with a comment saying what it holds and, for core modules, `Pure; times in
  ms.`
- **Doc comments say what, in plain words.** Every export gets a one-line `/** … */` that says what the value *is*
  or what the function *answers*, in the domain's words: `/** The quota the rate hurts most: the one that runs out
  soonest among equals */`. Explain *why* only where the code cannot: a tradeoff, a constraint, a bug it avoids.
- **The domain's vocabulary, everywhere.** Quota, reading, sample, window, reset, status, rate, budget, spend,
  gassed out. One name per concept, in code, tests, UI text and docs alike. Do not invent synonyms.
- **Small functions, early returns, no cleverness.** Prefer a named helper to a nested ternary. Prefer `const` and
  expressions. No dead code, no commented-out code, no speculative options.
- **Types carry the meaning.** Use the `Pace*` contract types at the edges and narrow unions (`RateLevel`,
  `Status`) over strings and booleans. Use `null` for "not known yet" and say so in the doc comment. Avoid `any`
  outside the engine boundary in `register.tsx`.
- **No new dependencies.** pace runs on the engine and Node's standard library. Adding a package needs a strong
  reason and the user's agreement.
- **UI text is short and plain.** Sentence case, no jargon, numbers with their unit (`26 of 17%/h`, `out in
  1h04m`). Red and flashing are for the one thing that needs action now; everything else is calm.
- **Docs move with the code.** A change the user can see updates the README (both languages where it says the
  same thing) and the changelog in the same change.

## Definition of done

- [ ] A test was written first and seen to fail for the right reason.
- [ ] `claude plugin test .` passes, with the new test among the passes.
- [ ] `claude plugin validate .` passes.
- [ ] `tsc -p .` is clean.
- [ ] The README and `CHANGELOG.md` say what changed, if a user or another mod can see it.
- [ ] The diff holds only what the task asked for.
