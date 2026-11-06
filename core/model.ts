// What the drawings show, from the samples, the prompts and the cache: each quota's pace, the prompting rate
// against it, and what to do about token usage. Pure; times in ms.

import type { PaceAuto, PaceCacheInfo, PaceQuota, PaceReading, PaceSample, PaceSnapshot, PaceSpend, PaceWarmMode } from '../types'
import { cacheLeft, nextCost, suggestions, type Suggestion } from './cache.ts'
import * as Q from './quota.ts'
import { budgetText, judgedOnMovement, movedPerHour, rateSince, type RateVerdict } from './rate.ts'
import { quotaPerDollar, sessionsOf, spendIn, spendVerdict, usdPerHour, usdPerPrompt } from './spend.ts'

const MIN = 60_000
const DAY = 24 * 60 * MIN

/** Everything a drawing reads: the band above the prompt, the pane and the window draw from the same */
export type Snapshot = {
  samples: readonly PaceSample[]
  prompts: readonly number[]
  /** The same prompts by the model they went to, where it was known */
  modelPrompts?: Readonly<Record<string, readonly number[]>>
  cache: PaceCacheInfo | null
  /** The host reports no prompt cache (Codex): the band leaves the cache's row out */
  noCache?: true
  /** The host is told no readings and estimates them from its spend (pi): before it knows a window's capacity, the band shows spend */
  estimated?: true
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
/** How far back the rate is smoothed, and how often within it: readings come a whole point at a time */
const SMOOTH_MS = 30_000
const SMOOTH_STEP_MS = 5_000

/** What was known at `t`: the readings, prompts and spend from then or before; the same snapshot when nothing is later */
function knownAt(s: Snapshot, t: number): Snapshot {
  const later = s.samples.some(x => x.at > t) || s.prompts.some(x => x > t) || (s.spend ?? []).some(x => x.t > t)
  if (!later) return s
  return {
    ...s,
    samples: s.samples.filter(x => x.at <= t),
    prompts: s.prompts.filter(x => x <= t),
    ...(s.spend ? { spend: s.spend.filter(x => x.t <= t) } : {}),
    ...(s.modelPrompts ? { modelPrompts: Object.fromEntries(Object.entries(s.modelPrompts).map(([m, l]) => [m, l.filter(x => x <= t)])) } : {}),
  }
}

/**
 * The rate against a quota, its points an hour smoothed over the last 30 seconds: the moment's rate every 5 seconds,
 * each from what was known then, averaged. The projections (at the reset, the run-out) follow the smoothed rate, so a
 * whole point arriving moves them over 30 seconds instead of at once; the level is the moment's, as reactive as it was
 */
export function rateOf(s: Snapshot, row: Row, now: number): RateVerdict {
  // A drawing asks a quota's rate several times (the band, the advice, the alerts): worked out once a snapshot
  const id = `${row.key}|${now}|${row.reading?.percent}|${row.reading?.resetsAt}`
  let byRow = rated.get(s)
  if (!byRow) rated.set(s, (byRow = new Map()))
  const known = byRow.get(id)
  if (known) return known
  const r = smoothed(s, row, now)
  byRow.set(id, r)
  return r
}

/** Each snapshot's rates, by quota and moment */
const rated = new WeakMap<Snapshot, Map<string, RateVerdict>>()

function smoothed(s: Snapshot, row: Row, now: number): RateVerdict {
  const known = knownAt(s, now)
  const at = known === s ? row : rowsOf(known.samples, now).find(r => r.key === row.key) ?? row
  const r = rateNow(known, at, now)
  if (at.view.kind !== 'pace' || !at.reading || r.pctPerHour == null) return r
  // Nothing new in the last 30 seconds: every moment of them knew what this one knows, so there is nothing to smooth
  const since = now - SMOOTH_MS
  const fresh = known.samples.some(x => x.at > since) || known.prompts.some(x => x > since) || (known.spend ?? []).some(x => x.t > since)
  if (!fresh) return r
  const rates = [r.pctPerHour]
  // The moments before this one on a 5-second grid, each worked out once for what was known then (see `pastRate`)
  for (let t = Math.floor((now - 1) / SMOOTH_STEP_MS) * SMOOTH_STEP_MS; t > now - SMOOTH_MS; t -= SMOOTH_STEP_MS) {
    const p = pastRate(s, row.key, t)
    if (p != null) rates.push(p)
  }
  const smoothed = rates.reduce((n, x) => n + x, 0) / rates.length
  return { ...judgedOnMovement(r, at.reading, smoothed), level: r.level }
}

/** Past moments' rates, by what was known then: a moment is worked out once, however often the rate is drawn */
const past = new Map<string, number | null>()
const PAST_KEPT = 512

/** A number folded into a running 32-bit hash, both halves of it: two snapshots alike up to a moment hash alike */
const fold = (h: number, x: number): number => {
  const lo = Math.imul(h ^ (x | 0), 16777619)
  return Math.imul(lo ^ Math.floor(x / 4294967296), 16777619)
}

/** Each text's hash, worked out once: quota keys, models and sessions repeat */
const texts = new Map<string, number>()
const textHash = (t: string): number => {
  let h = texts.get(t)
  if (h == null) {
    h = 2166136261
    for (let i = 0; i < t.length; i++) h = Math.imul(h ^ t.charCodeAt(i), 16777619)
    if (texts.size > 4096) texts.clear()
    texts.set(t, h)
  }
  return h
}

/**
 * A past moment's points an hour, from what was known then, worked out once: what was known is told by a hash of
 * everything the rate reads from then or before (readings, prompts and their models, spend and its models)
 */
function pastRate(s: Snapshot, key: string, t: number): number | null {
  // The quota's own readings, and the quotas there are (which models pace it); the prompts and the spend
  let h = fold(textHash(key), t)
  let kinds = 0
  for (const x of s.samples) {
    if (x.at > t) continue
    const r = x.quotas[key]
    h = r ? fold(fold(fold(fold(h, x.at), r.percent * 1000), r.resetsAt ?? -1), r.estimated ? 1 : 0) : fold(h, x.at)
    kinds = Math.max(kinds, Object.keys(x.quotas).length)
  }
  h = fold(h, kinds)
  for (const x of s.prompts) if (x <= t) h = fold(h, x)
  for (const m in s.modelPrompts ?? {}) {
    h = fold(h, textHash(m))
    for (const x of s.modelPrompts![m]!) if (x <= t) h = fold(h, x)
  }
  for (const x of s.spend ?? []) if (x.t <= t) h = fold(fold(fold(h, x.t), Math.round(x.usd * 1e6)), x.m ? textHash(x.m) : x.h ? 1 : 0)
  const id = `${key}|${t}|${h >>> 0}`
  if (past.has(id)) return past.get(id)!
  const then = knownAt(s, t)
  const row = rowsOf(then.samples, t).find(x => x.key === key)
  const rate = row ? rateNow(then, row, t).pctPerHour : null
  if (past.size >= PAST_KEPT) past.clear()
  past.set(id, rate)
  return rate
}

/** The rate against a quota at this moment, from what is known: its own movement first, else its dollars or prompts */
export function rateNow(s: Snapshot, row: Row, now: number): RateVerdict {
  const { samples } = s
  const prompts = promptsFor(s, row.key)
  if (row.view.kind !== 'pace') return rateSince(prompts, undefined, null, now)
  const priced = spentRate(s, row, now) ?? rateSince(prompts, row.reading, baselineOf(samples, row, now), now)
  // The quota's own movement, where its recent readings measure it, outranks any estimate from dollars or prompts.
  // Idle then means it is not moving, whoever moves it: a subagent on its model, another session, claude.ai.
  const whole = row.reading ? movedPerHour(heldSince(s, row, readingsOf(samples, row), now), now, recentSpan(row)) : null
  const moved = whole != null ? whole * pacedShare(s, row, now) : null
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

/**
 * The share of a quota's movement from the models that pace it (see `pacedBy`): all of a model's own week; of a
 * shared quota, their part of the dollars spent over the span, else of the prompts, all of it where neither is known
 */
function pacedShare(s: Snapshot, row: Row, now: number): number {
  if (Q.isPerModel(row.key)) return 1
  const from = now - recentSpan(row)
  const usd = spendIn(s.spend ?? [], from, now)
  if (usd > 0) return spendIn(spendFor(s, row.key), from, now) / usd
  const inSpan = (t: number) => t > from && t <= now
  const prompts = s.prompts.filter(inSpan).length
  return prompts ? promptsFor(s, row.key).filter(inSpan).length / prompts : 1
}

/** The quota's readings in its current window, oldest first */
function readingsOf(samples: readonly PaceSample[], row: Row): { at: number; percent: number }[] {
  const r = row.reading?.resetsAt
  return samples.flatMap(s => {
    const q = s.quotas[row.key]
    return q && (r == null || q.resetsAt == null || Math.abs(q.resetsAt - r) <= 90_000) ? [{ at: s.at, percent: q.percent }] : []
  })
}

/**
 * The readings, held flat to now when nothing has drawn on the quota since the last: no prompt and no spend after
 * it, past the reply's own spend, recorded with the reading. Readings come only with use, so without this the
 * last minutes of a busy stretch would stand as the rate until they age out of the span.
 */
function heldSince(s: Snapshot, row: Row, pts: { at: number; percent: number }[], now: number): { at: number; percent: number }[] {
  const last = pts[pts.length - 1]
  if (!last || last.at >= now) return pts
  const drawn = promptsFor(s, row.key).some(t => t > last.at) || spendFor(s, row.key).some(x => x.t > last.at + 10_000)
  return drawn ? pts : [...pts, { at: now, percent: last.percent }]
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
 * The prompts that pace a quota: every prompt, less those that went to a model whose use does not set its rate
 * (see `pacedBy`). A prompt whose model is not known counts, so a quota is never under-warned.
 */
export function promptsFor(s: Snapshot, key: string): readonly number[] {
  const keys = Q.quotaKeys(s.samples)
  const elsewhere = new Set(Object.entries(s.modelPrompts ?? {}).flatMap(([model, list]) => (Q.pacedBy(key, model, keys) ? [] : list)))
  return elsewhere.size ? s.prompts.filter(t => !elsewhere.has(t)) : s.prompts
}

/** The spend that paces a quota: all of it, less what went to a model whose use does not set its rate */
export function spendFor(s: Snapshot, key: string): readonly PaceSpend[] {
  const keys = Q.quotaKeys(s.samples)
  return (s.spend ?? []).filter(x => Q.pacedBy(key, x.m, keys))
}

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
