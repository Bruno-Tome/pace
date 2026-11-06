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
import { alertsOf } from '../core/alerts.ts'
import { AUTO_TURNS, commandOf, DEFAULT_PLAN, ULTRA_TURNS, USAGE, type PaceCommand } from '../core/command.ts'
import { route, type Host, type PaceAction, type Surface } from '../core/api.ts'
import { accountId, numbered, type Accounts } from '../core/account.ts'
import { FEED_STALE, FEEDS_DIR, feedFile, feedOf as parseFeed, type PaceFeed } from '../core/host.ts'
import { expiredDays, headLine, hydrate, LOG_DIR, logDays, logFile, logText, parseLog, slimSnapshot, type LogEntry, type LogEvent } from '../core/log.ts'
import { pooled } from '../core/meter.ts'
import { ALREADY_OPEN, herdrOpen, herdrReuse, paceViewOf, registryIn, sharedFile } from '../adapters/herdr/open.ts'
import { ACCOUNTS_FILE, KEY_FILE, keysFile, planFeedFile, ROW_FILE, stateFile, viewFile } from './files.ts'
import { isSessionKey, isStale, prefsFrom, sessionKey, sessionOf, sharedOf } from '../core/prefs.ts'
import { answerQuestions, continuePrompt, decide, effortFor, forModel, HANDOFF_FILE, pacingNote, protocol, startPrompt, upkeep, warmModeFor, type Decision } from '../core/auto.ts'
import { addPrice, priceOf, replyEquivalents, ttlSeconds, warmAction } from '../core/cache.ts'
import { snapshotOf, type Snapshot } from '../core/model.ts'
import * as Q from '../core/quota.ts'
import { parseClaudeJson, parseUsage } from './usage.ts'
import { goalOf, lockBroken, planChanges, revisionsOf, stepsOf } from '../core/plan.ts'
import { coldAt, mainModelFor, notchName, requestModel, spawnAllowed, startingGear, subagentModelFor } from '../core/throttle.ts'
import { closingPrompt, decideUltra, fanoutPrompt, gearNote, integratePrompt, planPrompt, ultraProtocol, workPrompt, type UltraDecision, type UltraInput } from '../core/ultra.ts'
import { nowRow, type PlanFeed } from '../core/timeline.ts'
import { mergeModelPrompts, mergePrompts } from '../core/rate.ts'
import { addSpend, mergeSpend, spendModel } from '../core/spend.ts'
import { bandLines, fittedLayout, paneLayout, lineText, pairWidth, paneLines, picked, planLines, press, sideBySide, splitParts, statusRow, toAnsi, type Feed, type Seg, type UiState } from '../core/view.ts'

const PANE = 'pace'
/** The plan `/pace auto` works through when it is given none */
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
const splitUiA = atom({ plugin: 'pace', key: 'splitUi' } as const, {} as UiState)

// ======================================================================
// Drawing
// ======================================================================

const toText = (T: ElementConstructor<TextProps>, segs: readonly Seg[]): RenderElement[] =>
  segs.map(s => (s.dim ? <T dimColor bold={s.bold}>{s.t}</T> : <T color={s.color} bold={s.bold}>{s.t}</T>))

/** The other live feeds, read at most once a minute: the harnesses on this session's quota pool into its snapshot */
let shared: { at: number; feeds: PaceFeed[] } = { at: -Infinity, feeds: [] }

async function sharedFeeds($: Engine, now: number): Promise<PaceFeed[]> {
  if (now - shared.at < MIN) return shared.feeds
  const home = await homeOf($)
  if (!home) return []
  await accountOf($, home)
  await prune($, home, now)
  const dir = `${home}/${FEEDS_DIR}`
  const own = feedFile('claude', spendId).split('/').pop()
  const names = await $.fs.list(dir).then(es => es.map(e => e.name)).catch(() => [] as string[])
  const all: PaceFeed[] = []
  for (const name of names) {
    if (!name.endsWith('.json') || name === own) continue
    const f = parseFeed(String(await $.fs.read(`${dir}/${name}`).catch(() => '')))
    if (f) all.push(f)
  }
  // Every feed counts towards its quota's history (an older one may still carry some); the live ones pool
  const feeds = hydrate(all, await logEntries($, home, now), now).filter(f => f.at >= now - FEED_STALE)
  shared = { at: now, feeds }
  return feeds
}

/** Each log file read, by path: its size and time as listed, and its events, so one not changed is not read again */
const logCache = new Map<string, { size: number; mtimeMs: number; entries: LogEntry[] }>()

