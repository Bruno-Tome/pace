// pace: rate-limit pacing for Claude Code in the terminal, inspired by weektoken
// (https://github.com/3dnow/claude-mods/tree/main/weektoken).
//
//   · A band above the prompt: the 5-hour and the weekly bar, each with its status and the rate against what that
//     quota can afford, then the prompt cache's timer with the next prompt's cost. The `placement` option draws it
//     there, or writes one row of it in ANSI to ~/.claude/pace-row.txt for a status-line command to print.
//   · A status-line entry with the same figures in a few words.
//   · /pace opens a terminal window of its own (bin/viewer.ts) drawing every quota as a burn-up chart, the rate,
//     the cache and suggestions, full-screen; /pace pane draws the same in a pane here.
//   · Warm mode (/pace warm compact | ping) keeps an idle cache from lapsing.
//   Data: the session's own rate limits, context and cost (after every reply), Claude Code's usage cache in
//   ~/.claude.json, and Anthropic's usage endpoint through Claude Code's own login for per-model quotas.
//   What is drawn is built in view.ts from model.ts; this module keeps the data and the hooks.

import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { PaceCacheInfo, PaceCacheTtl, PacePrefs, PaceReading, PaceSample, PaceSpend, PaceWarmMode } from '../types'
import { addPrice, priceOf, replyEquivalents, ttlSeconds, warmAction } from './cache.ts'
import type { Snapshot } from './model.ts'
import * as Q from './quota.ts'
import { mergePrompts } from './rate.ts'
import { addSpend, mergeSpend } from './spend.ts'
import { bandLines, chartHeight, lineText, paneLines, statusRow, toAnsi, type Seg } from './view.ts'

const PANE = 'pace'
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
const MIN = 60_000
const DEFAULT_PREFS: PacePrefs = { band: true, line: true, warm: 'off' }

const samplesA = atom({ plugin: 'pace', key: 'samples' } as const, [] as PaceSample[])
const promptsA = atom({ plugin: 'pace', key: 'prompts' } as const, [] as number[])
const prefsA = atom({ plugin: 'pace', key: 'prefs' } as const, DEFAULT_PREFS)
const nowA = atom({ plugin: 'pace', key: 'now' } as const, 0)
const cacheA = atom({ plugin: 'pace', key: 'cache' } as const, null as PaceCacheInfo | null)
const ttlA = atom({ plugin: 'pace', key: 'ttl' } as const, '1h' as PaceCacheTtl)
const pricesA = atom({ plugin: 'pace', key: 'prices' } as const, [] as number[])
const spendA = atom({ plugin: 'pace', key: 'spend' } as const, [] as PaceSpend[])

// ======================================================================
// Drawing
// ======================================================================

const toText = (T: any, segs: readonly Seg[]): any[] =>
  segs.map(s => (s.dim ? <T dimColor bold={s.bold}>{s.t}</T> : <T color={s.color} bold={s.bold}>{s.t}</T>))

async function snapshot($: any): Promise<Snapshot> {
  return {
    samples: (await read($, samplesA)) ?? [],
    prompts: (await read($, promptsA)) ?? [],
    cache: (await read($, cacheA)) ?? null,
    warm: ((await read($, prefsA)) ?? DEFAULT_PREFS).warm ?? 'off',
    price: priceOf((await read($, pricesA)) ?? []),
    spend: (await read($, spendA)) ?? [],
  }
}

function drawBand($: any, e: any, s: Snapshot, now: number): any {
  const { Box, Text, Client } = $.ui.resolve(e)
  const lines = bandLines(s, now, e.props.bodyColumns ?? 100)
  // Animated where the surface runs surface modules; drawn still elsewhere
  if (Client) return <Client key="pace-band" module="./band-client.tsx" props={{ lines }} />
  return (
    <Box key="pace-band" flexDirection="column">
      {lines.map((segs, i) => <Text key={`pace-line-${i}`} wrap="truncate-end">{toText(Text, segs)}</Text>)}
    </Box>
  )
}

