# pacebar roadmap

## Next
- **Open-source release.** See `OPEN_SOURCE_PLAN.md`.
- **Spend from sessions without pacebar.** Usage from claude.ai or another machine moves quotas with no spend
  recorded, which makes a dollar look dearer. Could detect quota movement with no local spend and leave those
  spans out of the ratio.

## Later
- **Overlay of past windows** in the charts (weektoken's history view): `pace.ts` already builds overlays.
- **Notifications.** A native notification when a quota turns too fast or the cache is about to lapse while
  the terminal is in the background (`$.ui.notify`).
- **Smarter warm mode.** Learn when you usually come back (prompt gaps) and only keep the cache warm when a
  return inside the TTL is likely; skip it at the end of the day.
- **Other terminals.** Detect iTerm/Ghostty/kitty and open there by default; on Linux, `x-terminal-emulator`.

## Housekeeping
Folded into `OPEN_SOURCE_PLAN.md` § 3.
