// Every drawing as lines of styled segments: the band above the prompt, the status-line row, the pane and the
// full-screen window. The hooks module turns a line into Text elements, the window and the status line into ANSI.
// Pure; times in ms.

import type { PaceCacheInfo, PacePrefs } from '../types'
import { cacheLeft, formatTokens, formatUsd, nextCost, ttlSeconds, type Suggestion } from './cache.ts'
import { chart, type Layer } from './chart.ts'
import { adviceOf, bandRows, isFable, ratedOf, rowsOf, verdictOf, worstOf, type Row, type Snapshot } from './model.ts'
import * as Q from './quota.ts'
import { bar, budgetText, buckets, rateText, sparkline, type Cell, type RateVerdict } from './rate.ts'
import { sessionsOf, usdPerPrompt } from './spend.ts'

const MIN = 60_000

/** A run of styled text; `bar` marks a bar's cells for the band's animation, `pulse` a warning that blinks there */
export type Seg = { t: string; color?: string; dim?: boolean; bold?: boolean; bar?: boolean; pulse?: boolean }
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
function quotaLine(row: Row, labelW: number, barWidth: number, wide: boolean): Line {
  const out: Line = [{ t: `${row.short.padEnd(labelW)} `, dim: true }]
  if (row.view.kind !== 'pace') return [...out, { t: Q.viewSummary(row.view), dim: true }]
  const p = row.view.pace
  const status = p.status
  if (barWidth > 0) out.push(...barSegs(bar(p.used, p.elapsed, barWidth), row.key, status), { t: ' ' })
  out.push({ t: `${pctOf(p.used)}%`.padStart(4), color: STATUS_COLOR[status], bold: true })
  out.push({ t: ` ${Q.statusLabel(status).padEnd(11)}`, color: STATUS_COLOR[status] })
  if (wide) out.push({ t: ` ↻ ${compact(p.resetIn).padEnd(6)}`, dim: true })
  return out
}