const paneLayout = (cols: number, prefs: PacePrefs) => ({ cols, chartWidth: Math.max(16, Math.min(72, cols - 6)), chartHeight, prefs })

function drawPane($: any, e: any, s: Snapshot, prefs: PacePrefs, now: number): any {
  const { Box, Text } = $.ui.resolve(e)
  const lines = paneLines(s, now, paneLayout(e.props.bodyColumns ?? 60, prefs))
  return (
    <Box flexDirection="column">
      {lines.map((segs, i) => <Text key={`l-${i}`} wrap="truncate-end">{segs.length ? toText(Text, segs) : ' '}</Text>)}
    </Box>
  )
}

// ======================================================================
// Data
// ======================================================================

type RateLimitLike = { kind: string; percentUsed: number; resetsAt?: string }

const ROW_FILE = '.claude/pace-row.txt'
const STATE_FILE = '.claude/pace-state.json'
const VIEW_FILE = '.claude/pace-view.command'
/** The window's keys for the session, `{ id, cmd }`: the viewer writes it, the mod polls it while feeding */
const KEYS_FILE = '.claude/pace-keys.json'
const WARM_NEXT: Record<PaceWarmMode, PaceWarmMode> = { off: 'ping', ping: 'compact', compact: 'off' }
/** Columns the status-line row is laid out for: the command is not told the terminal's width */
const ROW_COLS = 120
/** Samples the window gets: its charts show current windows, a week at most */
const STATE_SPAN = 8 * 24 * 60 * MIN

let placement: 'above' | 'status' = 'above'
let ttlOption: 'auto' | PaceCacheTtl = 'auto'
let terminalApp = 'Terminal'
let lastLine: string | undefined
let lastRow: string | undefined
let lastState: string | undefined
/** The window was opened from this session: keep its state file current */
let feeding = false
/** The last window key handled, by its id (the time it was pressed) */
let lastKey = 0
let keysTimer: { cancel: () => void } | undefined
let lastFetch = 0
let lastFetchPrompt = 0
/** A turn is running: warm mode waits */
let working = false
/** Warm-mode actions since the person's last prompt, and the reply it last acted on */
let warmActions = 0
let warmFor: number | null = null
let timers: { cancel: () => void }[] = []
/** The session's cost when it was last measured, which the next reply's cost is counted from */
let lastUsd: number | null = null
/** This session's own name in the shared spend: a reload counts on from the ledger under it, never twice */
let spendId = ''

const homeOf = async ($: any): Promise<string | undefined> => $.env.get('HOME')

/** The status-line entry, the status-line row and the window's state, each written only when it changed */
async function refreshLine($: any): Promise<void> {
  const prefs = (await read($, prefsA)) ?? DEFAULT_PREFS
  const s = await snapshot($)
  const now = await $.clock.now()
  const text = prefs.line ? lineText(s, now) : undefined
  try { await refreshRow($, s, prefs, now) } catch {}
  try { await writeState($, s, now) } catch {}
  if (text === lastLine) return
  lastLine = text
  $.ui.status(text)
}

/** The row the status line prints: the band in ANSI under placement `status`, empty otherwise so the row disappears */
async function refreshRow($: any, s: Snapshot, prefs: PacePrefs, now: number): Promise<void> {
  const text = placement === 'status' && prefs.band ? toAnsi(statusRow(s, now, ROW_COLS)) : ''
  if (text === lastRow) return
  const home = await homeOf($)
  if (!home) return
  await $.fs.write(`${home}/${ROW_FILE}`, text)
  lastRow = text
}

/** What the window draws: the snapshot, its samples cut to the last week, and when it was taken */
async function writeState($: any, s: Snapshot, now: number): Promise<void> {
  if (!feeding) return
  const text = JSON.stringify({ ...s, samples: s.samples.filter(x => x.at >= now - STATE_SPAN), at: now })
  if (text === lastState) return
  const home = await homeOf($)
  if (!home) return
  await $.fs.write(`${home}/${STATE_FILE}`, text)
  lastState = text
}

const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

