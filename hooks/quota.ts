// The quotas: what a reading says about a rate-limit window, how its usage stands against the clock, and the
// readings themselves (parsed, kept, merged). Pure; times are ms timestamps, window lengths seconds.

import type { PaceReading, PaceSample } from '../types'

export type { PaceReading, PaceSample }

const MIN = 60_000
export const FIVE_HOURS = 5 * 3600
export const WEEK = 7 * 86400

// ----------------------------------------------------------------------
// Quotas by key
// ----------------------------------------------------------------------

/** `five_hour`, `seven_day` (all models) and `seven_day_<model>` (one model's week) */
export const isWeekly = (key: string) => key.startsWith('seven_day')
export const isPerModel = (key: string) => key.startsWith('seven_day_')

export const windowOf = (key: string) => (isWeekly(key) ? WEEK : FIVE_HOURS)

const modelOf = (key: string, name?: string) => name ?? key.slice('seven_day_'.length).replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())

export function quotaName(key: string, name?: string): string {
  if (key === 'five_hour') return '5-hour window'
  if (key === 'seven_day') return 'Week · all models'
  return `Week · ${modelOf(key, name)}`
}

export function shortName(key: string, name?: string): string {
  if (key === 'five_hour') return '5h'
  if (key === 'seven_day') return '7d'
  return `${modelOf(key, name)} wk`
}

/**
 * Whether a session on `model` draws on a quota: the 5-hour window and the all-models week always, a model's own
 * week (`seven_day_fable`) only when the model is that one; every quota while the model is not known yet
 */
export function drawsOn(key: string, model: string | undefined): boolean {
  if (!model || !key.startsWith('seven_day_')) return true
  const family = key.slice('seven_day_'.length).split('_')[0]!
  return model.toLowerCase().includes(family)
}

/**
 * Whether a model's usage sets a quota's rate: a model's own week, that model's alone; a shared quota (the 5-hour
 * window, the all-models week), the models with no week of their own among `keys`, the quotas the plan has. A
 * model with a week of its own is paced by that week, so a plan that gives Fable one keeps a Fable burst off the
 * 5-hour window's rate, though the window's fill still shows. Every model while it is not known.
 */
export function pacedBy(key: string, model: string | undefined, keys: readonly string[]): boolean {
  if (!model) return true
  if (isPerModel(key)) return drawsOn(key, model)
  return !keys.some(k => isPerModel(k) && drawsOn(k, model))
}

/** A quota's name mid-sentence: `the 5-hour window`, `the week · Fable` */
export const theName = (name: string) => `the ${name.startsWith('5-hour') ? name : name.replace(/^Week/, 'week')}`

/** A week's model alone, for advice: `Fable`, `All models` */
export const modelName = (key: string, name?: string) => (isPerModel(key) ? modelOf(key, name) : key === 'seven_day' ? 'All models' : '5-hour')

const order = (key: string) => (key === 'five_hour' ? 0 : key === 'seven_day' ? 1 : 2)

/** The quotas a history knows, in drawing order: one is known once a reading of it carried a reset time */
export function quotaKeys(samples: readonly PaceSample[]): string[] {
  const keys = new Set<string>()
  for (const s of samples) for (const [k, r] of Object.entries(s.quotas)) if (r.resetsAt != null && (k === 'five_hour' || isWeekly(k))) keys.add(k)
  return [...keys].sort((a, b) => order(a) - order(b) || (a < b ? -1 : 1))
}

/** A quota's latest reading and when it was taken */
export function latest(samples: readonly PaceSample[], key: string): { reading: PaceReading; at: number } | null {
  for (let i = samples.length - 1; i >= 0; i--) {
    const r = samples[i]!.quotas[key]
    if (r) return { reading: r, at: samples[i]!.at }
  }
  return null
}

/** A reading as it stands now: once its reset has passed, the window running now, started at 0% */
export function asOf(r: PaceReading, window: number, now: number): PaceReading {
  if (r.resetsAt == null || r.resetsAt > now) return r
  const windows = Math.floor((now - r.resetsAt) / (window * 1000)) + 1
  return { ...r, percent: 0, resetsAt: r.resetsAt + windows * window * 1000 }
}

// ----------------------------------------------------------------------
// Pace
// ----------------------------------------------------------------------

/** `gassedOut`: the quota is spent until it resets */
export type Status = 'early' | 'under' | 'onPace' | 'over' | 'gassedOut'

