---
name: changing-pace
description: Use when changing the pace repo (core, adapters, hooks, bins, Herdr mods, stored feeds or the log), when a reader is slow or lags the machine, when pace's data on disk looks wrong, or when committing pace work
---

# Changing pace

## Overview

pace is a pure core with a thin adapter per host, and its history is an append-only log every reader hydrates
from. A change keeps both: the rule in `core/`, red first, wired into every host, and no read path working
anything out twice.

## Read first

- `.agents/README.md`: guardrails, architecture rules, checks, definition of done.
- `.agents/playbook.md`: the order of work, step by step, with what to run.
- `.agents/decisions/`: the ADR behind any stored shape you touch (0024 for feeds and the log).

## Quick reference

| Situation | Do |
|---|---|
| A bug | Reproduce it as a scratch script on the data's real shape; that output is the red test |
| A new rule | Pure function in `core/`, unit test in `tests/`, then each host (table in the playbook) |
| A stored shape changes | ADR, additive, old data read back, `CHANGELOG.md` *Unreleased* |
| Slow or laggy | Time each stage on real data, `node --cpu-prof`, then: read only what changed, work out only what changed, fold once, draw only on change |
| User data on disk | Back up to the scratchpad, dry run, apply, compare per quota |
| Commit | Branch, one commit per concern, check each staged snapshot alone |

## Common mistakes

- Merging many copies of shared data as one list: copies get summed. Merge a pair at a time (`mergeCopies`).
- Rebuilding history on every read: keep a `History` per reader and per home.
- Wiring one host and calling it done: Claude Code, the Node hosts, Herdr and Antigravity each read or write.
- A poll with no way out, or an unbounded search, left running.
