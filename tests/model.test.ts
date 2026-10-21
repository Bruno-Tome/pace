import { describe, expect, test } from 'claude-code/testing'

import type { PaceSample } from '../types'
import { rateOf, rowsOf, type Snapshot } from '../hooks/model.ts'
import { addSpend } from '../hooks/spend.ts'

const NOW = Date.UTC(2026, 9, 17, 12, 0, 0)
const MIN = 60_000
const H = 60 * MIN
const OPUS = 'claude-opus-5-5'
const FABLE = 'claude-fable-5-1'

// The Fable week at 68% with 3.6 of its 7 days left, about half of it gone: over pace
const fableWeek = (at: number, percent: number) => ({ at, quotas: { seven_day_fable: { percent, resetsAt: NOW + 3.6 * 24 * H, name: 'Fable' } } })
const fableRow = (s: Snapshot) => rowsOf(s.samples, NOW).find(r => r.key === 'seven_day_fable')!

describe('the rate against a model\'s own week', () => {
  // Ten prompts in the last 20 minutes, no per-prompt cost for the week yet
  const prompts = Array.from({ length: 10 }, (_, i) => NOW - i * 2 * MIN)
  const samples: PaceSample[] = [fableWeek(NOW, 68)]

  test('is idle while every prompt goes to another model', () => {
    const s: Snapshot = { samples, prompts, cache: null, modelPrompts: { [OPUS]: prompts } }
    expect(rateOf(s, fableRow(s), NOW).level).toBe('idle')
  })

  test('is too fast while that model is prompted over pace', () => {
    const s: Snapshot = { samples, prompts, cache: null, modelPrompts: { [FABLE]: prompts } }
    expect(rateOf(s, fableRow(s), NOW).level).toBe('fast')
  })

  test('counts prompts whose model is not known, so a session from before still warns', () => {
    const s: Snapshot = { samples, prompts, cache: null }
    expect(rateOf(s, fableRow(s), NOW).level).toBe('fast')
  })

  test('is judged on that model\'s dollars alone, not what another model spends', () => {
    // $20 of Fable moved the week 10 points: half a point a dollar
    const priced: PaceSample[] = [fableWeek(NOW - 6 * H, 58), fableWeek(NOW - 10 * MIN, 68)]
    const fable = [...Array.from({ length: 5 }, (_, i) => NOW - 5 * H + i * 10 * MIN), NOW - 5 * MIN]
    const opus = Array.from({ length: 10 }, (_, i) => NOW - 30_000 - i * MIN)
    let spend = addSpend([], 'a', NOW - 5 * H, 20, NOW, FABLE)
    spend = addSpend(spend, 'a', NOW - 4 * MIN, 0.1, NOW, FABLE)
    // Opus spends $40 in the last 5 minutes: $80/h, which would gas the week out if it counted
    spend = addSpend(spend, 'b', NOW - 5 * MIN, 40, NOW, OPUS)
    const s: Snapshot = { samples: priced, prompts: [...fable, ...opus].sort((x, y) => x - y), cache: null, spend, modelPrompts: { [FABLE]: fable, [OPUS]: opus } }
    const r = rateOf(s, fableRow(s), NOW)
    expect(r.level).toBe('ok')
    expect(Math.round(r.usdPerHour! * 100) / 100).toBe(0.2)
  })
})

describe('the rate from the quota\'s own movement', () => {
  // A fresh 5-hour window, 17 minutes in: a burst took it to 8% in its first 7 minutes, then it crawled to 10%
  const start = NOW - 17 * MIN
  const at = (min: number, percent: number): PaceSample => ({ at: start + min * MIN, quotas: { five_hour: { percent, resetsAt: start + 5 * H } } })
  const samples = [at(1, 1), at(7, 8), at(12, 9), at(14, 10)]
  // 46 prompts, 40 of them in the burst
  const prompts = [...Array.from({ length: 40 }, (_, i) => start + i * 10_000), ...Array.from({ length: 6 }, (_, i) => start + (8 + i * 1.5) * MIN)]
  const s: Snapshot = { samples, prompts, cache: null }
  const row = () => rowsOf(samples, NOW).find(r => r.key === 'five_hour')!

  test('a burst that ended is not the rate: the last readings move 16 points an hour, which lands near 85%', () => {
    const v = rateOf(s, row(), NOW)
    expect(v.level).not.toBe('fast')
    expect(v.pctPerHour!).toBeGreaterThan(14)
    expect(v.pctPerHour!).toBeLessThan(19)
    // At that rate it would run out only after the reset
    expect(v.emptyIn!).toBeGreaterThan(v.resetIn!)
    expect(v.pctAtReset!).toBeLessThan(100)
  })

  test('a quota climbing fast in its readings is too fast, whatever the prompt count says', () => {
    // 3 points in the last 6 minutes: 30 an hour, out in under 3 hours with 4.7 left
    const climbing = [...samples, at(16, 12), at(17, 13)]
    const v = rateOf({ samples: climbing, prompts: prompts.slice(40), cache: null }, rowsOf(climbing, NOW).find(r => r.key === 'five_hour')!, NOW)
    expect(v.level === 'fast' || v.level === 'burst').toBe(true)
    expect(v.emptyIn! / 3600).toBeLessThan(4.7)
  })
})

