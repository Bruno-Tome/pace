// Activity: what was spent, over any range of time and sliced any way (.agents/decisions/0025-activity.md). The log's
// events as hourly rows by provider, account, harness, repo and model, each with every metric; kept like History is
// (finished days from their checkpoint, the open days as their lines arrive); and a question asked of them: a metric,
// a range, what to break down by and what to keep, answered as bins, groups and totals. Pure; times in ms.

import { anyOf, oneOf, toggled, type Chip, type ChipRow } from './chips.ts'
import { DIM_NAME, DIMS, labelOf, repoOf, type Dim } from './dims.ts'
import type { Accounts } from './account.ts'
import type { LogEntry } from './log.ts'

const H = 3600_000
const DAY = 24 * H

/** An hour's activity on one provider, account, harness, repo and model */
export type ActivityRow = {
  hour: number
  provider: string
  account?: string
  harness?: string
  repo?: string
  model?: string
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  reasoning: number
  usd: number
  prompts: number
  replies: number
}

/** What activity measures: tokens (in, out, cache read and write together), each kind of token, dollars, prompts, replies */
export type Metric = 'tokens' | 'input' | 'output' | 'cacheRead' | 'cacheWrite' | 'reasoning' | 'usd' | 'prompts' | 'replies'
export const METRICS: readonly Metric[] = ['tokens', 'input', 'output', 'cacheRead', 'cacheWrite', 'reasoning', 'usd', 'prompts', 'replies']
export const METRIC_NAME: Record<Metric, string> = {
  tokens: 'Tokens', input: 'Input', output: 'Output', cacheRead: 'Cache read', cacheWrite: 'Cache write', reasoning: 'Reasoning',
  usd: 'Dollars', prompts: 'Prompts', replies: 'Replies',
}

/** A row's measure of a metric */
export const valueOf = (r: ActivityRow, m: Metric): number =>
  m === 'tokens' ? r.input + r.output + r.cacheRead + r.cacheWrite : r[m]

const keyOf = (r: Omit<ActivityRow, 'input' | 'output' | 'cacheRead' | 'cacheWrite' | 'reasoning' | 'usd' | 'prompts' | 'replies'>) =>
  `${r.hour}|${r.provider}|${r.account ?? ''}|${r.harness ?? ''}|${r.repo ?? ''}|${r.model ?? ''}`

/** The log's events as hourly rows; a reading is no activity */
export function activityOf(entries: readonly LogEntry[]): ActivityRow[] {
  const rows = new Map<string, ActivityRow>()
  for (const e of entries) {
    const ev = e.event
    if ('quotas' in ev) continue
    const model = 'model' in ev ? ev.model : undefined
    const id = {
      hour: Math.floor(ev.at / H) * H, provider: e.provider,
      ...(e.account ? { account: e.account } : {}), ...(e.host ? { harness: e.host } : {}),
      ...(e.repo || e.cwd ? { repo: e.repo ?? repoOf(e.cwd!) } : {}), ...(model ? { model } : {}),
    }
    const key = keyOf(id)
    let r = rows.get(key)
    if (!r) rows.set(key, (r = { ...id, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, usd: 0, prompts: 0, replies: 0 }))
    if ('prompt' in ev) r.prompts++
    else if ('usd' in ev) r.usd += ev.usd
    else {
      r.input += ev.tokens.input
      r.output += ev.tokens.output
      r.cacheRead += ev.tokens.cacheRead
      r.cacheWrite += ev.tokens.cacheWrite
      r.reasoning += ev.tokens.reasoning
      r.replies++
    }
  }
  return [...rows.values()].sort((a, b) => a.hour - b.hour)
}

/**
 * Activity kept over all of history: a finished day's rows set once (from its checkpoint), the open days' folded
 * again only when a line arrived for them. The same rows back while nothing changed
 */
export class Activity {
  private days = new Map<string, ActivityRow[]>()
  private open = new Map<string, { entries: LogEntry[]; rows: ActivityRow[] | null }>()
  private all: ActivityRow[] | null = null

  /** A finished day's rows: its open lines no longer needed */
  setDay(day: string, rows: readonly ActivityRow[]): void {
    this.days.set(day, [...rows])
    this.open.delete(day)
    this.all = null
  }

  hasDay(day: string): boolean {
    return this.days.has(day)
  }

