---
name: pace
description: Open pace beside this Codex session in Herdr - its quota charts, its band, or the fleet of every agent. Use only when the user invokes $pace, $pace band or $pace fleet.
---

# pace

pace's hook normally answers `$pace` before you see it. If you are reading this, it did not (the hook is not
installed or not yet trusted in `/hooks`), so open the view yourself:

1. Take the argument the user gave after `$pace`: nothing, `band` or `fleet`. Anything else: say pace takes
   `band` or `fleet` and stop.
2. Run exactly one command, with that argument (or none):

   ```sh
   node {{PACE_ROOT}}/adapters/codex/open.ts <argument>
   ```

3. Reply with the one line it printed, and nothing else. It exits 1 when nothing opened; say so, and that the pace
   hook in `~/.codex/config.toml` needs trusting in `/hooks` for `$pace` to open without a turn.

Do nothing else: no other commands, no files read or changed.