describe('the rate once the prompting stops', () => {
  // A fresh 5-hour window: 3% to 9% between 20 and 28 minutes in, a prompt before each reading, then nothing
  const start = NOW - 36 * MIN
  const at = (min: number, percent: number): PaceSample => ({ at: start + min * MIN, quotas: { five_hour: { percent, resetsAt: start + 5 * H } } })
  const samples = [at(20, 3), at(22, 5), at(24, 6), at(26, 8), at(28, 9)]
  const prompts = [19.5, 21.5, 23.5, 25.5, 27.5].map(m => start + m * MIN)
  const row = () => rowsOf(samples, NOW).find(r => r.key === 'five_hour')!

  test('is not the busy stretch\'s rate 8 quiet minutes on: 9% with 4h24m left runs out after the reset', () => {
    // The readings alone climb 4 points in 6 minutes, 40 an hour, out in about 2 hours; nothing has moved it since
    const v = rateOf({ samples, prompts, cache: null }, row(), NOW)
    expect(v.level).not.toBe('burst')
    expect(v.emptyIn!).toBeGreaterThan(v.resetIn!)
  })

  test('is still the readings\' rate while a prompt since the last one may be moving it', () => {
    const v = rateOf({ samples, prompts: [...prompts, NOW - MIN], cache: null }, row(), NOW)
    expect(v.level).toBe('burst')
  })
})

describe('a shared window on a plan with a model\'s own week', () => {
  // A fresh 5-hour window climbing 0% to 10% in its first 12 minutes, while the Fable week stands at 83%
  const start = NOW - 14 * MIN
  const five = (min: number, percent: number): PaceSample => ({ at: start + min * MIN, quotas: { five_hour: { percent, resetsAt: start + 5 * H } } })
  const samples = [five(0, 0), five(3, 2), five(6, 5), five(9, 7), five(12, 10), fableWeek(NOW - MIN, 83)]
  const prompts = [1, 4, 7, 10].map(m => start + m * MIN)
  const row = (s: Snapshot) => rowsOf(s.samples, NOW).find(r => r.key === 'five_hour')!

  test('is paced by the models with no week of their own: a Fable burst leaves it idle, not too fast', () => {
    // Every prompt and dollar since the window began went to Fable, whose week paces it
    const spend = addSpend([], 'a', NOW - 10 * MIN, 8, NOW, FABLE)
    const s: Snapshot = { samples, prompts, cache: null, spend, modelPrompts: { [FABLE]: prompts } }
    const v = rateOf(s, row(s), NOW)
    expect(v.level).toBe('idle')
    expect(v.emptyIn).toBeNull()
  })

  test('moves by the share of the dollars from those models: half from Opus, half the movement', () => {
    // $4 of Opus and $4 of Fable in the span, against the same $8 all from Opus
    const fable = addSpend([], 'a', NOW - 10 * MIN, 4, NOW, FABLE)
    const split: Snapshot = { samples, prompts, cache: null, spend: addSpend(fable, 'b', NOW - 8 * MIN, 4, NOW, OPUS), modelPrompts: { [FABLE]: prompts.slice(0, 2), [OPUS]: prompts.slice(2) } }
    const opus: Snapshot = { samples, prompts, cache: null, spend: addSpend([], 'b', NOW - 8 * MIN, 8, NOW, OPUS), modelPrompts: { [OPUS]: prompts } }
    const half = rateOf(split, row(split), NOW).pctPerHour!
    const whole = rateOf(opus, row(opus), NOW).pctPerHour!
    expect(whole).toBeGreaterThan(30)
    expect(Math.round((half / whole) * 100)).toBe(50)
  })

  test('without a model\'s own week on the plan, every model moves it: the same burst is too fast', () => {
    const spend = addSpend([], 'a', NOW - 10 * MIN, 8, NOW, FABLE)
    const s: Snapshot = { samples: samples.slice(0, 5), prompts, cache: null, spend, modelPrompts: { [FABLE]: prompts } }
    expect(rateOf(s, row(s), NOW).level).toBe('fast')
  })
})

describe('a quota moved by what pace sees no prompt for', () => {
  // The Fable week climbing 3 points in 3 hours while every prompt here went to Opus: a Fable subagent, or another session
  const week = (at: number, percent: number): PaceSample => ({ at, quotas: { seven_day_fable: { percent, resetsAt: NOW + 3.6 * 24 * H, name: 'Fable' } } })
  const samples = [week(NOW - 3 * H, 70), week(NOW - 2 * H, 71), week(NOW - H, 72), week(NOW - 5 * MIN, 73)]
  const prompts = Array.from({ length: 10 }, (_, i) => NOW - i * 2 * MIN)
  const s: Snapshot = { samples, prompts, cache: null, modelPrompts: { [OPUS]: prompts } }
  const row = () => rowsOf(samples, NOW).find(r => r.key === 'seven_day_fable')!

  test('is not idle: its own movement says it is being used, at about a point an hour', () => {
    const v = rateOf(s, row(), NOW)
    expect(v.level).not.toBe('idle')
    expect(v.pctPerHour!).toBeGreaterThan(0.9)
    expect(v.pctPerHour!).toBeLessThan(1.2)
  })

  test('and one whose readings have not moved is idle, whatever the prompts', () => {
    const flat = [week(NOW - 3 * H, 73), week(NOW - H, 73), week(NOW - 5 * MIN, 73)]
    const fable: Snapshot = { samples: flat, prompts, cache: null, modelPrompts: { [FABLE]: prompts } }
    expect(rateOf(fable, rowsOf(flat, NOW).find(r => r.key === 'seven_day_fable')!, NOW).level).toBe('idle')
  })
})
