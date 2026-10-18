// What the drawings show, from the samples, the prompts and the cache: each quota's pace, the prompting rate
// against it, and what to do about token usage. Pure; times in ms.

import type { PaceAuto, PaceCacheInfo, PaceQuota, PaceReading, PaceSample, PaceSnapshot, PaceSpend, PaceWarmMode } from '../types'
import { cacheLeft, nextCost, suggestions, type Suggestion } from './cache.ts'
import * as Q from './quota.ts'
import { budgetText, judgedOnMovement, movedPerHour, rateSince, type RateVerdict } from './rate.ts'
import { quotaPerDollar, sessionsOf, spendVerdict, usdPerHour, usdPerPrompt } from './spend.ts'

const MIN = 60_000
const DAY = 24 * 60 * MIN

/** Everything a drawing reads: the band above the prompt, the pane and the window draw from the same */
export type Snapshot = {
  samples: readonly PaceSample[]
  prompts: readonly number[]
  /** The same prompts by the model they went to, where it was known */
  modelPrompts?: Readonly<Record<string, readonly number[]>>
  cache: PaceCacheInfo | null
  warm?: PaceWarmMode
  /** Dollars per input-token equivalent, from the session's replies; absent before one was priced */
  price?: number | null
  /** What every local session spent */
  spend?: readonly PaceSpend[]
  /** On pace mode, and auto mode's run */
  onPace?: boolean
  auto?: PaceAuto | null
}

/** A quota as drawn: its names, its latest reading as of now (see `asOf`), what can be shown of it and its window's length (seconds) */
export type Row = { key: string; name: string; short: string; reading?: PaceReading; view: Q.View; window: number }

export const isFable = (key: string) => /fable/i.test(key)

export function rowsOf(samples: readonly PaceSample[], now: number): Row[] {
  return Q.quotaKeys(samples).map(key => {
    const window = Q.windowOf(key)
    const last = Q.latest(samples, key)?.reading
    const reading = last && Q.asOf(last, window, now)
    return { key, name: Q.quotaName(key, reading?.name), short: Q.shortName(key, reading?.name), reading, view: Q.viewOf(reading, window, now), window }
  })
}

/** The band's two quotas: the 5-hour window and the weekly Fable one, the all-models week standing in when there is no Fable reading */
export function bandRows(rows: readonly Row[]): Row[] {
  const five = rows.find(r => r.key === 'five_hour')
  const week = rows.find(r => isFable(r.key)) ?? rows.find(r => r.key === 'seven_day')
  return [five, week].filter((r): r is Row => !!r)
}

const isOver = (row: Row) => {
  const status = Q.viewStatus(row.view)
  return status === 'over' || status === 'gassedOut'
}

/**
 * Where a quota's per-prompt cost is measured from: its window's start at 0% when that is within the day of prompts
 * kept, else its earliest reading of this window inside that day; none until that reading is half an hour old.
 */
function baselineOf(samples: readonly PaceSample[], row: Row, now: number): { at: number; percent: number } | null {
  const r = row.reading?.resetsAt
  if (r == null) return null
  const start = r - row.window * 1000
  if (start >= now - DAY) return { at: start - 1, percent: 0 }
  const first = samples.find(s => s.at >= now - DAY && Math.abs((s.quotas[row.key]?.resetsAt ?? 0) - r) <= 90_000)
  return first && first.at <= now - 30 * MIN ? { at: first.at, percent: first.quotas[row.key]!.percent } : null
}

/**
 * The prompting rate against one quota: in dollars an hour across every session once the shared spend says what
 * a dollar of it costs, else in prompts an hour against what it moved since a baseline reading. A rate that
 * empties it before the reset is `fast` only when the quota is over pace or its average alone runs it out;
 * otherwise it is a `burst`. Where the quota's readings measure its movement, that sets the rate and `idle` means it
 * has not moved. Otherwise, with no per-prompt cost yet, a quota over pace is `fast` at any rate, and with no
 * prompt in the last 15 minutes it is `idle`.
 */
