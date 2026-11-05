// What a check-only build of the fleet starts with, so `herdr-app check` works the model out on feeds the size real
// use makes: scripts/herdr.ts writes the built copy for its load check; null here, in the mod.

import type { PaceFeed } from '../../../core/host.ts'

export const SEED: { pace: readonly PaceFeed[] } | null = null
