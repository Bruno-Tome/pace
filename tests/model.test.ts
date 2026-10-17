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