export type Pace = {
  /** Fraction of the quota used, 0–1 */
  used: number
  /** Fraction of the window gone, 0–1 */
  elapsed: number
  /** The window's length, seconds */
  window: number
  now: number
  /** Used over elapsed: 1 is even pace; null in a window's first minutes */
  ratio: number | null
  /** Seconds to the reset */
  resetIn: number
  /** When the quota runs out at its average rate, if before the reset */
  runOutAt: number | null
  /** Seconds usage runs ahead of even pace (behind when negative) */
  lead: number
  status: Status
}

/** Minutes of a window too early to judge */
const EARLY = 10 * 60

/** How far from even pace still counts as on it: 5 points, or a fifth of the time gone once that is more */
const margin = (elapsed: number) => Math.max(0.05, 0.2 * elapsed)

/** A reading's pace; null without a reset ahead to place it in its window */
export function paceOf(r: PaceReading, window: number, now: number): Pace | null {
  if (r.resetsAt == null || r.resetsAt <= now) return null
  const resetIn = Math.min((r.resetsAt - now) / 1000, window)
  const elapsed = 1 - resetIn / window
  const used = Math.min(Math.max(r.percent / 100, 0), 1)
  const early = elapsed * window < EARLY
  const ratio = early ? null : used / elapsed
  const runOut = ratio && used < 1 ? ((1 - used) / ratio) * window : null
  let status: Status
  if (used >= 1) status = 'gassedOut'
  else if (early) status = 'early'
  else if (used > elapsed + margin(elapsed)) status = 'over'
  else if (used < elapsed - margin(elapsed)) status = 'under'
  else status = 'onPace'
  return {
    used, elapsed, window, now, ratio, resetIn,
    runOutAt: runOut != null && runOut < resetIn ? now + runOut * 1000 : null,
    lead: (used - elapsed) * window,
    status,
  }
}

const STATUS_LABEL: Record<Status, string> = {
  early: 'Too early', under: 'Under pace', onPace: 'On pace', over: 'Over pace', gassedOut: 'Gassed out',
}

export const statusLabel = (s: Status) => STATUS_LABEL[s]

/** How far usage runs from even pace */
export function paceSummary(p: Pace): string {
  if (p.status === 'gassedOut') return 'Quota spent'
  if (p.status === 'early') return 'Window just opened'
  if (Math.abs(p.lead) < 3600) return 'Even with the clock'
  return `${formatDuration(Math.abs(p.lead))} ${p.lead > 0 ? 'ahead of' : 'behind'} even pace`
}

/** Where the average rate lands: when it runs out, or how much is used by the reset */
export function outlook(p: Pace): string | null {
  if (p.status === 'gassedOut') return `Resets in ${formatDuration(p.resetIn)}`
  if (p.ratio == null) return null
  if (p.runOutAt != null) return `Out by ${clockAt(p.runOutAt, p.runOutAt - p.now >= 86400_000)} at this rate`
  return `~${Math.round(Math.min(p.ratio, 1) * 100)}% at reset at this rate`
}

// ----------------------------------------------------------------------
// What can be shown of a quota
// ----------------------------------------------------------------------

export type View =
  | { kind: 'pace'; pace: Pace; reading: PaceReading }
  | { kind: 'usage'; reading: PaceReading; why: 'ended' | 'noReset' | 'stale' }
  | { kind: 'none' }

/** A reading older than this is too stale to set against the clock */
const staleAfter = (window: number) => Math.max(15 * 60, 0.05 * window) * 1000

export function viewOf(r: PaceReading | undefined, window: number, now: number, readAt?: number): View {
  if (!r) return { kind: 'none' }
  if (readAt != null && now - readAt > staleAfter(window)) return { kind: 'usage', reading: r, why: 'stale' }
  const pace = paceOf(r, window, now)
  if (pace) return { kind: 'pace', pace, reading: r }
  return { kind: 'usage', reading: r, why: r.resetsAt == null ? 'noReset' : 'ended' }
}

export const viewStatus = (v: View): Status | null => (v.kind === 'pace' ? v.pace.status : null)

export const viewUsed = (v: View): number | null => (v.kind === 'none' ? null : Math.min(Math.max(v.reading.percent / 100, 0), 1))

