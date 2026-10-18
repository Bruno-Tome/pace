import { describe, expect, test } from 'claude-code/testing'

import type { PaceGear, PaceQuota, PaceSnapshot } from '../types'
import { coldAt, gearFor, headroomOf, mainModelFor, requestModel, spawnAllowed, subagentModelFor, type GearBounds } from '../hooks/throttle.ts'

const NOW = Date.UTC(2026, 9, 17, 12, 0, 0)
const H = 3600_000

const quota = (over: Partial<PaceQuota> = {}, rate: Partial<PaceQuota['rate']> = {}): PaceQuota => ({
  key: 'five_hour', name: '5-hour window', percent: 40, status: 'onPace', resetsAt: NOW + 2 * H, runOutAt: null,
  rate: { level: 'ok', promptsPerHour: 6, usdPerHour: 10, usdBudgetPerHour: 30, percentPerHour: 10, percentBudgetPerHour: 30, percentAtReset: null, costPerPrompt: 1, emptyIn: null, ...rate },
  ...over,
})

const snap = (quotas: PaceQuota[]): PaceSnapshot => ({
  at: NOW, quotas, cache: null, spend: { usdPerHour: 10, sessions: 1, usdPerPrompt: 1 },
  gassedOut: false, advice: [], modes: { onPace: false, auto: null },
})

test('a quota under pace at a steady rate leaves room to push', () => {
  expect(headroomOf(snap([quota({ status: 'under' })]), undefined)).toBe('push')
  expect(headroomOf(snap([quota({ status: 'early' }, { level: 'idle' })]), undefined)).toBe('push')
})

test('on pace or a brisk rate cruises; over pace or a burst eases; too fast or gassed out holds', () => {
  expect(headroomOf(snap([quota({ status: 'onPace' })]), undefined)).toBe('cruise')
  expect(headroomOf(snap([quota({ status: 'under' }, { level: 'brisk' })]), undefined)).toBe('cruise')
  expect(headroomOf(snap([quota({ status: 'over' })]), undefined)).toBe('ease')
  expect(headroomOf(snap([quota({ status: 'under' }, { level: 'burst' })]), undefined)).toBe('ease')
  expect(headroomOf(snap([quota({ status: 'over' }, { level: 'fast' })]), undefined)).toBe('hold')
  expect(headroomOf(snap([quota({ status: 'gassedOut', percent: 100 })]), undefined)).toBe('hold')
})

test('a quota idle of prompts but spending, as subagents do while the main thread waits, is judged by its spend', () => {
    // Under pace and no prompt in 15 minutes, but $40/h against a $30/h budget: subagents are spending
    expect(headroomOf(snap([quota({ status: 'under' }, { level: 'idle', usdPerHour: 40, usdBudgetPerHour: 30 })]), undefined)).toBe('ease')
    // Close to the budget: no room to push
    expect(headroomOf(snap([quota({ status: 'under' }, { level: 'idle', usdPerHour: 27, usdBudgetPerHour: 30 })]), undefined)).toBe('cruise')
    // Spending well under it, or with no dollar figures yet: the status decides as before
    expect(headroomOf(snap([quota({ status: 'under' }, { level: 'idle', usdPerHour: 5, usdBudgetPerHour: 30 })]), undefined)).toBe('push')
    expect(headroomOf(snap([quota({ status: 'under' }, { level: 'idle', usdPerHour: null, usdBudgetPerHour: null })]), undefined)).toBe('push')
  })

test('the tightest quota decides', () => {
  // The 5-hour window has room; the week is over pace
  const week = quota({ key: 'seven_day', name: 'Week', status: 'over' })
  expect(headroomOf(snap([quota({ status: 'under' }), week]), undefined)).toBe('ease')
})

test('only the quotas the model draws on count: another model\'s week over pace does not ease this one', () => {
  const opusWeek = quota({ key: 'seven_day_opus', name: 'Week · Opus', status: 'over' })
  expect(headroomOf(snap([quota({ status: 'under' }), opusWeek]), 'claude-sonnet-5-5')).toBe('push')
  expect(headroomOf(snap([quota({ status: 'under' }), opusWeek]), 'claude-opus-5-5')).toBe('ease')
})

test('a quota that cannot be set against the clock, or no quota at all, cruises rather than pushes blind', () => {
  expect(headroomOf(snap([quota({ status: null })]), undefined)).toBe('cruise')
  expect(headroomOf(snap([]), undefined)).toBe('cruise')
})

