import { describe, expect, test } from 'claude-code/testing'

import type { PaceReading } from '../types'
import { bar, rateSince, sparkline } from '../hooks/rate.ts'

const NOW = Date.UTC(2026, 9, 17, 12, 0, 0)
const MIN = 60_000
const H = 60 * MIN

// The 5-hour window resets in 2h: it started 3h ago
const reset = NOW + 2 * H
/** The rate against a 5-hour window, priced from its start at 0% */
const rateVerdict = (prompts: number[], r: PaceReading | undefined, now: number) =>
  rateSince(prompts, r, r?.resetsAt != null ? { at: r.resetsAt - 5 * H - 1, percent: 0 } : null, now)
const every = (gapMin: number, n: number) => Array.from({ length: n }, (_, i) => NOW - i * gapMin * MIN)

describe('rateVerdict', () => {
  test('no prompts is idle', () => {
    const v = rateVerdict([], { percent: 10, resetsAt: reset }, NOW)
    expect(v.level).toBe('idle')
    expect(v.perHour).toBe(0)
  })

  test('slow prompting with plenty left is ok', () => {
    // 10 prompts over 3h for 20% used: 2% per prompt; 80% left over 2h = 20/h budget; rate 2/30m = 4/h
    const v = rateVerdict(every(18, 10), { percent: 20, resetsAt: reset }, NOW)
    expect(v.costPerPrompt).toBe(2)
    expect(v.budgetPerHour).toBe(20)
    expect(v.perHour).toBe(4)
    expect(v.level).toBe('ok')
  })

  test('prompting faster than the budget runs out before the reset', () => {
    // 30 prompts in the last hour for 60% used: 2% per prompt; 40% left over 2h = 10/h budget; rate 30/h
    const v = rateVerdict(every(2, 30), { percent: 60, resetsAt: reset }, NOW)
    expect(v.perHour).toBe(30)
    expect(v.budgetPerHour).toBe(10)
    expect(v.level).toBe('fast')
    // 20 prompts left at 30/h: 40 minutes
    expect(v.emptyIn).toBe(40 * 60)
  })

  test('close to the budget is brisk', () => {
    // 40 prompts in the window, 40% used: 1%/prompt; 60%/2h = 30/h budget; 12 in the last 30m = 24/h, above 3/4 of it
    const recent = Array.from({ length: 12 }, (_, i) => NOW - i * 2.5 * MIN)
    const old = Array.from({ length: 28 }, (_, i) => NOW - 40 * MIN - i * 5 * MIN)
    const v = rateVerdict([...recent, ...old], { percent: 40, resetsAt: reset }, NOW)
    expect(v.perHour).toBe(24)
    expect(v.budgetPerHour).toBe(30)
    expect(v.level).toBe('brisk')
  })

  test('too few prompts gives no cost estimate', () => {
    const v = rateVerdict(every(1, 2), { percent: 30, resetsAt: reset }, NOW)
    expect(v.costPerPrompt).toBe(null)
    expect(v.level).toBe('ok')
  })

  test('prompts before the window started do not count toward its cost', () => {
    const before = Array.from({ length: 20 }, (_, i) => NOW - 4 * H - i * MIN)
    const v = rateVerdict([...every(30, 5), ...before], { percent: 10, resetsAt: reset }, NOW)
    expect(v.costPerPrompt).toBe(2)
  })
})

describe('bar', () => {
  test('marks used, ahead-of-clock and the elapsed tick', () => {
    // 10 cells, 60% used, 40% elapsed: 4 on pace, 2 ahead, tick right after, rest empty
    expect(bar(0.6, 0.4, 10).map(c => c.kind).join(',')).toBe('used,used,used,used,ahead,ahead,empty,empty,empty,empty')
    expect(bar(0.2, 0.5, 10).map(c => c.kind).join(',')).toBe('used,used,margin,margin,margin,tick,empty,empty,empty,empty')
  })
})

describe('sparkline', () => {
  test('scales buckets to block heights', () => {
    expect(sparkline([0, 1, 2, 4])).toBe(' ▂▄█')
  })
})

describe('rateSince', () => {
  test('measures a weekly quota from a baseline reading: what it moved per prompt since then', () => {
    // 10 points since a reading 10h ago at 50%, over 20 prompts: 0.5% each; 40% left over 80h = 80 prompts, 1/h budget
    const weekReset = NOW + 80 * H
    const prompts = Array.from({ length: 20 }, (_, i) => NOW - 9 * H + i * 27 * MIN)
    const v = rateSince(prompts, { percent: 60, resetsAt: weekReset }, { at: NOW - 10 * H, percent: 50 }, NOW)
    expect(v.costPerPrompt).toBe(0.5)
    expect(v.budgetPerHour).toBe(1)
    expect(v.level).toBe('fast')
  })

  test('without a baseline there is no cost, and the level only says whether prompting is idle', () => {
    const v = rateSince(every(5, 6), { percent: 60, resetsAt: NOW + 80 * H }, null, NOW)
    expect(v.costPerPrompt).toBeNull()
    expect(v.level).toBe('ok')
  })
})
