import { describe, expect, test } from 'claude-code/testing'

import { cacheLeft, nextCost, suggestions, warmAction } from '../hooks/cache.ts'

const NOW = Date.UTC(2026, 9, 17, 12, 0, 0)
const MIN = 60_000
const warm = (ago: number, tokens = 180_000, ttl: '5m' | '1h' = '1h') => ({ at: NOW - ago * MIN, tokens, window: 1_000_000, ttl })

describe('cacheLeft', () => {
  test('counts the TTL down from the last reply, never below zero', () => {
    expect(cacheLeft(warm(17), NOW)).toBe(43 * 60)
    expect(cacheLeft(warm(2, 1, '5m'), NOW)).toBe(3 * 60)
    expect(cacheLeft(warm(90), NOW)).toBe(0)
  })
})

describe('nextCost', () => {
  test('in input-token equivalents: a warm cache reads at a tenth, a cold one rewrites at the TTL write rate', () => {
    expect(nextCost(180_000, '1h')).toEqual({ warm: 18_000, cold: 360_000 })
    expect(nextCost(180_000, '5m')).toEqual({ warm: 18_000, cold: 225_000 })
  })
})

describe('suggestions', () => {
  test('a large warm cache about to lapse comes first: prompt before it does', () => {
    const s = suggestions({ cache: warm(57), now: NOW })
    expect(s[0]?.level).toBe('urgent')
    expect(s[0]?.short).toContain('prompt within 3m')
  })

  test('a large cold context: compact before the next prompt rewrites it', () => {
    const s = suggestions({ cache: warm(120), now: NOW })
    expect(s[0]?.text).toContain('/compact')
    expect(s[0]?.text).toContain('180k')
  })

  test('a full context window, prompting too fast and a weekly quota over pace each say what to do', () => {
    const s = suggestions({
      cache: warm(1),
      now: NOW,
      contextPercent: 72,
      fast: { name: '5-hour session', emptyIn: 1200, slowTo: '7/h' },
      weeklyOverPace: 'Fable',
    })
    const all = s.map(x => x.text).join('\n')
    expect(all).toContain('72%')
    expect(all).toContain('≤7/h')
    expect(all).toContain('Fable')
  })

  test('nothing to improve says nothing', () => {
    expect(suggestions({ cache: warm(1, 20_000), now: NOW, contextPercent: 10 })).toEqual([])
  })

  test('a burst is named as one, with when the quota runs out if it keeps up', () => {
    const s = suggestions({ cache: null, now: NOW, burst: { name: '5-hour session', emptyIn: 52 * 60 } })
    expect(s[0]?.short).toBe('burst')
    expect(s[0]?.text).toContain('52m')
  })
})

describe('warmAction', () => {
  const idle = { working: false, actions: 0, lastFor: null }
  test('off does nothing', () => {
    expect(warmAction({ ...idle, mode: 'off', cache: warm(51), now: NOW })).toBeNull()
  })
  test('under 10 minutes left of an hour, idle, on a context worth keeping: act once', () => {
    expect(warmAction({ ...idle, mode: 'compact', cache: warm(51), now: NOW })).toBe('compact')
    expect(warmAction({ ...idle, mode: 'ping', cache: warm(51), now: NOW })).toBe('ping')
    expect(warmAction({ ...idle, mode: 'compact', cache: warm(49), now: NOW })).toBeNull()
    expect(warmAction({ ...idle, mode: 'compact', cache: warm(51), now: NOW, lastFor: warm(51).at })).toBeNull()
  })
  test('never while a turn runs, on a small context, once lapsed, or past its cap since the last prompt', () => {
    expect(warmAction({ ...idle, working: true, mode: 'compact', cache: warm(51), now: NOW })).toBeNull()
    expect(warmAction({ ...idle, mode: 'compact', cache: warm(51, 20_000), now: NOW })).toBeNull()
    expect(warmAction({ ...idle, mode: 'compact', cache: warm(61), now: NOW })).toBeNull()
    expect(warmAction({ ...idle, mode: 'compact', cache: warm(51), now: NOW, actions: 1 })).toBeNull()
    expect(warmAction({ ...idle, mode: 'ping', cache: warm(51), now: NOW, actions: 2 })).toBe('ping')
    expect(warmAction({ ...idle, mode: 'ping', cache: warm(51), now: NOW, actions: 3 })).toBeNull()
  })
  test('a 5-minute cache acts in its last half', () => {
    expect(warmAction({ ...idle, mode: 'ping', cache: warm(2.7, 180_000, '5m'), now: NOW })).toBe('ping')
    expect(warmAction({ ...idle, mode: 'ping', cache: warm(2, 180_000, '5m'), now: NOW })).toBeNull()
  })
})
