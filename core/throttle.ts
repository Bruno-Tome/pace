// Ultra pace's throttle: how much room the quotas leave, and the gear that spends it. Pure.
//
// Under pace is quota lost at the reset; over pace is quota run out before it. The throttle reads the same verdicts
// every other surface reads (each quota's status and rate level), never a second opinion.

import type { PaceGear, PaceGears, PaceQuota, PaceSnapshot } from '../types'
import { forModel } from './auto.ts'
import { CLAUDE_LADDER, gearOf, type Ladder } from './gears.ts'

/** How hard the quotas let ultra pace drive, from most room to none */
export type Headroom = 'push' | 'cruise' | 'ease' | 'hold'

const ORDER: readonly Headroom[] = ['push', 'cruise', 'ease', 'hold']

/** Spend this close to a quota's dollar budget leaves no room to push */
const NEAR_BUDGET = 0.8

/**
 * One quota's room; one that cannot be set against the clock cruises rather than pushes blind. A quota idle of
 * prompts may still be spending (subagents at work while the main thread waits): its dollars an hour against its
 * budget judge it then, where the shared spend prices them.
 */
function roomOf(q: PaceQuota): Headroom {
  if (q.rate.level === 'fast' || q.status === 'gassedOut') return 'hold'
  const { usdPerHour: spend, usdBudgetPerHour: budget } = q.rate
  if (q.rate.level === 'idle' && spend != null && budget != null && budget > 0) {
    if (spend > budget) return 'ease'
    if (spend >= budget * NEAR_BUDGET && q.status !== 'over') return 'cruise'
  }
  if (q.status === 'over' || q.rate.level === 'burst') return 'ease'
  if (q.status === 'onPace' || q.status == null || q.rate.level === 'brisk') return 'cruise'
  return 'push'
}

/** The room the tightest quota `model` draws on leaves; `cruise` with no quota to read */
export function headroomOf(snap: PaceSnapshot, model: string | undefined): Headroom {
  const rooms = forModel(snap, model).quotas.map(roomOf)
  if (!rooms.length) return 'cruise'
  return rooms.reduce((a, b) => (ORDER.indexOf(b) > ORDER.indexOf(a) ? b : a))
}

/** The user's bounds on the gear: the models it ranges over, and the model and effort they run at */
export type GearBounds = { floor: string; ceiling: string; model: string; effort: PaceGear['effort'] }

/** Decisions in a row a headroom with more room must hold before the gear climbs */
const CLIMB_AFTER = 2

/** The gears, lightest first */
const NOTCHES = ['ease', 'cruise', 'push'] as const
type Notch = (typeof NOTCHES)[number]

/** A notch on the ladder (core/gears.ts): Claude's unless the host offers its own */
const gearAt = (notch: Notch, b: GearBounds, ladder: Ladder = CLAUDE_LADDER): PaceGear => gearOf(notch, ladder, b)

/** The notch a gear sits at, by what never waits on the cache: its subagents and fan-out; `cruise` if none fits */
function notchOf(g: PaceGear, b: GearBounds, ladder: Ladder = CLAUDE_LADDER): number {
  if (!ladder.sub) {
    // A ladder with no subagents: told apart by model and thinking
    const i = NOTCHES.findIndex(n => { const at = gearAt(n, b, ladder); return at.model === g.model && at.effort === g.effort })
    return i < 0 ? 1 : i
  }
  const i = NOTCHES.findIndex(n => {
    const at = gearAt(n, b, ladder)
    return at.subagents === g.subagents && at.subagentModel === g.subagentModel && at.fanout === g.fanout
  })
  return i < 0 ? 1 : i
}

/**
 * The gear for the next turn, and the streak to carry. It drops at once to less room, but climbs one notch at a time
 * and only once more room has held for two decisions: flapping costs more than either gear. `cold`: whether the
 * cache has lapsed or a handoff starts a fresh context; the main model changes only then, since a new model starts
 * with a cold cache.
 */
export function gearFor(headroom: Headroom, bounds: GearBounds, current: { gear: PaceGear; streak: number; cold: boolean }, ladder: Ladder = CLAUDE_LADDER): { gear: PaceGear; streak: number } {
  if (headroom === 'hold') return { gear: current.gear, streak: 0 }
  const at = notchOf(current.gear, bounds, ladder)
  const want = NOTCHES.indexOf(headroom)
  const streak = want > at ? current.streak + 1 : 0
  const next = want <= at ? want : streak >= CLIMB_AFTER ? at + 1 : at
  const gear = gearAt(NOTCHES[next]!, bounds, ladder)
  return { gear: current.cold ? gear : { ...gear, model: current.gear.model }, streak: next > at ? 0 : streak }
}

