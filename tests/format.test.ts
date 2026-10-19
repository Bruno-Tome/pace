import { describe, expect, test } from 'claude-code/testing'

import { formatTokens, formatUsd } from '../hooks/cache.ts'
import { clockAt, formatDuration } from '../hooks/quota.ts'

describe('durations', () => {
  test('in the two largest units, a zero second unit left out', () => {
    expect(formatDuration(90 * 60)).toBe('1h 30m')
    expect(formatDuration(2 * 3600)).toBe('2h')
    expect(formatDuration(26 * 3600)).toBe('1d 2h')
    expect(formatDuration(3 * 86400)).toBe('3d')
    expect(formatDuration(45 * 60)).toBe('45m')
  })

  test('under a minute reads as under a minute, never "0m"', () => {
    expect(formatDuration(0)).toBe('<1m')
    expect(formatDuration(30)).toBe('<1m')
    expect(formatDuration(59.9)).toBe('<1m')
  })

  test('a negative span reads by its size', () => {
    expect(formatDuration(-90 * 60)).toBe('1h 30m')
  })
})

describe('clock times', () => {
  // A local time, so the test holds in any time zone
  const at = new Date(2026, 9, 18, 9, 5).getTime()

  test('as hours and minutes, padded, with the weekday when asked', () => {
    expect(clockAt(at, false)).toBe('09:05')
    expect(clockAt(at, true)).toBe('Sun 09:05')
  })
})

describe('tokens', () => {
  test('as they are under a thousand, in thousands, then in millions to one place', () => {
    expect(formatTokens(0)).toBe('0')
    expect(formatTokens(999)).toBe('999')
    expect(formatTokens(1500)).toBe('2k')
    expect(formatTokens(180_000)).toBe('180k')
    expect(formatTokens(1_000_000)).toBe('1M')
    expect(formatTokens(1_250_000)).toBe('1.3M')
  })

  test('a count that rounds to a thousand thousands reads as a million, never "1000k"', () => {
    expect(formatTokens(999_600)).toBe('1M')
  })
})

describe('dollars', () => {
  test('to the cent, and under a cent as under a cent', () => {
    expect(formatUsd(1.234)).toBe('$1.23')
    expect(formatUsd(0.004)).toBe('<$0.01')
  })

  test('nothing spent reads as nothing, not as under a cent', () => {
    expect(formatUsd(0)).toBe('$0.00')
  })
})
