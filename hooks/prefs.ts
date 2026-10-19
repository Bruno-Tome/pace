// Preferences by reach. What is drawn (the band, the status-line entry) and the onboarding are the person's, the
// same in every session. The modes a session runs in (warm mode, on pace mode, auto mode's run) are its own, kept
// under its id: `claude --resume` finds them again, and no other session ever acts on them. Pure; times in ms.

import type { PaceAuto, PaceGear, PacePrefs, PaceUltra, PaceWarmMode } from '../types'

const DAY = 24 * 60 * 60_000

/** The store key a session's own modes are kept under, by its id */
export const sessionKey = (id: string) => `session:${id}`
export const isSessionKey = (key: string) => key.startsWith('session:')

/** A session's own modes as stored, and when the session last changed them */
export type SessionPrefs = { at: number; warm?: PaceWarmMode; onPace?: boolean; auto?: PaceAuto | null }

/** How long a session's modes are kept after it last changed them */
const SESSION_KEEP = 30 * DAY

const WARM: readonly PaceWarmMode[] = ['off', 'ping', 'compact']

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v != null && !Array.isArray(v)

const PHASES: readonly PaceUltra['phase'][] = ['plan', 'work', 'fanout', 'integrate', 'review', 'verify']
const EFFORTS: readonly PaceGear['effort'][] = ['low', 'medium', 'high', 'xhigh', 'max']

const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every(x => typeof x === 'string')

/** A gear as stored, or null where it does not parse */
function gearOf(v: unknown): PaceGear | null {
  if (!isObject(v) || typeof v.model !== 'string' || !EFFORTS.includes(v.effort as PaceGear['effort'])) return null
  if (!isNumber(v.subagents) || typeof v.subagentModel !== 'string' || typeof v.fanout !== 'boolean') return null
  return { model: v.model, effort: v.effort as PaceGear['effort'], subagents: v.subagents, subagentModel: v.subagentModel, fanout: v.fanout }
}

/** An ultra pace run as stored, or null where it does not parse; a fan-out or a review owed that does not is left out */
function ultraOf(v: unknown): PaceUltra | null {
  if (!isObject(v) || typeof v.goal !== 'string' || (v.check !== null && typeof v.check !== 'string')) return null
  if (!PHASES.includes(v.phase as PaceUltra['phase'])) return null
  if (!isNumber(v.sinceReview) || !isNumber(v.quietReviews) || !isNumber(v.checkFails) || !isNumber(v.headroomStreak)) return null
  const m = v.models
  if (!isObject(m) || typeof m.floor !== 'string' || typeof m.ceiling !== 'string') return null
  const gear = gearOf(v.gear)
  if (!gear) return null
  const f = v.fanout
  const d = v.due
  return {
    goal: v.goal, check: v.check, phase: v.phase as PaceUltra['phase'],
    sinceReview: v.sinceReview, quietReviews: v.quietReviews, checkFails: v.checkFails,
    models: { floor: m.floor, ceiling: m.ceiling }, gear, headroomStreak: v.headroomStreak,
    ...(isObject(f) && isStrings(f.agentIds) && isStrings(f.steps)
      ? { fanout: { agentIds: f.agentIds, steps: f.steps, ...(isStrings(f.reported) ? { reported: f.reported } : {}) } }
      : {}),
    ...(isObject(d) && typeof d.reason === 'string' ? { due: { reason: d.reason, ...(typeof d.tail === 'string' ? { tail: d.tail } : {}) } } : {}),
  }
}

/** An auto mode run as stored, or null where it does not parse; an ultra pace part that does not is left out */
function autoOf(v: unknown): PaceAuto | null {
  if (!isObject(v) || typeof v.plan !== 'string' || typeof v.turns !== 'number' || typeof v.max !== 'number') return null
  const num = (k: string) => (typeof v[k] === 'number' ? { [k]: v[k] as number } : {})
  const ultra = ultraOf(v.ultra)
  return {
    plan: v.plan, turns: v.turns, max: v.max,
    ...num('heldUntil'), ...num('waitingUntil'), ...num('stalls'),
    ...(typeof v.why === 'string' ? { why: v.why } : {}),
    ...(v.paused === true ? { paused: true } : {}),
    ...(v.burst === true ? { burst: true } : {}),
    ...(ultra ? { ultra } : {}),
  }
}

/** The prefs every session shares, as stored: never a session's modes */
export const sharedOf = (p: PacePrefs): PacePrefs => ({ band: p.band, line: p.line, ...(p.onboarded ? { onboarded: true } : {}) })

/** A session's own modes, as stored at `at` */
export const sessionOf = (p: PacePrefs, at: number): SessionPrefs => ({ at, warm: p.warm ?? 'off', onPace: p.onPace ?? false, auto: p.auto ?? null })

/**
 * A session's prefs from what is stored: the shared ones, and its own modes. Modes in the shared copy, where an
 * older pace kept them, are left out: they were another session's. What does not parse falls back to the default.
 */
export function prefsFrom(shared: unknown, own: unknown): PacePrefs {
  const s = isObject(shared) ? shared : {}
  const o = isObject(own) ? own : {}
  return {
    band: typeof s.band === 'boolean' ? s.band : true,
    line: typeof s.line === 'boolean' ? s.line : true,
    ...(s.onboarded === true ? { onboarded: true } : {}),
    warm: WARM.includes(o.warm as PaceWarmMode) ? (o.warm as PaceWarmMode) : 'off',
    onPace: o.onPace === true,
    auto: autoOf(o.auto),
  }
}

/** Whether a session's stored modes are old enough to forget, or do not parse */
export const isStale = (v: unknown, now: number) => !isObject(v) || !isNumber(v.at) || v.at < now - SESSION_KEEP
