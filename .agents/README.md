# Working on pace

Guidelines for anyone changing pace, human or agent: how the code is laid out, what polished code looks like
here, and the guardrails every change goes through. Read this before writing code; [the playbook](playbook.md) is
the order of work that keeps to them. The user-facing description is
in the [README](../README.md).

## Guardrails

These are not optional. A change that skips one is not done.

1. **Red first.** No production code without a failing test that asks for it. See
   [Test-driven development](#test-driven-development-red-first).
2. **Green on every host.** Claude Code (`claude plugin test .`, `claude plugin validate .`, `tsc -p .`), Node (the
   core suite and the Node-only tests) and Herdr (`node scripts/herdr.ts check`) pass before a change is called
   done; the commands are under [Checks](#checks). Run them and read the output; never claim a result you did not
   see.
3. **Never weaken a test to get green.** Do not delete, skip, loosen or rewrite an assertion to fit the code.
   If a test is wrong, say why in the change and fix the test on its own, red first like any other change.
4. **Small and in scope.** Change what the task asks for. Note anything else you find; do not fix it on the way.
5. **The contract moves on purpose.** A change to `types/index.d.ts` or a stored shape is additive, documented
   in `CHANGELOG.md` under *Unreleased*, and read back safely from older data.
6. **Nothing in the transcript, nothing off the machine.** `/pace` answers in toasts and panes, never in the
   conversation. No telemetry: the only network call is the usage endpoint, and warm mode's one-word ping. A call
   on loopback to a harness's own server (Antigravity's, for its quotas) stays on the machine and is allowed
   ([ADR 0020](decisions/0020-antigravity-cli.md)). An account is a keyed hash of its email; no email is written.
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
  with the fake world in `tests/claude/world.ts`: submit prompts, move the clock, measure a reading, mount the
  surface and read what was drawn. Tests that need the engine live in `tests/claude/`.
- **A host adapter's I/O** (the Codex hook, `bin/band.ts`, the Herdr build) gets an end-to-end test on Node: run
  it in a scratch home and read what it wrote.
- **Where a test runs.** A `*.test.ts` runs on every host: Claude Code loads every one under the repo, so it
  imports only its own relative files and `claude-code/testing`, with the matchers `testing/expect.ts` has. A test
  that needs Node (files, processes) is a `*.node-test.ts`, which Claude Code does not load, and imports
  `testing/node.ts` itself.
- A bug that shows on screen usually wants both: the integration test that reproduces it, and a unit test that
  pins the rule.

Writing the test:

- Name it as a sentence about behavior: `a window over pace is not too fast once the prompting stops`.
- Use the fixed clock (`NOW`, `H`, `MIN`) and build the smallest data that makes the case. Comment the numbers
  that matter: `// 80% used with two thirds of the window gone: over pace`.
- Assert on what matters to the user or the caller, not on incidental formatting.

## Architecture

pace is a core of pure functions, host-agnostic, with a thin adapter for each host it runs under: Claude Code,
Codex, pi and Herdr. [hosts.md](hosts.md) is the spec for the hosts; the decisions that shape them are in
[decisions/](decisions/README.md), the first being that [Herdr comes first](decisions/0001-herdr-first.md) for every command.

```
hooks/register.tsx  the Claude Code adapter: hooks, commands, state atoms, the shared store. The only module that
                    touches `$`.
hooks/usage.ts      Claude Code's usage readings: the usage endpoint's answer and ~/.claude.json
hooks/files.ts      the files pace writes in ~/.claude, shared with bin/viewer.ts
hooks/band-client.tsx the band's animation, on the client's frame clock
hooks/plan-client.tsx the timeline in a pane, on the client's frame clock
core/model.ts       the core's entry: rows, the rate against each quota, advice, the public snapshot
core/quota.ts       readings and windows, statuses, names
core/rate.ts        the prompting rate; bar and sparkline primitives
core/spend.ts       the shared spend; pacing in dollars an hour
core/cache.ts       the prompt cache's timer and the next prompt's cost
core/auto.ts        auto mode and on pace mode, as decisions the shell carries out
core/throttle.ts    ultra pace's headroom and the gear it allows
core/ultra.ts       ultra pace, as decisions on top of auto mode's
core/alerts.ts      warnings, keyed so each is said once per window
core/api.ts         the one surface hosts call (ADRs 0018, 0022): a host declares its surfaces and what it can do
                    to its agent; route() turns a /pace command into what it does there, stepOf() auto mode's
                    decision, warmStep() warm mode's, viewLines() any view for any surface
core/meter.ts       what a host meters (prompts, readings, spend, cache, context), into its session's feed; the feed
                    carries its whole quota's history in memory, every harness on the provider and account
core/log.ts         the history as an append-only log, a file a day per session (ADR 0024): its lines, read back,
                    feeds hydrated from it and written slim, the days kept
core/account.ts     an account as a keyed hash of its email (HMAC-SHA-256, plain TypeScript), numbered, labelled
core/gears.ts       ultra pace's ladders: each provider's models and thinking levels, lightest first, and a notch on one
core/command.ts     /pace's arguments as a command, read once for every host; its defaults and usage
core/estimate.ts    quotas a host is told nothing of, estimated from its spend: windows, capacities learned
core/host.ts        the feed every host writes (PaceFeed), and the fleet: one row per quota, provider and account
core/view.ts        every drawing as lines of styled segments, the fleet's too
core/chart.ts       braille burn-up charts
core/plan.ts        the plan's checklist as steps on a timeline
core/timeline.ts    the plan timeline's animation as frames, shared by the pane and the sidebar
adapters/account.ts the account a Node adapter's session spends: pace's key made once, the email hashed, numbered
adapters/acp/       proxy.ts: pace between an ACP client and agent, the traffic as metered events, pure
adapters/antigravity/ status.ts: GetUserStatus read into readings, the server found, pure; feed.ts: the hook's input
                    and the shared history, pure; server.ts: the server asked on loopback; hook.ts: the hook
adapters/hermes/    events.ts: Hermes's providers, windows and its two modes as hosts, pure; plugin/: the Hermes plugin
                    (Python) that hands its events to bin/pace-hermes.ts
adapters/log.ts     the log on disk for the Node hosts: appended, read on from where it was left, feeds read hydrated
                    and written slim, pruned by whole files
adapters/views.ts   a view opened where the core routed it, for the Node bridges
adapters/codex/     rollout.ts: Codex's rollout and hook input, pure; hook.ts: the hook that writes the feed;
                    open.ts: /pace's views opened in Herdr; pace.md and skill/: /prompts:pace and $pace
adapters/herdr/     main.ts: the Herdr mod, three views; draw.ts: segments as the theme's colors, which view, pure;
                    open.ts: the herdr-app commands /pace runs to open a view beside a session, pure
                    send.ts: the fleet's Send work as a popup or a pane that stays open, pure; log.ts: the log as
                    the mods read it, a past day once
adapters/pi/        feed.ts: the quota a pi session spends and its feed, pure; commands.ts: pi's thinking levels,
                    pure; extension.ts: the pi extension that writes the feed, draws the band and runs /pace
bin/viewer.ts       the full-screen window, a Node process fed through a state file
bin/plan-viewer.ts  the plan's timeline as a tmux sidebar, fed through a file per session
bin/band.ts         the band or the fleet, live, in any terminal, from the feeds
bin/pace-hermes.ts  the Hermes bridge: the plugin's events in, the core run on them, replies and prompts out
bin/pace-acp.ts     pace as an ACP proxy: `pace-acp -- <agent>`; meters, answers /pace, runs auto mode
testing/            expect.ts: the matchers, host-neutral; node.ts and register.ts: the suite on node:test;
                    herdr.ts: the suite inside Herdr; load.ts: feeds the size real use makes
scripts/herdr.ts    builds the Herdr mod and the check-only core suite; installs or checks them
scripts/codex.ts    installs /prompts:pace and the pace skill into ~/.codex
scripts/hermes.ts   installs the Hermes plugin into ~/.hermes/plugins and enables it
scripts/pi.ts       installs the pi extension into ~/.pi/agent/extensions
types/index.d.ts    the public contract: stored shapes and `$.pace`
```

### Rules

- **A pure core and thin adapters.** `core/` is pure, and so are `hooks/usage.ts`, `adapters/codex/rollout.ts`,
  `adapters/pi/feed.ts`, `adapters/pi/commands.ts` and `adapters/herdr/draw.ts`. Of the rest, only `register.tsx` touches `$`; the hook, the bins, the mod and the
  scripts do the I/O around pure functions. In the core: values in, values out, no `$`, no
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
- **History is a log; readers hydrate.** Each session appends what it saw itself to its day's file in the log;
  feeds carry live state only; a reader fills each feed's history in from the log with a `History` (core/log.ts,
  [ADR 0024](decisions/0024-append-only-log.md)). Nothing is copied from feed to feed, and a merge never sees two
  copies of one event as two.