/** Opens the viewer in a terminal window of its own; false where that cannot be done (not macOS, no node) */
async function openWindow($: any): Promise<boolean> {
  const home = await homeOf($)
  if (!home) return false
  feeding = true
  lastState = undefined
  lastKey = await $.clock.now()
  if (!keysTimer) {
    const t = $.clock.every(2000, () => { void readKeys($).catch(() => {}) })
    keysTimer = t
    timers.push(t)
  }
  await writeState($, await snapshot($), await $.clock.now())
  const which = await $.process.run(['/usr/bin/which', 'node'])
  const node = which.exitCode === 0 ? which.stdout.trim() : ''
  if (!node) return false
  const script = `${home}/${VIEW_FILE}`
  await $.fs.write(script, [
    '#!/bin/sh',
    "printf '\\033]0;Pace\\007'",
    `exec ${shellQuote(node)} ${shellQuote(`${$.plugin.root}/bin/viewer.ts`)} ${shellQuote(`${home}/${STATE_FILE}`)} ${shellQuote(`${home}/${KEYS_FILE}`)}`,
    '',
  ].join('\n'))
  if ((await $.process.run(['chmod', '+x', script])).exitCode !== 0) return false
  return (await $.process.run(['open', '-a', terminalApp, script])).exitCode === 0
}

/** A key pressed in the window: w steps warm mode, r refreshes the figures; each handled once */
async function readKeys($: any): Promise<void> {
  const home = await homeOf($)
  const path = `${home}/${KEYS_FILE}`
  if (!home || !(await $.fs.exists(path))) return
  const k = JSON.parse(await $.fs.read(path)) as { id?: unknown; cmd?: unknown }
  if (typeof k.id !== 'number' || k.id <= lastKey) return
  lastKey = k.id
  if (k.cmd === 'warm') {
    await setPrefs($, p => ({ ...p, warm: WARM_NEXT[p.warm ?? 'off'] }))
    warmActions = 0
  } else if (k.cmd === 'refresh') await refreshAll($)
}

/** Every source read again: the session's limits, Claude Code's usage cache and the usage endpoint */
async function refreshAll($: any): Promise<boolean> {
  try { await recordRateLimits($, (await $.session.usage()).rateLimits) } catch {}
  try { await sampleCache($) } catch {}
  let ok = false
  try { ok = await sampleUsageApi($) } catch {}
  await tick($)
  return ok
}

async function persistSamples($: any): Promise<void> {
  const stored = await $.store.get('samples')
  let merged = Q.mergeSamples(Array.isArray(stored) ? (stored as PaceSample[]) : [], (await read($, samplesA)) ?? [])
  try {
    await $.store.set('samples', merged)
  } catch {
    merged = merged.slice(Math.floor(merged.length / 4))
    await $.store.set('samples', merged)
  }
  await update($, samplesA, () => merged)
}

async function addSample($: any, s: PaceSample): Promise<void> {
  let changed = false
  await update($, samplesA, list => {
    const next = Q.appendSample(list ?? [], s)
    changed = next !== list
    return next
  })
  if (!changed) return
  await persistSamples($)
  await refreshLine($)
}

async function recordRateLimits($: any, list: readonly RateLimitLike[] | undefined): Promise<void> {
  const quotas: Record<string, PaceReading> = {}
  for (const rl of list ?? []) {
    if (rl.kind !== 'five_hour' && rl.kind !== 'seven_day') continue
    const r = rl.resetsAt ? Date.parse(rl.resetsAt) : NaN
    quotas[rl.kind] = { percent: Math.min(Math.max(rl.percentUsed, 0), 100), ...(Number.isFinite(r) ? { resetsAt: r } : {}) }
  }
  if (Object.keys(quotas).length) await addSample($, { at: await $.clock.now(), quotas })
}

