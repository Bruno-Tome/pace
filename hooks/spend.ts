// Spend shared by every local session, and what it says about the quotas: how much of a quota a dollar uses,
// what a prompt costs, and whether the dollars an hour all sessions spend fit what a quota has left.
// Pure; times in ms.
//
// Each session adds what its replies cost to its own bucket for the minute, under an id of its own, and merges
// its list into the store's. A bucket only grows and only its session writes it, so a merge keeps the larger of
// two copies: parallel sessions never undo each other. Buckets older than two hours fold into hours, a session's
// minutes summed first, so a half-copied hour loses to a full one in the same way.

import type { PaceReading, PaceSample, PaceSpend } from '../types'
import { pctAt, pctBudget, type RateVerdict } from './rate.ts'

export type Spend = PaceSpend

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
/** Spend kept: a week's window and a day either side */
const KEEP = 8 * DAY
/** Minute buckets kept before they fold into hours */
const FOLD_AFTER = 2 * HOUR

/** Whether a bucket from `t` is folded into its hour by `now` */
const folds = (t: number, now: number) => t < now - FOLD_AFTER

/** One copy's buckets by session and slot, each slot's minutes summed */
function fold(list: readonly Spend[], now: number): Map<string, Spend> {
  const out = new Map<string, Spend>()
  for (const s of list) {
    if (typeof s?.t !== 'number' || typeof s.usd !== 'number' || typeof s.id !== 'string' || s.t < now - KEEP) continue
    const h = s.h || folds(s.t, now)
    const t = Math.floor(s.t / (h ? HOUR : MIN)) * (h ? HOUR : MIN)
    const m = typeof s.m === 'string' ? s.m : undefined
    const key = `${s.id}@${t}${h ? 'h' : ''}${m ? `:${m}` : ''}`
    out.set(key, { t, id: s.id, usd: (out.get(key)?.usd ?? 0) + s.usd, ...(h ? { h: true as const } : {}), ...(m ? { m } : {}) })
  }
  return out
}

/** Two copies of the shared spend as one: per session and slot, the larger */
export function mergeSpend(a: readonly Spend[], b: readonly Spend[], now: number): Spend[] {
  const out = fold(a, now)
  for (const [key, s] of fold(b, now)) if (s.usd > (out.get(key)?.usd ?? -1)) out.set(key, s)
  return [...out.values()].sort((x, y) => x.t - y.t || (x.id < y.id ? -1 : 1))
}

/** `usd` this session (`id`) spent at `at` on `model`, added to its bucket for that minute */
export function addSpend(list: readonly Spend[], id: string, at: number, usd: number, now: number, model?: string): Spend[] {
  if (!(usd > 0)) return mergeSpend(list, [], now)
  return mergeSpend([...list, { t: at, id, usd, ...(model ? { m: model } : {}) }], [], now)
}

/** Dollars every session spent in (from, to]: a minute's bucket at its minute, an hour's spread evenly over it */
export function spendIn(list: readonly Spend[], from: number, to: number): number {
  return list.reduce((n, s) => {
    if (!s.h) return s.t > from && s.t <= to ? n + s.usd : n
    const overlap = Math.min(to, s.t + HOUR) - Math.max(from, s.t)
    return overlap > 0 ? n + (s.usd * overlap) / HOUR : n
  }, 0)
}

/** Sessions that spent in the last half hour */
export function sessionsOf(list: readonly Spend[], now: number): number {
  return new Set(list.filter(s => s.t > now - 30 * MIN).map(s => s.id)).size
}

/** Dollars an hour every session spends, over the last half hour */
export const usdPerHour = (list: readonly Spend[], now: number) => spendIn(list, now - 30 * MIN, now) * 2

/** Dollars a prompt, every session's spend over every session's prompts in the last day; none below 3 prompts */
export function usdPerPrompt(list: readonly Spend[], prompts: readonly number[], now: number): number | null {
  const n = prompts.filter(t => t > now - DAY && t <= now).length
  const usd = spendIn(list, now - DAY, now)
  return n >= 3 && usd > 0 ? usd / n : null
}

