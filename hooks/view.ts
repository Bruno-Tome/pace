// Every drawing as lines of styled segments: the band above the prompt, the status-line row, the pane and the
// full-screen window. The hooks module turns a line into Text elements, the window and the status line into ANSI.
// Pure; times in ms.

import type { PaceAuto, PaceCacheInfo, PacePrefs } from '../types'
import { cacheLeft, formatTokens, formatUsd, nextCost, ttlSeconds, type Suggestion } from './cache.ts'
import { chart, type Layer } from './chart.ts'
import type { Step } from './plan.ts'
import { runsOut } from './auto.ts'
import { adviceOf, bandRows, isFable, ratedOf, rowsOf, snapshotOf, verdictOf, worstOf, type Row, type Snapshot } from './model.ts'
import * as Q from './quota.ts'
import { bar, budgetText, buckets, rateText, scoreText, sparkline, type Cell, type RateVerdict } from './rate.ts'
import { sessionsOf, usdPerPrompt } from './spend.ts'
import { gearText, notchName } from './throttle.ts'

const MIN = 60_000

/**
 * A run of styled text. For the band's animation, `bar` marks a bar's cells and `pulse` a warning that blinks; for
 * the plan's, `spin` marks the node of the step under way, `flow` the line into it and `pop` the step done last.
 * `whole` keeps a run on one row when its line wraps.
 */
export type Seg = { t: string; color?: string; dim?: boolean; bold?: boolean; bar?: boolean; pulse?: boolean; spin?: boolean; flow?: boolean; pop?: boolean; whole?: boolean; aura?: boolean }
export type Line = Seg[]

const compact = (seconds: number) => Q.formatDuration(seconds).replace(/ /g, '')
const pctOf = (x: number) => Math.round(x * 100)
const width = (segs: readonly Seg[]) => segs.reduce((n, x) => n + [...x.t].length, 0)

// ----------------------------------------------------------------------
// Colours
// ----------------------------------------------------------------------

const STATUS_COLOR: Record<Q.Status, string> = {
  under: 'success',
  onPace: 'text',
  over: 'warning',
  gassedOut: 'error',
  early: 'subtle',
}

function quotaColor(key: string): string {
  if (key === 'five_hour') return 'suggestion'
  if (isFable(key)) return 'merged'
  return 'ide'
}

const LEVEL: Record<RateVerdict['level'], { mark: string; color: string; word: string }> = {
  idle: { mark: '·', color: 'subtle', word: 'idle' },
  ok: { mark: '●', color: 'success', word: 'steady' },
  brisk: { mark: '▲', color: 'warning', word: 'brisk' },
  burst: { mark: '▲', color: 'warning', word: 'burst' },
  fast: { mark: '▲▲', color: 'error', word: 'too fast' },
}

/** A quota over pace with no per-prompt cost yet: rated `fast`, but nothing says the rate runs it out, so it is drawn calm */
const OVER_PACE = { mark: '▲', color: 'warning', word: 'over pace' }

const uncosted = (v: RateVerdict) => v.level === 'fast' && v.pctAtReset == null && v.emptyIn == null

/** How a rate is drawn: its level's mark, color and word, or over pace while a fast rate has no cost behind it */
const levelLook = (v: RateVerdict) => (uncosted(v) ? OVER_PACE : LEVEL[v.level])

const SUGGESTION_COLOR: Record<Suggestion['level'], string> = { urgent: 'error', warn: 'warning', info: 'suggestion' }

const LAYER_COLOR: Record<Layer, string | undefined> = { actual: undefined, projection: 'warning', ideal: 'subtle', empty: undefined }

const ANSI: Record<string, string> = {
  success: '32', warning: '33', error: '31', text: '37', subtle: '90', suggestion: '34', merged: '35', ide: '36',
}

/** A line as ANSI-coloured text, for a status-line command or a terminal of its own */
export function toAnsi(segs: readonly Seg[]): string {
  return segs
    .map(s => {
      const codes = [s.bold && '1', s.dim && '2', s.color && ANSI[s.color]].filter(Boolean)
      return codes.length ? `\x1b[${codes.join(';')}m${s.t}\x1b[0m` : s.t
    })
    .join('')
}

// ----------------------------------------------------------------------
// Pieces of a row
// ----------------------------------------------------------------------

function barSegs(cells: readonly Cell[], key: string, status: Q.Status): Seg[] {
  const fill = status === 'gassedOut' ? 'error' : quotaColor(key)
  const look = (k: Cell['kind']): Seg => {
    switch (k) {
      case 'used': return { t: '█', color: fill }
      case 'ahead': return { t: '█', color: status === 'gassedOut' ? 'error' : 'warning' }
      case 'margin': return { t: '░', color: 'success' }
      case 'tick': return { t: '│', color: 'text' }
      case 'empty': return { t: '░', dim: true }
    }
  }
  const runs: { kind: Cell['kind']; n: number }[] = []
  for (const c of cells) {
    const last = runs[runs.length - 1]
    if (last?.kind === c.kind) last.n += 1
    else runs.push({ kind: c.kind, n: 1 })
  }
  return runs.map(r => {
    const l = look(r.kind)
    return { ...l, t: l.t.repeat(r.n), bar: true }
  })
}

