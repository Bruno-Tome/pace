import { describe, expect, test } from 'claude-code/testing'

import { Activity, activityChips, activityOf, activityQuery, DEFAULT_QUERY, METRICS, pressed, valueOf, type ActivityRow } from '../core/activity.ts'
import { checkpointFrom, checkpointOf, entriesOf, logText, type LogHead, type LogEvent } from '../core/log.ts'

const H = 3600_000
const DAY = 24 * H
// Friday 2026-11-06, 12:00 UTC
const NOW = Date.UTC(2026, 10, 6, 12)
const tk = (input: number, output: number, cacheRead = 0, cacheWrite = 0, reasoning = 0) => ({ input, output, cacheRead, cacheWrite, reasoning })
const head = (o: Partial<LogHead> = {}): LogHead => ({ provider: 'claude', session: 's1', host: 'claude', cwd: '/work/pace', ...o })
const log = (h: LogHead, events: LogEvent[]) => entriesOf(logText(h, events, null).text)
const row = (o: Partial<ActivityRow>): ActivityRow => ({ hour: NOW, provider: 'claude', input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, usd: 0, prompts: 0, replies: 0, ...o })

describe('activity as hourly rows', () => {
  test('each hour\'s tokens, dollars, prompts and replies, by provider, account, harness, repo and model', () => {
    const rows = activityOf(log(head(), [
      { at: NOW + 60_000, prompt: true, model: 'claude-opus-4-6' },
      { at: NOW + 120_000, tokens: tk(1000, 200, 50_000, 300, 0), model: 'claude-opus-4-6' },
      { at: NOW + 180_000, tokens: tk(500, 100), model: 'claude-opus-4-6' },
      { at: NOW + 200_000, usd: 0.75, model: 'claude-opus-4-6' },
      { at: NOW + H, tokens: tk(10, 1), model: 'claude-haiku-4-5' },
    ]))
    expect(rows).toEqual([
      { hour: NOW, provider: 'claude', harness: 'claude', repo: 'pace', model: 'claude-opus-4-6', input: 1500, output: 300, cacheRead: 50_000, cacheWrite: 300, reasoning: 0, usd: 0.75, prompts: 1, replies: 2 },
      { hour: NOW + H, provider: 'claude', harness: 'claude', repo: 'pace', model: 'claude-haiku-4-5', input: 10, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0, usd: 0, prompts: 0, replies: 1 },
    ])
  })

  test('a header that names the repo (a worktree\'s) is counted under it, not under its folder', () => {
    const rows = activityOf(log(head({ cwd: '/Users/me/.maestro/worktrees/31908816', repo: 'maestro' }), [{ at: NOW, tokens: tk(1, 1) }]))
    expect(rows[0]!.repo).toBe('maestro')
  })

  test('readings are no activity; a header from before (no harness, no folder) still counts', () => {
    const rows = activityOf(log({ provider: 'codex', session: 'c1', account: 'a1' }, [{ at: NOW, quotas: {} }, { at: NOW, tokens: tk(1, 1) }]))
    expect(rows).toEqual([row({ provider: 'codex', account: 'a1', input: 1, output: 1, replies: 1 })])
  })

  test('the tokens metric is everything the model read and wrote: in, out, cache read and cache write', () => {
    expect(valueOf(row({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4, reasoning: 1 }), 'tokens')).toBe(10)
    expect(METRICS).toEqual(['tokens', 'input', 'output', 'cacheRead', 'cacheWrite', 'reasoning', 'usd', 'prompts', 'replies'])
  })
})

describe('a finished day\'s activity in its checkpoint', () => {
  test('is kept with the day, and read back', () => {
    const cp = checkpointOf('2026-11-03', log(head(), [{ at: Date.UTC(2026, 10, 3, 9), tokens: tk(1, 1) }]))
    expect(checkpointFrom(JSON.stringify(cp))!.activity).toEqual([row({ hour: Date.UTC(2026, 10, 3, 9), harness: 'claude', repo: 'pace', input: 1, output: 1, replies: 1 })])
  })

  test('a checkpoint from before activity reads back with none, to be folded again', () => {
    expect(checkpointFrom('{"version":1,"day":"2026-11-03","parts":[]}')!.activity).toBe(undefined)
  })
})

describe('activity kept', () => {
  test('a finished day from its checkpoint, the open days as their lines arrive; the same rows back while nothing changed', () => {
    const a = new Activity()
    a.setDay('2026-11-03', [row({ hour: NOW - 3 * DAY, input: 5 })])
    a.append(log(head(), [{ at: NOW, tokens: tk(1, 0) }]))
    const first = a.rows()
    expect(first.map(r => r.input)).toEqual([5, 1])
    expect(a.rows()).toBe(first)
    a.append(log(head(), [{ at: NOW + 1, tokens: tk(2, 0) }]))
    expect(a.rows().map(r => r.input)).toEqual([5, 3])
  })

  test('a day folded later replaces its open lines', () => {
    const a = new Activity()
    a.append(log(head(), [{ at: NOW - 3 * DAY, tokens: tk(1, 0) }]))
    a.setDay('2026-11-03', [row({ hour: NOW - 3 * DAY, input: 1 })])
    expect(a.rows().map(r => r.input)).toEqual([1])
  })
})