/** An account-wide reading: per-model quotas always; 5-hour / 7-day only when the session has none from the last 10 minutes */
async function addFresh($: any, s: PaceSample): Promise<void> {
  const samples = (await read($, samplesA)) ?? []
  const quotas: Record<string, PaceReading> = {}
  for (const [k, r] of Object.entries(s.quotas)) {
    if (Q.isPerModel(k)) quotas[k] = r
    else if (k === 'five_hour' || k === 'seven_day') {
      const last = Q.latest(samples, k)
      if (!last || s.at - last.at > 10 * MIN) quotas[k] = r
    }
  }
  if (Object.keys(quotas).length) await addSample($, { at: s.at, quotas })
}

async function sampleCache($: any): Promise<void> {
  const home = await homeOf($)
  if (!home) return
  const path = `${home}/.claude.json`
  if (!(await $.fs.exists(path))) return
  const s = Q.parseClaudeJson(await $.fs.read(path), await $.clock.now())
  if (s) await addFresh($, s)
}

/** Fresh figures from the endpoint `/usage` reads, sent with Claude Code's own login; the mod never sees the credential */
async function sampleUsageApi($: any): Promise<boolean> {
  const auth = await $.session.authorize()
  if (!auth?.handle || auth.kind !== 'bearer') return false
  const r = await $.http.fetch(USAGE_URL, { auth: auth.handle, headers: { 'anthropic-beta': 'oauth-2025-04-20' } })
  if (!r.ok) return false
  const quotas = Q.parseUsage(JSON.parse(r.text))
  if (!Object.keys(quotas).length) return false
  lastFetch = await $.clock.now()
  await addFresh($, { at: lastFetch, quotas })
  return true
}

/** What this session just spent, added to the shared spend: the store's copy merged in first, so no session's is lost */
async function recordSpend($: any, usd: number): Promise<void> {
  const now = await $.clock.now()
  const stored = await $.store.get('spend')
  const mine = addSpend((await read($, spendA)) ?? [], spendId, now, usd, now)
  const merged = mergeSpend(Array.isArray(stored) ? (stored as PaceSpend[]) : [], mine, now)
  await $.store.set('spend', merged)
  await update($, spendA, () => merged)
}

async function recordPrompt($: any): Promise<void> {
  const now = await $.clock.now()
  await update($, promptsA, list => mergePrompts(list ?? [], [now], now))
  const stored = await $.store.get('prompts')
  const merged = mergePrompts(Array.isArray(stored) ? (stored as number[]) : [], (await read($, promptsA)) ?? [], now)
  await $.store.set('prompts', merged)
  await update($, promptsA, () => merged)
}

/** The last reply's context starts the cache's timer; none (after /clear or a compaction) clears it. `usd` is what the reply cost, which prices it */
async function recordContext($: any, tokens: number | undefined, window: number, usd?: number): Promise<void> {
  const now = await $.clock.now()
  const ttl = ttlOption === 'auto' ? ((await read($, ttlA)) ?? '1h') : ttlOption
  if (usd != null && tokens != null) {
    const equivalents = replyEquivalents((await read($, cacheA)) ?? null, tokens, ttl, now)
    await update($, pricesA, list => addPrice(list ?? [], usd, equivalents))
    await $.store.set('prices', await read($, pricesA))
  }
  await update($, cacheA, () => (tokens == null ? null : { at: now, tokens, window, ttl }))
  await update($, nowA, () => now)
  await refreshLine($)
}

/** Every minute: move the clock the drawings read and take in what other sessions stored */
async function tick($: any): Promise<void> {
  const now = await $.clock.now()
  const stored = await $.store.get('samples')
  if (Array.isArray(stored)) await update($, samplesA, cur => Q.mergeSamples(stored as PaceSample[], cur ?? []))
  const sp = await $.store.get('prompts')
  if (Array.isArray(sp)) await update($, promptsA, cur => mergePrompts(sp as number[], cur ?? [], now))
  const spent = await $.store.get('spend')
  if (Array.isArray(spent)) await update($, spendA, cur => mergeSpend(spent as PaceSpend[], cur ?? [], now))
  await update($, nowA, () => now)
  await refreshLine($)
}

