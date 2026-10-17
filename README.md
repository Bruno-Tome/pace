# pacebar

A terminal-first port of [weektoken](https://github.com/3dnow/claude-mods/tree/main/weektoken) for Claude Code,
with some small upgrades and quality-of-life changes.

weektoken (by mj0111, MIT) charts your Claude rate-limit quotas against the clock: whether you're over or under
pace, and where your current slope lands by the reset. pacebar keeps its pace model and turns it into something
you see while you work in the terminal, without opening anything.

## What it shows

- **A band above the prompt:** the 5-hour and weekly bars, each with its pace status and the prompting rate
  against it, then the prompt cache's timer with what the next prompt costs.
- **A status-line entry,** or with `placement: status`, a full row your status line prints.
- **`/pace`:** weektoken-style burn-up charts, full-screen in a terminal window of their own. Two columns on wide
  terminals. Keys: `1`–`9` shows one quota alone, `w` cycles warm mode, `r` refreshes, `q` quits.
  `/pace pane` draws the same in a pane inside Claude Code.

## What pacebar adds

- **Shared pacing across parallel sessions.** Every session records what it spends in a store all sessions share.
  Pacing is judged in dollars an hour across all of them against what each quota has left, so five sessions at
  once read as one budget.
- **Per-prompt cost from the first prompt.** pacebar learns how many points of a quota a dollar uses, from the
  quota's readings against the shared spend over the last week. A prompt's cost is that times recent dollars per
  prompt.
- **Burst vs too fast.** A burst runs a quota out early only if it keeps up, while the quota is still on pace on
  average. Too fast means it's already over pace.
- **The prompt cache.** A countdown from the last reply, and the next prompt's cost warm vs cold, in tokens and
  dollars (priced from what the session's own replies cost).
- **Warm mode** (`/pace warm ping | compact | off`): keeps an idle cache from lapsing.

## Install

```
/plugin install pacebar --marketplace <owner>/pacebar
```

The `/pace` window needs macOS and a Node that runs TypeScript directly (23.6 or later) on your `PATH`. Set the `terminal` option for iTerm,
Ghostty and so on.

## Commands

`/pace` · `/pace pane` · `/pace refresh` · `/pace hide | show` · `/pace line on | off` ·
`/pace warm ping | compact | off`

## Options

| Option | Values | Default |
| --- | --- | --- |
| `placement` | `above` (band above the prompt) or `status` (a row in `~/.claude/pacebar-row.txt` for your status line) | `above` |
| `cacheTtl` | `auto`, `1h`, `5m` | `auto` |
| `terminal` | the macOS app `/pace` opens in | `Terminal` |

## Where the numbers come from

- **Quotas:** the session's own rate-limit readings after each reply, Claude Code's usage cache in
  `~/.claude.json`, and Anthropic's usage endpoint (for per-model quotas), called with Claude Code's own login.
  The mod never sees the credential.
- **Spend:** the session's cost ledger (what `/cost` totals).
- **Limits of the estimate:** usage pacebar can't see (claude.ai, another machine) moves a quota without spend,
  which makes a dollar look dearer. Quota readings are whole points, so a quota's ratio waits for 8 points of
  movement.

pacebar has no telemetry. The only requests it makes are the usage-endpoint call (the same one `/usage` makes)
and, in warm mode `ping`, an ordinary one-word model call that reads the cache.

## Credits

The pace model, its thresholds and copy (`hooks/pace.ts`, `hooks/i18n.ts`) come from
[weektoken](https://github.com/3dnow/claude-mods/tree/main/weektoken), MIT License, Copyright (c) 2026 mj0111.
See `LICENSE.weektoken`.
