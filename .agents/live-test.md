# Live test of every harness, through Herdr

Run on 2026-11-05 by the agent working on pace, inside Herdr (`hc`), each harness in a terminal of its own in
`/tmp/claude-501/pace-live` (a scratch folder with a two-step `PLAN.md`). Each harness gets at most two trivial
prompts ("Reply with just: ok"), so the quota spent is negligible. Results go under each step.

## Before

- [x] Rebuild and install Herdr's pace mod from this tree (`node scripts/herdr.ts install`)
- [x] Note the feeds already in `~/.local/state/pace/feeds`, so new ones are told apart

## Each harness (Claude Code, Codex, pi, Antigravity's `agy`, Hermes)

For each:

1. **Starts and meters.** Start it in an `hc` terminal, send one trivial prompt, wait. Its feed appears in
   `~/.local/state/pace/feeds/<host>-<session>.json` with the right host, provider, account (16 hex digits, the same
   for one sign-in everywhere), one prompt, a context, and readings (real, or an estimate marked `estimated`).
2. **`/pace` opens in Herdr.** The terminal runs in Herdr, so `/pace` opens the charts in a Herdr pane beside it
   (Herdr first, ADR 0001), and the harness answers without a model turn.
3. **A command the harness cannot carry out** (`/pace hide` where it has no band) answers plainly, with no model turn.
4. **`/pace fleet`** opens the fleet in Herdr, with this harness's quota on its row.

## Across harnesses

- [x] One account, one row: harnesses on the same sign-in show under one quota in the fleet
- [x] `pace-acp -- agy acp`, driven by a small ACP client script: a prompt metered, `/pace` answered without reaching
      the agent, the agent's model and thinking options read

## After

- [x] Close every terminal and Herdr pane the test opened
- [x] Record what failed, with the fix or the reason it is left

## Results (2026-11-05)

Run in Herdr terminals t22–t2f. Each harness got one trivial prompt; Codex got a second by accident (see below).

| Harness | Meters | `/pace` (Herdr first) | A command it cannot do | Notes |
| --- | --- | --- | --- | --- |
| Claude Code | ✔ feed, account, context, cache, real readings | ✔ (toast, no transcript row) | ✔ `/pace hide` hid the band, `show` brought it back | |
| Codex | ✔ feed, account, 2% 5-hour | ✔ `$pace` blocked by the hook: "already open in Herdr" | ✔ "Codex has no band of its own" | |
| pi | ✔ feed, context, cache | ✔ no model turn | ✔ "pi cannot ping its cache" | Fixed: with two ChatGPT accounts here it borrowed both accounts' readings |
| Hermes | ✔ feed on its own ChatGPT account | ✔ in place | ✔ "Hermes has no band of its own" | Hermes is signed in to a different ChatGPT account than Codex: two rows, correctly |
| Antigravity (`agy` TUI) | ✔ feed per conversation, per-model quotas | ✔ after two fixes | ✔ "Antigravity has no band of its own" | Fixed: `/pace` was completed to another skill; the plugin now ships a `pace` skill, and the hook reads `/pace:pace` |
| `pace-acp -- agy acp` | ✔ feed, account, readings, model and thinking options | ✔ answered without the agent | ✔ | A real prompt timed out in the test client, which does not answer the agent's permission requests |

Also fixed: a Herdr chart pane was keyed by provider alone, so two accounts of one provider shared one pane; it is
now keyed by provider and account, and the fleet's rows open their own.

The test method itself had a flaw: `hc send` tags each message `<hc from=…>`, so a harness gets a message, not a
command. Untagged sends (no `HC_TERMINAL_ID`) were used after that; the first, tagged `/pace` cost a model turn in
Claude Code, Codex and pi.

Not verified live: Hermes's bot mode in a real chat (no gateway was started), auto mode and ultra pace end to end.