/** The prompting rate against a quota: the rate, its budget, and for a burst or worse when the quota runs out */
function rateSegs(v: RateVerdict, wide: boolean): Seg[] {
  const l = LEVEL[v.level]
  const fast = v.level === 'fast'
  const budget = budgetText(v)
  const out: Seg[] = [{ t: `${l.mark} `, color: l.color, pulse: fast }, { t: rateText(v), bold: true }]
  if (wide && budget) out.push({ t: ` of ${budget}`, dim: true })
  if (fast) out.push({ t: ' too fast', color: 'error', bold: true, pulse: true })
  else if (v.level === 'burst' || v.level === 'brisk') out.push({ t: ` ${l.word}`, color: 'warning' })
  if (wide && (fast || v.level === 'burst') && v.emptyIn != null) out.push({ t: ` · out in ${compact(v.emptyIn)}`, dim: true })
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

/** Auto mode's run or on pace mode, in a row under the band; none while both are off */
function modesLine(s: Snapshot, now: number): Line | null {
  const a = s.auto
  if (a?.paused) return [{ t: 'auto  ⏸ paused', color: 'warning', bold: true }, { t: ` · ${a.plan} · /pace auto resume`, dim: true }]
  if (a?.heldUntil != null) {
    return [
      { t: `auto  ⏸ held until ${Q.clockAt(a.heldUntil, a.heldUntil - now >= 86400_000)}`, color: 'warning', bold: true },
      { t: ` · ${a.why ?? ''} · /pace auto off`, dim: true },
    ]
  }
  if (a) return [{ t: 'auto  ▶ ', color: 'success', bold: true }, { t: `${a.plan} · turn ${a.turns}/${a.max} · /pace auto off`, dim: true }]
  if (s.onPace) return [{ t: 'on pace ●', color: 'success' }, { t: ' compacts heavy contexts while warm, keeps the cache warm', dim: true }]
  return null
}

/** Rows of [figures, rate or suggestion], the figures padded to one width so the separators stack in a column */
function columns(rows: readonly [Line, Line][]): Line[] {
  const left = Math.max(...rows.map(([l]) => width(l)))
  return rows.map(([l, r]) => [...l, ...(width(l) < left ? [{ t: ' '.repeat(left - width(l)) }] : []), SEP, ...r])
}

/** The status-line row: the band's quotas and the overall rate on one line, short bars */
export function statusRow(s: Snapshot, now: number, cols: number): Line {
  const rows = rowsOf(s.samples, now)
  const shown = bandRows(rows)
  const barWidth = cols >= 110 ? 14 : cols >= 85 ? 8 : 0
  const wide = cols >= 70
  const parts: Line = []
  for (const row of shown) parts.push(...quotaLine(row, row.short.length, barWidth, false), SEP)
  if (!shown.length) parts.push({ t: 'usage appears after the first reply', dim: true }, SEP)
  parts.push(...rateSegs(verdictOf(s, rows, now), wide))
  return parts
}

/** The status-line entry: the band in a few words */
export function lineText(s: Snapshot, now: number): string {
  const rows = rowsOf(s.samples, now)
  const parts = bandRows(rows).map(r => {
    const u = Q.viewUsed(r.view)
    return `${r.short} ${u == null ? '—' : `${pctOf(u)}%`}`
  })
  const v = verdictOf(s, rows, now)
  const word = v.level === 'fast' || v.level === 'burst' || v.level === 'brisk' ? ` ${LEVEL[v.level].word}` : ''
  parts.push(`${rateText(v)}${word}`)
  return parts.join(' · ')
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
  const l = LEVEL[v.level]
  out.push([{ t: 'Prompting', bold: true }])
  out.push([{ t: `${v.perHour}/h`, bold: true }, { t: `  · ${v.last15} in the last 15m`, dim: true }])
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
    const ql = LEVEL[r.level]
    const figures = [
      r.costPerPrompt != null ? `~${r.costPerPrompt.toFixed(r.costPerPrompt < 1 ? 2 : 1)}% per prompt` : 'no per-prompt cost yet',
      budgetText(r) ? `budget ${budgetText(r)}` : '',
      r.emptyIn != null && r.resetIn != null && r.emptyIn < r.resetIn ? `out in ${compact(r.emptyIn)}` : '',
    ].filter(Boolean)
    out.push([{ t: `${row.short.padEnd(labelW)} `, dim: true }, { t: `${ql.mark} ${ql.word}`, color: ql.color, bold: true }, { t: `  · ${figures.join(' · ')}`, dim: true }])
  }
  const promptBuckets = buckets(s.prompts, now, 20, 15 * MIN)
  out.push([{ t: sparkline(promptBuckets), color: l.color }, { t: `  prompts per 15m, last ${(promptBuckets.length * 15) / 60}h`, dim: true }])
  const advice = (() => {
    const name = worst?.name ?? 'the 5-hour window'
    if ((v.level === 'fast' || v.level === 'burst') && v.emptyIn != null && v.resetIn != null) {
      const slow = budgetText(v) ? ` Slow to ≤${budgetText(v)}` : ''
      return v.level === 'fast'
        ? `At ${rateText(v)} ${name} runs out in ${Q.formatDuration(v.emptyIn)}, ${Q.formatDuration(v.resetIn - v.emptyIn)} before it resets, and it is already over pace.${slow}.`
        : `A burst: at ${rateText(v)} ${name} would run out in ${Q.formatDuration(v.emptyIn)}, though its average is on pace. Fine for a short run.${slow ? `${slow} if it keeps up.` : ''}`
    }
    if (v.level === 'fast') return `${name} is ahead of the clock: ease off until it falls back under pace.`
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
    const pct = Math.round((c.tokens / c.window) * 100)
    const barWidth = Math.max(10, Math.min(40, o.cols - 34))
    out.push([
      ...cacheLine(c, now, 5, barWidth, false),
      { t: left ? ` left of ${c.ttl}` : ` · lapsed ${Q.formatDuration((now - c.at) / 1000 - ttlSeconds(c.ttl))} ago`, dim: true },
    ])
    const usd = (tokens: number) => (s.price != null ? ` (${formatUsd(tokens * s.price)})` : '')
    out.push([{ t: `context ${formatTokens(c.tokens)} of ${formatTokens(c.window)} (${pct}%) · next prompt ≈${formatTokens(cost.warm)} tk${usd(cost.warm)} warm, ≈${formatTokens(cost.cold)}${usd(cost.cold)} cold (${Math.round(cost.cold / Math.max(1, cost.warm))}×)`, dim: true }])
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
    out.push([{ t: `/pace refresh · /pace window · /pace ${o.prefs.band ? 'hide' : 'show'} band · /pace line ${o.prefs.line ? 'off' : 'on'}`, dim: true }])
  }
  return out
}

/** The window's state: a snapshot and when the session wrote it */
export type Feed = Snapshot & { at: number }

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
  const layout = (w: number, h: number): PaneLayout => ({ cols: w, chartWidth: Math.max(16, w - 6), chartHeight: () => h })
  const fit = (lines: Line[]) => [title, [], ...lines].slice(0, rows).map(l => toAnsi(clip(l, cols))).join('\n')

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
    return [...(blocks.length ? top : NO_USAGE), ...restLines(f, now, layout(cols, h))]
  }
  const fixed = body(0).length + 2
  return fit(body(Math.max(4, Math.min(16, Math.floor((rows - fixed) / Math.max(1, chartRows))))))
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