  /** Lines just read from the log, of days not yet folded */
  append(entries: readonly LogEntry[]): void {
    for (const e of entries) {
      const day = new Date(e.event.at).toISOString().slice(0, 10)
      if (this.days.has(day)) continue
      const o = this.open.get(day)
      if (o) {
        o.entries.push(e)
        o.rows = null
      } else this.open.set(day, { entries: [e], rows: null })
      this.all = null
    }
  }

  rows(): ActivityRow[] {
    if (!this.all) {
      const open = [...this.open.values()].flatMap(o => (o.rows ??= activityOf(o.entries)))
      this.all = [...[...this.days.values()].flat(), ...open].sort((a, b) => a.hour - b.hour)
    }
    return this.all
  }
}

/** How far back a view looks: the last 24 hours, 7 days, 30 days or 12 months, or all of history */
export type Range = 'day' | 'week' | 'month' | 'year' | 'all'
export const RANGES: readonly Range[] = ['day', 'week', 'month', 'year', 'all']
export const RANGE_NAME: Record<Range, string> = { day: 'Day', week: 'Week', month: 'Month', year: 'Year', all: 'All' }

/** A question of activity: a metric over a range, broken down by a dimension, keeping only the values `only` names */
export type ActivityQuery = { metric: Metric; range: Range; by: Dim; only: Partial<Record<Dim, readonly string[]>> }
export const DEFAULT_QUERY: ActivityQuery = { metric: 'tokens', range: 'week', by: 'provider', only: {} }

export type Bin = { start: number; end: number; label: string }
/** A group's measure in each bin, and over the range */
export type ActivityGroup = { value: string; label: string; values: number[]; total: number }
export type ActivityResult = {
  query: ActivityQuery
  bins: Bin[]
  groups: ActivityGroup[]
  /** The metric over the range */
  total: number
  /** Every metric over the range, with the filters */
  totals: Record<Metric, number>
}

/** The most groups drawn apart; the rest are one, `other` */
const GROUPS = 7
const DAYS_OF_WEEK = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** The bins a range is drawn in, by local time (`zone`, ms ahead of UTC), the last one holding `now` */
function binsOf(range: Range, now: number, zone: number, first: number | null): Bin[] {
  const local = (t: number) => new Date(t + zone)
  const dayStart = (t: number) => Math.floor((t + zone) / DAY) * DAY - zone
  const monthStart = (t: number, back: number) => {
    const d = local(t)
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - back, 1) - zone
  }
  const hours = (n: number) => Array.from({ length: n }, (_, i) => {
    const start = Math.floor((now + zone) / H) * H - zone - (n - 1 - i) * H
    return { start, end: start + H, label: String(local(start).getUTCHours()).padStart(2, '0') }
  })
  const days = (n: number, week: boolean) => Array.from({ length: n }, (_, i) => {
    const start = dayStart(now) - (n - 1 - i) * DAY
    const d = local(start)
    return { start, end: start + DAY, label: week ? `${DAYS_OF_WEEK[d.getUTCDay()]} ${d.getUTCDate()}` : String(d.getUTCDate()) }
  })
  const months = (n: number, years: boolean) => Array.from({ length: n }, (_, i) => {
    const start = monthStart(now, n - 1 - i)
    const d = local(start)
    return { start, end: monthStart(now, n - 2 - i), label: years ? `${MONTHS[d.getUTCMonth()]} ${String(d.getUTCFullYear()).slice(2)}` : MONTHS[d.getUTCMonth()]! }
  })
  if (range === 'day') return hours(24)
  if (range === 'week') return days(7, true)
  if (range === 'month') return days(30, false)
  if (range === 'year') return months(12, false)
  // All of history: a day a bar while it is short, a month a bar after
  const from = first ?? now
  if (now - from <= 45 * DAY) return days(Math.max(1, Math.round((dayStart(now) - dayStart(from)) / DAY) + 1), false)
  const a = local(from)
  const b = local(now)
  return months((b.getUTCFullYear() - a.getUTCFullYear()) * 12 + b.getUTCMonth() - a.getUTCMonth() + 1, true)
}

const dimOf = (r: ActivityRow, d: Dim): string => (d === 'provider' ? r.provider : r[d === 'harness' ? 'harness' : d] ?? '')

/** Rows the filters keep: for each dimension `only` names, a row whose value is one of its values */
export const kept = (rows: readonly ActivityRow[], only: ActivityQuery['only']) =>
  rows.filter(r => DIMS.every(d => !only[d]?.length || only[d]!.includes(dimOf(r, d))))

