// Opening pace in Herdr from a host's /pace: the herdr-app commands that put a view of the pace mod beside the
// terminal the session runs in. Pure; the hosts run the commands.

import type { PaceProvider } from '../../core/host.ts'

/** A view of the pace mod, as the props of its pane: a harness's charts, one agent's band, or the fleet panel */
/** A pace pane in Herdr: a quota's charts (its provider, and its account when known), an agent's band, the fleet */
export type HerdrView = { view: 'pane'; provider: PaceProvider; account?: string } | { view: 'band'; terminal: string } | { view: 'panel' }

/**
 * What /pace opens in Herdr, by its argument: the harness's charts for `/pace`, `split`, `pane` and `window`, the band
 * for `band`, the fleet for `fleet`; null for what is not a view. In Herdr every view goes through it first
 * (.agents/decisions/0001-herdr-first.md)
 */
export function paceViewOf(arg: string, provider: PaceProvider, terminal: string, account?: string): HerdrView | null {
  if (arg === '' || arg === 'split' || arg === 'pane' || arg === 'window') return { view: 'pane', provider, ...(account ? { account } : {}) }
  if (arg === 'band') return { view: 'band', terminal }
  if (arg === 'fleet') return { view: 'panel' }
  return null
}

/**
 * The commands that open `view` beside `terminal`: focus its pane, then split it, a band under its agent and the
 * rest to the right. `pane.split` takes a pane, not a terminal; focusing the terminal first makes its pane the one.
 */
export function herdrOpen(terminal: string, view: HerdrView): string[][] {
  return [
    ['herdr-app', 'do', 'pane.focus', JSON.stringify({ terminal })],
    ['herdr-app', 'do', 'pane.split', JSON.stringify({ direction: view.view === 'band' ? 'down' : 'right', mod: 'pace', props: view })],
  ]
}

// ----------------------------------------------------------------------
// Panes already open: each pace pane records its view under its pane in Herdr's shared state, `pace.panes`, so a
// /pace for the same view focuses it rather than open another. Herdr does not tell a mod which pane it is in, so a
// new copy claims the one pace pane not yet recorded.
// ----------------------------------------------------------------------

/** The shared state's key for the pace panes open, `{ [pane]: viewKey }` */
export const PANES_KEY = 'pace.panes'

/** A view's key in the registry: `pane:claude`, `band:t8`, `panel` */
export function viewKey(view: HerdrView): string {
  if (view.view === 'pane') return `pane:${view.provider}${view.account ? `:${view.account}` : ''}`
  if (view.view === 'band') return `band:${view.terminal}`
  return 'panel'
}

/** The registry as stored, what of it parses */
function registryOf(v: unknown): Record<string, string> {
  if (typeof v !== 'object' || v == null || Array.isArray(v)) return {}
  return Object.fromEntries(Object.entries(v).filter((e): e is [string, string] => typeof e[1] === 'string'))
}

/** The command that focuses the pane already showing `view`; null when none is recorded */
export function herdrReuse(registry: unknown, view: HerdrView): string[] | null {
  const key = viewKey(view)
  const pane = Object.entries(registryOf(registry)).find(([, k]) => k === key)?.[0]
  return pane ? ['herdr-app', 'do', 'pane.focus', JSON.stringify({ pane })] : null
}

/**
 * The registry once a new copy claims its pane: the one of `panes` (every pace pane open) not yet recorded, the
 * panes gone forgotten. Null when it cannot tell which pane is its own: none unrecorded, or more than one.
 */
export function claimOf(registry: unknown, panes: readonly string[], key: string): Record<string, string> | null {
  const known = registryOf(registry)
  const unclaimed = panes.filter(p => !(p in known))
  if (unclaimed.length !== 1) return null
  const kept = Object.fromEntries(Object.entries(known).filter(([p]) => panes.includes(p)))
  return { ...kept, [unclaimed[0]!]: key }
}

/** Herdr's shared state on disk, under its home (`HERDR_APP_HOME`, else ~/.config/herdr-app) */
export const sharedFile = (appHome: string) => `${appHome}/shared.json`

/** The pace panes recorded in the shared state's text; empty when it does not parse */
export function registryIn(sharedText: string): Record<string, string> {
  try {
    return registryOf((JSON.parse(sharedText) as Record<string, unknown> | null)?.[PANES_KEY])
  } catch {
    return {}
  }
}

/** What an opener answers when the view was already open and is focused */
export const ALREADY_OPEN = 'Pace is already open in Herdr'