export function rateOf(s: Snapshot, row: Row, now: number): RateVerdict {
  const { samples } = s
  const prompts = promptsFor(s, row.key)
  if (row.view.kind !== 'pace') return rateSince(prompts, undefined, null, now)
  const priced = spentRate(s, row, now) ?? rateSince(prompts, row.reading, baselineOf(samples, row, now), now)
  // The quota's own movement, where its recent readings measure it, outranks any estimate from dollars or prompts.
  // Idle then means it is not moving, whoever moves it: a subagent on its model, another session, claude.ai.
  const moved = row.reading ? movedPerHour(readingsOf(samples, row), now, recentSpan(row)) : null
  if (moved != null && row.reading) {
    const m = judgedOnMovement(priced, row.reading, moved)
    if (moved === 0) return { ...m, level: 'idle' }
    return m.level === 'fast' && !isOver(row) && row.view.pace.runOutAt == null ? { ...m, level: 'burst' } : m
  }
  const v = priced
  if (v.last15 === 0) return { ...v, level: 'idle' }
  if (v.level === 'fast') return isOver(row) || row.view.pace.runOutAt != null ? v : { ...v, level: 'burst' }
  if (v.level === 'idle' || v.costPerPrompt != null) return v
  return isOver(row) ? { ...v, level: 'fast' } : v
}

/**
 * How far back a quota's readings measure its movement: 15 minutes for the 5-hour window, short enough to forget a
 * burst that ended; 3 hours for a week, whose whole points move slowly
 */
const recentSpan = (row: Row) => Math.max(15 * MIN, (row.window * 1000) / 56)

/** The quota's readings in its current window, oldest first */
function readingsOf(samples: readonly PaceSample[], row: Row): { at: number; percent: number }[] {
  const r = row.reading?.resetsAt
  return samples.flatMap(s => {
    const q = s.quotas[row.key]
    return q && (r == null || q.resetsAt == null || Math.abs(q.resetsAt - r) <= 90_000) ? [{ at: s.at, percent: q.percent }] : []
  })
}

/** The rate judged in dollars, where the shared spend prices both the quota and a prompt */
function spentRate(s: Snapshot, row: Row, now: number): RateVerdict | null {
  const spend = spendFor(s, row.key)
  const prompts = promptsFor(s, row.key)
  const perDollar = row.reading ? quotaPerDollar(s.samples, row.key, spend, now) : null
  const perPrompt = usdPerPrompt(spend, prompts, now)
  if (!row.reading || perDollar == null || perPrompt == null) return null
  return spendVerdict({ prompts, reading: row.reading, perDollar, usdPerPrompt: perPrompt, usdPerHour: usdPerHour(spend, now), now })
}

/**
 * The prompts that draw on a quota: every prompt, less those that went to a model whose use does not count against
 * it. A prompt whose model is not known counts, so a quota is never under-warned.
 */
export function promptsFor(s: Snapshot, key: string): readonly number[] {
  const elsewhere = new Set(Object.entries(s.modelPrompts ?? {}).flatMap(([model, list]) => (Q.drawsOn(key, model) ? [] : list)))
  return elsewhere.size ? s.prompts.filter(t => !elsewhere.has(t)) : s.prompts
}

/** The spend that draws on a quota: all of it, less what went to a model whose use does not count against it */
export const spendFor = (s: Snapshot, key: string) => (s.spend ?? []).filter(x => Q.drawsOn(key, x.m))

const SEVERITY: Record<RateVerdict['level'], number> = { idle: 0, ok: 1, brisk: 2, burst: 3, fast: 4 }

export type Rated = { row: Row; r: RateVerdict }

/** The band's quotas, each with the prompting rate against it */
export function ratedOf(s: Snapshot, rows: readonly Row[], now: number): Rated[] {
  return bandRows(rows).map(row => ({ row, r: rateOf(s, row, now) }))
}

