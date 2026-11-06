# 25. Activity: every metric over all history, in a split with chips

Status: accepted, 2026-11-06. Builds on [24](0024-append-only-log.md).

## Context

The user wants to see what was spent, over any range of time and sliced any way: tokens in and out, cache reads and
writes, reasoning, dollars, prompts, replies and quota use; by day, week, month, year or all of history; by provider,
account, harness, repo or model. The log held prompts, readings and costs, no tokens, and was kept eight days.

## Decision

- **Tokens are events.** A reply's tokens go to the log as a `usage` event: input, output, cache read, cache write,
  reasoning, and its model. Hosts that report them write them (Claude Code's `turn.complete`, Codex's rollout,
  pi's replies, Hermes where its calls say); a host that does not (ACP agents, Antigravity) shows its dollars,
  prompts and readings only, never zeros dressed as tokens.
- **A header names its harness and folder** (`h`, `c`), so activity slices by harness and repo. Additive: a header
  without them is read as before.
- **Checkpoints forever, raw lines nine days.** A finished day's checkpoint gains its activity: hourly rows by
  provider, account, harness, repo and model, each with every metric. Checkpoints are never deleted; a day's raw
  lines are, once it is past nine days and folded. A checkpoint written before this (no activity) is folded again
  while its raw lines are there.
- **One shared core.** `core/dims.ts` names what things are sliced by (provider, account, harness, repo, model) and
  how each is labelled, for the fleet and activity alike. `core/activity.ts` turns log entries into hourly rows,
  keeps them (an `Activity`, beside `History`), and answers a query: a metric, a range, a dimension to break down by
  and filters, as bins over the range, each group's share and totals. `core/chips.ts` is the chips model: what can be
  picked, what is on, and the query a click makes. The drawing (stacked bars, legend, totals) is `core/view.ts`'s,
  in segments, for every surface.
- **A split, with chips.** `/pace activity` opens like `/pace split`: a Herdr split (`pane.split`, the pace mod's
  `{ view: 'activity' }`), a tmux split or a terminal window running `bin/activity.ts`, which is also its full-screen
  version. Chips only: metric, range, breakdown and each filter are chips to click (or to move to and press in a
  terminal), never a typed bar.

## Consequences

- Activity reads every day folder's checkpoint once per process, then only what the log adds.
- A day of activity is a few kilobytes kept for good; history, quotas and the fleet still read eight days.