/** Points a quota must have moved before its ratio counts: readings are whole points, so this keeps it within ~12% */
const MIN_POINTS = 8

/**
 * Points of a quota one dollar uses: what it moved between readings of the same window over what every session
 * spent between them, across the last week the spend covers. Spans a reset falls in are left out. Usage the mod
 * never saw (claude.ai, another machine) moves the quota without spend, which reads as a dearer dollar.
 */
export function quotaPerDollar(samples: readonly PaceSample[], key: string, spend: readonly Spend[], now: number): number | null {
  if (!spend.length) return null
  const from = Math.max(now - 7 * DAY, spend[0]!.t - HOUR)
  let points = 0
  let usd = 0
  let prev: { at: number; r: PaceReading } | null = null
  for (const s of samples) {
    const r = s.quotas[key]
    if (!r || s.at < from || s.at > now) continue
    if (prev && r.resetsAt != null && prev.r.resetsAt != null && Math.abs(r.resetsAt - prev.r.resetsAt) <= 90_000 && r.percent >= prev.r.percent) {
      const spent = spendIn(spend, prev.at, s.at)
      // Moved with nothing spent here: usage pace cannot see (claude.ai, another machine) would make a dollar look dearer
      if (spent > 0 || r.percent === prev.r.percent) {
        points += r.percent - prev.r.percent
        usd += spent
      }
    }
    prev = { at: s.at, r }
  }
  return points >= MIN_POINTS && usd >= 1 ? points / usd : null
}

export type SpendInput = {
  /** Prompt times from every session */
  prompts: readonly number[]
  /** The quota's latest reading */
  reading: PaceReading
  /** Points of the quota a dollar uses */
  perDollar: number
  usdPerPrompt: number
  usdPerHour: number
  now: number
}

/** The prompting rate against a quota, judged in dollars an hour across every session */
export function spendVerdict(i: SpendInput): RateVerdict {
  const count = (from: number) => i.prompts.reduce((n, t) => (t > from && t <= i.now ? n + 1 : n), 0)
  const last15 = count(i.now - 15 * MIN)
  const perHour = count(i.now - 30 * MIN) * 2
  const resetIn = i.reading.resetsAt != null && i.reading.resetsAt > i.now ? (i.reading.resetsAt - i.now) / 1000 : null
  const leftUsd = Math.max(0, 100 - i.reading.percent) / i.perDollar
  const usdBudgetPerHour = resetIn != null ? leftUsd / (resetIn / 3600) : null
  const emptyIn = i.usdPerHour > 0 ? (leftUsd / i.usdPerHour) * 3600 : null
  let level: RateVerdict['level'] = 'ok'
  if (perHour === 0 && last15 === 0 && i.usdPerHour === 0) level = 'idle'
  else if (emptyIn != null && resetIn != null && emptyIn < resetIn) level = 'fast'
  else if (usdBudgetPerHour != null && i.usdPerHour > 0.75 * usdBudgetPerHour) level = 'brisk'
  return {
    last15,
    perHour,
    costPerPrompt: i.perDollar * i.usdPerPrompt,
    budgetPerHour: usdBudgetPerHour != null ? usdBudgetPerHour / i.usdPerPrompt : null,
    emptyIn,
    resetIn,
    level,
    usdPerHour: i.usdPerHour,
    usdBudgetPerHour,
    pctPerHour: i.usdPerHour * i.perDollar,
    pctBudgetPerHour: pctBudget(i.reading, resetIn),
    pctAtReset: pctAt(i.reading, i.usdPerHour * i.perDollar, resetIn),
  }
}

/**
 * Whose dollars a cost reading brings: the one model that answered since the last reading (a subagent's on haiku
 * counts toward haiku, not the session's week), the session's when none was seen, and none when several answered:
 * spend with no model counts against every quota, so it is never under-warned.
 */
export function spendModel(answered: readonly string[], session: string | undefined): string | undefined {
  const models = new Set(answered)
  return models.size === 0 ? session : models.size === 1 ? [...models][0] : undefined
}
