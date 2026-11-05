// pace's one surface for the hosts it runs under (.agents/decisions/0018-core-api-acp-ports.md and
// 0022-surfaces-not-harnesses.md). A host declares what it can show and what it can do to its agent; the core decides
// what each `/pace` command and each of auto mode's decisions comes to there, and the host only carries it out. No
// rule here names a harness: the answers name the host by the name it gives. Pure; times in ms.

import type { PaceCacheInfo, PaceSnapshot, PaceWarmMode } from '../types'
import { warmModeFor, type Decision } from './auto.ts'
import { warmAction } from './cache.ts'
import { DEFAULT_PLAN, type PaceCommand, type ViewWhere } from './command.ts'
import { clockAt } from './quota.ts'
import { agentOf, fleetOf, type PaceFeed } from './host.ts'
import { stepsOf } from './plan.ts'
import { agentLine, bandLines, fleetLines, paneLayout, paneLines, planLines, type Line } from './view.ts'

/** The version of this surface; it only grows */
export const PACE_API = 1

/**
 * Where pace can show something for a host:
 * - `herdr` a Herdr pane beside the session (only while it runs in Herdr)
 * - `split` a terminal split beside it (tmux), `window` a terminal window of its own
 * - `pane` a pane inside the harness, `overlay` lines over its TUI
 * - `band` lines above its input, `status` a line in its footer, `toast` a short notice
 * - `answer` text the user reads in place of a reply (a blocked prompt's reason)
 */
export type Surface = 'herdr' | 'split' | 'window' | 'pane' | 'overlay' | 'band' | 'status' | 'toast' | 'answer'

/** What pace can do to a host's agent: send a prompt, compact or clear its context, lower its effort, change its model, ping its cache */
export type Drive = 'prompt' | 'compact' | 'clear' | 'effort' | 'model' | 'ping'

/** A host as it declares itself */
export type Host = {
  /** Its name, as the answers say it */
  name: string
  /** What its input is called, where the band sits above it: `prompt`, `editor` */
  input: string
  /** The surfaces it has, in the order it prefers them; `herdr` and `split` only where they are */
  surfaces: readonly Surface[]
  drives: readonly Drive[]
  /** Whether it reports its prompt cache */
  cache: boolean
  /** How long, in ms, it can wait out a hold in place; absent for as long as needed */
  holdUpTo?: number
  /** The preferences it keeps and carries out; absent for all of them */
  keeps?: readonly (keyof HostPrefs)[]
}

/** A view pace draws: the charts, the band, the fleet, the plan's timeline */
export type PaceView = 'pane' | 'band' | 'fleet' | 'plan'

/** A host's preferences for pace, by surface and mode */
export type HostPrefs = { band: boolean; line: boolean; onPace: boolean; warm: PaceWarmMode }
export const HOST_PREFS: HostPrefs = { band: true, line: true, onPace: false, warm: 'off' }

/** What a host does for a command; every `text` and `note` is said to the user, never to the model */
export type PaceAction =
  /** Show `view` on `surface`; `fallback` when it fails there (Herdr first) */
  | { kind: 'open'; view: PaceView; surface: Surface; files?: string[]; note?: string; fallback?: PaceAction }
  | { kind: 'prefs'; prefs: Partial<HostPrefs>; text: string }
  | { kind: 'refresh'; text: string }
  | { kind: 'say'; text: string }
  /** Close pace's own pane */
  | { kind: 'close' }
  | { kind: 'auto'; plan: string; max: number }
  | { kind: 'ultra'; plan: string; max: number; floor?: string; ceiling?: string }
  | { kind: 'preview' }
  | { kind: 'resume' }
  | { kind: 'stop'; ultra: boolean; text: string }
  | { kind: 'burst'; on: boolean }

const has = (h: Host, s: Surface) => h.surfaces.includes(s)
const can = (h: Host, d: Drive) => h.drives.includes(d)

/** The first of `wanted` the host has, in the host's order or, with `ours`, in `wanted`'s */
function pick(h: Host, wanted: readonly Surface[], ours = false): Surface | null {
  if (ours) return wanted.find(s => has(h, s)) ?? null
  return h.surfaces.find(s => wanted.includes(s)) ?? null
}

/** Surfaces that show a view's lines */
const SHOWS: readonly Surface[] = ['split', 'pane', 'overlay', 'answer', 'window']

function open(view: PaceView, surface: Surface | null, h: Host, extra: { files?: string[]; note?: string } = {}): PaceAction {
  if (!surface) return { kind: 'say', text: `${h.name} has nowhere pace can show this` }
  return { kind: 'open', view, surface, ...extra }
}

