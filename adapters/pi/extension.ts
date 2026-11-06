// The pi extension: pi loads it in its own process (`~/.pi/agent/extensions/`, TypeScript through jiti). It listens to
// pi's events, writes the session's feed, ~/.local/state/pace/feeds/pi-<session>.json, draws the band above pi's
// editor and the quotas in its footer, says each warning once per window, answers `/pace` (adapters/pi/commands.ts)
// in a notification, never in the transcript, and runs auto mode: after each run, core/auto.ts's decision.
//
// pi is told no readings, so the session estimates them from what it spends (adapters/pi/feed.ts, core/estimate.ts).
// What a window holds is learned from a usage limit reached or a live feed's real readings, and kept for every pi
// session in ~/.local/state/pace/pi/<provider>.json. It never gets in pi's way: an error writing or drawing is
// dropped, and the next event tries again.

import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import type { PaceAuto, PaceGears } from '../../types'
import { alertsOf } from '../../core/alerts.ts'
import { continuePrompt, decide, protocol, resumed, runsOut, startPrompt, upkeep } from '../../core/auto.ts'
import { commandOf, DEFAULT_PLAN, USAGE } from '../../core/command.ts'
import { learn, type Capacities } from '../../core/estimate.ts'
import { FEED_STALE, feedFile, fleetOf, type PaceFeed, type PaceProvider } from '../../core/host.ts'
import { eventsOf, type Tokens } from '../../core/log.ts'
import { snapshotOf } from '../../core/model.ts'
import { stepsOf } from '../../core/plan.ts'
import { bandLines, fleetLines, lineText, paneLayout, paneLines, planLines, toAnsi, type Line } from '../../core/view.ts'
import { openInHerdr } from '../codex/open.ts'
import { HOST_PREFS, route, stepOf, warmStep, type Host, type HostPrefs, type PaceAction, liveOf } from '../../core/api.ts'
import { PI_THINKING, thinkingFor } from './commands.ts'
import { ladderFor, type Ladder } from '../../core/gears.ts'
import { coldAt, headroomOf, shiftGears, startGears } from '../../core/throttle.ts'
import { emailOfJwt, soleAccount } from '../../core/account.ts'
import { accountFor } from '../account.ts'
import { appendLog, pruneLog, readFeeds, sessionFeeds, writeFeed } from '../log.ts'
import { isLimit, nextFeed, piMetered, providerOf } from './feed.ts'

/** What the extension uses of pi's extension context */
type Ctx = {
  cwd: string
  hasUI?: boolean
  model?: { provider: string; id?: string }
  modelRegistry: { isUsingOAuth(model: unknown): boolean; getAvailable?(): { provider: string; id: string }[]; find?(provider: string, id: string): unknown }
  sessionManager: { getSessionId(): string }
  getContextUsage(): { tokens: number | null; contextWindow: number } | undefined
  compact(): void
  isIdle?(): boolean
  ui: {
    setWidget(key: string, lines: string[] | undefined): void
    setStatus(key: string, text: string | undefined): void
    notify(text: string, type?: 'info' | 'warning' | 'error'): void
    custom(factory: (tui: { requestRender(): void }, theme: unknown, keys: unknown, done: (r: undefined) => void) => Overlay, options?: { overlay?: boolean }): Promise<unknown>
  }
}

/** What pi draws over itself: lines for its width, closed by q or Escape */
type Overlay = { render(width: number): string[]; handleInput?(data: string): void; invalidate(): void }

/** What the extension uses of pi's extension API */
type Pi = {
  on(event: string, handler: (event: any, ctx: Ctx) => unknown): void
  registerCommand(name: string, options: { description: string; handler: (args: string, ctx: Ctx) => unknown }): void
  sendUserMessage(text: string, options?: { deliverAs?: 'steer' | 'followUp' }): void
  getThinkingLevel(): string
  setThinkingLevel(level: string): void
  setModel?(model: unknown): Promise<boolean>
}

/** What an event adds to the feed */
type Happened = { prompted?: boolean; spent?: number; limit?: boolean; cached?: number; tokens?: Tokens }

const KEY = 'pace'
/** How often the band is drawn again while pi is idle, for the clocks and the other sessions' feeds */
const TICK_MS = 30_000

/** Where pi's sessions keep the capacities learned on a provider, relative to the home directory */
const capacityFile = (provider: PaceProvider) => `.local/state/pace/pi/${provider}.json`
const NOT_RUNNING = 'Auto mode is not running: /pace auto <plan file> starts it'

