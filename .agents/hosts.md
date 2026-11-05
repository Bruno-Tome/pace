# pace on every host: Claude Code, Codex and Herdr

The spec for running pace's one core under three hosts, each through a thin adapter. Read
[README.md](README.md) first: every guardrail there still holds, and this spec adds to them.

## Goal

The same pace, the same rules and nearly the same drawing, wherever the agent runs:

- **Claude Code:** today's plugin, unchanged for the user.
- **Codex CLI:** the same quotas paced from Codex's own readings, and the same band, in a pane beside Codex.
- **Herdr:** a mod that draws each agent's band, and a fleet view that sets every host's quotas side by side,
  so work goes where there is room for it.

## Layout

```
core/                 the pure core, host-agnostic: everything hooks/ holds today but register.tsx, the clients
                      and the Claude-specific parts. Pure; times in ms.
  host.ts             the contract a host's feed meets (PaceFeed), and the fleet: hosts side by side
hooks/                the Claude Code adapter, where Claude Code's plugin layout wants it: register.tsx,
                      band-client.tsx, plan-client.tsx, files.ts and usage.ts (the usage endpoint's and
                      ~/.claude.json's readings)
adapters/codex/       hook.ts: a Codex hook (Node) that reads the session's rollout and writes its feed;
                      rollout.ts: pure rollout and hook-input parsing; fixtures.ts: the shapes Codex 0.161 writes
adapters/herdr/       main.ts: the Herdr mod; draw.ts: segments as the theme's colors and which view (pure); built
                      to plain JS by scripts/herdr.ts
bin/                  viewer.ts and plan-viewer.ts as today, plus band.ts: the band or the fleet, live, in any terminal
testing/              expect.ts: claude-code/testing's matchers, host-neutral; node.ts: describe and test on
                      node:test, register.ts mapping the module name to it; herdr.ts: a collecting runner for Herdr
scripts/herdr.ts      strips types (node:module stripTypeScriptTypes) into a mod folder; installs or checks it
```

Auto mode, ultra pace and throttle stay in `core/`: they are pure, and the band draws them; a host without them
never turns them on. Imports between core files keep their `.ts` extensions; the Herdr build rewrites them to `.js`.

## The seam

- **Inputs** are what the core already takes: `PaceSample` readings, prompt times, `PaceSpend`, the cache
  (`tokens`, `window`, `ttl`), `now`. Spend, price and cache are optional per host: a host that reports no
  dollars (Codex) paces on readings and prompts alone, and the band leaves out what it cannot know.
- **Quota keys** stay as they are for Claude (`five_hour`, `seven_day`, `seven_day_<model>`). A feed names its
  provider (`claude`, `codex`), so two hosts' `five_hour` never mix.
- **Feeds.** Each host session writes one file, `~/.local/state/pace/feeds/<host>-<session>.json`, a `PaceFeed`:
  `{version, host, provider, session, terminal?, cwd, at, snapshot, context?}`. `terminal` is Herdr's
  `HC_TERMINAL_ID` when the session runs in Herdr. Written atomically, read defensively, dropped once stale.
- **The fleet** (`core/host.ts`): feeds in, one row per provider out, with each provider's pace status and
  headroom, and the agents on it with their context use. A pure rule: `fleetOf(feeds, now)`.
- **A feed carries its harness's whole history**, not just its session's: Claude's shared store makes it so, and
  the Codex hook merges the other live Codex sessions' readings and prompts into its own. The harness's merging
  happens in the writers, which run in fast runtimes; the fleet only picks, per provider, the session with the
  newest reading. A reader never merges copies of one history.
- **Readers have a budget.** Herdr interrupts any call into a mod past its budget (between half a second and a
  second) and keeps showing what it drew before. The mod draws in steps (the fleet, one agent's band, a harness's
  charts), each a call of its own; `node scripts/herdr.ts check` runs each step on feeds the size real use makes
  (`testing/load.ts`), so a step that grows past the budget fails there, not in the app.
- **The drawing** is `view.ts`'s `Seg`/`Line`, unchanged. Claude turns them into elements, `bin/` into ANSI,
  Herdr into gpui-kit divs. A host never draws rules of its own.

## Codex

Codex has hooks but no custom prompt area, status line or pane (its `tui.status_line` takes only built-in items).