/** A view outside Herdr: on the surface the command asks for, else the host's own choice, saying why */
function outside(w: ViewWhere, h: Host): PaceAction {
  switch (w) {
    case '': return open('pane', pick(h, SHOWS), h)
    case 'split':
      return has(h, 'split') ? open('pane', 'split', h) : open('pane', pick(h, SHOWS), h, { note: 'Not inside tmux; the charts open here' })
    case 'pane': return open('pane', pick(h, ['pane', 'overlay', 'answer', 'split', 'window'], true), h)
    case 'window':
      return has(h, 'window') ? open('pane', 'window', h) : open('pane', pick(h, SHOWS), h, { note: `${h.name} has no window of its own; the charts open here` })
    case 'band':
      if (has(h, 'band')) return { kind: 'say', text: `The band is above the ${h.input}; /pace hide hides it, and in Herdr /pace band opens it under the session` }
      return open('band', pick(h, ['split', 'window', 'overlay', 'answer']), h)
    case 'fleet': return open('fleet', pick(h, ['pane', 'overlay', 'split', 'answer', 'window'], true), h)
  }
}

/** A view: in Herdr first, the host's own its fallback; outside Herdr, the band is in place where the host has one */
function viewAt(w: ViewWhere, h: Host): PaceAction {
  const own = outside(w, h)
  if (!has(h, 'herdr')) return own
  const view: PaceView = w === 'band' || w === 'fleet' ? w : 'pane'
  return { kind: 'open', view, surface: 'herdr', fallback: own }
}

const WARM_TEXT = (how: string) => `with under 10 minutes of cache left and the agent idle, ${how} (once until your next prompt)`

/** What a host does for `/pace <command>` */
export function route(c: PaceCommand, h: Host): PaceAction {
  switch (c.kind) {
    case 'view': return viewAt(c.where, h)
    case 'plan': case 'timeline':
      return open('plan', pick(h, ['split', 'pane', 'overlay', 'answer', 'window'], true), h, { files: c.kind === 'plan' ? c.files : [] })
    case 'band':
      if (!has(h, 'band')) return { kind: 'say', text: `${h.name} has no band of its own: /pace band opens one beside it` }
      return { kind: 'prefs', prefs: { band: c.show }, text: c.show ? 'Pace band shown' : 'Pace band hidden; /pace show brings it back' }
    case 'line':
      if (!has(h, 'status')) return { kind: 'say', text: `${h.name} has no status line pace can write to` }
      return { kind: 'prefs', prefs: { line: c.on }, text: `Pace status line ${c.on ? 'on' : 'off'}` }
    case 'onPace':
      if (h.keeps && !h.keeps.includes('onPace')) return { kind: 'say', text: `On pace mode is not in ${h.name} yet: pace keeps no modes there` }
      if (!can(h, 'compact') && !can(h, 'effort')) return { kind: 'say', text: `On pace mode is not in ${h.name}: pace cannot lower its effort or compact it. pace still warns before a quota gasses out` }
      return { kind: 'prefs', prefs: { onPace: c.on }, text: c.on ? 'On pace mode on: compacts a heavy context while its cache is warm, keeps a large idle cache warm, and lowers the effort while the rate would gas a quota out' : 'On pace mode off' }
    case 'warm':
      if (!h.cache) return { kind: 'say', text: `Warm mode is not in ${h.name}: it reports no prompt cache` }
      if (!can(h, 'ping') && !can(h, 'compact')) return { kind: 'say', text: `Warm mode is not in ${h.name}: pace cannot ping its cache or compact it` }
      if (c.mode === 'ping' && !can(h, 'ping')) return { kind: 'say', text: `${h.name} cannot ping its cache: /pace warm compact keeps it warm by compacting` }
      if (c.mode === 'compact' && !can(h, 'compact')) return { kind: 'say', text: `${h.name} cannot compact for pace: /pace warm ping keeps its cache warm` }
      return { kind: 'prefs', prefs: { warm: c.mode }, text: c.mode === 'off' ? 'Warm mode off' : `Warm mode ${c.mode}: ${WARM_TEXT(c.mode === 'ping' ? 'sends one word to keep it warm' : 'compacts')}` }
    case 'refresh': return { kind: 'refresh', text: 'Pace figures refreshed' }
    case 'close': return has(h, 'pane') ? { kind: 'close' } : { kind: 'say', text: 'Close the pace split with q there' }
    case 'error': return { kind: 'say', text: c.text }
    case 'ultra': return canGear(h) ? { kind: 'ultra', plan: c.plan, max: c.max, ...(c.floor && c.ceiling ? { floor: c.floor, ceiling: c.ceiling } : {}) } : noUltra(h)
    case 'preview': return can(h, 'model') && can(h, 'clear') ? { kind: 'preview' } : noUltra(h)
    case 'stop':
      if (c.ultra && !canGear(h)) return noUltra(h)
      if (!can(h, 'prompt')) return noAuto(h)
      return { kind: 'stop', ultra: c.ultra, text: c.ultra ? 'Ultra pace off' : 'Auto mode off' }
    case 'auto': return can(h, 'prompt') ? { kind: 'auto', plan: c.plan, max: c.max } : noAuto(h)
    case 'resume': return can(h, 'prompt') ? { kind: 'resume' } : noAuto(h)
    case 'burst': return can(h, 'prompt') ? { kind: 'burst', on: c.on } : noAuto(h)
  }
}

