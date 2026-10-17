import { expect, test } from 'claude-code/testing'

import type { PaceQuota, PaceSnapshot } from '../types'
import { alertsOf } from '../hooks/alerts.ts'

const NOW = Date.UTC(2026, 9, 17, 12, 0, 0)
const H = 3600_000

const quota = (over: Partial<PaceQuota> = {}): PaceQuota => ({
  key: 'five_hour', name: '5-hour window', percent: 40, status: 'onPace', resetsAt: NOW + 2 * H, runOutAt: null,
  rate: { level: 'ok', promptsPerHour: 6, usdPerHour: null, usdBudgetPerHour: null, costPerPrompt: null, emptyIn: null },
  ...over,
})
const snap = (quotas: PaceQuota[]): PaceSnapshot => ({
  at: NOW, quotas, cache: null, spend: { usdPerHour: 0, sessions: 1, usdPerPrompt: null }, gassedOut: quotas.some(q => q.status === 'gassedOut'), advice: [],
})

test('nothing to say about a quota with room to spare', () => {
  expect(alertsOf(snap([quota()]))).toEqual([])
})

test('warns at 80% and 95% of a quota, and when it is gassed out, each once per window', () => {
  const at80 = alertsOf(snap([quota({ percent: 82 })]))
  expect(at80.map(a => a.id)).toEqual([`five_hour@${NOW + 2 * H}:80`])
  expect(at80[0]!.text).toContain('risk getting gassed out')
  expect(alertsOf(snap([quota({ percent: 96 })])).map(a => a.id)).toEqual([`five_hour@${NOW + 2 * H}:80`, `five_hour@${NOW + 2 * H}:95`])
  const out = alertsOf(snap([quota({ percent: 100, status: 'gassedOut' })]))
  expect(out.map(a => a.level)).toContain('urgent')
  expect(out.find(a => a.id.endsWith(':out'))!.text).toMatch(/^Gassed out: 5-hour window is spent until \d\d:\d\d/)
})

test('warns when the rate would gas a quota out before it resets', () => {
  const a = alertsOf(snap([quota({ rate: { level: 'fast', promptsPerHour: 40, usdPerHour: 62, usdBudgetPerHour: 30, costPerPrompt: 2, emptyIn: 2400 } })]))
  expect(a.map(x => x.id)).toEqual([`five_hour@${NOW + 2 * H}:fast`])
  expect(a[0]!.text).toBe('At $62/h the 5-hour window gasses out in 40m, 1h 20m before it resets.')
})
