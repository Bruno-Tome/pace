import { describe, expect, test } from 'claude-code/testing'

import type { PaceSample } from '../types'
import {
  appendSample, mergeSamples, outlook, paceOf, paceSummary, parseClaudeJson, parseUsage, quotaKeys, quotaName,
  shortName, statusLabel, trajectoryOf, viewOf, viewSummary, windowOf,
} from '../hooks/quota.ts'

const NOW = Date.UTC(2026, 9, 17, 12, 0, 0)
const MIN = 60_000
const H = 60 * MIN
const FIVE = 5 * 3600

describe('pace', () => {
  test('usage against the clock: under, on and over pace, with a margin that keeps a small lead on pace', () => {
    // 2h left of 5h: 60% of the window gone
    const at = (percent: number) => paceOf({ percent, resetsAt: NOW + 2 * H }, FIVE, NOW)!.status
    expect(at(60)).toBe('onPace')
    expect(at(68)).toBe('onPace')
    expect(at(80)).toBe('over')
    expect(at(30)).toBe('under')
  })

  test('a spent quota is gassed out until it resets', () => {
    const p = paceOf({ percent: 100, resetsAt: NOW + 2 * H }, FIVE, NOW)!
    expect(p.status).toBe('gassedOut')
    expect(statusLabel(p.status)).toBe('Gassed out')
    expect(outlook(p)).toBe('Resets in 2h')
  })

  test('the first minutes of a window are too early to judge', () => {
    expect(paceOf({ percent: 3, resetsAt: NOW + FIVE * 1000 - 2 * MIN }, FIVE, NOW)!.status).toBe('early')
  })

  test('says how far ahead or behind even pace usage runs, and where the current rate lands', () => {
    const behind = paceOf({ percent: 30, resetsAt: NOW + 72 * H }, 7 * 86400, NOW)!
    expect(paceSummary(behind)).toBe('1d 21h behind even pace')
    expect(outlook(behind)).toBe('~53% at reset at this rate')
    const even = paceOf({ percent: 60, resetsAt: NOW + 2 * H }, FIVE, NOW)!
    expect(paceSummary(even)).toBe('Even with the clock')
    const ahead = paceOf({ percent: 90, resetsAt: NOW + 2 * H }, FIVE, NOW)!
    expect(paceSummary(ahead)).toBe('1h 30m ahead of even pace')
    expect(outlook(ahead)).toMatch(/^Out by \d\d:\d\d at this rate$/)
  })

  test('no pace without a reset ahead, or from a stale reading', () => {
    expect(paceOf({ percent: 10 }, FIVE, NOW)).toBeNull()
    expect(viewSummary(viewOf({ percent: 10, resetsAt: NOW - MIN }, FIVE, NOW))).toBe('Window ended')
    expect(viewSummary(viewOf({ percent: 10 }, FIVE, NOW))).toBe('No reset time')
    expect(viewSummary(viewOf({ percent: 10, resetsAt: NOW + H }, FIVE, NOW, NOW - H))).toBe('Stale reading')
    expect(viewSummary(viewOf(undefined, FIVE, NOW))).toBe('No reading')
  })
})

describe('quotas', () => {
  test('names: the 5-hour window, the all-models week and a model\'s own week', () => {
    expect(windowOf('five_hour')).toBe(FIVE)
    expect(windowOf('seven_day_fable')).toBe(7 * 86400)
    expect(quotaName('five_hour')).toBe('5-hour window')
    expect(quotaName('seven_day')).toBe('Week · all models')
    expect(quotaName('seven_day_fable', 'Fable')).toBe('Week · Fable')
    expect([shortName('five_hour'), shortName('seven_day'), shortName('seven_day_fable', 'Fable')]).toEqual(['5h', '7d', 'Fable wk'])
  })

  test('the quotas a history knows, 5-hour first, then the all-models week, then each model\'s', () => {
    const samples: PaceSample[] = [{ at: NOW, quotas: { seven_day_fable: { percent: 5, resetsAt: NOW + H }, seven_day: { percent: 1, resetsAt: NOW + H }, five_hour: { percent: 2, resetsAt: NOW + H }, extra: { percent: 0 } } }]
    expect(quotaKeys(samples)).toEqual(['five_hour', 'seven_day', 'seven_day_fable'])
  })
})

describe('readings', () => {
  test('the usage endpoint: top-level windows and the limits list, a model\'s week named for its model', () => {
    const r = parseUsage({
      five_hour: { utilization: 12.5, resets_at: '2026-10-17T14:00:00Z' },
      seven_day_fable: { utilization: 60, resets_at: '2026-10-20T09:00:00Z' },
      limits: [{ kind: 'weekly_scoped', percent: 61, resets_at: '2026-10-20T09:00:00Z', scope: { model: { display_name: 'Fable' } } }],
    })
    expect(r.five_hour).toEqual({ percent: 12.5, resetsAt: Date.UTC(2026, 9, 17, 14) })
    expect(r.seven_day_fable).toEqual({ percent: 61, resetsAt: Date.UTC(2026, 9, 20, 9), name: 'Fable' })
  })

  test('Claude Code\'s usage cache, while under an hour old', () => {
    const text = JSON.stringify({ cachedUsageUtilization: { fetchedAtMs: NOW - 10 * MIN, utilization: { five_hour: { utilization: 40, resets_at: NOW / 1000 + 3600 } } } })
    expect(parseClaudeJson(text, NOW)).toEqual({ at: NOW - 10 * MIN, quotas: { five_hour: { percent: 40, resetsAt: NOW + H } } })
    expect(parseClaudeJson(text, NOW + 2 * H)).toBeNull()
    expect(parseClaudeJson('not json', NOW)).toBeNull()
  })

  test('a reading that repeats the last one within 5 minutes is not kept; sessions\' copies merge into one history', () => {
    const a: PaceSample = { at: NOW, quotas: { five_hour: { percent: 10, resetsAt: NOW + H } } }
    const same: PaceSample = { at: NOW + MIN, quotas: { five_hour: { percent: 10, resetsAt: NOW + H } } }
    const moved: PaceSample = { at: NOW + 2 * MIN, quotas: { five_hour: { percent: 11, resetsAt: NOW + H } } }
    expect(appendSample(appendSample([a], same), moved)).toEqual([a, moved])
    expect(mergeSamples([a, moved], [same, moved])).toEqual([a, moved])
  })

  test('a window\'s trajectory: its readings in order, and the recent slope projected to the reset', () => {
    const reset = NOW + 2 * H
    // A reading every 10 minutes for 2 hours, 20% to 60%
    const samples: PaceSample[] = Array.from({ length: 13 }, (_, i) => ({ at: NOW - 2 * H + i * 10 * MIN, quotas: { five_hour: { percent: 20 + (40 * i) / 12, resetsAt: reset } } }))
    const t = trajectoryOf('five_hour', reset, samples, FIVE)!
    expect(t.segments.length).toBe(1)
    expect([t.segments[0]![0]!, t.segments[0]![12]!].map(p => Math.round(p.used * 100))).toEqual([20, 60])
    // A pause past 15 minutes starts a new segment
    expect(trajectoryOf('five_hour', reset, [...samples.slice(0, 3), ...samples.slice(6)], FIVE)!.segments.length).toBe(2)
    expect(t.projection!.to.used).toBe(1)
    expect(trajectoryOf('five_hour', reset, samples.slice(0, 1), FIVE)).toBeNull()
  })
})
