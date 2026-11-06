import { describe, expect, test } from 'claude-code/testing'

import type { PaceSample } from '../types'
import { rateOf, rowsOf } from '../core/model.ts'
import { addSpend, mergeCopies, mergeSpend, unionMax, quotaPerDollar, sessionsOf, spendIn, spendModel, spendVerdict, usdPerPrompt } from '../core/spend.ts'

const NOW = Date.UTC(2026, 9, 17, 12, 0, 0)
const MIN = 60_000
const H = 60 * MIN
const near = (x: number | null | undefined, y: number) => expect(x != null && Math.abs(x - y) < 1e-6 ? y : x).toBe(y)

describe('shared spend', () => {
  test('parallel sessions add up, and merging either way round loses neither', () => {
    const a = addSpend([], 'a', NOW - 5 * MIN, 0.4, NOW)
    const b = addSpend([], 'b', NOW - 5 * MIN, 0.6, NOW)
    near(spendIn(mergeSpend(a, b, NOW), NOW - H, NOW), 1)
    near(spendIn(mergeSpend(b, a, NOW), NOW - H, NOW), 1)
    expect(sessionsOf(mergeSpend(a, b, NOW), NOW)).toBe(2)
  })

  test('a stale copy of a session\'s spend never undoes what it added since', () => {
    const early = addSpend([], 'a', NOW - 10 * MIN, 0.5, NOW)
    const later = addSpend(early, 'a', NOW - 10 * MIN, 0.25, NOW)
    near(spendIn(mergeSpend(later, early, NOW), NOW - H, NOW), 0.75)
    near(spendIn(mergeSpend(early, later, NOW), NOW - H, NOW), 0.75)
  })

  test('old minutes fold into hours, the totals unchanged, and spend past 8 days goes', () => {
    let list: ReturnType<typeof addSpend> = []
    for (let i = 0; i < 30; i++) list = addSpend(list, 'a', NOW - 5 * H + i * MIN, 0.1, NOW - 5 * H + i * MIN)
    list = addSpend(list, 'a', NOW - 9 * 24 * H, 5, NOW - 9 * 24 * H)
    const merged = mergeSpend(list, [], NOW)
    expect(merged.length).toBeLessThanOrEqual(2)
    near(spendIn(merged, NOW - 6 * H, NOW), 3)
    near(spendIn(merged, 0, NOW), 3)
    // Folding a half-copied hour and a full one keeps the full one
    const partial = mergeSpend(list.slice(0, 10), [], NOW)
    near(spendIn(mergeSpend(partial, merged, NOW), 0, NOW), 3)
  })
})

describe('many copies of the shared spend', () => {
  test('five feeds carrying the same dollar are one dollar, however often they are merged', () => {
    let copies = Array.from({ length: 5 }, () => addSpend([], 's1', NOW - MIN, 1, NOW))
    for (let round = 0; round < 3; round++) {
      const merged = mergeCopies(copies, NOW)
      near(spendIn(merged, NOW - H, NOW), 1)
      copies = copies.map(() => merged)
    }
  })

  test('copies that each know a different session add up', () => {
    near(spendIn(mergeCopies([addSpend([], 'a', NOW - MIN, 0.4, NOW), addSpend([], 'b', NOW - MIN, 0.6, NOW)], NOW), NOW - H, NOW), 1)
  })

  test('a bucket no session could spend is dropped, so a copy gone wrong cannot win the merge', () => {
    // A minute bucket of $1e105, as the compounding wrote: no session spends that, and the larger would win
    const bad = [{ t: NOW - MIN, id: 's1', usd: 1.03e105 }]
    near(spendIn(mergeSpend(bad, addSpend([], 's1', NOW - MIN, 1, NOW), NOW), NOW - H, NOW), 1)
    expect(mergeSpend([{ t: NOW - MIN, id: 's1', usd: Infinity }], [], NOW)).toEqual([])
  })
})

