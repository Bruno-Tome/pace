# pace

[中文](README.zh-CN.md)

Rate-limit pacing for Claude Code, in the terminal. pace shows your 5-hour and weekly quotas against the clock
while you work, prices each prompt, and keeps long-running sessions from getting **gassed out**: hitting a spent
quota and stalling until it resets.

Inspired by [weektoken](https://github.com/3dnow/claude-mods/tree/main/weektoken), a quota-pace chart for Claude Code.
pace is its own take on the idea: a terminal-first port with small upgrades and quality-of-life changes.

## What it shows

- **A band above the prompt:** the 5-hour and weekly bars, each with its pace status and the rate against it,
  then the prompt cache's countdown with what the next prompt costs.
- **A status-line entry,** or with `placement: status`, a full row your status line prints.
- **`/pace`:** burn-up charts for every quota, full-screen in a terminal window of its own. Two columns on wide
  terminals. Keys: `1`–`9` shows one quota alone, `w` cycles warm mode, `r` refreshes, `q` quits.
  `/pace pane` draws the same in a pane inside Claude Code.

`/pace` runs at once, even mid-turn, and answers in a toast. Nothing lands in the conversation, so it never costs
context.

## Statuses

| Status | Meaning |
| --- | --- |
| Under pace | Using less than the time gone |
| On pace | Within a few points of even pace |
| Over pace | Using faster than the clock |
| **Gassed out** | The quota is spent: prompts fail until it resets |

The rate against a quota is **steady**, **brisk** (near its budget), **burst** (would run out early if it keeps
up, though the average is on pace) or **too fast** (runs out before the reset and already over pace).

## Pacing across parallel sessions

Every session records what it spends in a store all sessions share. Pacing is judged in dollars an hour across all
of them against what each quota has left, so five sessions at once read as one budget. A prompt's cost comes from
how much of a quota a dollar uses (learned from the last week of readings) times recent dollars per prompt, so it
is there from the first prompt.

pace warns once per window, in a toast and a notification: at 80% and 95% of a quota, when the rate would get it
gassed out before it resets, and when it is gassed out.

## On pace mode

`/pace on` keeps a long-running session on pace:

- compacts a heavy context (60% of the window) after a turn, while its cache is still warm and compacting is cheap
- keeps an idle cache from lapsing: compacting a large context, pinging a small one
- warns before a quota gets gassed out

`/pace off` turns it off.

## Auto mode

`/pace auto <plan file> [turns]` works through a plan or roadmap with no one at the keyboard. The first time, a
pane says what it does and that it spends quota on its own; it starts when you press Start.

- After each turn pace sends the next prompt, until Claude ends a turn with `PACE: DONE` or `PACE: BLOCKED`, or the
  turn cap (40 by default) is reached.
- It answers Claude's questions with the recommended option.
- It has Claude hand searches and routine edits to subagents on lighter models, and keep `.pace/handoff.md` up to
  date. When the context gets heavy, or is cold and large, pace clears it and resumes from that file.
- It holds while the rate would get a quota gassed out, and while one is gassed out, until it resets.
- It turns on on pace mode.

Its instructions are a fixed system-prompt section, so the prompt cache keeps them. Live pacing notes ride in each
prompt instead. `/pace auto off` stops it; an interrupt pauses it until `/pace auto resume`.

## For other mods

pace adds `$.pace` to the engine. List `pace` under `dependencies` in your `plugin.json`, and Claude Code lays its
types into your mod.

```ts
const snap = await $.pace.snapshot()
snap.quotas        // [{ key, name, percent, status, resetsAt, runOutAt, rate: { level, usdPerHour, … } }]
snap.cache         // { tokens, secondsLeft, nextWarm, nextCold, nextWarmUsd, … } or null
snap.spend         // { usdPerHour, sessions, usdPerPrompt }
snap.gassedOut     // a quota is spent
snap.modes         // { onPace, auto }
snap.advice        // [{ level, text }]
```

The snapshot is as of `snap.at`: pace refreshes it after every reply, reading and minute.

## Install

```
/plugin install pace --marketplace <owner>/pace
```

The `/pace` window needs macOS and a Node that runs TypeScript directly (23.6 or later) on your `PATH`.

## Commands

| Command | Does |
| --- | --- |
| `/pace` | Opens the charts window (or a pane, where it can't) |
| `/pace pane` | The charts in a pane |
| `/pace refresh` | Reads every source again |
| `/pace on`, `/pace off` | On pace mode |
| `/pace auto <plan> [turns]`, `auto off`, `auto resume` | Auto mode |
| `/pace warm ping \| compact \| off` | Keeps an idle cache warm |
| `/pace hide`, `/pace show` | The band |
| `/pace line on \| off` | The status-line entry |

## Options

| Option | Values | Default |
| --- | --- | --- |
| `placement` | `above` (band above the prompt) or `status` (a row in `~/.claude/pace-row.txt` for your status line) | `above` |
| `cacheTtl` | `auto`, `1h`, `5m` | `auto` |
| `terminal` | The macOS app `/pace` opens in | `Terminal` |

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

## Development

```
claude --plugin-dir .        # run it from this folder
claude plugin test .         # the tests
claude plugin validate .     # what the engine would refuse
```

## License

MIT. See [LICENSE](LICENSE).
