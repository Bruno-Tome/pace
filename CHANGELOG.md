# Changelog

## 0.8.0

pace, a terminal-first take on [weektoken](https://github.com/3dnow/claude-mods/tree/main/weektoken)'s idea, with
its own quota model. What differs from weektoken:

- Terminal surfaces: a band above the prompt, a status-line entry or row, and `/pace`'s full-screen window
  (two columns when wide; keys `1`–`9`, `w`, `r`, `q`).
- `/pace` runs at once, mid-turn too, and answers in a toast: nothing lands in the conversation.
- Statuses: under pace, on pace, over pace, and **gassed out** for a spent quota.
- The rate against each quota: steady, brisk, burst, too fast.
- Shared spend across parallel sessions: pacing in dollars an hour against what each quota has left, and a
  per-prompt cost from the first prompt.
- The prompt cache: a countdown and the next prompt's cost, warm vs cold, in tokens and dollars.
- Warm mode keeps an idle cache from lapsing.
- Usage warnings at 80%, 95%, a rate that gasses a quota out, and gassed out: once per window, as a toast and a
  notification.
- On pace mode (`/pace on`) for long-running sessions: compacts a heavy context while its cache is warm.
- Auto mode (`/pace auto <plan>`): works through a plan with no one at the keyboard, with handoffs, subagents on
  lighter models, holds for pacing, and an onboarding pane.
- `$.pace.snapshot()` for other mods.
