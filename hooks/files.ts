// The files pace writes, relative to the home directory: the shell writes them, the viewer reads two of them.

/** The status-line row, in ANSI, for a status-line command to print */
export const ROW_FILE = '.claude/pace-row.txt'
/** The window's feed for one session: the samples, prompts, cache and plans the viewer draws */
export const stateFile = (session: string) => `.claude/pace-state-${session}.json`
/** The window's launcher script for one session */
export const viewFile = (session: string) => `.claude/pace-view-${session}.command`
/** The window's keys for one session, `{ id, cmd }`: the viewer writes it, the mod polls it while feeding */
export const keysFile = (session: string) => `.claude/pace-keys-${session}.json`
/** The plan sidebar's feed for one session, a `PlanFeed`: the mod writes it, bin/plan-viewer.ts reads it */
export const planFeedFile = (session: string) => `.claude/pace-plan-${session}.json`
