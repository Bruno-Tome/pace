---
name: pace
description: pace's commands in Codex - its quota charts, its band, the fleet of every agent, the plan's timeline and auto mode. Use only when the user invokes $pace, alone or with arguments.
---

# pace

pace's hook normally answers `$pace` before you see it. If you are reading this, it did not (the hook is not
installed or not yet trusted in `/hooks`), so open the view yourself:

1. Take the argument the user gave after `$pace`. Only a view opens without the hook: nothing, `band` or `fleet`.
   For anything else (auto mode, a plan, `pane`, `window`), say that `$pace` needs pace's hook in
   `~/.codex/config.toml`, trusted in `/hooks`, and stop.
2. Run exactly one command, with that argument (or none):

   ```sh
   node {{PACE_ROOT}}/adapters/codex/open.ts <argument>
   ```

3. Reply with the one line it printed, and nothing else. It exits 1 when nothing opened; say so, and that the pace
   hook in `~/.codex/config.toml` needs trusting in `/hooks` for `$pace` to open without a turn.

Do nothing else: no other commands, no files read or changed.
