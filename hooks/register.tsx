// pace: rate-limit pacing for Claude Code in the terminal, inspired by weektoken
// (https://github.com/3dnow/claude-mods/tree/main/weektoken).
//
//   · A band above the prompt: the 5-hour and the weekly bar, each with its status and the rate against what that
//     quota can afford, then the prompt cache's timer with the next prompt's cost. The `placement` option draws it
//     there, or writes one row of it in ANSI to ~/.claude/pace-row.txt for a status-line command to print.
//   · A status-line entry with the same figures in a few words.
//   · /pace draws every quota as a burn-up chart, the rate, the cache and suggestions: inside tmux, the viewer
//     (bin/viewer.ts) in a split beside Claude; elsewhere, a pane here, docked beside a fullscreen transcript.
//     /pace window opens the viewer in a macOS terminal window of its own instead.
//   · Warm mode (/pace warm compact | ping) keeps an idle cache from lapsing.
//   Data: the session's own rate limits, context and cost (after every reply), Claude Code's usage cache in
//   ~/.claude.json, and Anthropic's usage endpoint through Claude Code's own login for per-model quotas.
//   What is drawn is built in view.ts from model.ts; this module keeps the data and the hooks.

import { atom, read, update } from 'claude-code'
import type { ElementConstructor, EngineInterface as Engine, Register, RenderElement, RenderInput, TextProps } from 'claude-code'

import type { Pace, PaceAuto, PaceCacheInfo, PaceCacheTtl, PaceGear, PaceSnapshot, PacePrefs, PaceReading, PaceSample, PaceSpend, PaceUltra, PaceWarmMode } from '../types'
import { alertsOf } from './alerts.ts'
import { KEYS_FILE, planFeedFile, ROW_FILE, STATE_FILE, VIEW_FILE } from './files.ts'
import { isSessionKey, isStale, prefsFrom, sessionKey, sessionOf, sharedOf } from './prefs.ts'
import { answerQuestions, continuePrompt, decide, effortFor, forModel, HANDOFF_FILE, pacingNote, protocol, startPrompt, upkeep, warmModeFor, type Decision } from './auto.ts'
import { addPrice, priceOf, replyEquivalents, ttlSeconds, warmAction } from './cache.ts'
import { snapshotOf, type Snapshot } from './model.ts'
import * as Q from './quota.ts'
import { goalOf, lockBroken, planChanges, revisionsOf, stepsOf } from './plan.ts'
import { coldAt, mainModelFor, notchName, requestModel, spawnAllowed, startingGear, subagentModelFor } from './throttle.ts'
import { closingPrompt, decideUltra, fanoutPrompt, gearNote, planPrompt, ultraProtocol, workPrompt, type UltraDecision, type UltraInput } from './ultra.ts'
import { nowRow, type PlanFeed } from './timeline.ts'
import { mergeModelPrompts, mergePrompts } from './rate.ts'
import { addSpend, mergeSpend, spendModel } from './spend.ts'
import { bandLines, chartHeight, lineText, pairWidth, paneLines, planLines, sideBySide, statusRow, toAnsi, type Feed, type Seg } from './view.ts'

const PANE = 'pace'
/** The plan `/pace auto` works through when it is given none */
const DEFAULT_PLAN = 'ROADMAP.md'
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
const MIN = 60_000
const DEFAULT_PREFS: PacePrefs = { band: true, line: true, warm: 'off' }

const samplesA = atom({ plugin: 'pace', key: 'samples' } as const, [] as PaceSample[])
const promptsA = atom({ plugin: 'pace', key: 'prompts' } as const, [] as number[])
const modelPromptsA = atom({ plugin: 'pace', key: 'modelPrompts' } as const, {} as Record<string, number[]>)
const prefsA = atom({ plugin: 'pace', key: 'prefs' } as const, DEFAULT_PREFS)
const nowA = atom({ plugin: 'pace', key: 'now' } as const, 0)
/** Until when `/pace ultra preview` plays push on the band; 0 when it does not */
const previewA = atom({ plugin: 'pace', key: 'preview' } as const, 0)
const cacheA = atom({ plugin: 'pace', key: 'cache' } as const, null as PaceCacheInfo | null)
const ttlA = atom({ plugin: 'pace', key: 'ttl' } as const, '1h' as PaceCacheTtl)
const pricesA = atom({ plugin: 'pace', key: 'prices' } as const, [] as number[])
const spendA = atom({ plugin: 'pace', key: 'spend' } as const, [] as PaceSpend[])

// ======================================================================
// Drawing
// ======================================================================

const toText = (T: ElementConstructor<TextProps>, segs: readonly Seg[]): RenderElement[] =>
  segs.map(s => (s.dim ? <T dimColor bold={s.bold}>{s.t}</T> : <T color={s.color} bold={s.bold}>{s.t}</T>))

async function snapshot($: Engine): Promise<Snapshot> {
  return {
    samples: (await read($, samplesA)) ?? [],
    prompts: (await read($, promptsA)) ?? [],
    modelPrompts: (await read($, modelPromptsA)) ?? {},
    cache: (await read($, cacheA)) ?? null,
    warm: ((await read($, prefsA)) ?? DEFAULT_PREFS).warm ?? 'off',
    onPace: ((await read($, prefsA)) ?? DEFAULT_PREFS).onPace ?? false,
    auto: ((await read($, prefsA)) ?? DEFAULT_PREFS).auto ?? null,
    price: priceOf((await read($, pricesA)) ?? []),
    spend: (await read($, spendA)) ?? [],
  }
}

/** What `/pace ultra preview` draws the band with where no ultra run is at work: a run in push */
const PREVIEW_RUN: PaceAuto = {
  plan: 'preview', turns: 1, max: 1,
  ultra: {
    goal: 'preview', check: null, phase: 'work', sinceReview: 0, quietReviews: 0, checkFails: 0,
    models: { floor: 'sonnet', ceiling: 'opus' }, headroomStreak: 0,
    gear: { model: 'opus', effort: 'xhigh', subagents: 3, subagentModel: 'sonnet', fanout: true },
  },
}

function drawBand($: Engine, e: RenderInput<'AbovePrompt'>, snap: Snapshot, now: number, preview = false): RenderElement {
  // A preview plays push over the band, unless an ultra run is at work to show for itself
  const working = (a: PaceAuto | null | undefined) => a?.ultra && !a.paused && a.heldUntil == null
  const s = preview && !working(snap.auto) ? { ...snap, auto: PREVIEW_RUN } : snap
  const els = $.ui.resolve(e)
  const { Box, Text } = els
  const Client = 'Client' in els ? els.Client : undefined
  const lines = bandLines(s, now, e.props.bodyColumns ?? 100)
  // Animated where the surface runs surface modules; drawn still elsewhere
  // An ultra run at work powers the animation up by its gear
  const a = s.auto
  const ultra = a?.ultra && working(a) ? (preview ? 'push' : notchName(a.ultra.gear)) : undefined
  if (Client) return <Client key="pace-band" module="./band-client.tsx" props={{ lines, ...(ultra ? { ultra } : {}) }} />
  return (
    <Box key="pace-band" flexDirection="column">
      {lines.map((segs, i) => <Text key={`pace-line-${i}`} wrap="truncate-end">{toText(Text, segs)}</Text>)}
    </Box>
  )
}

