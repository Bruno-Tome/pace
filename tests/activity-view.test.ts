import { describe, expect, test } from 'claude-code/testing'

import { activityChips, activityQuery, DEFAULT_QUERY, type ActivityRow } from '../core/activity.ts'
import { activityLines, chipLines, compactOf } from '../core/view.ts'

const H = 3600_000
const NOW = Date.UTC(2026, 10, 6, 12)
const row = (o: Partial<ActivityRow>): ActivityRow => ({ hour: NOW, provider: 'claude', input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, usd: 0, prompts: 0, replies: 0, ...o })
const text = (l: { t: string }[]) => l.map(s => s.t).join('')
const rows = [
  row({ hour: NOW, provider: 'claude', input: 3_000_000, output: 100_000, usd: 40, prompts: 12, replies: 30 }),
  row({ hour: NOW - 24 * H, provider: 'codex', input: 1_000_000, output: 50_000, usd: 0, prompts: 4, replies: 9 }),
]

describe('activity drawn', () => {
  const r = activityQuery(rows, DEFAULT_QUERY, NOW, { zone: 0 })
  const lines = activityLines(r, { cols: 80, rows: 20 })

  test('says what it shows and its total', () => {
    expect(text(lines[0]!)).toContain('Tokens · Week · by Provider')
    expect(text(lines[0]!)).toContain('4.2M')
  })

  test('stacks each group in its own colour, the tallest bar reaching the top', () => {
    const bars = lines.filter(l => l.some(s => s.t.includes('█')))
    expect(bars.length).toBeGreaterThan(5)
    const colours = new Set(lines.flatMap(l => l.filter(s => /[▁-█]/.test(s.t)).map(s => s.color)))
    expect(colours.size).toBe(2)
  })

  test('a legend with each group\'s share, and every metric\'s total', () => {
    const all = lines.map(text).join('\n')
    expect(all).toContain('Claude')
    expect(all).toContain('75%')
    expect(all).toContain('$40.00')
    expect(all).toContain('16 prompts')
    expect(all).toContain('39 replies')
  })

  test('fits the width it is given', () => {
    for (const cols of [40, 80, 140]) for (const l of activityLines(r, { cols, rows: 20 })) expect([...text(l)].length <= cols).toBe(true)
  })

  test('a range with nothing in it says so', () => {
    const none = activityQuery([], DEFAULT_QUERY, NOW, { zone: 0 })
    expect(activityLines(none, { cols: 80, rows: 20 }).map(text).join('\n')).toContain('No activity')
  })
})

describe('numbers, short', () => {
  test('thousands, millions, billions; dollars with cents', () => {
    expect(compactOf(999, 'tokens')).toBe('999')
    expect(compactOf(4_150_000, 'tokens')).toBe('4.2M')
    expect(compactOf(1_200, 'input')).toBe('1.2k')
    expect(compactOf(3_400_000_000, 'tokens')).toBe('3.4B')
    expect(compactOf(86.4, 'usd')).toBe('$86.40')
    expect(compactOf(1_250, 'usd')).toBe('$1.3k')
  })
})

describe('chips drawn for a terminal', () => {
  test('each chip where it can be clicked, the ones on picked out, rows wrapped to the width', () => {
    const chips = activityChips(rows, DEFAULT_QUERY, {})
    const { lines, hits } = chipLines(chips, 60)
    expect(hits.some(h => h.key === 'metric:tokens' && h.label === 'Tokens')).toBe(true)
    const hit = hits.find(h => h.key === 'provider:codex')!
    // The hit's column and row point at its label
    expect(text(lines[hit.y - 1]!).slice(hit.x - 1, hit.x - 1 + hit.w)).toContain('Codex')
    expect(lines.flat().find(s => s.t.includes('Tokens'))!.bold).toBe(true)
    for (const l of lines) expect([...text(l)].length <= 60).toBe(true)
  })

  test('the chip in focus in brackets, the same width', () => {
    const chips = activityChips(rows, DEFAULT_QUERY, {})
    const { lines } = chipLines(chips, 60, 1)
    expect(text(lines[0]!)).toContain('[Input]')
    expect(text(lines[0]!).length).toBe(text(chipLines(chips, 60).lines[0]!).length)
  })
})