/** The log of the days kept (core/log.ts): every session's events, every harness's */
async function logEntries($: Engine, home: string, now: number): Promise<LogEntry[]> {
  const seen = new Set<string>()
  for (const day of logDays(now)) {
    const dir = `${home}/${LOG_DIR}/${day}`
    const files = await $.fs.list(dir).catch(() => [])
    for (const e of files) {
      if (!e.name.endsWith('.jsonl')) continue
      const path = `${dir}/${e.name}`
      seen.add(path)
      const known = logCache.get(path)
      // Size and time say a file has not changed; a host that lists neither has every file read again
      if (known && e.size && known.size === e.size && known.mtimeMs === e.mtimeMs) continue
      const text = String(await $.fs.read(path).catch(() => ''))
      logCache.set(path, { size: e.size, mtimeMs: e.mtimeMs, entries: parseLog(text, null).entries })
    }
  }
  for (const path of logCache.keys()) if (!seen.has(path)) logCache.delete(path)
  return [...logCache.values()].flatMap(f => f.entries)
}

/** The day pruning last ran on, in this process */
let prunedOn = ''

/** Deletes the log's day folders past keeping and the feeds not written for eight days, once a day (core/log.ts) */
async function prune($: Engine, home: string, now: number): Promise<void> {
  const today = new Date(now).toISOString().slice(0, 10)
  if (prunedOn === today) return
  prunedOn = today
  const root = `${home}/${LOG_DIR}`
  const days = await $.fs.list(root).then(es => es.map(e => e.name)).catch(() => [] as string[])
  const feeds = await $.fs.list(`${home}/${FEEDS_DIR}`).catch(() => [])
  const gone = [
    ...expiredDays(days, now).map(d => `${root}/${d}`),
    ...feeds.filter(e => e.name.endsWith('.json') && e.mtimeMs && e.mtimeMs < now - STATE_SPAN).map(e => `${home}/${FEEDS_DIR}/${e.name}`),
  ]
  if (gone.length) await $.process.run(['/bin/rm', '-rf', ...gone]).catch(() => null)
}

/** This session's log as written so far today: its path, its text, the header in force at its end */
let ownLog: { path: string; text: string; head: string | null } | null = null

/**
 * Appends this session's events to its log. Claude Code's files are written whole, so the day's text is kept and
 * written again with the new lines after it: a reader never sees a line change
 */
async function logEvents($: Engine, events: readonly LogEvent[], now: number): Promise<void> {
  if (!events.length) return
  const home = await homeOf($)
  if (!home) return
  const account = await accountOf($, home)
  const path = `${home}/${logFile('claude', spendId, now)}`
  if (ownLog?.path !== path) {
    const read = String(await $.fs.read(path).catch(() => ''))
    // A line cut short when a write was stopped is left out, so the next one starts on its own line
    const text = read.slice(0, read.lastIndexOf('\n') + 1)
    const head = parseLog(text, null).head
    ownLog = { path, text, head: head ? headLine(head) : null }
  }
  const { text, head } = logText({ provider: 'claude', ...(account ? { account } : {}), session: spendId }, events, ownLog.head)
  ownLog = { path, text: ownLog.text + text, head }
  await $.fs.write(path, ownLog.text)
}

async function snapshot($: Engine): Promise<Snapshot> {
  const now = await $.clock.now()
  return pooled(await ownSnapshot($), await sharedFeeds($, now), { provider: 'claude', ...(accountCache ? { account: accountCache.id } : {}) }, { host: 'claude', session: spendId }, now)
}