describe('asking activity a question', () => {
  const rows = [
    row({ hour: NOW, model: 'claude-opus-4-6', input: 100, output: 10, usd: 2, prompts: 1, replies: 1 }),
    row({ hour: NOW - H, model: 'claude-haiku-4-5', input: 50, output: 5, usd: 0.1, replies: 1 }),
    row({ hour: NOW - 2 * DAY, model: 'claude-opus-4-6', input: 1000, output: 100, usd: 20, replies: 3 }),
    row({ hour: NOW - 400 * DAY, provider: 'codex', model: 'gpt-5', input: 7, output: 7, replies: 1 }),
  ]

  test('a day: the last 24 hours, an hour a bar, each model\'s share', () => {
    const r = activityQuery(rows, { metric: 'tokens', range: 'day', by: 'model', only: {} }, NOW, { zone: 0 })
    expect(r.bins.length).toBe(24)
    expect(r.bins.at(-1)!.start).toBe(NOW)
    expect(r.groups.map(g => [g.label, g.total])).toEqual([['opus-4-6', 110], ['haiku-4-5', 55]])
    expect(r.groups[0]!.values.at(-1)).toBe(110)
    expect(r.groups[1]!.values.at(-2)).toBe(55)
    expect(r.total).toBe(165)
    expect(r.totals.usd).toBe(2.1)
  })

  test('a week is seven days, a day a bar, from the local midnight', () => {
    // Three hours behind UTC: today began at 03:00 UTC
    const r = activityQuery(rows, { metric: 'usd', range: 'week', by: 'provider', only: {} }, NOW, { zone: -3 * H })
    expect(r.bins.length).toBe(7)
    expect(r.bins.at(-1)!.start).toBe(Date.UTC(2026, 10, 6, 3))
    expect(r.total).toBe(22.1)
  })

  test('a month is thirty days; a year twelve months', () => {
    expect(activityQuery(rows, { metric: 'replies', range: 'month', by: 'provider', only: {} }, NOW, { zone: 0 }).bins.length).toBe(30)
    const year = activityQuery(rows, { metric: 'replies', range: 'year', by: 'provider', only: {} }, NOW, { zone: 0 })
    expect(year.bins.length).toBe(12)
    expect(year.bins.at(-1)!.start).toBe(Date.UTC(2026, 10, 1))
    expect(year.total).toBe(5)
  })

  test('all of history: a month a bar from the first, no cap', () => {
    const r = activityQuery(rows, { metric: 'replies', range: 'all', by: 'provider', only: {} }, NOW, { zone: 0 })
    expect(r.bins[0]!.start).toBe(Date.UTC(2025, 9, 1))
    expect(r.total).toBe(6)
    expect(r.groups.map(g => g.value)).toEqual(['claude', 'codex'])
  })

  test('a short history shows a day a bar', () => {
    const r = activityQuery(rows.slice(0, 3), { metric: 'replies', range: 'all', by: 'provider', only: {} }, NOW, { zone: 0 })
    expect(r.bins.length).toBe(3)
  })

  test('filters keep only what they name', () => {
    const r = activityQuery(rows, { metric: 'tokens', range: 'all', by: 'model', only: { provider: ['codex'] } }, NOW, { zone: 0 })
    expect(r.groups.map(g => g.value)).toEqual(['gpt-5'])
    expect(r.total).toBe(14)
  })

  test('past seven groups, the rest are one: other', () => {
    const many = Array.from({ length: 10 }, (_, i) => row({ hour: NOW, repo: `r${i}`, input: 10 - i }))
    const r = activityQuery(many, { metric: 'input', range: 'day', by: 'repo', only: {} }, NOW, { zone: 0 })
    expect(r.groups.length).toBe(8)
    expect(r.groups.at(-1)).toMatchObject({ label: 'other', total: 6 })
  })
})

describe('activity\'s chips', () => {
  const rows = [row({ provider: 'claude', model: 'claude-opus-4-6', input: 9 }), row({ provider: 'codex', model: 'gpt-5', input: 1 })]

  test('metric, range and breakdown, then a row for each dimension with the values seen, the busiest first', () => {
    const chips = activityChips(rows, DEFAULT_QUERY, {})
    expect(chips.map(r => r.title)).toEqual(['Metric', 'Range', 'By', 'Provider', 'Account', 'Harness', 'Repo', 'Model'])
    expect(chips[0]!.chips.find(c => c.on)!.value).toBe('tokens')
    expect(chips[3]!.chips.map(c => c.label)).toEqual(['All', 'Claude', 'Codex'])
    expect(chips[7]!.chips.map(c => c.label)).toEqual(['All', 'opus-4-6', 'gpt-5'])
  })

  test('a click makes the next question', () => {
    const chips = activityChips(rows, DEFAULT_QUERY, {})
    const month = pressed(DEFAULT_QUERY, chips[1]!.chips.find(c => c.value === 'month')!)
    expect(month.range).toBe('month')
    const codex = pressed(month, chips[3]!.chips.find(c => c.value === 'codex')!)
    expect(codex.only).toEqual({ provider: ['codex'] })
    expect(pressed(codex, chips[3]!.chips[0]!).only).toEqual({ provider: [] })
  })
})
