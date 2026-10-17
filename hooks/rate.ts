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
  /** Points of this quota an hour at the current rate: the rate scored against this quota alone; null without a cost */
  pctPerHour: number | null
  /** Points of this quota an hour that would land exactly at 100% on reset */
  pctBudgetPerHour: number | null
  /** Percent used at the reset if the rate keeps up, past 100 where it runs out first; null without a cost */
  pctAtReset: number | null
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

  const pctPerHour = costPerPrompt != null ? costPerPrompt * perHour : null
  return {
    last15, perHour, costPerPrompt, budgetPerHour, emptyIn, resetIn, level,
    pctPerHour,
    pctBudgetPerHour: pctBudget(reading, resetIn),
    pctAtReset: pctAt(reading, pctPerHour, resetIn),
  }
}

/** Points an hour that spend what a quota has left exactly by its reset */
export const pctBudget = (reading: PaceReading | undefined, resetIn: number | null) =>
  reading && resetIn != null ? Math.max(0, 100 - reading.percent) / (resetIn / 3600) : null

/** Where a quota lands by its reset at `pctPerHour`: it closes in on what is used as the reset nears */
export const pctAt = (reading: PaceReading | undefined, pctPerHour: number | null, resetIn: number | null) =>
  reading && pctPerHour != null && resetIn != null ? reading.percent + pctPerHour * (resetIn / 3600) : null

const usd = (n: number) => `$${n >= 10 ? Math.round(n) : n.toFixed(1)}`
const pct = (n: number) => `${n >= 10 ? Math.round(n) : n >= 1 ? n.toFixed(1) : n.toFixed(2)}%`

/** The rate scored against its own quota, points of it an hour; `—%/h` until it has a cost */
export const scoreText = (v: RateVerdict) => `${v.pctPerHour != null ? pct(v.pctPerHour) : '—%'}/h`

/** The rate as said: dollars an hour where it is judged in dollars, else prompts an hour; shared by every quota */
export const rateText = (v: RateVerdict) => (v.usdPerHour != null ? `${usd(v.usdPerHour)}/h` : `${v.perHour}/h`)

/** The rate that lands at 100% on reset, said the same way; null where unknown */
export function budgetText(v: RateVerdict): string | null {
  if (v.usdPerHour != null) return v.usdBudgetPerHour != null ? `${usd(v.usdBudgetPerHour)}/h` : null
  return v.budgetPerHour != null ? `${Math.floor(v.budgetPerHour)} prompts/h` : null
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
    // The clock's tick shows over the fill too, so a quota over pace still says where even pace is
    if (i === tick) return { kind: 'tick' }
    if (pos < used) return { kind: elapsed != null && pos > elapsed ? 'ahead' : 'used' }
    if (i < tick) return { kind: 'margin' }
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

/** Two copies of the prompts by model as one: each model's lists merged; a list that does not parse is dropped */
export function mergeModelPrompts(a: Readonly<Record<string, readonly number[]>>, b: Readonly<Record<string, readonly number[]>>, now: number): Record<string, number[]> {
  const out: Record<string, number[]> = {}
  for (const model of new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})])) {
    const list = mergePrompts(Array.isArray(a?.[model]) ? a[model]! : [], Array.isArray(b?.[model]) ? b[model]! : [], now)
    if (list.length) out[model] = list
  }
  return out
}