/** Ultra pace's gears need a host that can change the model or the thinking level (.agents/decisions/0021) */
const canGear = (h: Host) => can(h, 'model') || can(h, 'effort')
const noUltra = (h: Host): PaceAction => ({ kind: 'say', text: `Ultra pace is not in ${h.name}: it changes the model and the effort turn by turn, and pace cannot change them there` })
const noAuto = (h: Host): PaceAction => ({ kind: 'say', text: `Auto mode is not in ${h.name}: pace cannot send it a prompt` })

/** What a host does with auto mode's decision after a turn */
export type PaceStep =
  /** Send the next prompt; clear or compact the context first for a handoff */
  | { kind: 'send'; prompt: string; clear?: true; compact?: true }
  /** Look again at `until`, saying why */
  | { kind: 'hold'; until: number; note: string }
  /** Off until `/pace auto resume`; held until `heldUntil` when a hold the host cannot wait out paused it */
  | { kind: 'pause'; message: string; heldUntil?: number }
  | { kind: 'stop'; message: string }

/** What a host does with auto mode's decision (core/auto.ts): a handoff clears where it can, else compacts */
export function stepOf(d: Decision, h: Host, now: number): PaceStep {
  const at = (t: number) => clockAt(t, t - now >= 86400_000)
  switch (d.kind) {
    case 'continue': return { kind: 'send', prompt: d.prompt }
    case 'handoff':
      return { kind: 'send', prompt: d.prompt, ...(can(h, 'clear') ? { clear: true as const } : can(h, 'compact') ? { compact: true as const } : {}) }
    case 'hold': case 'wait': {
      const note = d.kind === 'hold' ? `Auto mode holding until ${at(d.until)}. ${d.why}` : `Auto mode sends nothing until ${at(d.until)} or a turn of its own. ${d.why}`
      if (h.holdUpTo == null || d.until - now <= h.holdUpTo) return { kind: 'hold', until: d.until, note }
      return { kind: 'pause', heldUntil: d.until, message: `${note}. ${h.name} cannot wait that long: /pace auto resume picks it up then` }
    }
    case 'pause': return { kind: 'pause', message: `Auto mode paused. ${d.why}` }
    case 'stop': return { kind: 'stop', message: `Auto mode off. ${d.why}` }
  }
}

/** What keeping a cache warm needs: the preferences, the snapshot, the cache, and what warm mode did since the last prompt */
export type WarmStepInput = {
  prefs: Pick<HostPrefs, 'onPace' | 'warm'>
  snap: PaceSnapshot
  cache: PaceCacheInfo | null
  now: number
  /** A turn is running */
  working: boolean
  /** Warm-mode actions since the user's last prompt */
  actions: number
  /** The cache's `at` warm mode last acted for; null for none */
  lastFor: number | null
}

/**
 * What keeps the host's cache warm now: warm mode's decision (core/cache.ts) on the mode in force (core/auto.ts), as
 * far as the host can carry it out; null for nothing
 */
export function warmStep(i: WarmStepInput, h: Host): 'ping' | 'compact' | null {
  const mode = warmModeFor(i.prefs, i.snap)
  if (mode === 'off' || !can(h, mode)) return null
  return warmAction({ mode, cache: i.cache, now: i.now, working: i.working, actions: i.actions, lastFor: i.lastFor })
}

/** What a view is drawn from: the session's feed, the other live feeds, the plans shown with their text, the width */
export type ViewInput = { feed: PaceFeed; others: readonly PaceFeed[]; plans: readonly { plan: string; text: string }[]; now: number; cols: number }

/** A view's lines, for any surface: a host renders them as it can (core/view.ts's segments) */
export function viewLines(view: PaceView, i: ViewInput): Line[] {
  const { feed, now, cols } = i
  if (view === 'fleet') return fleetLines(fleetOf([feed, ...i.others], now), now, cols)
  if (view === 'band') return [agentLine(agentOf(feed), now), ...bandLines(feed.snapshot, now, cols)]
  if (view === 'plan') {
    return i.plans.flatMap(({ plan, text }, n) => [
      ...(n ? [[] as Line] : []),
      ...planLines(stepsOf(text, false), { plan, auto: feed.snapshot.auto?.plan === plan ? feed.snapshot.auto : null, cols, now }),
    ])
  }
  return [agentLine(agentOf(feed), now), ...paneLines(feed.snapshot, now, paneLayout(cols))]
}

/** Lines as plain text, for a surface that shows text as it is (an answer) */
export const plainText = (lines: readonly Line[]) => lines.map(l => l.map(x => x.t).join('').trimEnd()).join('\n')

/** The plans a timeline shows: those named, else auto mode's, else the roadmap */
export const plansFor = (feed: PaceFeed, files: readonly string[]): string[] => (files.length ? [...files] : [feed.snapshot.auto?.plan ?? DEFAULT_PLAN])
