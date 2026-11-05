// What Antigravity needs of pace beyond the core's API (core/api.ts): a view beside it is bin/band.ts in a terminal
// window. Pure.

import type { PaceView } from '../../core/api.ts'

/** bin/band.ts's arguments for a view of the conversation's `feed`: the charts, the band, or the fleet */
export function bandArgs(view: PaceView, feed: string): string[] {
  if (view === 'fleet') return ['--fleet']
  return view === 'band' ? [feed] : ['--pane', feed]
}
