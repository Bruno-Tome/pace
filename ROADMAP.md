# pace roadmap

## Next
- **Open-source release.** See `OPEN_SOURCE_PLAN.md`.
- **Spend pace can't see.** Usage from claude.ai or another machine moves quotas with no spend recorded, which
  makes a dollar look dearer. Detect quota movement with no local spend and leave those spans out of the ratio.
- **Auto mode in a live session.** Covered by tests only so far: run it on a real plan, watch the handoffs and
  holds, and tune the thresholds (heavy at 60%, cold-and-large at 100k tokens, 15-minute pacing holds).

## Later
- **Overlay of past windows** in the charts.
- **Smarter warm mode.** Learn when you usually come back and keep the cache warm only when a return inside the
  TTL is likely.
- **Other terminals** for the window: detect iTerm, Ghostty and kitty; `x-terminal-emulator` on Linux.
- **Subagent models.** Let on pace mode move subagents to a lighter model when a model's week is over pace,
  rather than only asking Claude to.