/** What a quota with no pace shows in its place */
export function viewSummary(v: View): string {
  if (v.kind === 'pace') return statusLabel(v.pace.status)
  if (v.kind === 'none') return 'No reading'
  return { ended: 'Window ended', noReset: 'No reset time', stale: 'Stale reading' }[v.why]
}

// ----------------------------------------------------------------------
// A window's trajectory, for its chart
// ----------------------------------------------------------------------

type Point = { elapsed: number; used: number }
export type Trajectory = { segments: Point[][]; projection: { from: Point; to: Point } | null }

/** Readings of one window share its reset time, give or take this */
const SAME_RESET = 90_000

/**
 * The readings of the window that resets at `reset`, in order, split where the readings stop for a while; and the
 * slope of the last fifth of the window, projected to the reset or to 100%. Null with fewer than two readings.
 */
export function trajectoryOf(key: string, reset: number, samples: readonly PaceSample[], window: number): Trajectory | null {
  const pts = samples
    .filter(s => { const r = s.quotas[key]?.resetsAt; return r != null && Math.abs(r - reset) <= SAME_RESET && reset - s.at <= window * 1000 && s.at <= reset })
    .map(s => ({ at: s.at, elapsed: 1 - (reset - s.at) / 1000 / window, used: Math.min(Math.max(s.quotas[key]!.percent / 100, 0), 1) }))
    .sort((a, b) => a.at - b.at)
  if (pts.length < 2) return null
  const gap = Math.max(15 * 60, 0.02 * window) * 1000
  const segments: Point[][] = [[]]
  pts.forEach((p, i) => {
    if (i && p.at - pts[i - 1]!.at > gap) segments.push([])
    segments[segments.length - 1]!.push({ elapsed: p.elapsed, used: p.used })
  })
  const last = pts[pts.length - 1]!
  const from = [...pts].reverse().find(p => last.elapsed - p.elapsed >= 0.2) ?? pts[0]!
  const slope = last.elapsed > from.elapsed ? (last.used - from.used) / (last.elapsed - from.elapsed) : 0
  let projection: Trajectory['projection'] = null
  if (slope > 0) {
    const atReset = last.used + slope * (1 - last.elapsed)
    const to = atReset <= 1 ? { elapsed: 1, used: atReset } : { elapsed: last.elapsed + (1 - last.used) / slope, used: 1 }
    projection = { from: { elapsed: last.elapsed, used: last.used }, to }
  }
  return { segments, projection }
}

// ----------------------------------------------------------------------
// Readings: parsed, kept and merged
// ----------------------------------------------------------------------

const resetOf = (v: unknown): number | undefined => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? (Number.isFinite(Number(v)) ? Number(v) : Date.parse(v)) : NaN
  if (!Number.isFinite(n) || n <= 0) return undefined
  return n < 1e12 ? n * 1000 : n
}

const percentOf = (v: number) => Math.min(Math.max(v, 0), 100)

const reading = (percent: number, reset: unknown, name?: string): PaceReading => {
  const resetsAt = resetOf(reset)
  return { percent: percentOf(percent), ...(resetsAt != null ? { resetsAt } : {}), ...(name ? { name } : {}) }
}

/**
 * The usage endpoint's answer (what `/usage` reads): windows by key at the top (`five_hour`, `seven_day`,
 * `seven_day_<model>`, each `{ utilization, resets_at }`) and a `limits` list (`{ kind, percent, resets_at, scope }`),
 * whose entries win, a model's week keyed `seven_day_<model>` and named for it.
 */
export function parseUsage(root: unknown): Record<string, PaceReading> {
  const out: Record<string, PaceReading> = {}
  if (!root || typeof root !== 'object') return out
  for (const [k, v] of Object.entries(root as Record<string, unknown>)) {
    const o = v as { utilization?: unknown; resets_at?: unknown } | null
    if (o && typeof o === 'object' && typeof o.utilization === 'number') out[k] = reading(o.utilization, o.resets_at)
  }
  const limits = (root as { limits?: unknown }).limits
  for (const l of Array.isArray(limits) ? limits : []) {
    const o = l as { kind?: unknown; percent?: unknown; resets_at?: unknown; scope?: { model?: { display_name?: unknown } } } | null
    if (!o || typeof o.percent !== 'number') continue
    const name = typeof o.scope?.model?.display_name === 'string' ? o.scope.model.display_name : undefined
    const key = o.kind === 'session' ? 'five_hour'
      : o.kind === 'weekly_all' ? 'seven_day'
      : o.kind === 'weekly_scoped' && name ? `seven_day_${name.toLowerCase().replace(/\s+/g, '_')}`
      : null
    if (key) out[key] = reading(o.percent, o.resets_at, name)
  }
  return out
}

