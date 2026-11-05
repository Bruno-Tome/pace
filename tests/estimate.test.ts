import { describe, expect, test } from 'claude-code/testing'

import { capacityAtLimit, capacityFromReadings, estimateOf, learn, windowOf, type Capacities } from '../core/estimate.ts'
import type { PaceSample, PaceSpend } from '../types'

const NOW = Date.UTC(2026, 10, 5, 12, 0, 0)
const MIN = 60_000
const H = 60 * MIN
const FIVE = 5 * H

/** `usd` spent by session `p1` in the minute from `t` */
const spent = (t: number, usd: number): PaceSpend => ({ t, id: 'p1', usd })

describe('a window', () => {
  test('starts with the first activity after the last window ended, and resets its length later', () => {
    // Work at 9:00 opened a window to 14:00; work at 15:00 opened the next, to 20:00
    const nine = NOW - 3 * H
    expect(windowOf([nine, nine + H], FIVE, NOW)).toEqual({ start: nine, resetsAt: nine + FIVE })
    expect(windowOf([nine, NOW + 3 * H], FIVE, NOW + 4 * H)).toEqual({ start: NOW + 3 * H, resetsAt: NOW + 3 * H + FIVE })
  })

  test('is none when the last one has ended and nothing has happened since', () => {
    expect(windowOf([NOW - 6 * H], FIVE, NOW)).toBeNull()
    expect(windowOf([], FIVE, NOW)).toBeNull()
  })
})

describe('a window\'s capacity', () => {
  test('is what was spent in it when its limit was reached', () => {
    const spend = [spent(NOW - 2 * H, 6), spent(NOW - H, 4)]
    expect(capacityAtLimit(spend, [], 'five_hour', NOW)).toEqual({ usd: 10, at: NOW, source: 'limit' })
  })

  test('is none from a limit with nothing spent in the window: there is nothing to scale by', () => {
    expect(capacityAtLimit([], [], 'five_hour', NOW)).toBeNull()
  })

  test('comes from real readings when a feed on the same provider has them: a dollar\'s points, inverted', () => {
    // 5 points for $1 between two readings of one window: the window holds $20
    const resetsAt = NOW + 2 * H
    const samples: PaceSample[] = [
      { at: NOW - 40 * MIN, quotas: { five_hour: { percent: 20, resetsAt } } },
      { at: NOW - 10 * MIN, quotas: { five_hour: { percent: 30, resetsAt } } },
    ]
    const spend = [spent(NOW - 30 * MIN, 1), spent(NOW - 20 * MIN, 1)]
    expect(capacityFromReadings(samples, 'five_hour', spend, NOW)).toEqual({ usd: 20, at: NOW - 10 * MIN, source: 'reading' })
  })
})

describe('the estimate', () => {
  test('is the window\'s spend over its capacity, marked as an estimate, with the window\'s reset', () => {
    const start = NOW - H
    const capacities: Capacities = { five_hour: { usd: 20, at: NOW - 3 * 24 * H, source: 'limit' } }
    const s = estimateOf([spent(start, 3), spent(NOW - 10 * MIN, 2)], [start], capacities, NOW)
    expect(s).toEqual({ at: NOW, quotas: { five_hour: { percent: 25, resetsAt: start + FIVE, estimated: true } } })
  })

  test('is 0% when the window has ended: the next one starts empty', () => {
    const capacities: Capacities = { five_hour: { usd: 20, at: NOW - H, source: 'limit' } }
    expect(estimateOf([spent(NOW - 6 * H, 30)], [NOW - 6 * H], capacities, NOW)).toEqual({ at: NOW, quotas: { five_hour: { percent: 0, estimated: true } } })
  })

  test('never says more than 100%', () => {
    const capacities: Capacities = { five_hour: { usd: 4, at: NOW - H, source: 'limit' } }
    expect(estimateOf([spent(NOW - 30 * MIN, 9)], [NOW - 30 * MIN], capacities, NOW)!.quotas.five_hour!.percent).toBe(100)
  })

  test('is none before any capacity is known: the band shows spend alone', () => {
    expect(estimateOf([spent(NOW - 30 * MIN, 9)], [NOW - 30 * MIN], {}, NOW)).toBeNull()
  })
})

describe('learning the capacities', () => {
  const DAY = 24 * H
  // $6 this 5-hour window, opened an hour ago; $30 this week, opened two days ago
  const spend = [spent(NOW - 2 * DAY, 24), spent(NOW - H, 6)]
  const prompts = [NOW - H]

  test('a limit reached fills the 5-hour window when nothing says it is not the one', () => {
    expect(learn({}, { spend, prompts, samples: [], limitAt: NOW }, NOW).five_hour).toEqual({ usd: 6, at: NOW, source: 'limit' })
  })

  test('a limit reached with the 5-hour window well under full is the week\'s', () => {
    // The 5-hour window holds $20 and has $6 in it: 30%, so the week ran out
    const known: Capacities = { five_hour: { usd: 20, at: NOW - DAY, source: 'limit' } }
    const c = learn(known, { spend, prompts, samples: [], limitAt: NOW }, NOW)
    expect(c.five_hour).toEqual(known.five_hour)
    expect(c.seven_day).toEqual({ usd: 30, at: NOW, source: 'limit' })
  })

  test('real readings replace an older capacity, and an older reading leaves a newer one be', () => {
    const resetsAt = NOW + 2 * H
    const samples: PaceSample[] = [
      { at: NOW - 40 * MIN, quotas: { five_hour: { percent: 20, resetsAt } } },
      { at: NOW - 10 * MIN, quotas: { five_hour: { percent: 30, resetsAt } } },
    ]
    const readSpend = [spent(NOW - 30 * MIN, 1), spent(NOW - 20 * MIN, 1)]
    const old: Capacities = { five_hour: { usd: 9, at: NOW - DAY, source: 'limit' } }
    expect(learn(old, { spend: readSpend, prompts: [], samples }, NOW).five_hour).toEqual({ usd: 20, at: NOW - 10 * MIN, source: 'reading' })
    const newer: Capacities = { five_hour: { usd: 9, at: NOW, source: 'limit' } }
    expect(learn(newer, { spend: readSpend, prompts: [], samples }, NOW).five_hour).toEqual(newer.five_hour)
  })
})
