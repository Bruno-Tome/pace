// The prompting rate against a quota (the 5-hour window, or a week from a reading inside the last day), and the
// terminal drawing primitives (bar cells, sparkline).
// Pure functions; never touches `$`. Times are ms timestamps.

import type { PaceRateLevel, PaceReading } from '../types'

const MIN = 60_000

/** `burst`: the recent rate empties the quota before its reset though its average would not; `fast`: it does and the quota is over pace too */
export type RateLevel = PaceRateLevel

export type RateVerdict = {
  /** Prompts in the last 15 minutes */
  last15: number
  /** Prompts per hour, measured over the last 30 minutes */
  perHour: number
  /** Percent of the 5-hour window one prompt costs, averaged over this window; null below 3 prompts */
  costPerPrompt: number | null
  /** Prompts per hour that would land exactly at 100% on reset */
  budgetPerHour: number | null
  /** Seconds until 100% at the current rate */
  emptyIn: number | null
  /** Seconds until the 5-hour window resets */
  resetIn: number | null
  level: RateLevel
  /** Dollars an hour every session spends, where the rate is judged in dollars */
  usdPerHour?: number
  /** Dollars an hour that would land exactly at 100% on reset */
  usdBudgetPerHour?: number | null
}

const countSince = (prompts: readonly number[], from: number, now: number) =>
  prompts.reduce((n, t) => (t > from && t <= now ? n + 1 : n), 0)

/**
 * The prompting rate against one quota. `since` is a reading of that quota earlier in its window (its start at 0%
 * for a short one; for a week, one inside the day of prompts kept): what it moved since then, over the prompts
 * since then, is the cost of a prompt. No `since`, no cost.
 */
export function rateSince(prompts: readonly number[], reading: PaceReading | undefined, since: { at: number; percent: number } | null, now: number): RateVerdict {
  const last15 = countSince(prompts, now - 15 * MIN, now)
  const perHour = countSince(prompts, now - 30 * MIN, now) * 2
  const resetIn = reading?.resetsAt != null && reading.resetsAt > now ? (reading.resetsAt - now) / 1000 : null

  let costPerPrompt: number | null = null
  let budgetPerHour: number | null = null
  let emptyIn: number | null = null
  if (reading && since && resetIn != null) {
    // Prompts from before this mod was installed are missing, which errs toward a higher cost
    const n = countSince(prompts, since.at, now)
    const moved = reading.percent - since.percent
    if (n >= 3 && moved > 0) {
      costPerPrompt = moved / n
      const left = Math.max(0, 100 - reading.percent) / costPerPrompt
      budgetPerHour = left / (resetIn / 3600)
      if (perHour > 0) emptyIn = (left / perHour) * 3600
    }
  }

  let level: RateLevel = 'ok'
  if (perHour === 0 && last15 === 0) level = 'idle'
  else if (emptyIn != null && resetIn != null && emptyIn < resetIn) level = 'fast'
  else if (budgetPerHour != null && perHour > 0.75 * budgetPerHour) level = 'brisk'

  return { last15, perHour, costPerPrompt, budgetPerHour, emptyIn, resetIn, level }
}

const usd = (n: number) => `$${n >= 10 ? Math.round(n) : n.toFixed(1)}`

/** The rate as said: dollars an hour where it is judged in dollars, else prompts an hour */
export const rateText = (v: RateVerdict) => (v.usdPerHour != null ? `${usd(v.usdPerHour)}/h` : `${v.perHour}/h`)

/** The rate that lands at 100% on reset, said the same way; null where unknown */
export function budgetText(v: RateVerdict): string | null {
  if (v.usdPerHour != null) return v.usdBudgetPerHour != null ? `${usd(v.usdBudgetPerHour)}/h` : null
  return v.budgetPerHour != null ? `${Math.floor(v.budgetPerHour)}/h` : null
}

export type CellKind = 'used' | 'ahead' | 'margin' | 'tick' | 'empty'
export type Cell = { kind: CellKind }

/**
 * A bar `width` cells wide. `used`: fill on pace; `ahead`: fill past the clock; `margin`: unused time already gone
 * (headroom you have banked); `tick`: where the clock is; `empty`: the rest of the window.
 */
export function bar(used: number, elapsed: number | null, width: number): Cell[] {
  const tick = elapsed == null ? -1 : Math.min(width - 1, Math.floor(elapsed * width))
  return Array.from({ length: width }, (_, i) => {
    const pos = (i + 0.5) / width
    if (pos < used) return { kind: elapsed != null && pos > elapsed ? 'ahead' : 'used' }
    if (i < tick) return { kind: 'margin' }
    if (i === tick) return { kind: 'tick' }
    return { kind: 'empty' }
  })
}

const BLOCKS = ' ▁▂▃▄▅▆▇█'

export function sparkline(values: readonly number[], max = Math.max(0, ...values)): string {
  return values.map(v => BLOCKS[max > 0 ? Math.round((Math.min(v, max) / max) * 8) : 0]).join('')
}

/** Counts of prompts in `n` buckets of `bucketMs`, oldest first, the last ending at `now` */
export function buckets(prompts: readonly number[], now: number, n: number, bucketMs: number): number[] {
  const out = new Array<number>(n).fill(0)
  for (const t of prompts) {
    const back = Math.floor((now - t) / bucketMs)
    if (back >= 0 && back < n) out[n - 1 - back] = (out[n - 1 - back] ?? 0) + 1
  }
  return out
}

/** Keep prompts from the last day, merged and sorted, at most 4000 */
export function mergePrompts(a: readonly number[], b: readonly number[], now: number): number[] {
  const all = [...new Set([...a, ...b])].filter(t => typeof t === 'number' && t > now - 24 * 60 * MIN).sort((x, y) => x - y)
  return all.slice(-4000)
}
