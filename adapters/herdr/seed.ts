// What a check-only build of the mod starts with, so `herdr-app check` draws it with data: a view, its size, the
// feeds and which of the view's steps to run (see `steps` in main.ts). scripts/herdr.ts writes the built copy for
// its load check; null here, in the mod.

import type { ActivityQuery, ActivityRow } from '../../core/activity.ts'
import type { PaceFeed } from '../../core/host.ts'
import type { HerdrView } from './open.ts'

/** A check's starting state: the view, its columns and rows, the feeds, the step to draw; activity's rows and question */
export type Seed = { view: HerdrView; cols: number; rows: number; feeds: readonly PaceFeed[]; step: number; activity?: ActivityRow[]; query?: ActivityQuery }

export const SEED: Seed | null = null