- **Nothing is worked out twice.** Read paths run in many copies and often: read only what changed, work out only
  what changed, fold what is final once, draw only when what is shown changed. How, in
  [the playbook](playbook.md#4-never-work-anything-out-twice).
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
- **Docs move with the code.** A change the user can see updates the README and the changelog in the same
  change.

## Checks

```
claude plugin test .                    # Claude Code: every *.test.ts, in the engine
claude plugin validate .
npx -y -p typescript tsc -p .           # tsc: the core, the Claude adapter, the pure adapter files
node --import ./testing/register.ts --test tests/*.test.ts adapters/*/*.test.ts      # the core suite on Node
node --test testing/*.node-test.ts scripts/*.node-test.ts adapters/*.node-test.ts adapters/*/*.node-test.ts bin/*.node-test.ts  # Node-only
node scripts/herdr.ts check             # Herdr: the mod, the core suite in a check-only mod, and each of the
                                        # mod's steps on a week of feeds (testing/load.ts) within Herdr's budget
```

Node 23.6 or later runs these (it strips the types); the Herdr check needs `herdr-app` on the `PATH`. Modules a
Herdr mod builds from import only relative `.ts` files, never `node:` or a package.

## Definition of done

- [ ] A test was written first and seen to fail for the right reason.
- [ ] `claude plugin test .` passes, with the new test among the passes.
- [ ] `claude plugin validate .` passes.
- [ ] `tsc -p .` is clean.
- [ ] The core suite and the Node-only tests pass on Node, and `node scripts/herdr.ts check` passes.
- [ ] The README and `CHANGELOG.md` say what changed, if a user or another mod can see it.
- [ ] The diff holds only what the task asked for.
