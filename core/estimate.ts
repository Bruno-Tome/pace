// Quotas a host is told nothing of, inferred from what it spends: pi's. A window opens with the first activity after
// the last one ended and resets its length later; its use is what was spent in it over what it holds, in dollars,
// learned from a limit reached or from real readings of the same provider. Pure; times in ms.

import type { PaceSample, PaceSpend } from '../types'
import { quotaPerDollar, spendIn } from './spend.ts'

/** What a window holds, in dollars of spend, and how it was learned: a limit reached, or real readings */
export type Capacity = { usd: number; at: number; source: 'limit' | 'reading' }
/** The capacities learned, by quota key */
export type Capacities = Partial<Record<string, Capacity>>

const HOUR = 3600_000
/** The windows pace estimates, by quota key, in ms */
export const WINDOWS: Record<string, number> = { five_hour: 5 * HOUR, seven_day: 7 * 24 * HOUR }

/** Dollars spent in a window by `to`: the spend that opened it counts, where spendIn's span leaves its start out */
const spentIn = (spend: readonly PaceSpend[], start: number, to: number) => spendIn(spend, start - 1, to)

/** The times something happened: prompts, and the spend's buckets */
const activityOf = (spend: readonly PaceSpend[], prompts: readonly number[]) => [...prompts, ...spend.map(s => s.t)]

/** The window of `length` open at `now`, given when there was activity; null when none is open */
export function windowOf(activity: readonly number[], length: number, now: number): { start: number; resetsAt: number } | null {
  let start: number | null = null
  for (const t of [...activity].filter(t => t <= now).sort((a, b) => a - b)) if (start == null || t >= start + length) start = t
  return start != null && now < start + length ? { start, resetsAt: start + length } : null
}

/** A window's capacity, from its limit reached at `at`: what was spent in it by then; null with nothing spent */
export function capacityAtLimit(spend: readonly PaceSpend[], prompts: readonly number[], key: string, at: number): Capacity | null {
  const w = windowOf(activityOf(spend, prompts), WINDOWS[key] ?? 0, at)
  const usd = w ? spentIn(spend, w.start, at) : 0
  return usd > 0 ? { usd, at, source: 'limit' } : null
}

/** A window's capacity, from real readings of it and the spend between them; null when they do not say */
export function capacityFromReadings(samples: readonly PaceSample[], key: string, spend: readonly PaceSpend[], now: number): Capacity | null {
  const perDollar = quotaPerDollar(samples.filter(s => !s.quotas[key]?.estimated), key, spend, now)
  const last = samples.filter(s => s.quotas[key] && !s.quotas[key]!.estimated && s.at <= now).at(-1)
  return perDollar && last ? { usd: 100 / perDollar, at: last.at, source: 'reading' } : null
}

/** Each window's spend since it opened and when it resets (null when none is open), for a host that knows no capacity yet */
export function spentWindows(spend: readonly PaceSpend[], prompts: readonly number[], now: number): { key: string; usd: number; resetsAt: number | null }[] {
  return Object.entries(WINDOWS).map(([key, length]) => {
    const w = windowOf(activityOf(spend, prompts), length, now)
    return { key, usd: w ? spentIn(spend, w.start, now) : 0, resetsAt: w?.resetsAt ?? null }
  })
}

/** The estimated reading of each window with a known capacity, at `now`; null when no capacity is known */
export function estimateOf(spend: readonly PaceSpend[], prompts: readonly number[], capacities: Capacities, now: number): PaceSample | null {
  const quotas: PaceSample['quotas'] = {}
  for (const [key, capacity] of Object.entries(capacities)) {
    if (!capacity || !WINDOWS[key]) continue
    const w = windowOf(activityOf(spend, prompts), WINDOWS[key]!, now)
    quotas[key] = w
      ? { percent: Math.min(100, (spentIn(spend, w.start, now) / capacity.usd) * 100), resetsAt: w.resetsAt, estimated: true }
      : { percent: 0, estimated: true }
  }
  return Object.keys(quotas).length ? { at: now, quotas } : null
}

/** What a host saw since it last learned: its spend and prompts, real readings of its provider, a limit it reached */
export type Seen = { spend: readonly PaceSpend[]; prompts: readonly number[]; samples: readonly PaceSample[]; limitAt?: number }

/** Below this estimate, a limit reached is not the 5-hour window's: the week ran out */
const FULL = 80

/**
 * The window a limit reached at `at` filled. The host is not told which: the 5-hour window, unless its estimate says it
 * is well under full
 */
function limitKey(c: Capacities, i: Seen, at: number): string {
  const five = estimateOf(i.spend, i.prompts, { five_hour: c.five_hour }, at)?.quotas.five_hour
  return five && five.percent < FULL ? 'seven_day' : 'five_hour'
}

/** The capacities after what was seen: a limit reached sets its window's; real readings newer than a capacity replace it */
export function learn(c: Capacities, i: Seen, now: number): Capacities {
  const out: Capacities = { ...c }
  for (const key of Object.keys(WINDOWS)) {
    const read = capacityFromReadings(i.samples, key, i.spend, now)
    if (read && read.at > (out[key]?.at ?? -Infinity)) out[key] = read
  }
  if (i.limitAt != null) {
    const key = limitKey(out, i, i.limitAt)
    const hit = capacityAtLimit(i.spend, i.prompts, key, i.limitAt)
    if (hit) out[key] = hit
  }
  return out
}