describe('the gear', () => {
  // The user runs opus at high effort and lets ultra pace range from sonnet to opus
  const BOUNDS: GearBounds = { floor: 'sonnet', ceiling: 'opus', model: 'opus', effort: 'high' }
  const PUSH: PaceGear = { model: 'opus', effort: 'xhigh', subagents: 3, subagentModel: 'sonnet', fanout: true }
  const CRUISE: PaceGear = { model: 'opus', effort: 'high', subagents: 2, subagentModel: 'sonnet', fanout: false }
  const EASE: PaceGear = { model: 'sonnet', effort: 'medium', subagents: 1, subagentModel: 'haiku', fanout: false }

  test('room to push drives harder only after it held for two decisions', () => {
    expect(gearFor('push', BOUNDS, { gear: CRUISE, streak: 0, cold: true })).toEqual({ gear: CRUISE, streak: 1 })
    expect(gearFor('push', BOUNDS, { gear: CRUISE, streak: 1, cold: true })).toEqual({ gear: PUSH, streak: 0 })
  })

  test('it climbs one notch at a time', () => {
    expect(gearFor('push', BOUNDS, { gear: EASE, streak: 1, cold: true })).toEqual({ gear: CRUISE, streak: 0 })
  })

  test('less room drops the gear at once: the floor model, an effort lighter, one subagent on haiku', () => {
    expect(gearFor('ease', BOUNDS, { gear: PUSH, streak: 0, cold: true })).toEqual({ gear: EASE, streak: 0 })
    expect(gearFor('cruise', BOUNDS, { gear: PUSH, streak: 1, cold: true })).toEqual({ gear: CRUISE, streak: 0 })
  })

  test('room that does not hold starts the count again', () => {
    expect(gearFor('cruise', BOUNDS, { gear: CRUISE, streak: 1, cold: true })).toEqual({ gear: CRUISE, streak: 0 })
  })

  test('the main model waits for a cold cache: until then only effort and subagents move', () => {
    expect(gearFor('ease', BOUNDS, { gear: PUSH, streak: 0, cold: false }).gear).toEqual({ ...EASE, model: 'opus' })
    // Once cold, the held gear takes its own model
    expect(gearFor('ease', BOUNDS, { gear: { ...EASE, model: 'opus' }, streak: 0, cold: true }).gear).toEqual(EASE)
  })

  test('a hold leaves the gear as it is: auto mode already holds', () => {
    expect(gearFor('hold', BOUNDS, { gear: PUSH, streak: 1, cold: true })).toEqual({ gear: PUSH, streak: 0 })
  })

  test('easing from the lightest effort stays at it', () => {
    expect(gearFor('ease', { ...BOUNDS, effort: 'low' }, { gear: CRUISE, streak: 0, cold: true }).gear.effort).toBe('low')
  })
})

describe('applying the gear', () => {
  const EASE: PaceGear = { model: 'sonnet', effort: 'medium', subagents: 1, subagentModel: 'haiku', fanout: false }

  test('a subagent runs on the gear\'s model when the caller names none or a heavier one, its own when lighter', () => {
    expect(subagentModelFor(EASE, undefined)).toBe('haiku')
    expect(subagentModelFor(EASE, 'opus')).toBe('haiku')
    expect(subagentModelFor({ ...EASE, subagentModel: 'sonnet' }, 'claude-haiku-5-5')).toBe('claude-haiku-5-5')
    // A model pace does not rank is left as the caller named it
    expect(subagentModelFor(EASE, 'custom-model')).toBe('custom-model')
  })

  test('spawns go through up to the gear\'s count running at once', () => {
    expect(spawnAllowed(EASE, 0)).toBe(true)
    expect(spawnAllowed(EASE, 1)).toBe(false)
  })

  test('the main thread switches to the gear\'s model only on a cold cache, and keeps it after', () => {
    expect(mainModelFor(EASE, null, false)).toBeNull()
    expect(mainModelFor(EASE, null, true)).toBe('sonnet')
    expect(mainModelFor({ ...EASE, model: 'opus' }, 'sonnet', false)).toBe('sonnet')
  })

  test('a cache is cold at a moment once its time left, counted from the snapshot, has run out, or with none', () => {
    const s = snap([quota()])
    expect(coldAt(s, NOW)).toBe(true)
    const warm = { ...s, cache: { tokens: 1, window: 2, ttl: '1h' as const, secondsLeft: 600, nextWarm: 0, nextCold: 0, nextWarmUsd: null, nextColdUsd: null } }
    expect(coldAt(warm, NOW + 599_000)).toBe(false)
    expect(coldAt(warm, NOW + 600_000)).toBe(true)
  })

  test('a request keeps its own model where the gear names the same family: a version is never traded for an alias', () => {
    expect(requestModel('sonnet', 'claude-opus-5-5')).toBe('sonnet')
    expect(requestModel('opus', 'claude-opus-5-5')).toBe('claude-opus-5-5')
    expect(requestModel(null, 'claude-opus-5-5')).toBe('claude-opus-5-5')
  })
})
