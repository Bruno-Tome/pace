// `/pace` and its arguments, read once for every host: what is asked, with its defaults, or why it cannot be read.
// Each host carries the command out its own way, or says it cannot. Pure.

import type { PaceWarmMode } from '../types'

/** The plan auto mode and ultra pace work through when none is named */
export const DEFAULT_PLAN = 'ROADMAP.md'
/** Turns an auto run takes before it stops to ask, and an ultra run */
export const AUTO_TURNS = 40
export const ULTRA_TURNS = 80

export const USAGE = 'split | pane | window | band | fleet | activity | refresh | timeline | close | on | off | auto [plan] [turns] | auto off | auto resume | auto burst [off] | ultra [plan] [turns] [floor..ceiling] | ultra off | ultra resume | ultra preview | plan [file] [file] | hide | show | line on | line off | warm compact | warm ping | warm off'

/** Where a view opens: '' for the host's own choice */
export type ViewWhere = '' | 'split' | 'pane' | 'window' | 'band' | 'fleet' | 'activity'

/** What `/pace` asks for */
export type PaceCommand =
  | { kind: 'view'; where: ViewWhere }
  | { kind: 'refresh' | 'timeline' | 'close' | 'resume' | 'preview' }
  | { kind: 'onPace'; on: boolean }
  | { kind: 'band'; show: boolean }
  | { kind: 'line'; on: boolean }
  | { kind: 'warm'; mode: PaceWarmMode }
  | { kind: 'plan'; files: string[] }
  | { kind: 'auto'; plan: string; max: number }
  | { kind: 'ultra'; plan: string; max: number; floor?: string; ceiling?: string }
  | { kind: 'stop'; ultra: boolean }
  | { kind: 'burst'; on: boolean }
  | { kind: 'error'; text: string }

const VIEWS: readonly ViewWhere[] = ['', 'split', 'pane', 'window', 'band', 'fleet', 'activity']
const WARM: readonly PaceWarmMode[] = ['off', 'ping', 'compact']

/** The most turns a run may be given: a count past it is not one a person means, and Infinity would never stop */
export const MAX_TURNS = 10_000

const turns = (n: string | undefined, fallback: number) => (n ? Math.max(1, Number(n)) : fallback)
const tooMany = (n: string | undefined) => n != null && !(Number(n) <= MAX_TURNS)
const TOO_MANY = `A run takes at most ${MAX_TURNS} turns`

function autoOf(rest: string): PaceCommand {
  const arg = rest.toLowerCase()
  if (arg === 'off') return { kind: 'stop', ultra: false }
  if (arg === 'resume') return { kind: 'resume' }
  if (/^burst( on| off)?$/.test(arg)) return { kind: 'burst', on: !arg.endsWith('off') }
  const m = /^(\S+)(?:\s+(\d+))?$/.exec(rest || DEFAULT_PLAN)
  if (!m) return { kind: 'error', text: 'Use /pace auto [plan file] [turns], /pace auto off or /pace auto resume' }
  if (tooMany(m[2])) return { kind: 'error', text: TOO_MANY }
  return { kind: 'auto', plan: m[1]!, max: turns(m[2], AUTO_TURNS) }
}

function ultraOf(rest: string): PaceCommand {
  const arg = rest.toLowerCase()
  if (arg === 'off') return { kind: 'stop', ultra: true }
  if (arg === 'resume') return { kind: 'resume' }
  if (arg === 'preview') return { kind: 'preview' }
  const m = /^(\S+)?(?:\s+(\d+))?(?:\s+([\w.-]+)\.\.([\w.-]+))?$/.exec(rest)
  if (!m) return { kind: 'error', text: 'Use /pace ultra [plan file] [turns] [floor..ceiling], /pace ultra off or /pace ultra resume' }
  if (tooMany(m[2])) return { kind: 'error', text: TOO_MANY }
  return { kind: 'ultra', plan: m[1] ?? DEFAULT_PLAN, max: turns(m[2], ULTRA_TURNS), ...(m[3] ? { floor: m[3], ceiling: m[4]! } : {}) }
}

/** What `/pace <args>` asks for; an error that says what it takes when it cannot be read */
export function commandOf(args: string): PaceCommand {
  const raw = args.trim().replace(/\s+/g, ' ')
  const arg = raw.toLowerCase()
  if (VIEWS.includes(arg as ViewWhere)) return { kind: 'view', where: arg as ViewWhere }
  if (arg === 'refresh' || arg === 'timeline' || arg === 'close') return { kind: arg }
  if (arg === 'on' || arg === 'off') return { kind: 'onPace', on: arg === 'on' }
  if (arg === 'show' || arg === 'hide') return { kind: 'band', show: arg === 'show' }
  if (arg === 'line on' || arg === 'line off') return { kind: 'line', on: arg === 'line on' }
  if (arg.startsWith('warm ')) {
    const mode = arg.slice(5) as PaceWarmMode
    return WARM.includes(mode) ? { kind: 'warm', mode } : { kind: 'error', text: 'Use /pace warm compact, ping or off' }
  }
  if (arg === 'plan' || arg.startsWith('plan ')) return { kind: 'plan', files: raw.split(' ').slice(1, 3) }
  if (arg === 'auto' || arg.startsWith('auto ')) return autoOf(raw.slice(4).trim())
  if (arg === 'ultra' || arg.startsWith('ultra ')) return ultraOf(raw.slice(5).trim())
  return { kind: 'error', text: `Unknown argument "${arg}": use ${USAGE}` }
}

/** The arguments of a prompt that is `/pace` or `$pace` (a skill by name), alone or with any; null for any other prompt */
export function paceArgsOf(prompt: string): string | null {
  const m = /^[/$]pace(?:\s+([\s\S]*))?$/.exec(prompt.trim())
  return m ? (m[1] ?? '').trim().replace(/\s+/g, ' ') : null
}