/** Claude Code's own copy of that answer in `~/.claude.json`, while it is under an hour old */
export function parseClaudeJson(text: string, now: number): PaceSample | null {
  let root: { cachedUsageUtilization?: { fetchedAtMs?: unknown; utilization?: unknown } }
  try { root = JSON.parse(text) } catch { return null }
  const c = root?.cachedUsageUtilization
  if (!c || typeof c.fetchedAtMs !== 'number' || now - c.fetchedAtMs < 0 || now - c.fetchedAtMs > 3600_000) return null
  const quotas = parseUsage(c.utilization)
  return Object.keys(quotas).length ? { at: c.fetchedAtMs, quotas } : null
}

/** Readings kept */
const KEEP = 8000

const sameQuotas = (a: PaceSample, b: PaceSample) => Object.keys(a.quotas).sort().join() === Object.keys(b.quotas).sort().join()

/** Whether `b` says nothing `a` did not, taken within 5 minutes of it */
function repeats(a: PaceSample, b: PaceSample): boolean {
  if (b.at - a.at >= 5 * MIN || !sameQuotas(a, b)) return false
  return Object.entries(a.quotas).every(([k, x]) => {
    const y = b.quotas[k]!
    return Math.abs(x.percent - y.percent) < 0.001 && Math.abs((x.resetsAt ?? 0) - (y.resetsAt ?? 0)) <= 5000
  })
}

/** A reading added to the history, unless it repeats the last one of the same quotas */
export function appendSample(list: readonly PaceSample[], s: PaceSample): PaceSample[] {
  const last = [...list].reverse().find(x => sameQuotas(x, s))
  if (last && repeats(last, s)) return [...list]
  return [...list, s].sort((a, b) => a.at - b.at).slice(-KEEP)
}

/** A stored reading in the shape pace writes, its malformed quotas left out; null when nothing of it is */
function wellFormed(s: unknown): PaceSample | null {
  const x = s as { at?: unknown; quotas?: unknown } | null
  if (!x || typeof x.at !== 'number' || !Number.isFinite(x.at) || !x.quotas || typeof x.quotas !== 'object') return null
  const quotas: Record<string, PaceReading> = {}
  for (const [k, r] of Object.entries(x.quotas as Record<string, PaceReading | null>)) {
    if (r && Number.isFinite(r.percent) && (r.resetsAt == null || Number.isFinite(r.resetsAt))) quotas[k] = r
  }
  return Object.keys(quotas).length ? { at: x.at, quotas } : null
}

/** Two copies of the history as one: readings at the same moment joined, repeats and malformed ones dropped */
export function mergeSamples(a: readonly PaceSample[], b: readonly PaceSample[]): PaceSample[] {
  const byAt = new Map<number, PaceSample>()
  for (const s of [...a, ...b].map(wellFormed).filter((x): x is PaceSample => x != null)) {
    const prev = byAt.get(s.at)
    byAt.set(s.at, prev ? { at: s.at, quotas: { ...prev.quotas, ...s.quotas } } : s)
  }
  const out: PaceSample[] = []
  for (const s of [...byAt.values()].sort((x, y) => x.at - y.at)) {
    const last = [...out].reverse().find(x => sameQuotas(x, s))
    if (!last || !repeats(last, s)) out.push(s)
  }
  return out.slice(-KEEP)
}

// ----------------------------------------------------------------------
// Words for times
// ----------------------------------------------------------------------

/** `1d 21h`, `1h 30m`, `52m`: whole units, cut rather than rounded */
export function formatDuration(seconds: number): string {
  const s = Math.trunc(Math.abs(seconds))
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (d) return h ? `${d}d ${h}h` : `${d}d`
  if (h) return m ? `${h}h ${m}m` : `${h}h`
  // Under a minute: "0m" would read as already
  return m ? `${m}m` : '<1m'
}

const pad = (n: number) => String(n).padStart(2, '0')

/** `14:05`, or `Tue 14:05` a day or more away */
export function clockAt(at: number, withDay: boolean): string {
  const d = new Date(at)
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  return withDay ? `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()]} ${hm}` : hm
}