- `adapters/codex/hook.ts` runs on `SessionStart`, `UserPromptSubmit`, `PostToolUse` and `Stop` (async), reads
  the hook's JSON on stdin (`session_id`, `transcript_path`, `cwd`), parses the rollout's new lines from where it
  left off, and writes the feed. Prompts come from `UserPromptSubmit`; readings from `token_count` events
  (`rate_limits.primary` → `five_hour`, `secondary` → `seven_day`, `used_percent`, `resets_at` in seconds);
  context from `info.last_token_usage` and `model_context_window`.
- The rollout is not a stable interface, so `rollout.ts` drops any line it cannot read and the tests pin the
  shapes seen in Codex 0.161. Only the `codex` rate limit (or one with no id) is read: Codex 0.153–0.155 also
  wrote a `premium` limit with null windows. `transcript_path` may be null; the feed is written all the same.
- Codex has no prompt cache or dollars to report: its snapshot sets `noCache`, and the band leaves the cache's row
  out.
- The hook prints nothing (a `UserPromptSubmit` hook's stdout joins the conversation), always exits 0, and keeps
  how far it has read in `~/.local/state/pace/codex/<session>.json`. Async hooks can overlap a prompt's hook, so
  it holds a lock while it reads and writes.
- The band shows through `bin/band.ts` in a pane beside Codex; under Herdr the mod opens it.
- Installing writes hooks to `~/.codex/config.toml` only with the user's go-ahead.

## Herdr

- Mods are plain JS and import only from their own folder, so `scripts/herdr.ts` builds `adapters/herdr/` and
  `core/` into `~/.config/herdr-app/mods/pace/`.
- The mod reads every feed (`watchFolder`, a timer as fallback) and draws: per agent, its band in a panel; and
  the fleet, every provider's quotas and pace with the agents on each, ordered by headroom.
- `/pace` opens a view beside the session (`adapters/herdr/open.ts`: focus the session's terminal, split its pane).
  Claude's shell runs the commands; the Codex hook does for a `/pace` or `$pace` prompt (adapters/codex/open.ts,
  also a command the pace skill runs), then blocks it. Codex's TUI refuses an unknown slash command, so the way in
  is the custom prompt `/prompts:pace` or the skill `$pace`, both installed by `node scripts/codex.ts install`. A pane already
  showing the view is focused instead: Herdr names no mod's pane to it, so a copy opened with a `view` prop claims
  the one pace pane not yet in the registry (`pace.panes` in Herdr's shared state, read from `shared.json`).
- One mod, three views by its props: the panel; `{view: 'band', terminal}`, one agent's band; `{view: 'pane',
  provider}`, a harness's `/pace` pane from the fleet's merged snapshot (every live session of it, no cache).
- The mod works the drawing out when the feeds change and on its clock, never in `render`: Herdr interrupts a
  render that runs long, and every agent's week of readings is real work.

## Tests: green on every host

The guardrails' checks, plus one per host. All of them pass before a phase is done.

- **Claude Code:** `claude plugin test .`, `claude plugin validate .`, `tsc -p .`. Every test that passes today
  passes after the move, unchanged except for import paths.
- **Codex (Node):** `node --import ./testing/register.ts --test tests/*.test.ts adapters/*/*.test.ts` runs the
  core suite and the adapters' pure tests (rollout fixtures, hook stdin) on Node, through `testing/node.ts`; the
  files are named, since `tests/claude/` needs the engine. `node --test` on the `*.node-test.ts` files runs the
  tests that need Node: the hook and `bin/band.ts` end to end, the Herdr build, the shim.
- **Every `*.test.ts` runs on every host.** Claude Code loads each one under the repo and lets it import only
  relative files and `claude-code/testing`, so a Node-only test is a `*.node-test.ts`.
- **Herdr:** `node scripts/herdr.ts check` builds the mod and the core suite into a check-only mod and runs
  `herdr-app check` on both, so the core's tests pass inside Herdr's own JS runtime. A check renders once and
  waits for nothing async, so the suite runs synchronously and a failure throws from `render` with every test
  that failed.

## Phases

Each phase is red first and leaves every host green. All six are done.

1. **Move.** The pure modules `hooks/` → `core/`, behavior unchanged. The Claude-only parsers leave
   `quota.ts` for `hooks/usage.ts`. All 354 tests pass under `claude plugin test .`.
2. **Node.** `testing/node.ts`; the core suite green on Node.
3. **Feeds and fleet.** `PaceFeed`, `fleetOf`; the Claude adapter writes its feed.
4. **Codex.** `rollout.ts`, `hook.ts`, `bin/band.ts`.
5. **Herdr.** The build, the mod, the fleet view; the core suite green in Herdr.
6. **Docs.** README, CHANGELOG, this file's layout in `.agents/README.md`.
