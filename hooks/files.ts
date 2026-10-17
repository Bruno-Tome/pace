// The files pace writes, relative to the home directory: the shell writes them, the viewer reads two of them.

/** The status-line row, in ANSI, for a status-line command to print */
export const ROW_FILE = '.claude/pace-row.txt'
/** The window's feed: the samples, prompts and cache the viewer draws */
export const STATE_FILE = '.claude/pace-state.json'
/** The window's launcher script */
export const VIEW_FILE = '.claude/pace-view.command'
/** The window's keys for the session, `{ id, cmd }`: the viewer writes it, the mod polls it while feeding */
export const KEYS_FILE = '.claude/pace-keys.json'