/** pi's preferences, and the warnings already said, shared by its sessions */
const PREFS_FILE = '.local/state/pace/pi/prefs.json'
const ALERTED_FILE = '.local/state/pace/pi/alerted.json'

function writeAtomically(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(`${path}.tmp`, text)
  renameSync(`${path}.tmp`, path)
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

/** The capacities kept, those that parse */
function capacitiesIn(path: string): Capacities {
  const v = readJson(path)
  if (typeof v !== 'object' || v == null) return {}
  const out: Capacities = {}
  for (const [key, c] of Object.entries(v as Record<string, any>)) {
    if (c && Number.isFinite(c.usd) && c.usd > 0 && Number.isFinite(c.at) && (c.source === 'limit' || c.source === 'reading')) out[key] = { usd: c.usd, at: c.at, source: c.source }
  }
  return out
}

const ROOT = join(import.meta.dirname, '../..')

/** A plan's text, as named from the session's folder; empty when it cannot be read */
function planText(cwd: string, plan: string): string {
  try {
    return readFileSync(join(cwd, plan), 'utf8')
  } catch {
    return ''
  }
}

/** The preferences kept, what of them parses */
function prefsIn(path: string): HostPrefs {
  const v = readJson(path) as Partial<Record<keyof HostPrefs, unknown>> | null
  const flag = (k: 'band' | 'line' | 'onPace') => (typeof v?.[k] === 'boolean' ? (v[k] as boolean) : HOST_PREFS[k])
  const warm = v?.warm === 'compact' || v?.warm === 'off' ? v.warm : HOST_PREFS.warm
  return { band: flag('band'), line: flag('line'), onPace: flag('onPace'), warm }
}

/** Every live feed, each with its quota's history */
const liveIn = (home: string, now: number): PaceFeed[] => readFeeds(home, now).filter(f => f.at >= now - FEED_STALE)

/** The account pi is signed in with on `provider`: its token's email, where the token carries one (ChatGPT's does not) */
function piAccount(home: string, provider: PaceProvider, piProvider: string | undefined): string | undefined {
  const auth = readJson(join(home, '.pi/agent/auth.json')) as Record<string, Record<string, unknown>> | null
  const entry = piProvider ? auth?.[piProvider] : undefined
  const token = [entry?.id_token, entry?.idToken, entry?.access].find((t): t is string => typeof t === 'string')
  return token ? accountFor(home, provider, emailOfJwt(token)) : undefined
}

/** pi as pace's host: its own overlay, band and footer, a split in tmux; pace sends its prompts, compacts it and lowers its thinking */
function piHost(): Host {
  const surfaces: Host['surfaces'] = [...(process.env.HC_TERMINAL_ID ? ['herdr' as const] : []), 'overlay', ...(process.env.TMUX ? ['split' as const] : []), 'band', 'status', 'toast']
  return { name: 'pi', input: 'editor', surfaces, drives: ['prompt', 'compact', 'effort', 'model'], cache: true }
}

export default function pace(pi: Pi): void {
  let prev: PaceFeed | null = null
  let last: Ctx | null = null
  let timer: ReturnType<typeof setInterval> | null = null

  const clear = (ctx: Ctx) => {
    ctx.ui.setWidget(KEY, undefined)
    ctx.ui.setStatus(KEY, undefined)
  }

  function draw(ctx: Ctx, feed: PaceFeed, now: number): void {
    if (ctx.hasUI === false) return
    const prefs = prefsIn(join(homedir(), PREFS_FILE))
    const cols = process.stdout.columns || 100
    ctx.ui.setWidget(KEY, prefs.band ? bandLines(feed.snapshot, now, cols).map(toAnsi) : undefined)
    ctx.ui.setStatus(KEY, prefs.line ? lineText(feed.snapshot, now) : undefined)
  }

  /** Says each warning once per window across pi's sessions */
  function announce(ctx: Ctx, feed: PaceFeed, now: number): void {
    const path = join(homedir(), ALERTED_FILE)
    const said = readJson(path)
    const seen = new Set<string>(Array.isArray(said) ? said.filter((x): x is string => typeof x === 'string') : [])
    const fresh = alertsOf(snapshotOf(feed.snapshot, now)).filter(a => !seen.has(a.id))
    if (!fresh.length) return
    for (const a of fresh) seen.add(a.id)
    writeAtomically(path, JSON.stringify([...seen].slice(-200)))
    for (const a of fresh) ctx.ui.notify(`pace: ${a.text}`, a.level === 'urgent' ? 'error' : 'warning')
  }

  function update(ctx: Ctx, happened: Happened = {}): void {
    last = ctx
    const provider = ctx.model ? providerOf(ctx.model.provider, ctx.modelRegistry.isUsingOAuth(ctx.model)) : null
    if (!provider) return clear(ctx)
    const home = homedir()
    const now = Date.now()
    const session = ctx.sessionManager.getSessionId()
    const path = join(home, feedFile('pi', session))
    const feeds = sessionFeeds(home, now, f => f.host === 'pi' && f.session === session)
    const before = prev?.session === session ? prev : feeds.own
    const others = feeds.others
    const account = piAccount(home, provider, ctx.model?.provider) ?? soleAccount(others, provider)
    const event = {
      session, provider, ...(account ? { account } : {}), cwd: ctx.cwd, now, prompted: happened.prompted ?? false, spent: happened.spent ?? 0,
      ...(happened.cached ? { cached: happened.cached } : {}),
      ...(happened.tokens ? { tokens: happened.tokens, ...(ctx.model?.id ? { model: ctx.model.id } : {}) } : {}),
      context: ctx.getContextUsage() ?? null,
      ...(process.env.HC_TERMINAL_ID ? { terminal: process.env.HC_TERMINAL_ID } : {}),
    }
    const capPath = join(home, capacityFile(provider))
    const known = capacitiesIn(capPath)
    const seen = nextFeed(before, event, others, known)
    const learned = learn(known, { ...seen.snapshot, spend: seen.snapshot.spend ?? [], ...(happened.limit ? { limitAt: now } : {}) }, now)
    const changed = JSON.stringify(learned) !== JSON.stringify(known)
    if (changed) writeAtomically(capPath, JSON.stringify(learned))
    const feed = changed ? nextFeed(before, event, others, learned) : seen
    // The events after the feed is worked out from the log, so none is counted twice
    appendLog(home, 'pi', { provider, ...(account ? { account } : {}), session, host: 'pi', cwd: ctx.cwd }, eventsOf(piMetered(event)), now)
    writeFeed(path, feed)
    pruneLog(home, now)
    prev = feed
    draw(ctx, feed, now)
    announce(ctx, feed, now)
  }

  const safely = (ctx: Ctx, happened?: Happened) => {
    try {
      update(ctx, happened)
    } catch {
      // A feed not written this time is written on the next event
    }
  }

  /** Opens `lines` over pi, drawn again for its width; q or Escape closes it */
  function overlay(ctx: Ctx, lines: (width: number) => Line[]): void {
    void ctx.ui.custom((_tui, _theme, _keys, done) => ({
      render: width => lines(width).map(toAnsi),
      handleInput: data => { if (data === 'q' || data === '\x1b') done(undefined) },
      invalidate: () => {},
    }), { overlay: true })
  }

  /** `/pace <args>`, carried out and answered in a notification */
  function command(args: string, ctx: Ctx): void {
    carry(route(commandOf(args), piHost()), ctx)
  }

  /** Carries out what /pace decided; a view Herdr could not open falls back to pi's own */
  function carry(action: PaceAction, ctx: Ctx): void {
    const home = homedir()
    const say = (text: string) => ctx.ui.notify(text, 'info')
    switch (action.kind) {
      case 'say': return say(action.text)
      case 'prefs': {
        writeAtomically(join(home, PREFS_FILE), JSON.stringify({ ...prefsIn(join(home, PREFS_FILE)), ...action.prefs }))
        safely(ctx)
        if (prev) draw(ctx, prev, Date.now())
        return say(action.text)
      }
      case 'refresh':
        safely(ctx)
        return say(action.text)
      case 'auto':
        setAuto(ctx, { plan: action.plan, turns: 1, max: action.max })
        send(ctx, startPrompt(action.plan))
        return say(`Auto mode on: ${action.plan}`)
      case 'resume': {
        const auto = prev?.snapshot.auto
        if (!auto) return say(NOT_RUNNING)
        setAuto(ctx, resumed(auto))
        send(ctx, continuePrompt(auto.plan, snapshotOf(prev!.snapshot, Date.now())))
        return say(`Auto mode resumed: ${auto.plan}`)
      }
      case 'stop':
        setAuto(ctx, null)
        return say(action.text)
      case 'burst': {
        const auto = prev?.snapshot.auto
        if (!auto) return say(NOT_RUNNING)
        const { burst: _, ...rest } = auto
        setAuto(ctx, action.on ? { ...rest, burst: true } : rest)
        if (action.on && (auto.why ?? '').startsWith('Pacing')) endHold()
        return say(action.on
          ? 'Burst on: auto mode no longer holds for pacing, only for a quota gassed out. /pace auto burst off brings the holds back'
          : 'Burst off: auto mode holds again while the rate would gas a quota out')
      }
      case 'ultra': {
        const ladder = piLadder(ctx)
        if (!ladder || !ctx.model?.id) return say('Ultra pace needs a model pace can see the ladder of')
        const gears = startGears(ladder, ctx.model.id, pi.getThinkingLevel(), action.floor, action.ceiling)
        setAuto(ctx, { plan: action.plan, turns: 1, max: action.max, gears })
        send(ctx, startPrompt(action.plan))
        return say(`Ultra pace on: ${action.plan}, from ${gears.floor} to ${gears.ceiling}`)
      }
      case 'close': case 'preview': return say('Not in pi')
      case 'open': {
        if (action.surface === 'herdr') {
          const r = openInHerdr(action.view === 'pane' ? '' : action.view, prev?.provider ?? 'codex', 'pi', prev?.account)
          if (!r.opened && action.fallback) carry(action.fallback, ctx)
          return say(r.text)
        }
        if (action.note) say(action.note)
        if (action.surface === 'split') {
          const feed = prev ? join(home, feedFile('pi', prev.session)) : ''
          const run = action.view === 'plan' ? null : liveOf(action.view, feed)
          const command = !run
            ? `node '${join(ROOT, 'bin/plan-viewer.ts')}' '${planFeed(home, ctx.cwd, action.files ?? [])}'`
            : ['node', join(ROOT, run.bin), ...run.args].map(p => (p === 'node' ? p : `'${p}'`)).join(' ')
          try {
            execFileSync('tmux', ['split-window', '-h', '-d', '-l', '64', command], { stdio: 'ignore', timeout: 5000 })
            return say(`Pace ${action.view === 'plan' ? 'plan timeline' : 'view'} opened in a tmux split; q there closes it`)
          } catch {
            return say('Could not open a tmux split')
          }
        }
        safely(ctx)
        const now = Date.now()
        if (action.view === 'fleet') overlay(ctx, width => fleetLines(fleetOf(liveIn(home, now), now), now, width))
        else if (action.view === 'plan') overlay(ctx, width => plansOf(action.files ?? []).flatMap((plan, i) => [
          ...(i ? [[] as Line] : []),
          ...planLines(stepsOf(planText(ctx.cwd, plan), false), { plan, auto: prev?.snapshot.auto?.plan === plan ? prev.snapshot.auto : null, cols: width, now: Date.now() }),
        ]))
        else overlay(ctx, width => (prev ? paneLines(prev.snapshot, Date.now(), paneLayout(Math.max(40, width - 4))) : [[{ t: 'pace has no quota to pace on this sign-in', dim: true }]]))
      }
    }
  }

  /** The plans a timeline shows: those named, else auto mode's, else the roadmap */
  const plansOf = (files: readonly string[]) => (files.length ? [...files] : [prev?.snapshot.auto?.plan ?? DEFAULT_PLAN])

  /** The plan feed bin/plan-viewer.ts reads: the plans shown, and auto mode's run on each; written, its path returned */
  function planFeed(home: string, cwd: string, files: readonly string[]): string {
    const [plan, also] = plansOf(files)
    const auto = prev?.snapshot.auto ?? null
    const entry = (p: string) => ({ plan: p, path: join(cwd, p), auto: auto?.plan === p ? auto : null })
    const path = join(home, `.local/state/pace/pi/${(prev?.session ?? 'pi').replace(/[^A-Za-z0-9_-]/g, '_')}.plan.json`)
    writeAtomically(path, JSON.stringify({ ...entry(plan!), at: Date.now(), ...(also ? { also: entry(also) } : {}) }))
    return path
  }

  pi.registerCommand('pace', {
    description: `Rate-limit pace and the prompting rate, charted: ${USAGE}`,
    handler: (args, ctx) => command(args ?? '', ctx),
  })

  /** The last reply's text and whether it was interrupted: how auto mode's run ended */
  let answer = ''
  let aborted = false
  let holdTimer: ReturnType<typeof setTimeout> | null = null

  /** The session's feed with auto mode's run set, or ended with null; written, and drawn */
  function setAuto(ctx: Ctx, auto: PaceAuto | null): void {
    if (!auto && holdTimer) clearTimeout(holdTimer)
    if (!prev) update(ctx)
    if (!prev) return
    const { auto: _, ...rest } = prev.snapshot
    prev = { ...prev, snapshot: auto ? { ...rest, auto } : rest }
    writeFeed(join(homedir(), feedFile('pi', prev.session)), prev)
    draw(ctx, prev, Date.now())
  }

  /** A prompt for pi: now when it is idle, after the run under way otherwise */
  const send = (ctx: Ctx, text: string) => pi.sendUserMessage(text, ctx.isIdle && !ctx.isIdle() ? { deliverAs: 'followUp' } : undefined)

  /** pi's ladder on the session's sign-in: the models it offers on its provider, and its thinking levels (core/gears.ts) */
  function piLadder(ctx: Ctx): Ladder | null {
    const provider = ctx.model ? providerOf(ctx.model.provider, ctx.modelRegistry.isUsingOAuth(ctx.model)) : null
    if (!provider || !ctx.model) return null
    const models = (ctx.modelRegistry.getAvailable?.() ?? []).filter(m => m.provider === ctx.model!.provider).map(m => m.id)
    return ladderFor(provider, models, PI_THINKING)
  }

  /** Ultra pace's next gear, carried out: the thinking level at once, the model once the cache is cold */
  function shift(ctx: Ctx, g: PaceGears, snap: ReturnType<typeof snapshotOf>, now: number): PaceGears {
    const ladder = piLadder(ctx)
    if (!ladder) return g
    const { gears, set } = shiftGears(g, headroomOf(snap, ctx.model?.id), ladder, coldAt(snap, now))
    if (set.effort) pi.setThinkingLevel(set.effort)
    const model = set.model && ctx.model ? ctx.modelRegistry.find?.(ctx.model.provider, set.model) : undefined
    if (model) void pi.setModel?.(model)
    return gears
  }

  /** Auto mode after a run, or after a hold with no run to judge: core/auto.ts decides, pi carries it out */
  function runAuto(ctx: Ctx, said: string, interrupted: boolean): void {
    const was = prev?.snapshot.auto
    if (!prev || !was || was.paused || was.heldUntil != null || was.waitingUntil != null) return
    const now = Date.now()
    // Ultra pace's gear shifts at every turn's end, whatever auto mode decides next
    const auto = was.gears ? { ...was, gears: shift(ctx, was.gears, snapshotOf(prev.snapshot, now), now) } : was
    const d = decide({ auto, snap: snapshotOf(prev.snapshot, now), answer: said, aborted: interrupted })
    const step = stepOf(d, piHost(), now)
    if (step.kind === 'send') {
      setAuto(ctx, { ...auto, turns: auto.turns + 1, ...('stalls' in d ? { stalls: d.stalls } : {}) })
      if (step.compact) ctx.compact()
      return send(ctx, step.prompt)
    }
    if (step.kind === 'hold') {
      const waiting = d.kind === 'wait'
      setAuto(ctx, { ...auto, ...(waiting ? { waitingUntil: step.until } : { heldUntil: step.until }), why: 'why' in d ? d.why : '' })
      if (holdTimer) clearTimeout(holdTimer)
      holdTimer = setTimeout(endHold, Math.max(0, step.until - now))
      holdTimer.unref?.()
      return ctx.ui.notify(`pace: ${step.note}`, 'warning')
    }
    if (step.kind === 'pause') setAuto(ctx, { ...auto, paused: true, why: step.message })
    else setAuto(ctx, null)
    ctx.ui.notify(`pace: ${step.message}`, 'info')
  }

  /** A hold or a wait is over: fresh figures, then decide again, with no run to judge */
  function endHold(): void {
    if (holdTimer) clearTimeout(holdTimer)
    holdTimer = null
    const auto = prev?.snapshot.auto
    if (!last || !auto || auto.paused) return
    const { heldUntil: _h, waitingUntil: _w, why: _y, ...running } = auto
    setAuto(last, running)
    safely(last)
    runAuto(last, '', false)
  }

  /** On pace mode's thinking level holds for one run; the level before it comes back when the run settles */
  let ownLevel: string | null = null
  /** Warm mode's compactions since the last prompt, and the cache (its `at`) it last compacted for */
  let warmActions = 0
  let warmFor: number | null = null

  const compact = (ctx: Ctx, why: string) => {
    ctx.ui.notify(`pace: ${why}`, 'info')
    ctx.compact()
  }

  /** On pace mode after a run: compact a heavy context while its cache is warm, when reading it is cheapest */
  function upkeepAfter(ctx: Ctx): void {
    if (!prev || !prefsIn(join(homedir(), PREFS_FILE)).onPace) return
    if (upkeep(snapshotOf(prev.snapshot, Date.now())) === 'compact') compact(ctx, 'compacting a heavy context while its cache is warm')
  }

  /** Warm mode on pi's clock: compact an idle cache about to lapse */
  function keepWarm(ctx: Ctx): void {
    const cache = prev?.snapshot.cache ?? null
    if (!prev || !cache) return
    const now = Date.now()
    const prefs = prefsIn(join(homedir(), PREFS_FILE))
    const act = warmStep({ prefs, snap: snapshotOf(prev.snapshot, now), cache, now, working: ctx.isIdle ? !ctx.isIdle() : false, actions: warmActions, lastFor: warmFor }, piHost())
    if (!act) return
    warmActions += 1
    warmFor = cache.at
    compact(ctx, 'compacting to keep the cache warm')
  }

  pi.on('before_agent_start', e => {
    if (!prev) return
    if (prefsIn(join(homedir(), PREFS_FILE)).onPace) {
      const level = pi.getThinkingLevel()
      const lower = thinkingFor(level, runsOut(snapshotOf(prev.snapshot, Date.now())))
      if (lower !== level) {
        ownLevel = level
        pi.setThinkingLevel(lower)
      }
    }
    // Auto mode's instructions, a section of the system prompt while it runs: fixed text, so the cache keeps it
    const auto = prev.snapshot.auto
    if (auto && !auto.paused && typeof e?.systemPrompt === 'string') return { systemPrompt: `${e.systemPrompt}\n\n${protocol()}` }
  })

  pi.on('session_start', (_e, ctx) => {
    prev = null
    safely(ctx)
    if (timer) clearInterval(timer)
    timer = setInterval(() => {
      if (!last) return
      safely(last)
      try { keepWarm(last) } catch {}
    }, TICK_MS)
    timer.unref?.()
  })
  pi.on('input', (e, ctx) => {
    if (e?.source !== 'extension') warmActions = 0
    safely(ctx, { prompted: e?.source !== 'extension' })
  })
  pi.on('message_end', (e, ctx) => {
    const m = e?.message
    if (m?.role !== 'assistant') return
    answer = Array.isArray(m.content) ? m.content.filter((c: any) => c?.type === 'text').map((c: any) => String(c.text)).join('\n') : ''
    aborted = m.stopReason === 'aborted'
    const usd = Number(m.usage?.cost?.total)
    const n = (x: unknown) => (Number.isFinite(Number(x)) ? Number(x) : 0)
    // The prompt's tokens, when the reply read or wrote the cache: what the cache holds now
    const touched = n(m.usage?.cacheRead) + n(m.usage?.cacheWrite)
    // The reply's tokens as pi reports them; its output counts the reasoning, which pi does not say apart
    const tokens = { input: n(m.usage?.input), output: n(m.usage?.output), cacheRead: n(m.usage?.cacheRead), cacheWrite: n(m.usage?.cacheWrite), reasoning: 0 }
    safely(ctx, {
      spent: Number.isFinite(usd) && usd > 0 ? usd : 0, limit: m.stopReason === 'error' && isLimit(m.errorMessage),
      ...(touched > 0 ? { cached: n(m.usage?.input) + touched } : {}),
      ...(tokens.input || tokens.output || tokens.cacheRead || tokens.cacheWrite ? { tokens } : {}),
    })
  })
  pi.on('model_select', (_e, ctx) => safely(ctx))
  pi.on('agent_settled', (_e, ctx) => {
    if (ownLevel != null) pi.setThinkingLevel(ownLevel)
    ownLevel = null
    safely(ctx)
    try {
      if (prev?.snapshot.auto) runAuto(ctx, answer, aborted)
      else upkeepAfter(ctx)
    } catch {}
  })
  pi.on('session_shutdown', (_e, ctx) => {
    if (timer) clearInterval(timer)
    if (holdTimer) clearTimeout(holdTimer)
    holdTimer = null
    timer = null
    last = null
    clear(ctx)
  })
}