describe('two copies already folded', () => {
  test('join without folding again: per session and slot the larger, the rest as they are', () => {
    const a = [{ t: NOW - 3 * H, id: 's1', usd: 2, h: true as const }, { t: NOW - MIN, id: 's1', usd: 1 }]
    const b = [{ t: NOW - 3 * H, id: 's1', usd: 5, h: true as const }, { t: NOW - MIN, id: 's2', usd: 0.5 }]
    expect(unionMax(a, b)).toEqual([{ t: NOW - 3 * H, id: 's1', usd: 5, h: true }, { t: NOW - MIN, id: 's1', usd: 1 }, { t: NOW - MIN, id: 's2', usd: 0.5 }])
  })
})

describe('quota per dollar', () => {
  // The 5-hour window moved 1 point per $2 across all sessions
  const reset = NOW + 2 * H
  const samples: PaceSample[] = Array.from({ length: 7 }, (_, i) => ({ at: NOW - 3 * H + i * 30 * MIN, quotas: { five_hour: { percent: 10 + i * 5, resetsAt: reset } } }))
  let spend: ReturnType<typeof addSpend> = []
  for (let i = 1; i < 7; i++) spend = addSpend(spend, i % 2 ? 'a' : 'b', NOW - 3 * H + i * 30 * MIN - MIN, 10, NOW)

  test('is what the quota moved over what every session spent in the same span', () => {
    near(quotaPerDollar(samples, 'five_hour', spend, NOW), 0.5)
  })

  test('is unknown before the spend covers enough of it', () => {
    expect(quotaPerDollar(samples, 'five_hour', [], NOW)).toBeNull()
    expect(quotaPerDollar(samples.slice(0, 2), 'five_hour', spend, NOW)).toBeNull()
  })

  test('skips the span a reset falls in: its spend bought usage the old window no longer shows', () => {
    const across: PaceSample[] = [
      { at: NOW - 3 * H, quotas: { five_hour: { percent: 90, resetsAt: NOW - 2 * H } } },
      { at: NOW - H, quotas: { five_hour: { percent: 10, resetsAt: NOW + 4 * H } } },
      { at: NOW, quotas: { five_hour: { percent: 20, resetsAt: NOW + 4 * H } } },
    ]
    let s = addSpend([], 'a', NOW - 2 * H, 50, NOW)
    s = addSpend(s, 'a', NOW - 30 * MIN, 20, NOW)
    near(quotaPerDollar(across, 'five_hour', s, NOW), 0.5)
  })

  test('leaves out a span the quota moved in with nothing spent here: usage from claude.ai or another machine', () => {
    const seen: PaceSample[] = [
      { at: NOW - 3 * H, quotas: { five_hour: { percent: 10, resetsAt: NOW + H } } },
      { at: NOW - 2 * H, quotas: { five_hour: { percent: 20, resetsAt: NOW + H } } },
      // 30 points in the next hour, not a cent of it spent by any session here
      { at: NOW - H, quotas: { five_hour: { percent: 50, resetsAt: NOW + H } } },
    ]
    // $20 moved it 10 points: half a point a dollar, not 2
    const s = addSpend([], 'a', NOW - 2.5 * H, 20, NOW)
    near(quotaPerDollar(seen, 'five_hour', s, NOW), 0.5)
  })
})

describe('spend pacing', () => {
  const prompts = Array.from({ length: 10 }, (_, i) => NOW - i * 6 * MIN)

  test('dollars per prompt are every session\'s spend over every session\'s prompts', () => {
    const spend = addSpend([], 'a', NOW - 30 * MIN, 5, NOW)
    near(usdPerPrompt(spend, prompts, NOW), 0.5)
    expect(usdPerPrompt(spend, prompts.slice(0, 2), NOW)).toBeNull()
  })

  test('prices a prompt from the first one, and judges the rate in dollars an hour', () => {
    // 0.5% per $, $1 a prompt: 0.5% a prompt. 40% left over 2h is $80, $40/h; spending $60/h runs out in 1h20m
    const v = spendVerdict({ prompts, reading: { percent: 60, resetsAt: NOW + 2 * H }, perDollar: 0.5, usdPerPrompt: 1, usdPerHour: 60, now: NOW })
    near(v.costPerPrompt, 0.5)
    near(v.usdBudgetPerHour, 40)
    near(v.budgetPerHour, 40)
    near(v.emptyIn, 80 * 60)
    // $60/h at 0.5 points a dollar, against 40 points over 2h
    near(v.pctPerHour, 30)
    near(v.pctBudgetPerHour, 20)
    // 60% and 30 points an hour for 2 hours: past 100%, it runs out first
    near(v.pctAtReset, 120)
    expect(v.level).toBe('fast')
    const slow = spendVerdict({ prompts, reading: { percent: 60, resetsAt: NOW + 2 * H }, perDollar: 0.5, usdPerPrompt: 1, usdPerHour: 20, now: NOW })
    expect(slow.level).toBe('ok')
  })
})