/** The gear a run starts in: cruise, the user's model and effort, until the headroom says otherwise */
export const startingGear = (b: GearBounds, ladder: Ladder = CLAUDE_LADDER): PaceGear => gearAt('cruise', b, ladder)

/** The model families pace ranks, lightest first; a model of none of them is left as named */
const FAMILIES = ['haiku', 'sonnet', 'opus', 'fable'] as const
const familyOf = (model: string) => FAMILIES.find(f => model.toLowerCase().includes(f))
const rankOf = (model: string) => { const f = familyOf(model); return f ? FAMILIES.indexOf(f) : -1 }

/** A subagent's model: the gear's when the caller names none or a heavier one, the caller's when it is lighter */
export function subagentModelFor(g: PaceGear, asked: string | undefined): string {
  if (!asked) return g.subagentModel
  const rank = rankOf(asked)
  return rank > rankOf(g.subagentModel) ? g.subagentModel : asked
}

/** Whether one more subagent may start with `running` of them at work */
export const spawnAllowed = (g: PaceGear, running: number): boolean => running < g.subagents

/**
 * The model the main thread runs on: the gear's once the cache is cold, since a new model starts with a cold cache,
 * and the one it last switched to until then; null for the session's own
 */
export const mainModelFor = (g: PaceGear, current: string | null, cold: boolean): string | null => (cold ? g.model : current)

/** Whether the prompt cache is cold at `now`: no cache, or its time left as of the snapshot run out since */
export const coldAt = (s: PaceSnapshot, now: number): boolean => !s.cache || s.cache.secondsLeft * 1000 - (now - s.at) <= 0

/** The model a request names: `model` where it is another family than the request's own, so a version never becomes an alias */
export const requestModel = (model: string | null, requested: string): string =>
  model && familyOf(model) !== familyOf(requested) ? model : requested

/** The gear's notch by name, from what never waits on the cache: its subagents and fan-out */
export const notchName = (g: PaceGear): 'push' | 'cruise' | 'ease' =>
  NOTCHES[notchOf(g, { floor: '', ceiling: '', model: '', effort: 'high' })]!

/** A gear in a few words: `push · opus xhigh · 3 agents` */
export function gearText(g: PaceGear): string {
  const model = familyOf(g.model) ?? g.model
  return `${notchName(g)} · ${model} ${g.effort} · ${g.subagents} agent${g.subagents === 1 ? '' : 's'}`
}

/** The rung of `ladder` a name the user gave stands for: the first model holding it; `fallback` for none */
const rungOf = (ladder: Ladder, name: string | undefined, fallback: string) => (name && ladder.models.find(m => m.toLowerCase().includes(name.toLowerCase()))) || fallback

/**
 * Gears for a run on a host other than Claude Code (pi, an ACP agent): cruising on the user's model and thinking,
 * ranging from `floor` (the ladder's second rung by default, as Claude's floor is sonnet) to `ceiling` (its top)
 */
export function startGears(ladder: Ladder, model: string, effort: string, floor?: string, ceiling?: string): PaceGears {
  const ms = ladder.models.length ? ladder.models : [model]
  const bounds = { floor: rungOf(ladder, floor, ms[Math.min(1, ms.length - 1)]!), ceiling: rungOf(ladder, ceiling, ms[ms.length - 1]!), model, effort }
  return { ...bounds, gear: gearAt('cruise', bounds, ladder), streak: 0 }
}

/**
 * The next turn's gears, and what the host has to set for them: the model only once the cache is cold (a new model
 * starts with a cold cache), the thinking level at once
 */
export function shiftGears(g: PaceGears, headroom: Headroom, ladder: Ladder, cold: boolean): { gears: PaceGears; set: { model?: string; effort?: string } } {
  const { gear, streak } = gearFor(headroom, g, { gear: g.gear, streak: g.streak, cold }, ladder)
  return {
    gears: { ...g, gear, streak },
    set: { ...(gear.model !== g.gear.model ? { model: gear.model } : {}), ...(gear.effort !== g.gear.effort ? { effort: gear.effort } : {}) },
  }
}