/** A quota in one row: label, bar, percent used, status and the time to reset */
function quotaLine(row: Row, labelW: number, barWidth: number, wide: boolean, packed = false): Line {
  const out: Line = [{ t: `${row.short.padEnd(labelW)} `, dim: true }]
  if (row.view.kind !== 'pace') return [...out, { t: Q.viewSummary(row.view), dim: true }]
  const p = row.view.pace
  const status = p.status
  if (barWidth > 0) out.push(...barSegs(bar(p.used, p.elapsed, barWidth), row.key, status), { t: ' ' })
  out.push({ t: packed ? `${pctOf(p.used)}%` : `${pctOf(p.used)}%`.padStart(4), color: STATUS_COLOR[status], bold: true })
  out.push({ t: ` ${packed ? Q.statusLabel(status) : Q.statusLabel(status).padEnd(11)}`, color: STATUS_COLOR[status] })
  if (wide) out.push({ t: ` ↻ ${compact(p.resetIn).padEnd(6)}`, dim: true })
  return out
}

/**
 * Where the rate takes a quota: when it runs out, if before the reset, else the percent it lands at by the reset
 * (`→ 71% at reset`). Null until a prompt's cost is known.
 */
function landingText(v: RateVerdict, wide: boolean): string | null {
  if (v.emptyIn != null && v.resetIn != null && v.emptyIn < v.resetIn) return `out in ${compact(v.emptyIn)}`
  if (v.pctAtReset == null) return null
  return `→ ${Math.round(v.pctAtReset)}%${wide ? ' at reset' : ''}`
}

/** The prompting rate against a quota, as where it takes the quota: idle, the percent at reset, or when it runs out */
function rateSegs(v: RateVerdict, wide: boolean): Seg[] {
  const l = LEVEL[v.level]
  const fast = v.level === 'fast'
  const out: Seg[] = [{ t: `${l.mark} `, color: l.color, pulse: fast }]
  if (v.level === 'idle') return [...out, { t: l.word, dim: true }]
  if (uncosted(v)) return [{ t: `${OVER_PACE.mark} `, color: OVER_PACE.color }, { t: OVER_PACE.word, color: OVER_PACE.color }, { t: ' · no cost yet', dim: true }]
  // A burst is the recent rate, not the window so far: say so, so it does not read against an under-pace status
  const landing = landingText(v, wide)
  if (v.level === 'burst' && landing) return [...out, { t: l.word, color: l.color }, { t: ' · ' }, { t: `${landing} at this rate`, bold: true }]
  out.push({ t: landing ?? `→ —${wide ? ' at reset' : ''}`, bold: true })
  if (fast) out.push({ t: ' too fast', color: 'error', bold: true, pulse: true })
  else if (v.level === 'burst' || v.level === 'brisk') out.push({ t: ` ${l.word}`, color: 'warning' })
  return out
}

