import { describe, expect, test } from 'claude-code/testing'

import type { PaceReading } from '../types'
import { bar, mergeModelPrompts, movedPerHour, rateSince, sparkline } from '../hooks/rate.ts'

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
    // 8 points an hour for the 2 hours left: it lands at 36%
    expect(v.pctAtReset).toBe(36)
  })

  test('prompting faster than the budget runs out before the reset', () => {
    // 30 prompts in the last hour for 60% used: 2% per prompt; 40% left over 2h = 10/h budget; rate 30/h
    const v = rateVerdict(every(2, 30), { percent: 60, resetsAt: reset }, NOW)
    expect(v.perHour).toBe(30)
    expect(v.budgetPerHour).toBe(10)
    expect(v.level).toBe('fast')
    // 20 prompts left at 30/h: 40 minutes
    expect(v.emptyIn).toBe(40 * 60)
    // Scored against this quota alone: 2 points a prompt at 30/h, against 40 points over 2h
    expect(v.pctPerHour).toBe(60)
    expect(v.pctBudgetPerHour).toBe(20)
    // Past 100%: it runs out first
    expect(v.pctAtReset).toBe(180)
  })

  test('where it lands closes in on what is used as the reset nears, never exploding', () => {
    // 65% used with 17 minutes left; 28 prompts over the window, 3 in the last half hour
    const r = { percent: 65, resetsAt: NOW + 17 * MIN }
    const near = (left: number) => rateSince(every(10, 28), { ...r }, { at: r.resetsAt - 5 * H - 1, percent: 0 }, r.resetsAt - left * MIN).pctAtReset!
    expect(near(17)).toBeGreaterThan(65)
    expect(near(17)).toBeLessThan(70)
    expect(near(1)).toBeLessThan(near(17))
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
    expect(bar(0.6, 0.4, 10).map(c => c.kind).join(',')).toBe('used,used,used,used,tick,ahead,empty,empty,empty,empty')
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

describe('mergeModelPrompts', () => {
  test('merges each model\'s prompts from both copies, the last day only, and drops what does not parse', () => {
    const a = { 'claude-opus-5-5': [NOW - 2 * MIN, NOW - 25 * H], 'claude-fable-5-1': [NOW - MIN] }
    const b = { 'claude-opus-5-5': [NOW - MIN, NOW - 2 * MIN], junk: 'x', 'claude-haiku-5-5': [] } as any
    expect(mergeModelPrompts(a, b, NOW)).toEqual({ 'claude-opus-5-5': [NOW - 2 * MIN, NOW - MIN], 'claude-fable-5-1': [NOW - MIN] })
  })
})

describe('the rate in points an hour', () => {
  test('is the slope of the quota\'s readings over the recent span, fitted through all of them', () => {
    // 8% ten minutes ago, 9% five minutes ago, 10% three minutes ago: about 16 points an hour
    const pts = [{ at: NOW - 10 * MIN, percent: 8 }, { at: NOW - 5 * MIN, percent: 9 }, { at: NOW - 3 * MIN, percent: 10 }]
    const v = movedPerHour(pts, NOW, 20 * MIN)!
    expect(v).toBeGreaterThan(16.1)
    expect(v).toBeLessThan(16.2)
  })

  test('leaves out readings older than the span, and is 0 for a quota that has not moved', () => {
    const pts = [{ at: NOW - 40 * MIN, percent: 0 }, { at: NOW - 15 * MIN, percent: 10 }, { at: NOW - 1 * MIN, percent: 10 }]
    expect(movedPerHour(pts, NOW, 20 * MIN)).toBe(0)
  })

  test('says nothing from readings spanning too little time to measure', () => {
    expect(movedPerHour([{ at: NOW - 2 * MIN, percent: 8 }, { at: NOW, percent: 9 }], NOW, 20 * MIN)).toBeNull()
    expect(movedPerHour([{ at: NOW - 10 * MIN, percent: 8 }], NOW, 20 * MIN)).toBeNull()
  })
})
