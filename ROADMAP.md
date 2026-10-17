# pace roadmap

Worked top to bottom, one step per turn. Each step follows [`.agents/README.md`](.agents/README.md): a failing test
first, then the change, then `claude plugin test .`, `claude plugin validate .` and `tsc -p .` green, the
changelog updated, and the step ticked here. Steps marked **(needs you)** wait for the user: stop and say so.

## 1. Bug fixes

- [ ] **Stale reading after a reset.** Once a window's reset time passes and no new reading has arrived, the band
      and status line still show the old window's percent (`5h 65%` minutes after the reset). Show the new window
      as started (0%, or `—` until a reading) from the moment its reset passes.
- [ ] **Too fast with nothing to say.** A quota over pace with no per-prompt cost yet reads `→ — at reset too
      fast`. Say something a person can act on, e.g. `over pace · cost after 3 prompts`, and keep the red flash
      only for a rate that is known to run the quota out, or decide with a test what `fast` without a cost means.

## 2. Code polish

- [ ] **Type the hooks module.** Replace `$: any` in `register.tsx` with the engine's types. Splitting
      `register.tsx` further is limited by two engine rules: a `$.state` atom must be read in the file that
      defines it, and `$` is followed across files only into `function` declarations.
- [ ] **One compact layout.** The status-line row and `lineText` drawn from `bandLines`, so the band, the row and
      the entry cannot disagree.
- [ ] **File paths in one place.** One constants block for `pace-row.txt`, `pace-state.json`, `pace-keys.json`
      and `pace-view.command`, shared with `bin/viewer.ts`.

## 3. Docs

- [ ] **Platform table** in both READMEs: the band, the status line and the pane work anywhere Claude Code runs;
      the tmux split needs tmux and Node 23.6+; `/pace window` is macOS-only.
- [ ] **Screenshots or an asciinema clip** of the band, the window in two columns, a focused chart and auto
      mode's pane. **(needs you)**

## 4. Release

- [ ] **CI.** A GitHub Actions workflow running `tsc -p .`, and `claude plugin validate .` and
      `claude plugin test .` if the CLI runs headless there. Write the workflow; pushing it is **(needs you)**.
- [ ] **1.0.0.** Bump `plugin.json`, move *Unreleased* in `CHANGELOG.md` under `1.0.0`, tag `v1.0.0`.
      **(needs you)** for the tag and the push.

## 5. Next

- [ ] **Spend pace can't see.** Usage from claude.ai or another machine moves quotas with no spend recorded,
      which makes a dollar look dearer. Detect quota movement with no local spend and leave those spans out of
      the ratio.
- [ ] **Auto mode in a live session.** Run it on a real plan, watch the handoffs and holds, and tune the
      thresholds (heavy at 60%, cold-and-large at 100k tokens, 15-minute pacing holds). **(needs you)** to watch.

## Later

- **Overlay of past windows** in the charts.
- **Smarter warm mode.** Learn when you usually come back and keep the cache warm only when a return inside the
  TTL is likely.
- **Other terminals** for the window: detect iTerm, Ghostty and kitty; `x-terminal-emulator` on Linux.
- **Subagent models.** Let on pace mode move subagents to a lighter model when a model's week is over pace,
  rather than only asking Claude to.