/** Every 15 seconds while the cache is warm: move its timer, and let warm mode act before it lapses */
async function cacheTick($: any): Promise<void> {
  const c = await read($, cacheA)
  const now = await $.clock.now()
  if (!c || (now - c.at) / 1000 > ttlSeconds(c.ttl) + 15) return
  await update($, nowA, () => now)
  const mode = ((await read($, prefsA)) ?? DEFAULT_PREFS).warm ?? 'off'
  const act = warmAction({ mode, cache: c, now, working, actions: warmActions, lastFor: warmFor })
  if (!act) return
  warmActions += 1
  warmFor = c.at
  if (act === 'compact') {
    $.ui.toast('pace: compacting to keep the cache warm')
    await $.command.run({ command: 'compact' })
    return
  }
  // A fork reads the conversation's cached prefix, which restarts its TTL, and leaves the conversation as it was
  const r = await $.model.fork({ prompt: 'Reply with the single word: ok' })
  if (!r.isAnswered) return
  await update($, cacheA, cur => (cur ? { ...cur, at: now } : cur))
  warmFor = now
  $.ui.toast('pace: pinged the cache to keep it warm')
}

async function load($: any): Promise<void> {
  const prefs = await $.store.get('prefs')
  if (prefs && typeof prefs === 'object') await update($, prefsA, cur => ({ ...(cur ?? DEFAULT_PREFS), ...(prefs as PacePrefs) }))
  const ttl = await $.store.get('ttl')
  if (ttl === '5m' || ttl === '1h') await update($, ttlA, () => ttl)
  const prices = await $.store.get('prices')
  if (Array.isArray(prices)) await update($, pricesA, () => prices.filter((p): p is number => typeof p === 'number'))
  await tick($)
}

async function setPrefs($: any, fn: (p: PacePrefs) => PacePrefs): Promise<void> {
  await update($, prefsA, p => fn(p ?? DEFAULT_PREFS))
  await $.store.set('prefs', await read($, prefsA))
  await refreshLine($)
}

// ======================================================================
// Hooks
// ======================================================================

const USAGE = 'window | pane | refresh | hide | show | line on | line off | warm compact | warm ping | warm off'