/** Time left on the cache: minutes for an hour's TTL, minutes and seconds under five */
function clockLeft(seconds: number): string {
  if (seconds >= 300) return `${Math.floor(seconds / 60)}m`
  return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, '0')}s`
}

/** Tokens, and their dollars where the replies priced them: `≈18k tk · $0.03` */
const costText = (tokens: number, price: number | null | undefined) =>
  `≈${formatTokens(tokens)} tk${price != null ? ` · ${formatUsd(tokens * price)}` : ''}`

/** The cache in one row, as a quota's: label, a bar of the TTL left, the time left, the context and the next prompt's cost */
function cacheLine(cache: PaceCacheInfo | null, now: number, labelW: number, barWidth: number, wide: boolean, price?: number | null): Line {
  const out: Line = [{ t: `${'cache'.padEnd(labelW)} `, dim: true }]
  if (!cache) return [...out, { t: 'warms with the next reply', dim: true }]
  const left = cacheLeft(cache, now)
  const frac = left / ttlSeconds(cache.ttl)
  const color = left === 0 ? 'error' : frac < 0.25 ? 'warning' : 'success'
  if (barWidth > 0) {
    const n = Math.round(frac * barWidth)
    if (n) out.push({ t: '█'.repeat(n), color, bar: true })
    if (barWidth - n) out.push({ t: '░'.repeat(barWidth - n), dim: true, bar: true })
    out.push({ t: ' ' })
  }
  const cost = nextCost(cache.tokens, cache.ttl)
  out.push({ t: (left ? clockLeft(left) : 'cold').padStart(4), color, bold: true })
  out.push({ t: ` ${formatTokens(cache.tokens)} ctx`.padEnd(12), dim: true })
  if (wide) out.push(left ? { t: `next ${costText(cost.warm, price)}` } : { t: `next ${costText(cost.cold, price)}`, color: 'error' })
  return out
}

// ----------------------------------------------------------------------
// The band and the status line
// ----------------------------------------------------------------------

const SEP: Seg = { t: '  │  ', dim: true }

/** The band above the prompt: one row per quota with the prompting rate against it, then the cache with the top suggestion */
export function bandLines(s: Snapshot, now: number, cols: number): Line[] {
  const rows = rowsOf(s.samples, now)
  const shown = bandRows(rows)
  const wide = cols >= 70
  const top = adviceOf(s, now)[0]
  const labelW = Math.max(5, ...shown.map(r => r.short.length))
  const advice: Line = top ? [{ t: `⚑ ${top.short}`, color: SUGGESTION_COLOR[top.level], pulse: top.level === 'urgent' }] : []
  const cacheRow = (barWidth: number): [Line, Line] => [cacheLine(s.cache, now, labelW, barWidth, wide, s.price), advice]
  if (!shown.length) {
    return columns([[[{ t: 'usage appears after the first reply', dim: true }], rateSegs(verdictOf(s, rows, now), wide)], cacheRow(0)])
  }
  const rated = ratedOf(s, rows, now)
  const lay = (barWidth: number): [Line, Line][] => [
    ...rated.map(({ row, r }): [Line, Line] => [quotaLine(row, labelW, barWidth, wide), rateSegs(r, wide)]),
    cacheRow(barWidth),
  ]
  // The bar takes what the widest row's words leave, the bar's own trailing space included
  const room = cols - Math.max(...columns(lay(0)).map(width)) - 1
  const modes = modesLine(s, now)
  return [...columns(lay(room >= 8 ? Math.min(48, room) : 0)), ...(modes ? [modes] : [])]
}

/**
 * Auto mode's run or on pace mode, in a row under the band; none while both are off. `extra` goes after the mode's
 * own figures, before the command that turns it off.
 */
function modesLine(s: Snapshot, now: number, extra: readonly Seg[] = []): Line | null {
  const a = s.auto
  const hint = (cmd: string): Seg => ({ t: ` · ${cmd}`, dim: true })
  const mode = a?.ultra ? 'ultra' : 'auto'
  if (a?.paused) return [{ t: `${mode.padEnd(5)} ⏸ paused`, color: 'warning', bold: true }, { t: ` · ${a.plan}`, dim: true }, ...extra, hint(`/pace ${mode} resume`)]
  if (a?.heldUntil != null) {
    return [
      { t: `${mode.padEnd(5)} ⏸ held until ${Q.clockAt(a.heldUntil, a.heldUntil - now >= 86400_000)}`, color: 'warning', bold: true },
      { t: ` · ${a.why ?? ''}`, dim: true },
      ...extra,
      hint(`/pace ${mode} off`),
    ]
  }
  if (a?.ultra) {
    const u = a.ultra
    const tense = notchName(u.gear) === 'ease' || u.checkFails > 0
    return [
      { t: 'ultra ▶ ', color: tense ? 'warning' : 'success', bold: true, aura: true },
      { t: `${gearText(u.gear)} · turn ${a.turns}/${a.max}`, dim: true },
      ...ultraCheck(a),
      ...extra,
      hint('/pace ultra off'),
    ]
  }
  if (a) return [{ t: 'auto  ▶ ', color: 'success', bold: true }, { t: `${a.plan} · turn ${a.turns}/${a.max}`, dim: true }, ...extra, hint('/pace auto off')]
  if (s.onPace) return [{ t: 'on pace ●', color: 'success' }, { t: ' compacts heavy contexts, keeps the cache warm', dim: true }, ...extra, hint('/pace off')]
  return null
}

/** An ultra run's failed checks in a row, in the warning color; nothing while none failed */
const ultraCheck = (a: PaceAuto): Seg[] => (a.ultra?.checkFails ? [{ t: ` · check failed ${a.ultra.checkFails}×`, color: 'warning' }] : [])

/** Rows of [figures, rate or suggestion], the figures padded to one width so the separators stack in a column */
function columns(rows: readonly [Line, Line][]): Line[] {
  const left = Math.max(...rows.map(([l]) => width(l)))
  return rows.map(([l, r]) => [...l, ...(width(l) < left ? [{ t: ' '.repeat(left - width(l)) }] : []), SEP, ...r])
}

/** The status-line row: the band's quotas on one line, each with the rate scored against it, short bars */
export function statusRow(s: Snapshot, now: number, cols: number): Line {
  const rows = rowsOf(s.samples, now)
  const barWidth = cols >= 110 ? 14 : cols >= 85 ? 8 : 0
  const rated = ratedOf(s, rows, now)
  if (!rated.length) return [{ t: 'usage appears after the first reply', dim: true }, SEP, ...rateSegs(verdictOf(s, rows, now), cols >= 70)]
  return rated.flatMap(({ row, r }, i) => [...(i ? [SEP] : []), ...quotaLine(row, row.short.length, barWidth, false, true), { t: ' ' }, ...rateSegs(r, false)])
}

const levelWord = (v: RateVerdict) => (v.level === 'fast' || v.level === 'burst' || v.level === 'brisk' ? ` ${levelLook(v).word}` : '')

/** Plain text of a drawn line */
const plainOf = (l: Line) => l.map(x => x.t).join('')

/** The status-line entry: each quota's percent and the band's own rate cell, in plain text */
export function lineText(s: Snapshot, now: number): string {
  const rows = rowsOf(s.samples, now)
  const rated = ratedOf(s, rows, now)
  const a = s.auto
  // An ultra run at work says its gear after the quotas
  const ultra = a?.ultra && !a.paused && a.heldUntil == null ? [`ultra · ${gearText(a.ultra.gear)}${plainOf(ultraCheck(a))}`] : []
  if (!rated.length) return [plainOf(rateSegs(verdictOf(s, rows, now), false)), ...ultra].join(' │ ')
  return [...rated.map(({ row, r }) => {
    const u = Q.viewUsed(row.view)
    return u == null ? `${row.short} —` : `${row.short} ${pctOf(u)}% ${plainOf(rateSegs(r, false))}`
  }), ...ultra].join(' │ ')
}

// ----------------------------------------------------------------------
// The pane and the window
// ----------------------------------------------------------------------

/** A time on a chart's axis: the hour for a short window, the weekday, day of month and hour for a week */
function clock(at: number, W: number): string {
  const d = new Date(at)
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  return W > 86400 ? `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()]} ${d.getDate()} ${hm}` : hm
}

/** A window's burn-up chart: y-axis percents on the left, the braille plot, a time axis with the clock's tick */
function chartLines(s: Snapshot, row: Row, p: Q.Pace, w: number, h: number): Line[] {
  const r = row.reading?.resetsAt
  const series = r == null ? null : Q.trajectoryOf(row.key, r, s.samples, row.window)
  const gutter = (i: number) => (i === 0 ? '100%┤' : i === h - 1 ? '  0%┤' : i === Math.floor((h - 1) / 2) ? ' 50%┤' : '    │')
  const lines: Line[] = chart(series, p, w, h).map((runs, i) => [
    { t: gutter(i), dim: true },
    ...runs.map(run => {
      const color = run.layer === 'actual' ? quotaColor(row.key) : LAYER_COLOR[run.layer]
      return color ? { t: run.t, color } : { t: run.t }
    }),
  ])
  const tick = Math.min(w - 1, Math.floor(p.elapsed * w))
  const end = r ?? p.now + p.resetIn * 1000
  const from = clock(end - row.window * 1000, row.window)
  const to = clock(end, row.window)
  return [
    ...lines,
    [{ t: '    └' + '─'.repeat(tick) + '┴' + '─'.repeat(Math.max(0, w - tick - 1)), dim: true }],
    [{ t: '     ' + from + ' '.repeat(Math.max(1, w - from.length - to.length)) + to, dim: true }],
  ]
}

/** Words of `text` in lines of at most `w` columns, each after `lead` (the first) or as many spaces */
function wrapped(lead: Seg, text: string, w: number, seg: Omit<Seg, 't'> = {}): Line[] {
  const room = Math.max(10, w - [...lead.t].length)
  const out: string[] = []
  let cur = ''
  for (const word of text.split(' ')) {
    if (cur && [...cur].length + 1 + [...word].length > room) { out.push(cur); cur = word }
    else cur = cur ? `${cur} ${word}` : word
  }
  if (cur) out.push(cur)
  return out.map((t, i) => [i === 0 ? lead : { t: ' '.repeat([...lead.t].length) }, { ...seg, t }])
}

export type PaneLayout = {
  /** Columns the lines may take */
  cols: number
  /** Cells across a chart's plot */
  chartWidth: number
  /** Rows of a chart's plot, by quota */
  chartHeight: (row: Row) => number
  /** The /pace commands under it; the window has its own */
  prefs?: PacePrefs
}

export const chartHeight = (row: Row) => (row.window > 86400 ? 6 : 5)

/** One quota's block: its name and reset, its chart, its figures, a blank line */
function quotaBlock(s: Snapshot, row: Row, o: PaneLayout): Line[] {
  const head: Seg = { t: row.name, bold: true, color: quotaColor(row.key) }
  if (row.view.kind !== 'pace') return [[head], [{ t: Q.viewSummary(row.view), dim: true }], []]
  const p = row.view.pace
  const status = p.status
  const fc = Q.outlook(p)
  return [
    [head, { t: `  resets in ${Q.formatDuration(p.resetIn)}`, dim: true }],
    ...chartLines(s, row, p, o.chartWidth, o.chartHeight(row)),
    [
      { t: `${pctOf(p.used)}%`, bold: true, color: STATUS_COLOR[status] },
      { t: ` used · ${pctOf(p.elapsed)}% elapsed · `, dim: true },
      { t: Q.statusLabel(status), color: STATUS_COLOR[status] },
    ],
    [{ t: `${Q.paceSummary(p)}${fc ? ` · ${fc}` : ''}${p.ratio != null ? ` · ${p.ratio.toFixed(2)}× even pace` : ''}`, dim: true }],
    [],
  ]
}

const LEGEND: Line = [
  { t: '⣿', color: 'text' }, { t: ' usage  ', dim: true },
  { t: '⠒⠂', color: 'warning' }, { t: ' projection  ', dim: true },
  { t: '⠊⠁', color: 'subtle' }, { t: ' even pace  ┴ now', dim: true },
]

const NO_USAGE: Line[] = [[{ t: 'No usage yet: figures appear after the first reply, or run /pace refresh.', dim: true }], []]

/** The pane: every quota's chart and figures, the prompting rate against each, the cache, suggestions */
export function paneLines(s: Snapshot, now: number, o: PaneLayout): Line[] {
  const rows = rowsOf(s.samples, now)
  const out: Line[] = rows.length ? rows.flatMap(row => quotaBlock(s, row, o)) : NO_USAGE
  return [...out, ...restLines(s, now, o)]
}

/** Everything under the charts: their legend, the prompting rate, the cache, suggestions, the commands */
function restLines(s: Snapshot, now: number, o: PaneLayout): Line[] {
  const rows = rowsOf(s.samples, now)
  const v = verdictOf(s, rows, now)
  const out: Line[] = []
  const blank = () => out.push([])
  if (rows.some(r => r.view.kind === 'pace')) {
    out.push(LEGEND)
    blank()
  }

  // Prompting: the rate, then against each quota, the worst one's advice last
  const rated = ratedOf(s, rows, now)
  const worst = worstOf(rated)?.row
  const labelW = Math.max(0, ...rated.map(q => q.row.short.length))
  const l = levelLook(v)
  out.push([{ t: 'Prompting', bold: true }])
  out.push([{ t: `${v.perHour} prompts/h`, bold: true }, { t: `  · ${v.last15} in the last 15m, every session`, dim: true }])
  const spend = s.spend ?? []
  const sessions = sessionsOf(spend, now)
  if (v.usdPerHour != null) {
    const perPrompt = usdPerPrompt(spend, s.prompts, now)
    out.push([
      { t: rateText(v), bold: true },
      { t: `  · across ${sessions} session${sessions === 1 ? '' : 's'}${perPrompt != null ? ` · ${formatUsd(perPrompt)} a prompt` : ''}`, dim: true },
    ])
  }
  for (const { row, r } of rated) {
    const ql = levelLook(r)
    const figures = [
      landingText(r, true) ?? 'lands —',
      r.costPerPrompt != null ? `~${r.costPerPrompt.toFixed(r.costPerPrompt < 1 ? 2 : 1)}% per prompt` : 'no per-prompt cost yet',
      budgetText(r) ? `budget ${budgetText(r)}` : '',
      r.emptyIn != null && r.resetIn != null && r.emptyIn < r.resetIn ? `out in ${compact(r.emptyIn)}` : '',
    ].filter(Boolean)
    out.push([{ t: `${row.short.padEnd(labelW)} `, dim: true }, { t: `${ql.mark} ${ql.word}`, color: ql.color, bold: true }, { t: `  · ${figures.join(' · ')}`, dim: true }])
  }
  const promptBuckets = buckets(s.prompts, now, 20, 15 * MIN)
  out.push([{ t: sparkline(promptBuckets), color: l.color }, { t: `  prompts per 15m, last ${(promptBuckets.length * 15) / 60}h`, dim: true }])
  const advice = (() => {
    const name = worst ? Q.theName(worst.name) : 'the 5-hour window'
    const Name = name[0]!.toUpperCase() + name.slice(1)
    if ((v.level === 'fast' || v.level === 'burst') && v.emptyIn != null && v.resetIn != null) {
      const slow = budgetText(v) ? ` Slow to ≤${budgetText(v)}` : ''
      return v.level === 'fast'
        ? `At ${scoreText(v)} ${name} runs out in ${Q.formatDuration(v.emptyIn)}, ${Q.formatDuration(v.resetIn - v.emptyIn)} before it resets, and it is already over pace.${slow}.`
        : `A burst: at ${scoreText(v)} ${name} would run out in ${Q.formatDuration(v.emptyIn)}, though its average is on pace. Fine for a short run.${slow ? `${slow} if it keeps up.` : ''}`
    }
    if (v.level === 'fast') return `${Name} is ahead of the clock: ease off until it falls back under pace.`
    if (v.level === 'brisk' && budgetText(v)) return `Close to the budget of ${budgetText(v)} for ${name}.`
    if (rated.some(q => q.r.costPerPrompt == null)) return 'A per-prompt cost appears after 3 prompts and half an hour of readings.'
    return null
  })()
  if (advice) out.push(...wrapped({ t: '' }, advice, o.cols, { color: v.level === 'ok' || v.level === 'idle' ? 'subtle' : l.color }))
  blank()

  // Cache & tokens
  out.push([{ t: 'Cache & tokens', bold: true }])
  const c = s.cache
  if (c) {
    const left = cacheLeft(c, now)
    const cost = nextCost(c.tokens, c.ttl)
    const size = c.window > 0 ? `${formatTokens(c.tokens)} of ${formatTokens(c.window)} (${Math.round((c.tokens / c.window) * 100)}%)` : formatTokens(c.tokens)
    const barWidth = Math.max(10, Math.min(40, o.cols - 34))
    out.push([
      ...cacheLine(c, now, 5, barWidth, false),
      { t: left ? ` left of ${c.ttl}` : ` · lapsed ${Q.formatDuration((now - c.at) / 1000 - ttlSeconds(c.ttl))} ago`, dim: true },
    ])
    const usd = (tokens: number) => (s.price != null ? ` (${formatUsd(tokens * s.price)})` : '')
    out.push([{ t: `context ${size} · next prompt ≈${formatTokens(cost.warm)} tk${usd(cost.warm)} warm, ≈${formatTokens(cost.cold)}${usd(cost.cold)} cold (${Math.round(cost.cold / Math.max(1, cost.warm))}×)`, dim: true }])
  } else out.push([{ t: 'The cache timer starts with the next reply.', dim: true }])
  const warm = s.warm ?? 'off'
  out.push([{ t: 'warm mode ', dim: true }, warm === 'off' ? { t: 'off', dim: true } : { t: warm, color: 'success', bold: true }, { t: warm === 'off' ? '  · /pace warm compact | ping' : '  · acts under 10m left, while idle · /pace warm off', dim: true }])
  blank()

  const advices = adviceOf(s, now)
  if (advices.length) {
    out.push([{ t: 'Suggestions', bold: true }])
    for (const x of advices.slice(0, 4)) out.push(...wrapped({ t: `${x.level === 'info' ? '•' : '⚑'} `, color: SUGGESTION_COLOR[x.level] }, x.text, o.cols))
    blank()
  }
  if (o.prefs) {
    out.push([{ t: `/pace refresh · /pace window · /pace ${o.prefs.onPace ? 'off' : 'on'} (on pace mode) · /pace auto <plan> · /pace ${o.prefs.band ? 'hide' : 'show'} band · /pace line ${o.prefs.line ? 'off' : 'on'}`, dim: true }])
  }
  return out
}

// ----------------------------------------------------------------------
// The plan's timeline
// ----------------------------------------------------------------------

export type PlanLayout = {
  /** The plan file, as named */
  plan: string
  /** Auto mode's run on this plan; null when it is not running one */
  auto: PaceAuto | null
  /** Columns the lines may take */
  cols: number
  now: number
  /** Rows the lines may take; 30 when not said */
  rows?: number
}

const NO_STEPS = 'No checklist in this plan yet: write its steps as - [ ] items and auto mode ticks them off as it goes.'

/** What auto mode is doing on the plan, in a few words */
function runText(a: PaceAuto | null, now: number): Seg {
  if (!a) return { t: 'auto mode off', dim: true }
  if (a.paused) return { t: `paused · ${a.why ?? '/pace auto resume picks it back up'}`, color: 'warning' }
  if (a.heldUntil != null) return { t: `holding until ${Q.clockAt(a.heldUntil, a.heldUntil - now >= 86400_000)} · ${a.why ?? ''}`, color: 'warning' }
  if (a.waitingUntil != null) return { t: `${a.why ?? 'Waiting'} · until ${Q.clockAt(a.waitingUntil, false)}`, color: 'subtle' }
  return { t: `turn ${a.turns} of ${a.max}`, color: 'success' }
}

/** A run of steps drawn as one node: `count` steps folded away before or after the ones shown */
type Fold = { fold: 'done' | 'next'; count: number }

/** What an ultra run adds to its timeline: the phase of the step under way, and the steps out on subagents */
type RunMarks = { phase?: string; out: ReadonlySet<string> }

/** A node: its mark and its text */
function nodeLine(e: Step | Fold, upNext: boolean, lastDone: boolean, marks: RunMarks = { out: new Set() }): Line {
  if ('fold' in e) {
    const s = e.count === 1 ? '' : 's'
    return e.fold === 'done'
      ? [{ t: '  ' }, { t: '✔', color: 'success', dim: true }, { t: '  ' }, { t: `${e.count} earlier step${s} done`, dim: true }]
      : [{ t: '  ' }, { t: '○', color: 'subtle' }, { t: '  ' }, { t: `${e.count} more step${s}`, dim: true }]
  }
  if (e.state === 'done') return [{ t: '  ' }, { t: '✔', color: 'success', ...(lastDone ? { pop: true } : {}) }, { t: '  ' }, { t: e.text, dim: true }]
  if (e.state === 'now') return [{ t: '  ' }, { t: '◉', color: 'suggestion', bold: true, spin: true }, { t: '  ' }, { t: e.text, bold: true }, { t: ` · ${marks.phase ?? 'under way'}`, color: 'suggestion', whole: true }]
  if (marks.out.has(e.text)) return [{ t: '  ' }, { t: '◌', color: 'suggestion', spin: true }, { t: '  ' }, { t: e.text }, { t: ' · with a subagent', color: 'suggestion', whole: true }]
  return upNext
    ? [{ t: '  ' }, { t: '○', color: 'subtle' }, { t: '  ' }, { t: e.text }, { t: ' · up next', dim: true, whole: true }]
    : [{ t: '  ' }, { t: '○', color: 'subtle' }, { t: '  ' }, { t: e.text, dim: true }]
}

/** The line between two nodes: solid behind the work, two flowing rows into the step under way, dotted ahead */
function linkLines(from: Step | Fold, to: Step | Fold): Line[] {
  const done = (e: Step | Fold) => ('fold' in e ? e.fold === 'done' : e.state === 'done')
  if (!('fold' in to) && to.state === 'now') return [[{ t: '  ' }, { t: '│', color: 'success', flow: true }], [{ t: '  ' }, { t: '│', color: 'success', flow: true }]]
  if (done(from) && done(to)) return [[{ t: '  ' }, { t: '│', color: 'success', dim: true }]]
  if (done(from)) return [[{ t: '  ' }, { t: '│', color: 'success' }]]
  return [[{ t: '  ' }, { t: '┆', color: 'subtle' }]]
}

/**
 * Styled segments in lines of at most `room` columns, broken between words (a `whole` run is one word, its leading
 * spaces dropped at a break); a word longer than a line is cut, and no line starts with a space
 */
function wrapSegs(segs: readonly Seg[], room: number): Line[] {
  const out: Line[] = [[]]
  let used = 0
  const pieces = (s: Seg) => (s.whole ? (/^\s/.test(s.t) ? [s.t.match(/^\s+/)![0], s.t.trimStart()] : [s.t]) : s.t.split(/(\s+)/).filter(Boolean))
  for (const s of segs) {
    for (const piece of pieces(s)) {
      const space = /^\s/.test(piece)
      let chars = [...piece]
      if (space && (used === 0 || used + chars.length >= room)) continue
      if (!space && used > 0 && used + chars.length > room) {
        const last = out[out.length - 1]!
        if (last.length && /^\s+$/.test(last[last.length - 1]!.t)) last.pop()
        out.push([])
        used = 0
      }
      while (chars.length) {
        if (used >= room) { out.push([]); used = 0 }
        const take = chars.slice(0, room - used)
        out[out.length - 1]!.push({ ...s, t: take.join('') })
        used += take.length
        chars = chars.slice(take.length)
      }
    }
  }
  return out
}

/** A node's line wrapped to `cols`: its text's later rows under its first, on `rail`, the line down to the next node */
function wrapNode(line: Line, rail: Seg, cols: number): Line[] {
  const [indent, mark, gap, ...body] = line
  const rows = wrapSegs(body, Math.max(8, cols - 5))
  return rows.map((r, i) => (i ? [{ t: '  ' }, rail, { t: '  ' }, ...r] : [indent!, mark!, gap ?? { t: '  ' }, ...r]))
}

/** The steps from `lo` to `hi` drawn as a timeline, with folds for the steps either side of them */
function timeline(steps: readonly Step[], lo: number, hi: number, cols: number, marks?: RunMarks): Line[] {
  const entries: (Step | Fold)[] = [
    ...(lo > 0 ? [{ fold: 'done' as const, count: lo }] : []),
    ...steps.slice(lo, hi + 1),
    ...(hi < steps.length - 1 ? [{ fold: 'next' as const, count: steps.length - 1 - hi }] : []),
  ]
  const upNext = steps.findIndex(s => s.state === 'next')
  const lastDone = steps.map(s => s.state).lastIndexOf('done')
  return entries.flatMap((e, i) => {
    const below = entries[i + 1]
    const { flow: _, ...rail } = below ? linkLines(e, below)[0]![1]! : { t: ' ' }
    return [
      ...(i ? linkLines(entries[i - 1]!, e) : []),
      ...wrapNode(nodeLine(e, e === steps[upNext], e === steps[lastDone], marks), rail, cols),
    ]
  })
}

/** The order steps join the timeline: the focus, the step after it, two before, then onward, then further back */
function byPriority(focus: number, n: number): number[] {
  const order = [focus, focus + 1, focus - 1, focus - 2]
  for (let i = 2; focus + i < n || focus - i - 1 >= 0; i++) order.push(focus + i, focus - i - 1)
  return order.filter(i => i >= 0 && i < n)
}

/**
 * The plan's timeline: its name and the steps done, a progress bar and what auto mode is doing, then the steps
 * around the one under way (or the next one up), with the rest folded away to fit the rows.
 */
export function planLines(steps: readonly Step[], o: PlanLayout): Line[] {
  const title: Seg = { t: o.plan, bold: true }
  if (!steps.length) return [[title, { t: '  ·  ', dim: true }, runText(o.auto, o.now)], [], [{ t: NO_STEPS, dim: true }]]
  const done = steps.filter(s => s.state === 'done').length
  const barWidth = Math.max(10, Math.min(40, o.cols - 30, o.cols - 5))
  const filled = Math.round((done / steps.length) * barWidth)
  const bar: Line = [
    { t: '━'.repeat(filled), color: 'success' },
    { t: '─'.repeat(barWidth - filled), color: 'subtle' },
    { t: ` ${pctOf(done / steps.length)}%`, dim: true },
  ]
  const run = runText(o.auto, o.now)
  const u = o.auto?.ultra
  // The phase names the step under way where it is not plain work
  const marks: RunMarks | undefined = u ? { phase: u.phase === 'work' ? undefined : u.phase, out: new Set(u.fanout?.steps ?? []) } : undefined
  // A narrow sidebar gives each its own rows
  const head: Line[] = [
    ...wrapSegs([title, { t: `  ·  ${done} of ${steps.length} steps done`, dim: true }], o.cols),
    ...(u ? wrapSegs([{ t: 'goal  ', dim: true }, { t: u.goal }], o.cols) : []),
    ...(width(bar) + 5 + width([run]) <= o.cols ? [[...bar, { t: '  ·  ', dim: true }, run]] : [bar, ...wrapSegs([run], o.cols)]),
    [],
  ]
  const room = (o.rows ?? 30) - head.length
  const unfinished = steps.findIndex(s => s.state !== 'done')
  const focus = unfinished < 0 ? steps.length - 1 : unfinished
  let lo = focus
  let hi = focus
  for (const i of byPriority(focus, steps.length).slice(1)) {
    const [nlo, nhi] = [Math.min(lo, i), Math.max(hi, i)]
    if (timeline(steps, nlo, nhi, o.cols, marks).length > room) break
    ;[lo, hi] = [nlo, nhi]
  }
  return [...head, ...timeline(steps, lo, hi, o.cols, marks)]
}

/** The window's state: a snapshot, when the session wrote it, and the plan's steps; `plan` absent without a checklist */
export type Feed = Snapshot & { at: number; plan?: { name: string; steps: readonly Step[] } }

/** What the window's keys chose: `focus` is the 1-based quota drawn alone */
export type ScreenOptions = { focus?: number }

/** Terminals at least this wide draw the charts two to a row */
const TWO_COLUMNS = 180

/**
 * The window, `cols` by at most `rows`: a title with the figures' age and the keys, then the pane with its charts
 * as wide as the terminal (two to a row on a wide one) and as tall as the rows left allow, in ANSI. A focused
 * quota is drawn alone, its chart taking every row.
 */
export function screen(f: Feed, now: number, cols: number, rows: number, opts: ScreenOptions = {}): string {
  const age = Math.max(0, now - f.at)
  const charted = rowsOf(f.samples, now).filter(r => r.view.kind === 'pace').slice(0, 9)
  const focused = opts.focus != null ? charted[opts.focus - 1] : undefined
  const keys = focused ? `${opts.focus} again: all` : charted.length > 1 ? `1–${charted.length} focus` : charted.length ? '1 focus' : ''
  const title: Line = [
    { t: 'Pace', bold: true },
    { t: `  · updated ${age < MIN ? 'just now' : `${compact(age / 1000)} ago`} · q quits · w warm · r refresh${keys ? ` · ${keys}` : ''}`, dim: true },
  ]
  const modes = splitModes(f, now)
  const layout = (w: number, h: number): PaneLayout => ({ cols: w, chartWidth: Math.max(16, w - 6), chartHeight: () => h })
  const fit = (lines: Line[]) => [title, ...(modes ? [modes] : []), [], ...lines].slice(0, rows).map(l => toAnsi(clip(l, cols))).join('\n')

  if (focused) {
    const fixed = quotaBlock(f, focused, layout(cols, 0)).length + 2
    return fit(quotaBlock(f, focused, layout(cols, Math.max(4, rows - fixed))))
  }
  const two = cols >= TWO_COLUMNS && charted.length > 1
  const colW = two ? Math.floor((cols - 3) / 2) : cols
  const chartRows = two ? Math.ceil(charted.length / 2) : charted.length
  // The charts share what the rest leaves, each between 4 and 16 rows
  const body = (h: number): Line[] => {
    const blocks = rowsOf(f.samples, now).map(row => quotaBlock(f, row, layout(colW, h)))
    const top = two ? pairs(blocks, colW) : blocks.flat()
    return [...(blocks.length ? top : NO_USAGE), ...planBlock(f, now, cols), ...restLines(f, now, layout(cols, h))]
  }
  const fixed = body(0).length + 2 + (modes ? 1 : 0)
  return fit(body(Math.max(4, Math.min(16, Math.floor((rows - fixed) / Math.max(1, chartRows))))))
}

/** The modes row under the window's title, saying so while on pace mode thinks one effort level lighter */
function splitModes(f: Feed, now: number): Line | null {
  const lighter = f.onPace && runsOut(snapshotOf(f, now))
  return modesLine(f, now, lighter ? [{ t: ' · effort a level lighter', color: 'warning' }] : [])
}

/** Rows the window gives the plan's timeline */
const PLAN_ROWS = 12

/** The plan's timeline in the window, under the charts; nothing without a checklist */
function planBlock(f: Feed, now: number, cols: number): Line[] {
  const steps = Array.isArray(f.plan?.steps) ? f.plan.steps : []
  if (!f.plan || !steps.length) return []
  const auto = f.auto?.plan === f.plan.name ? f.auto : null
  return [[{ t: 'Plan', bold: true }], ...planLines(steps, { plan: f.plan.name, auto, cols, now, rows: PLAN_ROWS }), []]
}

/** Blocks two to a row, the left one padded to `colW` columns */
function pairs(blocks: readonly Line[][], colW: number): Line[] {
  const out: Line[] = []
  for (let i = 0; i < blocks.length; i += 2) {
    const l = blocks[i]!
    const r = blocks[i + 1] ?? []
    for (let j = 0; j < Math.max(l.length, r.length); j++) {
      const left = clip(l[j] ?? [], colW)
      out.push([...left, { t: ' '.repeat(colW - width(left) + 3) }, ...(r[j] ?? [])])
    }
  }
  return out
}

/** A line cut to `cols` columns */
function clip(line: Line, cols: number): Line {
  const out: Line = []
  let left = cols
  for (const s of line) {
    if (left <= 0) break
    const chars = [...s.t]
    out.push(chars.length <= left ? s : { ...s, t: chars.slice(0, left).join('') })
    left -= chars.length
  }
  return out
}

/** What a key pressed in the window does: focus a quota (a digit; again shows all), send to the session, or quit */
export type KeyAction = { focus?: number | undefined; send?: 'warm' | 'refresh'; quit?: true }

export function keyAction(key: string, focus: number | undefined): KeyAction {
  if (key === 'q' || key === 'Q' || key === '\x03') return { quit: true }
  if (/^[1-9]$/.test(key)) return { focus: focus === Number(key) ? undefined : Number(key) }
  if (key === 'w') return { send: 'warm' }
  if (key === 'r') return { send: 'refresh' }
  return {}
}

/** The gap between two plans drawn side by side */
const PAIR_GAP = '   '

/** Two columns of lines side by side: each left line padded to `width`, a gap, the right line; the longer runs on alone */
export function sideBySide(left: readonly Line[], right: readonly Line[], width: number): Line[] {
  return Array.from({ length: Math.max(left.length, right.length) }, (_, i) => {
    const l = left[i] ?? []
    const pad = Math.max(0, width - l.reduce((n, s) => n + [...s.t].length, 0))
    return [...l, { t: ' '.repeat(pad) + PAIR_GAP }, ...(right[i] ?? [])]
  })
}

/** How wide each of two plans is drawn in `cols` */
export const pairWidth = (cols: number) => Math.max(20, Math.floor((cols - PAIR_GAP.length) / 2))