describe('the rate against an over-pace quota', () => {
  test('is idle with no prompt in the last 15 minutes, though a running turn still spends', () => {
    // 80% used with two thirds of the window gone: over pace, and the spend prices it
    const samples: PaceSample[] = [
      { at: NOW - 3 * H, quotas: { five_hour: { percent: 10, resetsAt: NOW + 2 * H } } },
      { at: NOW - 20 * MIN, quotas: { five_hour: { percent: 80, resetsAt: NOW + 2 * H } } },
    ]
    // The last prompt was 35 minutes ago; its turn is still running and spending
    const prompts = Array.from({ length: 10 }, (_, i) => NOW - 35 * MIN - i * 15 * MIN)
    let spend = addSpend([], 'a', NOW - 2 * H, 20, NOW)
    spend = addSpend(spend, 'a', NOW - 25 * MIN, 40, NOW)
    const s = { samples, prompts, cache: null, spend }
    const [five] = rowsOf(samples, NOW)
    expect(rateOf(s, five!, NOW).level).toBe('idle')
  })
})

describe('whose spend it is', () => {
  test('dollars go to the one model that answered since the last cost reading, else the session\'s', () => {
    expect(spendModel(['claude-haiku-5-5', 'claude-haiku-5-5'], 'claude-opus-5-5')).toBe('claude-haiku-5-5')
    expect(spendModel([], 'claude-opus-5-5')).toBe('claude-opus-5-5')
  })

  test('dollars several models earned go to none, so they count against every quota', () => {
    expect(spendModel(['claude-opus-5-5', 'claude-haiku-5-5'], 'claude-opus-5-5')).toBeUndefined()
  })
})

test('a quota\'s price over a week of readings and spend is what summing the spend between each pair of readings makes', () => {
  // The rule as written: for each pair of readings of one window, the dollars spent between them, every bucket summed
  const reference = (samples: readonly PaceSample[], key: string, list: Parameters<typeof spendIn>[0], now: number) => {
    const from = Math.max(now - 7 * 24 * H, list[0]!.t - H)
    let points = 0
    let usd = 0
    let prev: { at: number; percent: number; resetsAt: number } | null = null
    for (const s of samples) {
      const r = s.quotas[key]
      if (!r || r.resetsAt == null || s.at < from || s.at > now) continue
      if (prev && Math.abs(r.resetsAt - prev.resetsAt) <= 90_000 && r.percent >= prev.percent) {
        const spent = spendIn(list, prev.at, s.at)
        if (spent > 0 || r.percent === prev.percent) {
          points += r.percent - prev.percent
          usd += spent
        }
      }
      prev = { at: s.at, percent: r.percent, resetsAt: r.resetsAt }
    }
    return points >= 8 && usd >= 1 ? points / usd : null
  }
  // A reading every 5 minutes for 8 days, the 5-hour window climbing to 80% and resetting; spend in hours and minutes
  const samples: PaceSample[] = []
  for (let at = NOW - 8 * 24 * H; at <= NOW; at += 5 * MIN) {
    const start = Math.floor(at / (5 * H)) * 5 * H
    samples.push({ at, quotas: { five_hour: { percent: Math.round(((at - start) / (5 * H)) * 80), resetsAt: start + 5 * H } } })
  }
  const spend = [
    ...Array.from({ length: 168 }, (_, i) => ({ t: NOW - 2 * H - (168 - i) * H, id: 'a', usd: 1 + (i % 5), h: true as const })),
    ...Array.from({ length: 120 }, (_, i) => ({ t: NOW - (120 - i) * MIN, id: 'a', usd: 0.05 })),
  ]
  near(quotaPerDollar(samples, 'five_hour', spend, NOW), reference(samples, 'five_hour', spend, NOW)!)
})
