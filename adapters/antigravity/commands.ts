// What Antigravity needs of pace beyond the core's API (core/api.ts): a view beside it is bin/band.ts in a terminal
// window. Pure.

import { liveOf, type PaceView } from '../../core/api.ts'

/** bin/band.ts's arguments for a view of the conversation's `feed`: the charts, the band, or the fleet (core/api.ts) */
export const bandArgs = (view: Exclude<PaceView, 'plan' | 'activity'>, feed: string): string[] => liveOf(view, feed).args