/** The quota the rate hurts most: the one that runs out soonest among equals */
export function worstOf<T extends { r: RateVerdict }>(list: readonly T[]): T | undefined {
  if (!list.length) return undefined
  return list.reduce((a, b) =>
    SEVERITY[b.r.level] > SEVERITY[a.r.level] || (SEVERITY[b.r.level] === SEVERITY[a.r.level] && (b.r.emptyIn ?? Infinity) < (a.r.emptyIn ?? Infinity)) ? b : a)
}

/** The overall verdict, for the status line and the pane's headline */
export function verdictOf(s: Snapshot, rows: readonly Row[], now: number): RateVerdict {
  const rated = ratedOf(s, rows, now)
  const first = rows[0]
  const all = rated.length ? rated : first ? [{ row: first, r: rateOf(s, first, now) }] : []
  return worstOf(all)?.r ?? rateSince(s.prompts, undefined, null, now)
}

/** What would cut token usage now: from the cache, the context's fill, the prompting rate and the weekly quotas */
export function adviceOf(s: Snapshot, now: number): Suggestion[] {
  const rows = rowsOf(s.samples, now)
  const worst = worstOf(ratedOf(s, rows, now))
  const over = bandRows(rows).find(r => Q.isWeekly(r.key) && isOver(r))
  const priced = worst && worst.r.costPerPrompt != null
  return suggestions({
    cache: s.cache,
    now,
    warm: s.warm,
    contextPercent: s.cache && s.cache.window > 0 ? Math.round((s.cache.tokens / s.cache.window) * 100) : undefined,
    fast: priced && worst.r.level === 'fast' ? { name: Q.theName(worst.row.name), emptyIn: worst.r.emptyIn, slowTo: budgetText(worst.r) } : undefined,
    burst: priced && worst.r.level === 'burst' ? { name: Q.theName(worst.row.name), emptyIn: worst.r.emptyIn } : undefined,
    weeklyOverPace: over ? Q.modelName(over.key, over.reading?.name) : undefined,
  })
}

/** What `$.pace.snapshot()` answers: every quota with the rate against it, the cache, the shared spend, the advice */
export function snapshotOf(s: Snapshot, now: number): PaceSnapshot {
  const spend = s.spend ?? []
  const quotas = rowsOf(s.samples, now).map((row): PaceQuota => {
    const r = rateOf(s, row, now)
    const pace = row.view.kind === 'pace' ? row.view.pace : null
    return {
      key: row.key,
      name: row.name,
      percent: row.reading?.percent ?? null,
      status: pace?.status ?? null,
      resetsAt: row.reading?.resetsAt ?? null,
      runOutAt: pace?.runOutAt ?? null,
      rate: {
        level: r.level,
        promptsPerHour: r.perHour,
        usdPerHour: r.usdPerHour ?? null,
        usdBudgetPerHour: r.usdBudgetPerHour ?? null,
        percentPerHour: r.pctPerHour,
        percentBudgetPerHour: r.pctBudgetPerHour,
        percentAtReset: r.pctAtReset,
        costPerPrompt: r.costPerPrompt,
        emptyIn: r.emptyIn,
      },
    }
  })
  const c = s.cache
  const cost = c ? nextCost(c.tokens, c.ttl) : null
  const usd = (tokens: number) => (s.price != null ? tokens * s.price : null)
  return {
    at: now,
    quotas,
    cache: c && cost ? {
      tokens: c.tokens, window: c.window, ttl: c.ttl, secondsLeft: cacheLeft(c, now),
      nextWarm: cost.warm, nextCold: cost.cold, nextWarmUsd: usd(cost.warm), nextColdUsd: usd(cost.cold),
    } : null,
    spend: { usdPerHour: usdPerHour(spend, now), sessions: sessionsOf(spend, now), usdPerPrompt: usdPerPrompt(spend, s.prompts, now) },
    gassedOut: quotas.some(q => q.status === 'gassedOut'),
    modes: { onPace: s.onPace ?? false, auto: s.auto ?? null },
    advice: adviceOf(s, now).map(a => ({ level: a.level, text: a.text })),
  }
}