/** This session's snapshot from Claude Code's own store, before the other harnesses on its quota join it */
async function ownSnapshot($: Engine): Promise<Snapshot> {
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


function drawPane($: Engine, e: RenderInput<'Pane'>, s: Snapshot, prefs: PacePrefs, now: number): RenderElement {
  const { Box, Text } = $.ui.resolve(e)
  const cols = e.props.bodyColumns ?? 60
  const rows = e.props.scroll?.bodyRows
  const layout = e.props.placement === 'dock' && rows ? fittedLayout(s, now, cols, rows, prefs) : paneLayout(cols, prefs)
  const lines = paneLines(s, now, layout)
  return (
    <Box flexDirection="column">
      {lines.map((segs, i) => <Text key={`l-${i}`} wrap="truncate-end">{segs.length ? toText(Text, segs) : ' '}</Text>)}
    </Box>
  )
}

/** Rows of the split's command bar are led by what they hold, padded to line the buttons up */
const BAR_LEAD = 6

/**
 * The split in a pane, on a surface that draws native buttons and fields: the window's command bar as buttons with
 * its keys as hotkeys, the plan picker as a list and a path field, the body under them for the pane to scroll
 */
async function drawSplit($: Engine, e: RenderInput<'Pane'>, f: Feed, now: number): Promise<RenderElement> {
  const els = $.ui.resolve(e)
  if (!('Input' in els) || !('Select' in els)) return drawPane($, e, f, (await read($, prefsA)) ?? DEFAULT_PREFS, now)
  const { Box, Text, Button, Input, Select } = els
  const Svg = 'Svg' in els ? els.Svg : undefined
  const cols = e.props.bodyColumns ?? 100
  const ui = (await read($, splitUiA)) ?? {}
  const p = splitParts(f, now, cols, e.props.scroll?.bodyRows ?? 40, ui, !!Svg)
  const act = async (a: { ui: UiState; send?: string }) => {
    await update($, splitUiA, () => a.ui)
    if (a.send) say($, await paceCommand($, a.send, cols))
  }
  // In the monospace face: the desktop draws text proportional, and the charts and columns are laid out in cells
  const lines = (list: readonly Seg[][], key: string) =>
    list.map((segs, i) => {
      const pic = segs[0]?.svg
      if (pic && Svg) return <Svg key={`${key}-${i}`} source={pic.source} alt={pic.alt} height={pic.height} />
      return <Text key={`${key}-${i}`} mono wrap="truncate-end">{segs.length ? toText(Text, segs) : ' '}</Text>
    })
  const picker = (
    <Box key="pace-picker" flexDirection="row" flexWrap="wrap" columnGap={2}>
      <Text bold>{p.picking ?? ''}</Text>
      {p.known.length ? <Select key="pace-pick" options={p.known.map(value => ({ value }))} onSelect={v => act(picked(ui, v))} /> : null}
      <Input key="pace-path" placeholder="a plan file's path" submitLabel={ui.picking === 'plan' ? 'show' : 'start'} autoFocus onSubmit={v => act(picked(ui, v))} />
      <Button key="pace-cancel" label="cancel" onPress={() => act({ ui: {} })} />
    </Box>
  )
  const bar = p.bar.map(row => (
    <Box key={`pace-bar-${row.lead}`} flexDirection="row" flexWrap="wrap" columnGap={1}>
      <Text dimColor>{row.lead.padEnd(BAR_LEAD)}</Text>
      {row.buttons.length
        ? row.buttons.map(b => <Button key={`pace-${b.key}`} label={b.label} hotkey={b.key} {...(b.on || b.warn ? { variant: 'primary' as const } : {})} onPress={() => act(press(ui, b.key, f))} />)
        : <Text dimColor>nothing</Text>}
    </Box>
  ))
  return (
    <Box flexDirection="column">
      {lines(p.above, 'above')}
      {p.picking ? picker : bar}
      <Text> </Text>
      {lines(p.body, 'body')}
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
/** The host feed last written, without its time, and when: rewritten when it changes, and each minute to stay live */
let lastFeed: string | undefined
let lastFeedAt = 0
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
/** Where the session is drawn: the terminal, or an app that draws the split in a pane */
let surface = 'terminal'

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
  try { await writeFeed($, s, now) } catch {}
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

/** What the split draws: the snapshot, its samples cut to the last week, when it was taken, and the plan's steps */
async function feedOf($: Engine, s: Snapshot, now: number): Promise<Feed> {
  const shown = await shownPlans($)
  const timelines = await Promise.all(shown.map(async ({ plan, auto }) => {
    const steps = stepsOf(await fileText($, plan).catch(() => ''), auto != null && !auto.paused)
    return steps.length ? { name: plan, steps } : undefined
  }))
  const [plan, also] = timelines
  const prefs = (await read($, prefsA)) ?? DEFAULT_PREFS
  const feed: Feed = {
    ...s, samples: s.samples.filter(x => x.at >= now - STATE_SPAN), at: now,
    ...(plan ? { plan } : {}), ...(also ? { also } : {}),
    prefs: { band: prefs.band, line: prefs.line },
    known: [...new Set([DEFAULT_PLAN, ...(s.auto ? [s.auto.plan] : []), ...shown.map(x => x.plan)])],
    ...(lastNotice ? { notice: lastNotice } : {}),
  }
  return feed
}

/** Writes the window's feed while a window or split is open */
async function writeState($: Engine, s: Snapshot, now: number): Promise<void> {
  if (!feeding) return
  const text = JSON.stringify(await feedOf($, s, now))
  if (text === lastState) return
  const home = await homeOf($)
  if (!home) return
  await $.fs.write(`${home}/${stateFile(spendId)}`, text)
  lastState = text
}

/** Writes this session's host feed, for the band beside other hosts and Herdr's fleet: aside, then moved into place */
/** The account this session's feed names, worked out once per email; undefined signed out */
let accountCache: { email: string; id: string } | undefined

/**
 * The account Claude Code is signed in with (.agents/decisions/0017-quota-is-provider-and-account.md): the email in
 * ~/.claude.json hashed under pace's key (core/account.ts), the key made on first use, the account numbered as
 * first seen. No email is written
 */
async function accountOf($: Engine, home: string): Promise<string | undefined> {
  const root = await $.fs.read(`${home}/.claude.json`).then(t => JSON.parse(String(t)) as { oauthAccount?: { emailAddress?: unknown } }).catch(() => null)
  const email = root?.oauthAccount?.emailAddress
  if (typeof email !== 'string' || !email.includes('@')) return undefined
  if (accountCache?.email === email) return accountCache.id
  const keyPath = `${home}/${KEY_FILE}`
  let key = String(await $.fs.read(keyPath).catch(() => '')).trim()
  if (!/^[0-9a-f]{64}$/.test(key)) {
    key = [...crypto.getRandomValues(new Uint8Array(32))].map(b => b.toString(16).padStart(2, '0')).join('')
    await $.fs.write(keyPath, key)
    await $.process.run(['/bin/chmod', '600', keyPath]).catch(() => null)
  }
  const id = accountId(email, key)
  const accountsPath = `${home}/${ACCOUNTS_FILE}`
  const before = await $.fs.read(accountsPath).then(t => JSON.parse(String(t)) as Accounts).catch((): Accounts => ({}))
  const after = numbered(before && typeof before === 'object' ? before : {}, 'claude', id)
  if (after !== before) await $.fs.write(accountsPath, JSON.stringify(after))
  accountCache = { email, id }
  return id
}

async function writeFeed($: Engine, s: Snapshot, now: number): Promise<void> {
  const terminal = await $.env.get('HC_TERMINAL_ID')
  const home = await homeOf($)
  if (!home) return
  const account = await accountOf($, home)
  const feed: Omit<PaceFeed, 'at'> = {
    version: 1, host: 'claude', provider: 'claude', ...(account ? { account } : {}), session: spendId,
    ...(terminal ? { terminal } : {}),
    cwd,
    // Its history is in its log (core/log.ts)
    snapshot: slimSnapshot(s),
    ...(s.cache ? { context: { tokens: s.cache.tokens, window: s.cache.window } } : {}),
  }
  const text = JSON.stringify(feed)
  if (text === lastFeed && now - lastFeedAt < MIN) return
  const path = `${home}/${feedFile('claude', spendId)}`
  await $.fs.write(`${path}.tmp`, JSON.stringify({ ...feed, at: now }))
  await $.process.run(['/bin/mv', `${path}.tmp`, path])
  lastFeed = text
  lastFeedAt = now
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
  const script = `${home}/${viewFile(spendId)}`
  await $.fs.write(script, [
    '#!/bin/sh',
    "printf '\\033]0;Pace\\007'",
    `exec ${shellQuote(node)} ${shellQuote(`${$.plugin.root}/bin/viewer.ts`)} ${shellQuote(`${home}/${stateFile(spendId)}`)} ${shellQuote(`${home}/${keysFile(spendId)}`)}`,
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

/**
 * Opens what `/pace <arg>` asks for in Herdr beside this session, when it runs in Herdr: Claude's charts, its band
 * or the fleet. What to answer; null to go on to tmux and the pane, where Herdr is not there or did not open it.
 */
async function openHerdr($: Engine, arg: string): Promise<string | null> {
  const terminal = await $.env.get('HC_TERMINAL_ID')
  const herdrOnly = arg === 'band' || arg === 'fleet'
  if (!terminal) return null
  const view = paceViewOf(arg, 'claude', terminal, accountCache?.id)
  if (!view) return null
  const shared = sharedFile((await $.env.get('HERDR_APP_HOME')) || `${await homeOf($)}/.config/herdr-app`)
  const reuse = herdrReuse(await $.fs.read(shared).then(t => registryIn(String(t))).catch(() => ({})), view)
  if (reuse && (await $.process.run(reuse).catch(() => null))?.exitCode === 0) return ALREADY_OPEN
  for (const argv of herdrOpen(terminal, view)) {
    const r = await $.process.run(argv).catch(() => null)
    if (r?.exitCode !== 0) return null
  }
  return `Pace opened in Herdr${herdrOnly ? `: ${arg}` : ''}`
}

/** The last answer a command from the window got, for its feed */
let lastNotice: { id: number; text: string; at: number } | undefined

/**
 * A button pressed in the window: any `/pace` argument, run as the command would be and answered in the feed;
 * `warm` alone steps warm mode off → compact → ping. Each handled once.
 */
async function readKeys($: Engine): Promise<void> {
  const home = await homeOf($)
  const path = `${home}/${keysFile(spendId)}`
  if (!home || !(await $.fs.exists(path))) return
  const k = JSON.parse(await $.fs.read(path)) as { id?: unknown; cmd?: unknown }
  if (typeof k.id !== 'number' || k.id <= lastKey || typeof k.cmd !== 'string') return
  lastKey = k.id
  if (k.cmd === 'warm') {
    await setPrefs($, p => ({ ...p, warm: WARM_NEXT[p.warm ?? 'off'] }))
    warmActions = 0
    return
  }
  const text = await paceCommand($, k.cmd, 80)
  lastNotice = { id: k.id, text, at: await $.clock.now() }
  await refreshLine($)
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
  await logEvents($, [{ at: s.at, quotas: s.quotas }], s.at)
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
  const s = parseClaudeJson(await $.fs.read(path), await $.clock.now())
  if (s) await addFresh($, s)
}

/** Fresh figures from the endpoint `/usage` reads, sent with Claude Code's own login; the mod never sees the credential */
async function sampleUsageApi($: Engine): Promise<boolean> {
  const auth = await $.session.authorize()
  if (!auth?.handle || auth.kind !== 'bearer') return false
  const r = await $.http.fetch(USAGE_URL, { auth: auth.handle, headers: { 'anthropic-beta': 'oauth-2025-04-20' } })
  if (!r.ok) return false
  const quotas = parseUsage(JSON.parse(r.text))
  if (!Object.keys(quotas).length) return false
  lastFetch = await $.clock.now()
  await addFresh($, { at: lastFetch, quotas })
  return true
}

/** What this session just spent, added to the shared spend: the store's copy merged in first, so no session's is lost */
async function recordSpend($: Engine, usd: number): Promise<void> {
  const now = await $.clock.now()
  const stored = await $.store.get('spend')
  const model = spendModel(answered, await modelOf($))
  const mine = addSpend((await read($, spendA)) ?? [], spendId, now, usd, now, model)
  answered = []
  if (usd > 0) await logEvents($, [{ at: now, usd, ...(model ? { model } : {}) }], now)
  const merged = mergeSpend(Array.isArray(stored) ? (stored as PaceSpend[]) : [], mine, now)
  await $.store.set('spend', merged)
  await update($, spendA, () => merged)
}

async function recordPrompt($: Engine): Promise<void> {
  const now = await $.clock.now()
  const model = await modelOf($)
  await logEvents($, [{ at: now, prompt: true, ...(model ? { model } : {}) }], now)
  await update($, promptsA, list => mergePrompts(list ?? [], [now], now))
  const stored = await $.store.get('prompts')
  const merged = mergePrompts(Array.isArray(stored) ? (stored as number[]) : [], (await read($, promptsA)) ?? [], now)
  await $.store.set('prompts', merged)
  await update($, promptsA, () => merged)
  // The model it went to, so a model's own week counts only its prompts
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
/** The model ultra pace drops to at its lightest, unless told otherwise */
const ULTRA_FLOOR = 'sonnet'
/** A plan waiting on the onboarding pane's Start, and ultra pace's run on it */
let pendingPlan: { plan: string; max: number; ultra?: PaceUltra } | null = null
/** The effort the main loop last asked for: the user's, which ultra pace's cruise gear keeps */
let lastEffort: PaceGear['effort'] = 'high'
/** The plan as the last turn left it, for ultra pace's ticks and lock; null before one was read */
let planMark: string | null = null
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

/** The viewer and sidebar panes named closed, and forgotten */
async function killPanes($: Engine, panes: readonly (string | undefined)[]): Promise<void> {
  for (const pane of panes) {
    if (!pane) continue
    try { await $.process.run(['tmux', 'kill-pane', '-t', pane]) } catch {}
    if (pane === splitPane) splitPane = undefined
    if (pane === planSplit) planSplit = undefined
  }
}

/** Writes what the plan sidebar draws from */
async function writePlanFeed($: Engine): Promise<void> {
  const home = await homeOf($)
  if (!home) return
  const [first, also] = await shownPlans($)
  const feed: PlanFeed = { ...first!, at: await $.clock.now(), ...(also ? { also } : {}) }
  await $.fs.write(`${home}/${planFeedFile(spendId)}`, JSON.stringify(feed))
}

/** Opens the plan sidebar in a narrow tmux split on the right, or finds the one open; false outside tmux or where that fails */
async function openPlanSplit($: Engine, inside = false): Promise<boolean> {
  if (!(await inTmux($))) return false
  const home = await homeOf($)
  if (!home) return false
  await writePlanFeed($)
  if (planSplit && (await $.process.run(['tmux', 'display-message', '-p', '-t', planSplit, '#{pane_id}'])).exitCode === 0) return true
  const node = await nodeOf($)
  if (!node) return false
  const run = `exec ${shellQuote(node)} ${shellQuote(`${$.plugin.root}/bin/plan-viewer.ts`)} ${shellQuote(`${home}/${planFeedFile(spendId)}`)}`
  // Under the Pace split, half its height; else beside Claude, two plans side by side taking twice the width
  const under = inside && !!splitPane
  const beside = under ? splitPane : await $.env.get('TMUX_PANE')
  const width = (await shownPlans($)).length > 1 ? SIDEBAR_COLUMNS * 2 + 3 : SIDEBAR_COLUMNS
  const size = under ? ['-v', '-d', '-l', '50%'] : ['-h', '-d', '-l', String(width)]
  const r = await $.process.run(['tmux', 'split-window', ...size, ...(beside ? ['-t', beside] : []), '-P', '-F', '#{pane_id}', run])
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

/** Agent statuses that are still at work, or about to be */
const AT_WORK = new Set(['pending', 'running', 'waiting'])

/**
 * Whether every subagent out on the fan-out has reported: its turn's end heard (kept with the run, so a reload or a
 * resume forgets none), or the engine no longer lists it at work, which covers a report missed
 */
async function agentsDone($: Engine, ultra: PaceUltra): Promise<boolean> {
  const f = ultra.fanout
  if (!f) return true
  const heard = new Set(f.reported ?? [])
  const listed = await $.agent.list().catch(() => null)
  const atWork = listed ? new Set(listed.filter(a => AT_WORK.has(a.status)).map(a => a.id)) : null
  return f.agentIds.every(id => heard.has(id) || (atWork != null && !atWork.has(id)))
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
  // A wait on a fan-out says how the engine lists each subagent, so a stuck one can be told from a slow one
  if (d.kind === 'wait' && d.ultra.phase === 'fanout' && d.ultra.fanout) {
    const listed = await $.agent.list().catch(() => null)
    const how = listed
      ? d.ultra.fanout.agentIds.map(id => `${id.slice(0, 5)}…: ${listed.find(a => a.id === id)?.status ?? 'not listed'}`).join(', ')
      : 'agent list unavailable'
    await setAuto($, next)
    await act($, { ...d, why: `${d.why} (${how})` })
    return
  }
  await setAuto($, next)
  await act($, d)
  if (d.kind === 'stop' && d.why.startsWith('Goal reached')) await $.prompt.submit({ text: closingPrompt(auto.plan, d.ultra.goal) })
}

/** A subagent out on the fan-out reported: once the last has, ultra pace decides again */
async function fanoutReported($: Engine, agentId: string): Promise<void> {
  const auto = await autoOf($)
  const f = auto?.ultra?.fanout
  if (!auto?.ultra || !f?.agentIds.includes(agentId)) return
  const heard: PaceAuto = { ...auto, ultra: { ...auto.ultra, fanout: { ...f, reported: [...new Set([...(f.reported ?? []), agentId])] } } }
  await setAuto($, heard)
  if (working || heard.paused || !(await agentsDone($, heard.ultra!))) return
  holdTimer?.cancel()
  await refreshAll($)
  await decideAndAct($, running(heard), '', false, false)
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
/** `/pace auto off` and `/pace ultra off` */
async function stopCommand($: Engine, ultra: boolean): Promise<string> {
  holdTimer?.cancel()
  await setAuto($, null)
  return ultra ? 'Ultra pace off' : 'Auto mode off'
}

/** `/pace auto [plan] [turns]`: the first run of all shows what auto mode does before it starts */
async function autoCommand($: Engine, plan: string, max: number): Promise<string> {
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
  const u = auto.ultra
  // Resumed while waiting on a fan-out: you say go on, so what the subagents did is integrated now
  const out = u?.phase === 'fanout' ? u.fanout : undefined
  const { fanout: _, ...rest } = u ?? ({} as PaceUltra)
  const ultra = u && out ? { ultra: { ...rest, phase: 'integrate' as const } } : {}
  await setAuto($, { ...running(auto), ...ultra, turns: auto.turns + 1, max: auto.turns >= auto.max ? auto.turns + more : auto.max })
  const snap = forModel(published ?? snapshotOf(await snapshot($), await $.clock.now()), await modelOf($))
  const prompt = !u ? continuePrompt(auto.plan, snap)
    : `${out ? integratePrompt(auto.plan, out.steps) : workPrompt(auto.plan)}${pacingNote(snap)}${gearNote(u.gear)}`
  await submitSoon($, prompt)
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

/** `/pace ultra preview`: ultra pace's push on the band for a while */
async function previewCommand($: Engine): Promise<string> {
  await update($, previewA, () => 0)
  const now = await $.clock.now()
  await update($, previewA, () => now + PREVIEW_MS)
  timers.push($.clock.after(PREVIEW_MS, () => { void update($, previewA, () => 0).catch(() => {}) }))
  return `Preview: ultra pace in push on the band for ${PREVIEW_MS / 1000} seconds`
}

/** `/pace ultra [plan] [turns] [floor..ceiling]` */
async function ultraCommand($: Engine, c: Extract<PaceCommand, { kind: 'ultra' }>): Promise<string> {
  const { plan, max } = c
  const goal = goalOf(await fileText($, plan).catch(() => ''))
  if (!goal) return `${plan} has no ## Goal: ultra pace works toward one. Add the goal, its Done when lines and a Check: command`
  const ceiling = c.ceiling ?? (await modelOf($)) ?? ULTRA_FLOOR
  const models = { floor: c.floor ?? ULTRA_FLOOR, ceiling }
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

/** `/pace …` run: what it answers, from the prompt or from a button in the window; `columns` sizes the pane */
async function paceCommand($: Engine, args: string, columns: number): Promise<string> {
  const c = commandOf(args)
  const a = route(c, await claudeHost($))
  switch (a.kind) {
    case 'say': return a.text
    case 'prefs': {
      const { band, line, onPace, warm } = a.prefs
      await setPrefs($, p => ({ ...p, ...(band != null ? { band } : {}), ...(line != null ? { line } : {}), ...(onPace != null ? { onPace } : {}), ...(warm ? { warm } : {}) }))
      if (warm) warmActions = 0
      return a.text
    }
    case 'stop': return stopCommand($, a.ultra)
    case 'resume': return resumeAuto($)
    case 'burst': return burstCommand($, a.on)
    case 'auto': return autoCommand($, a.plan, a.max)
    case 'ultra': return ultraCommand($, a)
    case 'preview': return previewCommand($)
    case 'refresh': {
      const ok = await refreshAll($)
      return ok ? a.text : 'Could not reach the usage endpoint; showing the latest local figures'
    }
    case 'close':
      // The viewer quitting: its timeline pane goes with it, and the next /pace opens a fresh split
      await killPanes($, [planSplit])
      splitPane = undefined
      feeding = false
      return 'Pace split closed'
    case 'open':
      if (a.view === 'plan') return c.kind === 'timeline' ? timelineCommand($) : planCommand($, c.kind === 'plan' ? c.files : [])
      await tick($)
      return openAt($, a, columns)
  }
}

/** Claude Code as pace's host: Herdr and tmux where it runs in them, its pane, a window, the band, the status line, toasts; pace drives it all */
async function claudeHost($: Engine): Promise<Host> {
  const surfaces: Surface[] = [...((await $.env.get('HC_TERMINAL_ID')) ? ['herdr' as const] : []), ...((await inTmux($)) ? ['split' as const] : []), 'pane', 'window', 'band', 'status', 'toast']
  return { name: 'Claude Code', input: 'prompt', surfaces, drives: ['prompt', 'compact', 'clear', 'effort', 'model', 'ping'], cache: true }
}

async function planCommand($: Engine, files: readonly string[]): Promise<string> {
  planShown = files.join(' ') || null
  const where = await openPlan($)
  return `Plan timeline opened ${where === 'split' ? 'in a tmux sidebar' : 'in a pane'}: ${(await shownPlans($)).map(p => p.plan).join(' beside ')}`
}

/** The split's timeline button: the plan's timeline under the Pace split, closed again when it is open; the sidebar beside Claude without a split */
async function timelineCommand($: Engine): Promise<string> {
  if (planSplit && (await $.process.run(['tmux', 'display-message', '-p', '-t', planSplit, '#{pane_id}'])).exitCode === 0) {
    await killPanes($, [planSplit])
    return 'Plan timeline closed'
  }
  if (splitPane && (await openPlanSplit($, true).catch(() => false))) return `Plan timeline opened under the Pace split: ${(await shownPlans($)).map(p => p.plan).join(' beside ')}`
  return planCommand($, [])
}

/** A view opened where core/api.ts routed it: Herdr, a tmux split or a window, each falling back to Claude's own pane */
async function openAt($: Engine, a: Extract<PaceAction, { kind: 'open' }>, columns: number): Promise<string> {
  switch (a.surface) {
    case 'herdr': {
      const opened = await openHerdr($, a.view === 'pane' ? '' : a.view).catch(() => null)
      if (opened) return opened
      if (a.fallback?.kind === 'open') return openAt($, a.fallback, columns)
      return `Could not open pace in Herdr: is herdr-app on the PATH?${a.fallback?.kind === 'say' ? ` ${a.fallback.text}` : ''}`
    }
    case 'split': {
      let split: 'opened' | 'open' | false = false
      try { split = await openSplit($) } catch {}
      if (split === 'opened') return 'Pace opened in a tmux split; q there closes it'
      if (split === 'open') return 'Pace is already open in a tmux split'
      return openPane($, columns, 'Not inside tmux; ')
    }
    case 'window': {
      let opened = false
      try { opened = await openWindow($) } catch {}
      return opened ? 'Pace window opened; q closes it' : openPane($, columns, 'Could not open a terminal window; ')
    }
    default: return openPane($, columns, a.note ? `${a.note}; ` : '')
  }
}

/** Claude's own pace pane, saying `why` it opened there instead */
async function openPane($: Engine, columns: number, why: string): Promise<string> {
  const lines = paneLines(await snapshot($), await $.clock.now(), paneLayout(Math.max(40, columns - 4), DEFAULT_PREFS))
  await $.ui.open({ id: PANE, title: 'Pace', rows: lines.length + 4, columns: 80, focus: true, closeOnEscape: true })
  if (surface !== 'terminal') return 'Pace pane opened'
  return `${why}Pace pane opened${why ? ' here' : ''}`
}

/** /pace answers in a toast: no transcript row, so the model never reads it and the context stays as it was */
function say($: Engine, text: string): {} {
  $.ui.toast(text)
  return {}
}

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
    surface = e.surface ?? 'terminal'
    spendId = await $.session.id().catch(() => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`)
    await $.command.register({ name: 'pace', description: 'Rate-limit pace, prompting rate and the prompt cache, charted', argumentHint: USAGE, immediate: true })
    // A fresh set of timers before `load`, which re-arms a resumed run's hold among them
    for (const t of timers) t.cancel()
    keysTimer = undefined
    timers = [
      $.clock.every(MIN, () => { void tick($).catch(() => {}) }),
      $.clock.every(15_000, () => { void cacheTick($).catch(() => {}) }),
      $.clock.every(5 * MIN, () => { void sampleCache($).catch(() => {}) }),
      // Per-model quotas only move through the endpoint: ask again every 3 minutes, and only after a prompt or any
      // session's spend since the last ask (another session's subagents spend without prompting)
      $.clock.every(3 * MIN, () => {
        void (async () => {
          await tick($)
          const prompts = (await read($, promptsA)) ?? []
          const spent = (await read($, spendA)) ?? []
          const latest = Math.max(prompts[prompts.length - 1] ?? 0, ...spent.map(x => x.t))
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
      // Claude Code's gears come from Claude's ladder (core/gears.ts), so the effort is one of its own
      step = { ...e, model: requestModel(mainModel, e.model), ...(e.effort != null ? { effort: ultra.gear.effort as NonNullable<typeof e.effort> } : {}) }
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

  on('command.run', { command: 'pace' }, async ($, e) => say($, await paceCommand($, e.args ?? '', e.presentation?.columns ?? 80)))

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
    await killPanes($, [splitPane, planSplit])
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const prefs = (await read($, prefsA)) ?? DEFAULT_PREFS
    const now = (await read($, nowA)) || (await $.clock.now())
    if (e.surface !== 'terminal') return drawSplit($, e, await feedOf($, await snapshot($), now), now)
    return drawPane($, e, await snapshot($), prefs, now)
  })
}