export const register: Register = (on, options) => {
  placement = options.placement === 'status' ? 'status' : 'above'
  ttlOption = options.cacheTtl === '5m' || options.cacheTtl === '1h' ? options.cacheTtl : 'auto'
  terminalApp = typeof options.terminal === 'string' && options.terminal ? options.terminal : 'Terminal'
  lastRow = undefined

  on('session.start', async ($, e, next) => {
    spendId = await $.session.id().catch(() => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`)
    await $.command.register({ name: 'pace', description: 'Rate-limit pace, prompting rate and the prompt cache, charted', argumentHint: USAGE })
    try { await load($) } catch {}
    try {
      const usage = await $.session.usage()
      lastUsd = usage.cost?.usd ?? null
      await recordRateLimits($, usage.rateLimits)
    } catch {}
    try { await sampleCache($) } catch {}
    try { await sampleUsageApi($) } catch {}
    for (const t of timers) t.cancel()
    keysTimer = undefined
    timers = [
      $.clock.every(MIN, () => { void tick($).catch(() => {}) }),
      $.clock.every(15_000, () => { void cacheTick($).catch(() => {}) }),
      $.clock.every(5 * MIN, () => { void sampleCache($).catch(() => {}) }),
      // Per-model quotas only move through the endpoint: ask again every 15 minutes, and only after a prompt since the last ask
      $.clock.every(15 * MIN, () => {
        void (async () => {
          const prompts = (await read($, promptsA)) ?? []
          const latest = prompts[prompts.length - 1] ?? 0
          if (latest <= lastFetchPrompt) return
          lastFetchPrompt = latest
          await sampleUsageApi($)
        })().catch(() => {})
      }),
    ]
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    try { await recordRateLimits($, e.rateLimits) } catch {}
    // A reply's cost is what the ledger grew by since the last measurement, when the context moved with it
    const usd = e.cost && lastUsd != null && e.changed.includes('cost') ? e.cost.usd - lastUsd : undefined
    if (e.cost) {
      // Every reply counts toward the shared spend, a subagent's too; only the main thread's price the cache
      if (lastUsd != null && e.cost.usd > lastUsd) {
        try { await recordSpend($, e.cost.usd - lastUsd) } catch {}
      }
      lastUsd = e.cost.usd
    }
    if (e.changed.includes('context')) {
      try { await recordContext($, e.context.tokens, e.context.window, usd) } catch {}
    }
    return next(e)
  })

  // The cache TTL is said only when the model changes: keep it for the cache timer
  on('classic.PostModelSwitch', async ($, e, next) => {
    try {
      const ttl = e.cache_ttl === '5m' ? '5m' : '1h'
      await update($, ttlA, () => ttl)
      await $.store.set('ttl', ttl)
    } catch {}
    return next(e)
  })

  on('turn.start', async (_$, e, next) => {
    working = true
    return next(e)
  })

  on('turn.complete', async (_$, e, next) => {
    working = false
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    if (!e.command && !e.isMeta) {
      warmActions = 0
      try {
        await recordPrompt($)
        await refreshLine($)
      } catch {}
    }
    return next(e)
  })

  on('command.run', { command: 'pace' }, async ($, e) => {
    const arg = (e.args ?? '').trim().toLowerCase().replace(/\s+/g, ' ')
    if (arg === 'hide' || arg === 'show') {
      await setPrefs($, p => ({ ...p, band: arg === 'show' }))
      return { text: arg === 'show' ? 'Pace band shown' : 'Pace band hidden; /pace show brings it back' }
    }
    if (arg === 'line on' || arg === 'line off') {
      await setPrefs($, p => ({ ...p, line: arg === 'line on' }))
      return { text: `Pace status line ${arg === 'line on' ? 'on' : 'off'}` }
    }
    if (arg.startsWith('warm ')) {
      const mode = arg.slice(5) as PaceWarmMode
      if (mode !== 'off' && mode !== 'compact' && mode !== 'ping') return { text: 'Use /pace warm compact, ping or off' }
      await setPrefs($, p => ({ ...p, warm: mode }))
      warmActions = 0
      return {
        text: mode === 'off'
          ? 'Warm mode off'
          : `Warm mode ${mode}: with under 10 minutes of cache left and Claude idle, ${mode === 'compact' ? 'runs /compact (once until your next prompt)' : 'pings the cache through a fork (up to 3 times until your next prompt)'}`,
      }
    }
    if (arg === 'refresh') {
      const ok = await refreshAll($)
      return { text: ok ? 'Pace figures refreshed' : 'Could not reach the usage endpoint; showing the latest local figures' }
    }
    if (arg && arg !== 'pane' && arg !== 'window') return { text: `Unknown argument "${arg}": use ${USAGE}` }
    await tick($)
    if (arg !== 'pane') {
      let opened = false
      try { opened = await openWindow($) } catch {}
      if (opened) return { text: 'Pace window opened; q closes it' }
    }
    const lines = paneLines(await snapshot($), await $.clock.now(), paneLayout(Math.max(40, (e.presentation?.columns ?? 80) - 4), DEFAULT_PREFS))
    await $.ui.open({ id: PANE, title: 'Pace', rows: lines.length + 4, focus: true, closeOnEscape: true })
    return { text: arg === 'pane' ? 'Pace pane opened' : 'Could not open a terminal window; Pace pane opened here' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || placement !== 'above') return next(e)
    const prefs = (await read($, prefsA)) ?? DEFAULT_PREFS
    if (!prefs.band) return next(e)
    const now = (await read($, nowA)) || (await $.clock.now())
    const ours = drawBand($, e, await snapshot($), now)
    const below = await next(e)
    const { Box } = $.ui.resolve(e)
    return <Box flexDirection="column">{ours}{below ?? null}</Box>
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const prefs = (await read($, prefsA)) ?? DEFAULT_PREFS
    const now = (await read($, nowA)) || (await $.clock.now())
    return drawPane($, e, await snapshot($), prefs, now)
  })
}
