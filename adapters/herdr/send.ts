// Send work, the fleet's dispatch: in a popup over the fleet, or in a pane of its own that stays open, ready for the
// next task. Pure; adapters/herdr/fleet/main.ts draws it and runs what these return.

import type { PaceProvider } from '../../core/host.ts'

/** The hosts Send work can start */
export type SendHost = Extract<PaceProvider, 'claude' | 'codex'>

/** Where a copy of Send work is: a popup (Herdr gives it `props().overlay`) or a pane */
export type SendWhere = 'overlay' | 'pane'

/** What the form offers: the host picked first, and the folders to pick from */
export type SendForm = { where: SendWhere; recommended: SendHost; folders: string[] }

/** The fleet as the form reads it: the provider recommended, and the folders its agents work in */
type FleetNow = { recommended: { provider: PaceProvider } | null; agents: readonly { cwd: string | null }[] }

/** The shared state's key for the Send work panes open, `{ [pane]: 'send' }` */
export const SEND_PANES_KEY = 'fleet.panes'

const hostOf = (v: unknown): SendHost => (v === 'codex' ? 'codex' : 'claude')

/**
 * The form a copy shows. A popup keeps what it was opened with; a pane follows the fleet live: the host recommended
 * now (one Send work cannot start falls back to Claude), the folders the agents work in now, else home
 */
export function sendForm(props: unknown, fleet: FleetNow, home: string): SendForm {
  const p = (typeof props === 'object' && props != null ? props : {}) as Record<string, unknown>
  if (p.overlay) {
    const folders = Array.isArray(p.folders) ? p.folders.filter((f): f is string => typeof f === 'string') : []
    return { where: 'overlay', recommended: hostOf(p.host), folders: folders.length ? folders : [home] }
  }
  const folders = [...new Set(fleet.agents.map(a => a.cwd).filter((f): f is string => !!f))]
  return { where: 'pane', recommended: hostOf(fleet.recommended?.provider), folders: folders.length ? folders : [home] }
}

/** Once an agent is started: the popup closes, the pane clears for the next task */
export const afterStart = (where: SendWhere): 'close' | 'clear' => (where === 'overlay' ? 'close' : 'clear')

/** The Herdr command that shows Send work as a pane: the one recorded and still open focused, else a new one */
export function openSendPane(registry: unknown, panes: readonly string[]): [string, Record<string, unknown>] {
  const known = typeof registry === 'object' && registry != null ? (registry as Record<string, unknown>) : {}
  const open = Object.keys(known).find(p => known[p] === 'send' && panes.includes(p))
  return open ? ['pane.focus', { pane: open }] : ['pane.split', { direction: 'right', mod: 'fleet', props: { view: 'send' } }]
}