/** The bin holding `t`, found by halves: the rows need not come in order */
function binAt(bins: readonly Bin[], t: number): number {
  let lo = 0
  let hi = bins.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (bins[mid]!.start <= t) lo = mid
    else hi = mid - 1
  }
  return lo
}

/** Activity's answer to a question: the range's bins, each group's measure in each, the totals */
export function activityQuery(rows: readonly ActivityRow[], q: ActivityQuery, now: number, o: { zone: number; accounts?: Accounts }): ActivityResult {
  const on = kept(rows, q.only)
  const bins = binsOf(q.range, now, o.zone, on.length ? on.reduce((n, r) => Math.min(n, r.hour), Infinity) : null)
  const from = bins[0]!.start
  const to = bins.at(-1)!.end
  const groups = new Map<string, ActivityGroup>()
  const totals = Object.fromEntries(METRICS.map(m => [m, 0])) as Record<Metric, number>
  for (const r of on) {
    if (r.hour < from || r.hour >= to) continue
    for (const m of METRICS) totals[m] += valueOf(r, m)
    const b = binAt(bins, r.hour)
    const value = dimOf(r, q.by)
    let g = groups.get(value)
    if (!g) groups.set(value, (g = { value, label: labelOf(q.by, value, { provider: r.provider, ...(o.accounts ? { accounts: o.accounts } : {}) }), values: bins.map(() => 0), total: 0 }))
    const v = valueOf(r, q.metric)
    g.values[b]! += v
    g.total += v
  }
  const sorted = [...groups.values()].filter(g => g.total > 0).sort((x, y) => y.total - x.total || (x.label < y.label ? -1 : 1))
  const rest = sorted.slice(GROUPS)
  const shown = rest.length
    ? [...sorted.slice(0, GROUPS), { value: '…', label: 'other', values: bins.map((_, i) => rest.reduce((n, g) => n + g.values[i]!, 0)), total: rest.reduce((n, g) => n + g.total, 0) }]
    : sorted
  return { query: q, bins, groups: shown, total: totals[q.metric], totals }
}
/**
 * Activity's chips: the metric, the range and the breakdown, one each; then for each dimension the values seen in all
 * of history, the busiest by the metric first, any number of them
 */
export function activityChips(rows: readonly ActivityRow[], q: ActivityQuery, o: { accounts?: Accounts }): ChipRow[] {
  // Every dimension's values and totals in one pass over the rows: a year of them is tens of thousands
  const byDim = new Map<Dim, Map<string, { total: number; provider: string }>>(DIMS.map(d => [d, new Map()]))
  for (const r of rows) {
    const v = valueOf(r, q.metric)
    for (const d of DIMS) {
      const value = dimOf(r, d)
      if (!value) continue
      const totals = byDim.get(d)!
      const t = totals.get(value)
      if (t) t.total += v
      else totals.set(value, { total: v, provider: r.provider })
    }
  }
  const seen = DIMS.map(d => {
    const choices = [...byDim.get(d)!].sort((a, b) => b[1].total - a[1].total || (a[0] < b[0] ? -1 : 1))
      .map(([value, t]) => ({ value, label: labelOf(d, value, { provider: t.provider, ...(o.accounts ? { accounts: o.accounts } : {}) }) }))
    return anyOf(d, DIM_NAME[d], choices, q.only[d] ?? [])
  })
  return [
    oneOf('metric', 'Metric', METRICS.map(m => ({ value: m, label: METRIC_NAME[m] })), q.metric),
    oneOf('range', 'Range', RANGES.map(r => ({ value: r, label: RANGE_NAME[r] })), q.range),
    oneOf('by', 'By', DIMS.map(d => ({ value: d, label: DIM_NAME[d] })), q.by),
    ...seen,
  ]
}

/** The question a click on a chip makes */
export function pressed(q: ActivityQuery, chip: Chip): ActivityQuery {
  if (chip.group === 'metric') return { ...q, metric: chip.value as Metric }
  if (chip.group === 'range') return { ...q, range: chip.value as Range }
  if (chip.group === 'by') return { ...q, by: chip.value as Dim }
  const d = chip.group as Dim
  return { ...q, only: { ...q.only, [d]: toggled(q.only[d] ?? [], chip.value) } }
}