const paneLayout = (cols: number, prefs: PacePrefs) => ({ cols, chartWidth: Math.max(16, Math.min(72, cols - 6)), chartHeight, prefs })

/** Docked, the charts grow to share the rows the rest leaves, each between their usual height and 16 rows */
function dockedLayout(s: Snapshot, now: number, cols: number, rows: number, prefs: PacePrefs) {
  const at = (h: number) => paneLines(s, now, { ...paneLayout(cols, prefs), chartHeight: () => h }).length
  const fixed = at(0)
  const charts = at(1) - fixed
  if (charts <= 0) return paneLayout(cols, prefs)
  const h = Math.min(16, Math.floor((rows - fixed) / charts))
  return { ...paneLayout(cols, prefs), chartHeight: (row: Parameters<typeof chartHeight>[0]) => Math.max(chartHeight(row), h) }
}

function drawPane($: Engine, e: RenderInput<'Pane'>, s: Snapshot, prefs: PacePrefs, now: number): RenderElement {
  const { Box, Text } = $.ui.resolve(e)
  const cols = e.props.bodyColumns ?? 60
  const rows = e.props.scroll?.bodyRows
  const layout = e.props.placement === 'dock' && rows ? dockedLayout(s, now, cols, rows, prefs) : paneLayout(cols, prefs)
  const lines = paneLines(s, now, layout)
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

const WARM_NEXT: Record<PaceWarmMode, PaceWarmMode> = { off: 'ping', ping: 'compact', compact: 'off' }
/** Columns the status-line row is laid out for: the command is not told the terminal's width */
const ROW_COLS = 120
/** Samples the window gets: its charts show current windows, a week at most */
const STATE_SPAN = 8 * 24 * 60 * MIN

let placement: 'above' | 'status' = 'above'
let ttlOption: 'auto' | PaceCacheTtl = 'auto'
let terminalApp = 'Terminal'
/** The status-line entry last said; null until this load says one, since the engine keeps an entry across a hot reload */
let lastLine: string | undefined | null = null
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
/** The models that answered requests since the last cost reading, the subagents' included: whose the next dollars are */
let answered: string[] = []
/** This session's own name in the shared spend: a reload counts on from the ledger under it, never twice */
let spendId = ''

const homeOf = async ($: Engine): Promise<string | undefined> => $.env.get('HOME')

/** What `$.pace.snapshot()` answers: kept here, since the noun has no `$` of its own to read the state through */
let published: PaceSnapshot | undefined
const EMPTY: Snapshot = { samples: [], prompts: [], cache: null }

/** The status-line entry, the status-line row, the window's state and `$.pace`'s snapshot, each written only when it changed */
async function refreshLine($: Engine): Promise<void> {
  const prefs = (await read($, prefsA)) ?? DEFAULT_PREFS
  const s = await snapshot($)
  const now = await $.clock.now()
  published = snapshotOf(s, now)
  try { await announce($, published) } catch {}
  const text = prefs.line ? lineText(s, now) : undefined
  try { await refreshRow($, s, prefs, now) } catch {}
  try { await writeState($, s, now) } catch {}
  if (text === lastLine) return
  lastLine = text
  $.ui.status(text)
}

/** The row the status line prints: the band in ANSI under placement `status`, empty otherwise so the row disappears */
async function refreshRow($: Engine, s: Snapshot, prefs: PacePrefs, now: number): Promise<void> {
  const text = placement === 'status' && prefs.band ? toAnsi(statusRow(s, now, ROW_COLS)) : ''
  if (text === lastRow) return
  const home = await homeOf($)
  if (!home) return
  await $.fs.write(`${home}/${ROW_FILE}`, text)
  lastRow = text
}

/** What the window draws: the snapshot, its samples cut to the last week, when it was taken, and the plan's steps */
async function writeState($: Engine, s: Snapshot, now: number): Promise<void> {
  if (!feeding) return
  const { plan, auto } = await shownPlan($)
  const steps = stepsOf(await fileText($, plan).catch(() => ''), auto != null && !auto.paused)
  const feed: Feed = { ...s, samples: s.samples.filter(x => x.at >= now - STATE_SPAN), at: now, ...(steps.length ? { plan: { name: plan, steps } } : {}) }
  const text = JSON.stringify(feed)
  if (text === lastState) return
  const home = await homeOf($)
  if (!home) return
  await $.fs.write(`${home}/${STATE_FILE}`, text)
  lastState = text
}

const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

/** Node on the PATH, which runs the viewers; empty when there is none */
async function nodeOf($: Engine): Promise<string> {
  const which = await $.process.run(['/usr/bin/which', 'node'])
  return which.exitCode === 0 ? which.stdout.trim() : ''
}

/** Starts feeding the viewer and writes the script that runs it; undefined where that cannot be done (no node) */
async function viewerScript($: Engine): Promise<string | undefined> {
  const home = await homeOf($)
  if (!home) return undefined
  feeding = true
  lastState = undefined
  lastKey = await $.clock.now()
  if (!keysTimer) {
    const t = $.clock.every(2000, () => { void readKeys($).catch(() => {}) })
    keysTimer = t
    timers.push(t)
  }
  await writeState($, await snapshot($), await $.clock.now())
  const node = await nodeOf($)
  if (!node) return undefined
  const script = `${home}/${VIEW_FILE}`
  await $.fs.write(script, [
    '#!/bin/sh',
    "printf '\\033]0;Pace\\007'",
    `exec ${shellQuote(node)} ${shellQuote(`${$.plugin.root}/bin/viewer.ts`)} ${shellQuote(`${home}/${STATE_FILE}`)} ${shellQuote(`${home}/${KEYS_FILE}`)}`,
    '',
  ].join('\n'))
  if ((await $.process.run(['chmod', '+x', script])).exitCode !== 0) return undefined
  return script
}

/** Opens the viewer in a terminal window of its own; false where that cannot be done (not macOS, no node) */
async function openWindow($: Engine): Promise<boolean> {
  const script = await viewerScript($)
  return !!script && (await $.process.run(['open', '-a', terminalApp, script])).exitCode === 0
}

/** The tmux pane the viewer runs in, while it lives */
let splitPane: string | undefined

/** Whether Claude runs inside tmux, which can split its window */
const inTmux = async ($: Engine) => !!(await $.env.get('TMUX'))

/** Opens the viewer in a tmux split beside Claude, or finds the one open; false outside tmux or where that fails */
async function openSplit($: Engine): Promise<'opened' | 'open' | false> {
  if (!(await inTmux($))) return false
  if (splitPane && (await $.process.run(['tmux', 'display-message', '-p', '-t', splitPane, '#{pane_id}'])).exitCode === 0) return 'open'
  const script = await viewerScript($)
  if (!script) return false
  const beside = await $.env.get('TMUX_PANE')
  const r = await $.process.run(['tmux', 'split-window', '-h', '-d', '-l', '45%', ...(beside ? ['-t', beside] : []), '-P', '-F', '#{pane_id}', script])
  if (r.exitCode !== 0) return false
  splitPane = r.stdout.trim() || undefined
  return 'opened'
}

/** A key pressed in the window: w steps warm mode, r refreshes the figures; each handled once */
async function readKeys($: Engine): Promise<void> {
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
async function refreshAll($: Engine): Promise<boolean> {
  try { await recordRateLimits($, (await $.session.usage()).rateLimits) } catch {}
  try { await sampleCache($) } catch {}
  let ok = false
  try { ok = await sampleUsageApi($) } catch {}
  await tick($)
  return ok
}

async function persistSamples($: Engine): Promise<void> {
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

async function addSample($: Engine, s: PaceSample): Promise<void> {
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

async function recordRateLimits($: Engine, list: readonly RateLimitLike[] | undefined): Promise<void> {
  const quotas: Record<string, PaceReading> = {}
  for (const rl of list ?? []) {
    if ((rl.kind !== 'five_hour' && rl.kind !== 'seven_day') || !Number.isFinite(rl.percentUsed)) continue
    const r = rl.resetsAt ? Date.parse(rl.resetsAt) : NaN
    quotas[rl.kind] = { percent: Math.min(Math.max(rl.percentUsed, 0), 100), ...(Number.isFinite(r) ? { resetsAt: r } : {}) }
  }
  if (Object.keys(quotas).length) await addSample($, { at: await $.clock.now(), quotas })
}

/** An account-wide reading: per-model quotas always; 5-hour / 7-day only when the session has none from the last 10 minutes */
async function addFresh($: Engine, s: PaceSample): Promise<void> {
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

async function sampleCache($: Engine): Promise<void> {
  const home = await homeOf($)
  if (!home) return
  const path = `${home}/.claude.json`
  if (!(await $.fs.exists(path))) return
  const s = Q.parseClaudeJson(await $.fs.read(path), await $.clock.now())
  if (s) await addFresh($, s)
}

/** Fresh figures from the endpoint `/usage` reads, sent with Claude Code's own login; the mod never sees the credential */
async function sampleUsageApi($: Engine): Promise<boolean> {
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
async function recordSpend($: Engine, usd: number): Promise<void> {
  const now = await $.clock.now()
  const stored = await $.store.get('spend')
  const mine = addSpend((await read($, spendA)) ?? [], spendId, now, usd, now, spendModel(answered, await modelOf($)))
  answered = []
  const merged = mergeSpend(Array.isArray(stored) ? (stored as PaceSpend[]) : [], mine, now)
  await $.store.set('spend', merged)
  await update($, spendA, () => merged)
}

async function recordPrompt($: Engine): Promise<void> {
  const now = await $.clock.now()
  await update($, promptsA, list => mergePrompts(list ?? [], [now], now))
  const stored = await $.store.get('prompts')
  const merged = mergePrompts(Array.isArray(stored) ? (stored as number[]) : [], (await read($, promptsA)) ?? [], now)
  await $.store.set('prompts', merged)
  await update($, promptsA, () => merged)
  // The model it went to, so a model's own week counts only its prompts
  const model = await modelOf($)
  if (!model) return
  await update($, modelPromptsA, byModel => mergeModelPrompts(byModel ?? {}, { [model]: [now] }, now))
  const storedByModel = await $.store.get('modelPrompts')
  const mergedByModel = mergeModelPrompts(isRecord(storedByModel) ? storedByModel : {}, (await read($, modelPromptsA)) ?? {}, now)
  await $.store.set('modelPrompts', mergedByModel)
  await update($, modelPromptsA, () => mergedByModel)
}

const isRecord = (v: unknown): v is Record<string, number[]> => typeof v === 'object' && v != null && !Array.isArray(v)

/** The last reply's context starts the cache's timer; none (after /clear or a compaction) clears it. `usd` is what the reply cost, which prices it */
async function recordContext($: Engine, tokens: number | undefined, window: number, usd?: number): Promise<void> {
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
async function tick($: Engine): Promise<void> {
  const now = await $.clock.now()
  const stored = await $.store.get('samples')
  if (Array.isArray(stored)) await update($, samplesA, cur => Q.mergeSamples(stored as PaceSample[], cur ?? []))
  const sp = await $.store.get('prompts')
  if (Array.isArray(sp)) await update($, promptsA, cur => mergePrompts(sp as number[], cur ?? [], now))
  const byModel = await $.store.get('modelPrompts')
  if (isRecord(byModel)) await update($, modelPromptsA, cur => mergeModelPrompts(byModel, cur ?? {}, now))
  const spent = await $.store.get('spend')
  if (Array.isArray(spent)) await update($, spendA, cur => mergeSpend(spent as PaceSpend[], cur ?? [], now))
  await update($, nowA, () => now)
  await refreshLine($)
}

/** Every 15 seconds while the cache is warm: move its timer, and let warm mode act before it lapses */
async function cacheTick($: Engine): Promise<void> {
  const c = await read($, cacheA)
  const now = await $.clock.now()
  if (!c || (now - c.at) / 1000 > ttlSeconds(c.ttl) + 15) return
  await update($, nowA, () => now)
  const prefs = (await read($, prefsA)) ?? DEFAULT_PREFS
  const mode = warmModeFor({ onPace: prefs.onPace ?? false, warm: prefs.warm ?? 'off' }, snapshotOf(await snapshot($), now))
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

async function load($: Engine): Promise<void> {
  // The shared prefs, and this session's own modes: never another session's
  const prefs = prefsFrom(await $.store.get('prefs'), await $.store.get(sessionKey(spendId)))
  await update($, prefsA, () => prefs)
  try { await forgetOldSessions($) } catch {}
  const ttl = await $.store.get('ttl')
  if (ttl === '5m' || ttl === '1h') await update($, ttlA, () => ttl)
  const prices = await $.store.get('prices')
  if (Array.isArray(prices)) await update($, pricesA, () => prices.filter((p): p is number => typeof p === 'number'))
  await tick($)
  const auto = (await read($, prefsA))?.auto
  const until = auto?.heldUntil ?? auto?.waitingUntil
  if (until != null) await holdUntil($, until)
}

/** Other sessions' modes a month after they last changed them: a session ends without saying so */
async function forgetOldSessions($: Engine): Promise<void> {
  const now = await $.clock.now()
  for (const key of await $.store.keys()) {
    if (isSessionKey(key) && key !== sessionKey(spendId) && isStale(await $.store.get(key), now)) await $.store.delete(key)
  }
}

async function setPrefs($: Engine, fn: (p: PacePrefs) => PacePrefs): Promise<void> {
  await update($, prefsA, p => fn(p ?? DEFAULT_PREFS))
  const prefs = (await read($, prefsA)) ?? DEFAULT_PREFS
  await $.store.set('prefs', sharedOf(prefs))
  await $.store.set(sessionKey(spendId), sessionOf(prefs, await $.clock.now()))
  await refreshLine($)
}

// ======================================================================
// Warnings, on pace mode and auto mode
// ======================================================================

/** Says each warning once per window across every session: a toast, and a notification for a terminal in the background */
async function announce($: Engine, snap: PaceSnapshot): Promise<void> {
  const alerts = alertsOf(snap)
  if (!alerts.length) return
  const said = await $.store.get('alerted')
  const seen = new Set<string>(Array.isArray(said) ? (said as string[]) : [])
  const fresh = alerts.filter(a => !seen.has(a.id))
  if (!fresh.length) return
  for (const a of fresh) seen.add(a.id)
  await $.store.set('alerted', [...seen].slice(-200))
  for (const a of fresh) await tell($, a.text)
}

/** Something the person should hear though they may be away: a toast, and a notification */
async function tell($: Engine, text: string): Promise<void> {
  $.ui.toast(`pace: ${text}`)
  try { await $.ui.notify(text, { title: 'pace' }) } catch {}
}

const AUTO_PANE = 'pace-auto'
const PLAN_PANE = 'pace-plan'
/** Columns the plan sidebar takes in tmux */
const SIDEBAR_COLUMNS = 46
/** Turns auto mode takes before it stops to let the person look */
const AUTO_TURNS = 40
/** Turns ultra pace takes before it stops: more than auto mode, since it plans and reviews as well as works */
const ULTRA_TURNS = 80
/** The model ultra pace drops to at its lightest, unless told otherwise */
const ULTRA_FLOOR = 'sonnet'
/** A plan waiting on the onboarding pane's Start, and ultra pace's run on it */
let pendingPlan: { plan: string; max: number; ultra?: PaceUltra } | null = null
/** The effort the main loop last asked for: the user's, which ultra pace's cruise gear keeps */
let lastEffort: PaceGear['effort'] = 'high'
/** The plan as the last turn left it, for ultra pace's ticks and lock; null before one was read */
let planMark: string | null = null
/** Subagents out on ultra pace's fan-out that have reported, by id */
let reported = new Set<string>()
/** Subagents at work that the Agent tool started, by id: ultra pace's gear caps how many */
const active = new Set<string>()
/** The model ultra pace switched the main thread to, on a cold cache; null for the session's own */
let mainModel: string | null = null
/** How long `/pace ultra preview` plays push on the band */
const PREVIEW_MS = 20_000
/** How long the goal's check may run */
const CHECK_TIMEOUT = 10 * 60_000
/** Lines of the check's output a failed check's review carries */
const CHECK_TAIL = 40
/** How long pace waits on a fan-out before checking in, in case a subagent hung */
const FANOUT_CHECK = 15 * 60_000
/** The pending end of a hold or a wait: one at a time */
let holdTimer: { cancel: () => void } | undefined
/** The session's working directory, where a plan's relative path starts */
let cwd = ''
/** The plan and the handoff file as the last turn left them; null before one was read */
let progressMark: string | null = null
/** The plan the timeline shows; null for auto mode's, else ROADMAP.md */
let planShown: string | null = null

async function autoOf($: Engine): Promise<PaceAuto | null> {
  return ((await read($, prefsA)) ?? DEFAULT_PREFS).auto ?? null
}

async function setAuto($: Engine, auto: PaceAuto | null): Promise<void> {
  await setPrefs($, p => ({ ...p, auto }))
  if (planSplit) await writePlanFeed($).catch(() => {})
}

/** Auto mode's run, without a hold, a wait or a pause */
const running = (a: PaceAuto): PaceAuto => ({ plan: a.plan, turns: a.turns, max: a.max, ...(a.stalls ? { stalls: a.stalls } : {}), ...(a.burst ? { burst: true } : {}), ...(a.ultra ? { ultra: a.ultra } : {}) })

/** A file's text, its path relative to the session's working directory; empty when it is not there */
async function fileText($: Engine, path: string): Promise<string> {
  const at = path.startsWith('/') ? path : `${cwd}/${path}`
  return (await $.fs.exists(at)) ? String(await $.fs.read(at)) : ''
}

/** The plan and the handoff file's text: a turn that changed neither made no progress */
async function progressText($: Engine, plan: string): Promise<string> {
  return `${await fileText($, plan)}\u0000${await fileText($, HANDOFF_FILE)}`
}

/** Whether the turn just ended moved the plan or the handoff file; undefined when there is nothing to compare with */
async function progressed($: Engine, plan: string): Promise<boolean | undefined> {
  const now = await progressText($, plan).catch(() => null)
  const before = progressMark
  progressMark = now
  return before == null || now == null ? undefined : now !== before
}

/** A prompt for a turn of its own, sent once the hook that asked has returned: a command's hook holds the turn it would wait on */
async function submitSoon($: Engine, text: string): Promise<void> {
  timers.push($.clock.after(0, () => { void $.prompt.submit({ text }).catch(() => {}) }))
}

async function startAuto($: Engine, plan: string, max: number, ultra?: PaceUltra): Promise<void> {
  await setPrefs($, p => ({ ...p, onPace: true, auto: { plan, turns: 1, max, ...(ultra ? { ultra } : {}) } }))
  progressMark = await progressText($, plan).catch(() => null)
  planMark = await fileText($, plan).catch(() => null)
  mainModel = null
  await tell($, ultra
    ? `Ultra pace on: works toward the goal in ${plan} on its own and spends quota while you are away. /pace ultra off stops it.`
    : `Auto mode on: works through ${plan} on its own and spends quota while you are away. /pace auto off stops it.`)
  planShown = null
  try { await openPlan($) } catch {}
  // Last, with nothing awaited after it: a prompt sent while the command's hook still runs is refused and lost
  await submitSoon($, ultra ? planPrompt(plan) : startPrompt(plan))
}

type ShownPlan = { plan: string; path: string; auto: PaceAuto | null }

/**
 * The plans the timeline shows, each with its full path and auto mode's run when it is on that plan: the one or two
 * `/pace plan` named, else the roadmap beside an ultra run's own plan, else auto mode's plan or the roadmap
 */
async function shownPlans($: Engine): Promise<ShownPlan[]> {
  const run = await autoOf($)
  const names = planShown ? planShown.split(/\s+/).slice(0, 2)
    : run?.ultra && run.plan !== DEFAULT_PLAN ? [DEFAULT_PLAN, run.plan]
    : [run?.plan ?? DEFAULT_PLAN]
  return names.map(plan => ({ plan, path: plan.startsWith('/') ? plan : `${cwd}/${plan}`, auto: run?.plan === plan ? run : null }))
}

/** The first plan the timeline shows */
const shownPlan = async ($: Engine): Promise<ShownPlan> => (await shownPlans($))[0]!

/** The tmux pane the plan sidebar runs in, while it lives */
let planSplit: string | undefined

/** Writes what the plan sidebar draws from */
async function writePlanFeed($: Engine): Promise<void> {
  const home = await homeOf($)
  if (!home) return
  const [first, also] = await shownPlans($)
  const feed: PlanFeed = { ...first!, at: await $.clock.now(), ...(also ? { also } : {}) }
  await $.fs.write(`${home}/${planFeedFile(spendId)}`, JSON.stringify(feed))
}

/** Opens the plan sidebar in a narrow tmux split on the right, or finds the one open; false outside tmux or where that fails */
async function openPlanSplit($: Engine): Promise<boolean> {
  if (!(await inTmux($))) return false
  const home = await homeOf($)
  if (!home) return false
  await writePlanFeed($)
  if (planSplit && (await $.process.run(['tmux', 'display-message', '-p', '-t', planSplit, '#{pane_id}'])).exitCode === 0) return true
  const node = await nodeOf($)
  if (!node) return false
  const beside = await $.env.get('TMUX_PANE')
  const run = `exec ${shellQuote(node)} ${shellQuote(`${$.plugin.root}/bin/plan-viewer.ts`)} ${shellQuote(`${home}/${planFeedFile(spendId)}`)}`
  // Two plans side by side take twice the width
  const width = (await shownPlans($)).length > 1 ? SIDEBAR_COLUMNS * 2 + 3 : SIDEBAR_COLUMNS
  const r = await $.process.run(['tmux', 'split-window', '-h', '-d', '-l', String(width), ...(beside ? ['-t', beside] : []), '-P', '-F', '#{pane_id}', run])
  if (r.exitCode !== 0) return false
  planSplit = r.stdout.trim() || undefined
  return true
}

/** Opens the plan's timeline as a sidebar: a tmux split inside tmux, else a pane, docked beside a fullscreen transcript */
async function openPlan($: Engine): Promise<'split' | 'pane'> {
  if (await openPlanSplit($).catch(() => false)) return 'split'
  await $.ui.open({ id: PLAN_PANE, title: 'Pace · plan', rows: 24, columns: 72, closeOnEscape: true })
  // Open on the step under way, not the top of a long plan
  try {
    const { plan, auto } = await shownPlan($)
    const steps = stepsOf(await fileText($, plan).catch(() => ''), auto != null && !auto.paused)
    const row = nowRow(planLines(steps, { plan, auto, cols: 70, now: await $.clock.now(), rows: Infinity }))
    await $.ui.scroll({ in: PLAN_PANE, to: { key: `pace-plan-${row}` }, block: 'center' })
  } catch {}
  return 'pane'
}

/** The plan's timeline: its checklist from the file as it stands, animated where the surface runs surface modules */
async function drawPlan($: Engine, e: RenderInput<'Pane'>): Promise<RenderElement> {
  const els = $.ui.resolve(e)
  const { Box, Text } = els
  const Client = 'Client' in els ? els.Client : undefined
  const plans = await shownPlans($)
  const now = (await read($, nowA)) || (await $.clock.now())
  const cols = e.props.bodyColumns ?? 60
  const width = plans.length > 1 ? pairWidth(cols) : cols
  let done = 0
  // Every step: the engine scrolls a pane taller than its room, which beats folding steps away
  const drawn = await Promise.all(plans.map(async ({ plan, auto }) => {
    const steps = stepsOf(await fileText($, plan).catch(() => ''), auto != null && !auto.paused)
    done += steps.filter(s => s.state === 'done').length
    return planLines(steps, { plan, auto, cols: width, now, rows: Infinity })
  }))
  const lines = drawn.length > 1 ? sideBySide(drawn[0]!, drawn[1]!, width) : drawn[0]!
  if (Client) return <Client key="pace-plan" module="./plan-client.tsx" props={{ lines, done }} />
  return (
    <Box flexDirection="column">
      {lines.map((segs, i) => <Text key={`pace-plan-${i}`} wrap="truncate-end">{segs.length ? toText(Text, segs) : ' '}</Text>)}
    </Box>
  )
}

/** The session's model, which auto mode paces by: only the quotas it draws on hold or steer it */
const modelOf = async ($: Engine): Promise<string | undefined> => $.session.model().catch(() => undefined)

/** Carries out what auto mode decided after a turn or a hold */
async function act($: Engine, d: Decision): Promise<void> {
  const auto = await autoOf($)
  if (!auto) return
  // A turn ending decides afresh: whatever wait it ends is over
  if (d.kind !== 'hold') holdTimer?.cancel()
  if (d.kind === 'wait') {
    await setAuto($, { ...running(auto), waitingUntil: d.until, why: d.why, stalls: d.stalls })
    await holdUntil($, d.until)
    $.ui.toast(`pace: auto mode sends nothing until ${Q.clockAt(d.until, false)} or a turn of its own. ${d.why}`)
  } else if (d.kind === 'continue' || d.kind === 'handoff') {
    if (d.kind === 'handoff') {
      $.ui.toast('pace: handing off to a fresh context')
      await $.command.run({ command: 'clear' })
    }
    await setAuto($, { ...running(auto), turns: auto.turns + 1, stalls: d.stalls })
    await $.prompt.submit({ text: d.prompt })
  } else if (d.kind === 'hold') {
    await setAuto($, { ...running(auto), heldUntil: d.until, why: d.why })
    await holdUntil($, d.until)
    await tell($, `Auto mode holding until ${Q.clockAt(d.until, d.until - (await $.clock.now()) >= 86400_000)}. ${d.why}`)
  } else if (d.kind === 'pause') {
    await setAuto($, { ...running(auto), paused: true, why: d.why })
    await tell($, `Auto mode paused. ${d.why}`)
  } else {
    holdTimer?.cancel()
    await setAuto($, null)
    await tell($, `Auto mode off. ${d.why}`)
  }
}

async function holdUntil($: Engine, until: number): Promise<void> {
  holdTimer?.cancel()
  const t = $.clock.after(Math.max(0, until - (await $.clock.now())), () => { void endHold($).catch(() => {}) })
  holdTimer = t
  timers.push(t)
}

/** A hold or a wait is over: fresh figures, then decide again, with no turn to judge */
async function endHold($: Engine): Promise<void> {
  const auto = await autoOf($)
  if (!auto || (auto.heldUntil == null && auto.waitingUntil == null) || auto.paused) return
  await setAuto($, running(auto))
  // A turn under way ends by deciding: prompting now would land on top of it
  if (working) return
  await refreshAll($)
  if (auto.ultra) return decideAndAct($, running(auto), '', false, false)
  await act($, decide({ auto: running(auto), snap: published!, answer: '', aborted: false, model: await modelOf($) }))
}

/** After a turn of the main loop: auto mode's next move, else on pace mode's upkeep */
async function afterTurn($: Engine, answer: string, aborted: boolean): Promise<void> {
  const prefs = (await read($, prefsA)) ?? DEFAULT_PREFS
  await refreshLine($)
  const auto = prefs.auto
  if (auto && !auto.paused) {
    if (auto.heldUntil != null) return
    if (auto.ultra) return decideAndAct($, auto, answer, aborted, true)
    await act($, decide({ auto, snap: published!, answer, aborted, model: await modelOf($), progressed: await progressed($, auto.plan) }))
    return
  }
  if (prefs.onPace && upkeep(published!) === 'compact') {
    $.ui.toast('pace: compacting a heavy context while its cache is warm')
    await $.command.run({ command: 'compact' })
  }
}

const doneCount = (markdown: string) => stepsOf(markdown, false).filter(s => s.state === 'done').length

/** Whether every subagent out on the fan-out has reported: its turn's end heard, or the engine lists it as ended */
async function agentsDone($: Engine, ultra: PaceUltra): Promise<boolean> {
  const ids = ultra.fanout?.agentIds ?? []
  const ended = new Set((await $.agent.list().catch(() => [])).filter(a => a.status === 'completed' || a.status === 'failed' || a.status === 'killed').map(a => a.id))
  return ids.every(id => reported.has(id) || ended.has(id))
}

/**
 * Ultra pace's next move, then carried out. `turnRan`: a turn just ended, whose plan changes count; false when a
 * hold, a wait or a fan-out ends with no turn behind it.
 */
async function decideAndAct($: Engine, auto: PaceAuto, answer: string, aborted: boolean, turnRan: boolean): Promise<void> {
  const after = await fileText($, auto.plan).catch(() => '')
  const before = planMark ?? after
  if (turnRan) planMark = after
  const input: UltraInput = {
    auto, snap: published!, answer, aborted, model: await modelOf($), effort: lastEffort,
    progressed: turnRan ? await progressed($, auto.plan) : undefined,
    ticked: turnRan && doneCount(after) > doneCount(before),
    lock: turnRan ? lockBroken(planChanges(before, after), revisionsOf(after) > revisionsOf(before)) : [],
    steps: stepsOf(after, false),
    agentsDone: await agentsDone($, auto.ultra!),
  }
  await actUltra($, decideUltra(input), input)
}

/** Runs the goal's check as captured at the start, outside the permission prompts: an edited Check: line changes nothing */
async function runCheck($: Engine, command: string, plan: string): Promise<{ ok: boolean; tail: string }> {
  if (goalOf(await fileText($, plan).catch(() => ''))?.check !== command) {
    $.ui.toast(`pace: the plan's Check: line changed; ultra pace runs the one captured at the start: ${command}`)
  }
  try {
    const r = await $.process.run(['sh', '-c', command], { timeoutMs: CHECK_TIMEOUT })
    return { ok: r.exitCode === 0, tail: `${r.stdout}${r.stderr}`.trimEnd().split('\n').slice(-CHECK_TAIL).join('\n') }
  } catch (e) {
    return { ok: false, tail: `The check did not finish within ${CHECK_TIMEOUT / 60_000} minutes, or could not start: ${String(e)}` }
  }
}

/** Carries out what ultra pace decided: the check and the fan-out here, everything else as auto mode does */
async function actUltra($: Engine, d: UltraDecision, input: UltraInput): Promise<void> {
  const auto = await autoOf($)
  if (!auto) return
  const next: PaceAuto = { ...running(auto), ultra: d.ultra }
  if (d.kind === 'check') {
    await setAuto($, next)
    $.ui.toast(`pace: running the goal's check: ${d.command}`)
    const check = await runCheck($, d.command, auto.plan)
    return actUltra($, decideUltra({ ...input, auto: next, check }), input)
  }
  if (d.kind === 'fanout') {
    holdTimer?.cancel()
    reported = new Set()
    // A started subagent comes back with its id, but for a remote one, which only the check-in covers
    const agentIds: string[] = []
    const out: string[] = []
    for (const [i, step] of d.steps.entries()) {
      const r = await $.agent.spawn({ prompt: fanoutPrompt(d.ultra.goal, step, i + 1), description: `pace: ${step}`.slice(0, 60), model: d.ultra.gear.subagentModel }).catch(() => null)
      if (!r || r.deny) continue
      out.push(step)
      if (r.agentId) agentIds.push(r.agentId)
    }
    if (!out.length) {
      // None started: the main thread takes the next step itself
      const { fanout: _, ...rest } = d.ultra
      await setAuto($, { ...next, turns: auto.turns + 1, ultra: { ...rest, phase: 'work' } })
      await $.prompt.submit({ text: `${workPrompt(auto.plan)}${gearNote(d.ultra.gear)}` })
      return
    }
    const until = (await $.clock.now()) + FANOUT_CHECK
    await setAuto($, { ...next, waitingUntil: until, why: `Waiting on ${out.length} subagents`, ultra: { ...d.ultra, fanout: { agentIds, steps: out } } })
    await holdUntil($, until)
    $.ui.toast(`pace: ${out.length} subagents out on parallel steps; the main thread waits for their reports`)
    return
  }
  await setAuto($, next)
  await act($, d)
  if (d.kind === 'stop' && d.why.startsWith('Goal reached')) await $.prompt.submit({ text: closingPrompt(auto.plan, d.ultra.goal) })
}

/** A subagent out on the fan-out reported: once the last has, ultra pace decides again */
async function fanoutReported($: Engine, agentId: string): Promise<void> {
  const auto = await autoOf($)
  if (!auto?.ultra?.fanout?.agentIds.includes(agentId)) return
  reported.add(agentId)
  if (working || auto.paused || !(await agentsDone($, auto.ultra))) return
  holdTimer?.cancel()
  await refreshAll($)
  await decideAndAct($, running(auto), '', false, false)
}

/** The onboarding pane: what auto mode does and what it costs, before it starts the first time */
function drawOnboarding($: Engine, e: RenderInput<'Pane'>): RenderElement {
  const { Box, Text, Button } = $.ui.resolve(e)
  const plan = pendingPlan?.plan ?? 'the plan'
  const u = pendingPlan?.ultra
  const lines = u ? [
    `Ultra pace works toward the goal in ${plan} with no one at the keyboard: ${u.goal}`,
    '• Claude writes the steps, works them red first, reviews the plan every few steps and revises it, logging each change',
    u.check ? `• it stops once the goal's check passes: ${u.check}, run by pace as it is now` : '• with no Check: line, Claude verifies each Done when line against the code before it stops',
    `• it spends faster while a quota is under pace: a stronger model (up to ${u.models.ceiling}), more thinking, subagents in parallel; lighter (down to ${u.models.floor}) while one is over`,
    `• it holds while a quota is gassed out or the rate would gas one out, and stops after ${pendingPlan?.max ?? ULTRA_TURNS} turns, 3 failed checks or 3 reviews in a row with nothing done`,
  ] : [
    `Auto mode works through ${plan} with no one at the keyboard:`,
    `• after each turn pace sends the next prompt, until Claude says PACE: DONE or BLOCKED, ends a turn waiting on you, or after ${pendingPlan?.max ?? AUTO_TURNS} turns`,
    "• it answers Claude's questions with the recommended option",
    '• it has Claude hand searches and routine edits to subagents on lighter models, and hands a heavy context off to a fresh one through .pace/handoff.md',
    '• it holds while the rate would get a quota gassed out, and while one is gassed out, until it resets',
    '• it turns on pace mode: a heavy context is compacted while its cache is warm, an idle cache kept warm, and the effort lowered a level while the rate would run a quota out',
  ]
  return (
    <Box flexDirection="column">
      {lines.map((l, i) => <Text key={`pace-auto-${i}`}>{l}</Text>)}
      <Text key="pace-auto-cost" color="warning" bold>{`It spends quota on its own while you are away. Watch the band; /pace ${u ? 'ultra' : 'auto'} off stops it.`}</Text>
      <Box key="pace-auto-buttons">
        <Button key="pace-auto-start" label="Start" hotkey="s" variant="primary" onPress={async () => {
          const p = pendingPlan
          pendingPlan = null
          await setPrefs($, x => ({ ...x, onboarded: true }))
          await $.ui.close({ id: AUTO_PANE })
          if (p) await startAuto($, p.plan, p.max, p.ultra)
        }} />
        <Button key="pace-auto-cancel" label="Cancel" hotkey="c" onPress={async () => {
          pendingPlan = null
          await $.ui.close({ id: AUTO_PANE })
        }} />
      </Box>
    </Box>
  )
}

/** `/pace on | off | auto …`: on pace mode and auto mode; null for any other argument */
async function modeCommand($: Engine, raw: string): Promise<string | null> {
  const arg = raw.toLowerCase()
  if (arg === 'on' || arg === 'off') {
    await setPrefs($, p => ({ ...p, onPace: arg === 'on' }))
    return arg === 'on'
      ? 'On pace mode on: compacts a heavy context while its cache is warm, keeps an idle cache warm, and warns before a quota gasses out'
      : 'On pace mode off'
  }
  if (arg === 'ultra' || arg.startsWith('ultra ')) return ultraCommand($, raw.slice(5).trim())
  if (arg !== 'auto' && !arg.startsWith('auto ')) return null
  const rest = raw.slice(4).trim()
  if (rest.toLowerCase() === 'off') {
    holdTimer?.cancel()
    await setAuto($, null)
    return 'Auto mode off'
  }
  if (rest.toLowerCase() === 'resume') return resumeAuto($)
  if (/^burst( on| off)?$/i.test(rest)) return burstCommand($, !/off$/i.test(rest))
  const m = /^(\S+)(?:\s+(\d+))?$/.exec(rest || DEFAULT_PLAN)
  if (!m) return 'Use /pace auto [plan file] [turns], /pace auto off or /pace auto resume'
  const plan = m[1]!
  const max = m[2] ? Math.max(1, Number(m[2])) : AUTO_TURNS
  if (!((await read($, prefsA)) ?? DEFAULT_PREFS).onboarded) {
    pendingPlan = { plan, max }
    await $.ui.open({ id: AUTO_PANE, title: 'Pace · auto mode', rows: 12, focus: true, closeOnEscape: true })
    return 'Auto mode: read what it does and press Start'
  }
  await startAuto($, plan, max)
  return `Auto mode on: ${plan}`
}

/** `/pace auto resume` and `/pace ultra resume`: a paused or finished run picks back up, with more turns if it ran out */
async function resumeAuto($: Engine): Promise<string> {
  const auto = await autoOf($)
  if (!auto) return 'Auto mode is not running: /pace auto <plan file> starts it'
  const more = auto.ultra ? ULTRA_TURNS : AUTO_TURNS
  await setAuto($, { ...running(auto), turns: auto.turns + 1, max: auto.turns >= auto.max ? auto.turns + more : auto.max })
  const snap = forModel(published ?? snapshotOf(await snapshot($), await $.clock.now()), await modelOf($))
  await submitSoon($, auto.ultra ? `${workPrompt(auto.plan)}${pacingNote(snap)}${gearNote(auto.ultra.gear)}` : continuePrompt(auto.plan, snap))
  return `${auto.ultra ? 'Ultra pace' : 'Auto mode'} resumed: ${auto.plan}`
}

/** `/pace auto burst [off]`: the run stops holding for pacing; a pacing hold under way ends at once */
async function burstCommand($: Engine, on: boolean): Promise<string> {
  const auto = await autoOf($)
  if (!auto) return 'Auto mode is not running: /pace auto <plan file> starts it'
  const { burst: _, ...rest } = auto
  const pacing = on && auto.heldUntil != null && (auto.why ?? '').startsWith('Pacing')
  await setAuto($, on ? { ...rest, burst: true } : rest)
  if (pacing) {
    holdTimer?.cancel()
    timers.push($.clock.after(0, () => { void endHold($).catch(() => {}) }))
  }
  return on
    ? 'Burst on: auto mode no longer holds for pacing, only for a quota gassed out. /pace auto burst off brings the holds back'
    : 'Burst off: auto mode holds again while the rate would gas a quota out'
}

/** `/pace ultra [plan] [turns] [floor..ceiling] | off | resume` */
async function ultraCommand($: Engine, rest: string): Promise<string> {
  if (rest.toLowerCase() === 'off') {
    holdTimer?.cancel()
    await setAuto($, null)
    return 'Ultra pace off'
  }
  if (rest.toLowerCase() === 'resume') return resumeAuto($)
  if (rest.toLowerCase() === 'preview') {
    await update($, previewA, () => 0)
    const now = await $.clock.now()
    await update($, previewA, () => now + PREVIEW_MS)
    timers.push($.clock.after(PREVIEW_MS, () => { void update($, previewA, () => 0).catch(() => {}) }))
    return `Preview: ultra pace in push on the band for ${PREVIEW_MS / 1000} seconds`
  }
  const m = /^(\S+)?(?:\s+(\d+))?(?:\s+([\w.-]+)\.\.([\w.-]+))?$/.exec(rest)
  if (!m) return 'Use /pace ultra [plan file] [turns] [floor..ceiling], /pace ultra off or /pace ultra resume'
  const plan = m[1] ?? DEFAULT_PLAN
  const max = m[2] ? Math.max(1, Number(m[2])) : ULTRA_TURNS
  const goal = goalOf(await fileText($, plan).catch(() => ''))
  if (!goal) return `${plan} has no ## Goal: ultra pace works toward one. Add the goal, its Done when lines and a Check: command`
  const ceiling = m[4] ?? (await modelOf($)) ?? ULTRA_FLOOR
  const models = { floor: m[3] ?? ULTRA_FLOOR, ceiling }
  const ultra: PaceUltra = {
    goal: goal.text, check: goal.check, phase: 'plan', sinceReview: 0, quietReviews: 0, checkFails: 0, models,
    gear: startingGear({ ...models, model: ceiling, effort: lastEffort }), headroomStreak: 0,
  }
  if (!((await read($, prefsA)) ?? DEFAULT_PREFS).onboarded) {
    pendingPlan = { plan, max, ultra }
    await $.ui.open({ id: AUTO_PANE, title: 'Pace · ultra pace', rows: 12, focus: true, closeOnEscape: true })
    return 'Ultra pace: read what it does and press Start'
  }
  await startAuto($, plan, max, ultra)
  return `Ultra pace on: ${plan}`
}

// ======================================================================
// Hooks
// ======================================================================

/** /pace answers in a toast: no transcript row, so the model never reads it and the context stays as it was */
function say($: Engine, text: string): {} {
  $.ui.toast(text)
  return {}
}

const USAGE = 'split | pane | window | refresh | on | off | auto [plan] [turns] | auto off | auto resume | auto burst [off] | ultra [plan] [turns] [floor..ceiling] | ultra off | ultra resume | ultra preview | plan [file] [file] | hide | show | line on | line off | warm compact | warm ping | warm off'

export const register: Register = (on, options) => {
  placement = options.placement === 'status' ? 'status' : 'above'
  ttlOption = options.cacheTtl === '5m' || options.cacheTtl === '1h' ? options.cacheTtl : 'auto'
  terminalApp = typeof options.terminal === 'string' && options.terminal ? options.terminal : 'Terminal'
  lastRow = undefined

  // $.pace: what pace knows, for other plugins, as of the last reply, reading or minute tick
  on('engine.create', async (_$, e, next) => {
    const pace: Pace = { snapshot: async () => published ?? snapshotOf(EMPTY, 0) }
    return { ...(await next(e)), pace }
  })

  on('session.start', async ($, e, next) => {
    cwd = e.cwd ?? ''
    spendId = await $.session.id().catch(() => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`)
    await $.command.register({ name: 'pace', description: 'Rate-limit pace, prompting rate and the prompt cache, charted', argumentHint: USAGE, immediate: true })
    // A fresh set of timers before `load`, which re-arms a resumed run's hold among them
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
    try { await load($) } catch {}
    try {
      const usage = await $.session.usage()
      lastUsd = usage.cost?.usd ?? null
      await recordRateLimits($, usage.rateLimits)
    } catch {}
    try { await sampleCache($) } catch {}
    try { await sampleUsageApi($) } catch {}
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
    // A subagent's turn is not the session's: its end is never heard as one
    if (e.agentId !== undefined) return next(e)
    working = true
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) {
      active.delete(e.agentId)
      const r = await next(e)
      try { await fanoutReported($, e.agentId) } catch {}
      return r
    }
    working = false
    const r = await next(e)
    try { await afterTurn($, e.answer, e.isAborted) } catch {}
    return r
  })

  // On pace mode in a burst: each request thinks one effort level lighter, back as soon as the rate is steady.
  // Ultra pace instead runs the main thread at its gear's effort, and on its model once the cache is cold.
  on('turn.step', async function* ($, e, next) {
    const prefs = (await read($, prefsA)) ?? DEFAULT_PREFS
    if (e.agentId === undefined && typeof e.effort === 'string') lastEffort = e.effort
    const ultra = prefs.auto && !prefs.auto.paused ? prefs.auto.ultra : undefined
    let step = e
    if (e.agentId === undefined && ultra) {
      mainModel = mainModelFor(ultra.gear, mainModel, !published || coldAt(published, await $.clock.now()))
      step = { ...e, model: requestModel(mainModel, e.model), ...(e.effort != null ? { effort: ultra.gear.effort } : {}) }
    } else if (prefs.onPace && published && e.effort != null) {
      step = { ...e, effort: effortFor(forModel(published, e.model), e.effort) }
    }
    const r = yield* next(step)
    // Whose the next dollars are: subagents' requests come through here too
    if (r.usage?.model) answered.push(r.usage.model)
    return r
  })

  // Auto mode's instructions: fixed text after the engine's sections, so the prompt cache keeps them
  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    const auto = ((await read($, prefsA)) ?? DEFAULT_PREFS).auto
    if (!auto || auto.paused) return r
    const section = auto.ultra ? { id: 'pace:ultra', text: ultraProtocol() } : { id: 'pace:auto', text: protocol() }
    return { sections: [...r.sections, { ...section, scope: 'session' as const }] }
  })

  // No one is at the keyboard in auto mode: take the recommended answer
  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => {
    const auto = ((await read($, prefsA)) ?? DEFAULT_PREFS).auto
    if (!auto || auto.paused) return next(e)
    return { result: { questions: e.questions, answers: answerQuestions(e.questions) } }
  })

  // Ultra pace's gear on the Agent tool: subagents on its model, and no more at once than it allows
  on('agent.spawn', async ($, e, next) => {
    const auto = ((await read($, prefsA)) ?? DEFAULT_PREFS).auto
    const g = auto && !auto.paused ? auto.ultra?.gear : undefined
    if (!g) return next(e)
    if (!spawnAllowed(g, active.size)) {
      return { deny: `Pace allows ${g.subagents} subagent${g.subagents === 1 ? '' : 's'} at a time while the quota is at this pace: wait for one to finish, or do this inline.` }
    }
    const r = await next({ ...e, model: subagentModelFor(g, e.model) })
    if (r.agentId) active.add(r.agentId)
    return r
  })

  on('ui.render', { component: 'Pane', requestId: AUTO_PANE }, async ($, e) => drawOnboarding($, e))
  on('ui.render', { component: 'Pane', requestId: PLAN_PANE }, async ($, e) => drawPlan($, e))

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
    const raw = (e.args ?? '').trim().replace(/\s+/g, ' ')
    const arg = raw.toLowerCase()
    const mode = await modeCommand($, raw)
    if (mode != null) return say($, mode)
    if (arg === 'hide' || arg === 'show') {
      await setPrefs($, p => ({ ...p, band: arg === 'show' }))
      return say($, arg === 'show' ? 'Pace band shown' : 'Pace band hidden; /pace show brings it back')
    }
    if (arg === 'line on' || arg === 'line off') {
      await setPrefs($, p => ({ ...p, line: arg === 'line on' }))
      return say($, `Pace status line ${arg === 'line on' ? 'on' : 'off'}`)
    }
    if (arg.startsWith('warm ')) {
      const mode = arg.slice(5) as PaceWarmMode
      if (mode !== 'off' && mode !== 'compact' && mode !== 'ping') return say($, 'Use /pace warm compact, ping or off')
      await setPrefs($, p => ({ ...p, warm: mode }))
      warmActions = 0
      return say($, mode === 'off'
        ? 'Warm mode off'
        : `Warm mode ${mode}: with under 10 minutes of cache left and Claude idle, ${mode === 'compact' ? 'runs /compact (once until your next prompt)' : 'pings the cache through a fork (up to 3 times until your next prompt)'}`)
    }
    if (arg === 'refresh') {
      const ok = await refreshAll($)
      return say($, ok ? 'Pace figures refreshed' : 'Could not reach the usage endpoint; showing the latest local figures')
    }
    if (arg === 'plan' || arg.startsWith('plan ')) {
      planShown = raw.slice(4).trim() || null
      const where = await openPlan($)
      return say($, `Plan timeline opened ${where === 'split' ? 'in a tmux sidebar' : 'in a pane'}: ${(await shownPlans($)).map(p => p.plan).join(' beside ')}`)
    }
    if (arg && arg !== 'pane' && arg !== 'window' && arg !== 'split') return say($, `Unknown argument "${arg}": use ${USAGE}`)
    await tick($)
    if (arg === 'window') {
      let opened = false
      try { opened = await openWindow($) } catch {}
      if (opened) return say($, 'Pace window opened; q closes it')
    } else if (arg !== 'pane') {
      let split: 'opened' | 'open' | false = false
      try { split = await openSplit($) } catch {}
      if (split === 'opened') return say($, 'Pace opened in a tmux split; q there closes it')
      if (split === 'open') return say($, 'Pace is already open in a tmux split')
    }
    const lines = paneLines(await snapshot($), await $.clock.now(), paneLayout(Math.max(40, (e.presentation?.columns ?? 80) - 4), DEFAULT_PREFS))
    await $.ui.open({ id: PANE, title: 'Pace', rows: lines.length + 4, columns: 80, focus: true, closeOnEscape: true })
    const why = arg === 'window' ? 'Could not open a terminal window; ' : arg === 'split' ? 'Not inside tmux; ' : ''
    return say($, `${why}Pace pane opened${why ? ' here' : ''}`)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || placement !== 'above') return next(e)
    const prefs = (await read($, prefsA)) ?? DEFAULT_PREFS
    if (!prefs.band) return next(e)
    const now = (await read($, nowA)) || (await $.clock.now())
    const preview = (await read($, previewA)) > (await $.clock.now())
    const ours = drawBand($, e, await snapshot($), now, preview)
    const below = await next(e)
    const { Box } = $.ui.resolve(e)
    return <Box flexDirection="column">{ours}{below ?? null}</Box>
  })

  // The split's viewer would show stale figures once the session that feeds it is gone
  on('session.end', async ($, e, next) => {
    for (const pane of [splitPane, planSplit]) {
      if (pane) try { await $.process.run(['tmux', 'kill-pane', '-t', pane]) } catch {}
    }
    splitPane = undefined
    planSplit = undefined
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const prefs = (await read($, prefsA)) ?? DEFAULT_PREFS
    const now = (await read($, nowA)) || (await $.clock.now())
    return drawPane($, e, await snapshot($), prefs, now)
  })
}
