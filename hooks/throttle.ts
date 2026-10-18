// Ultra pace's throttle: how much room the quotas leave, and the gear that spends it. Pure.
//
// Under pace is quota lost at the reset; over pace is quota run out before it. The throttle reads the same verdicts
// every other surface reads (each quota's status and rate level), never a second opinion.

import type { PaceGear, PaceQuota, PaceSnapshot } from '../types'
import { forModel } from './auto.ts'

/** How hard the quotas let ultra pace drive, from most room to none */
export type Headroom = 'push' | 'cruise' | 'ease' | 'hold'

const ORDER: readonly Headroom[] = ['push', 'cruise', 'ease', 'hold']

/** One quota's room; one that cannot be set against the clock cruises rather than pushes blind */
function roomOf(q: PaceQuota): Headroom {
  if (q.rate.level === 'fast' || q.status === 'gassedOut') return 'hold'
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

const EFFORTS: readonly PaceGear['effort'][] = ['low', 'medium', 'high', 'xhigh', 'max']
const lighter = (e: PaceGear['effort']) => EFFORTS[Math.max(0, EFFORTS.indexOf(e) - 1)]!

/** The gears, lightest first */
const NOTCHES = ['ease', 'cruise', 'push'] as const
type Notch = (typeof NOTCHES)[number]

function gearAt(notch: Notch, b: GearBounds): PaceGear {
  if (notch === 'push') return { model: b.ceiling, effort: 'xhigh', subagents: 3, subagentModel: 'sonnet', fanout: true }
  if (notch === 'cruise') return { model: b.model, effort: b.effort, subagents: 2, subagentModel: 'sonnet', fanout: false }
  return { model: b.floor, effort: lighter(b.effort), subagents: 1, subagentModel: 'haiku', fanout: false }
}

/** The notch a gear sits at, by what never waits on the cache: its subagents and fan-out; `cruise` if none fits */
function notchOf(g: PaceGear, b: GearBounds): number {
  const i = NOTCHES.findIndex(n => {
    const at = gearAt(n, b)
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
export function gearFor(headroom: Headroom, bounds: GearBounds, current: { gear: PaceGear; streak: number; cold: boolean }): { gear: PaceGear; streak: number } {
  if (headroom === 'hold') return { gear: current.gear, streak: 0 }
  const at = notchOf(current.gear, bounds)
  const want = NOTCHES.indexOf(headroom)
  const streak = want > at ? current.streak + 1 : 0
  const next = want <= at ? want : streak >= CLIMB_AFTER ? at + 1 : at
  const gear = gearAt(NOTCHES[next]!, bounds)
  return { gear: current.cold ? gear : { ...gear, model: current.gear.model }, streak: next > at ? 0 : streak }
}

/** The gear a run starts in: cruise, the user's model and effort, until the headroom says otherwise */
export const startingGear = (b: GearBounds): PaceGear => gearAt('cruise', b)
