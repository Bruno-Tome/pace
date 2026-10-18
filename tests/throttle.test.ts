import { describe, expect, test } from 'claude-code/testing'

import type { PaceGear, PaceQuota, PaceSnapshot } from '../types'
import { gearFor, headroomOf, type GearBounds } from '../hooks/throttle.ts'

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
