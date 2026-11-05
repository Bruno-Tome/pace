// The Codex hook: run by Codex on SessionStart, UserPromptSubmit, PostToolUse, Stop and Interrupt with the event's
// JSON on stdin. Reads the session's rollout on from where it last stopped and writes the session's feed,
// ~/.local/state/pace/feeds/codex-<session>.json, for the band and Herdr's fleet. Run by Node, which strips the
// types: `node adapters/codex/hook.ts`.
//
// It always exits 0: pace never gets in Codex's way. Async hooks can overlap, so a lock keeps one writer at a time.
// What it says goes on stdout as the event's JSON: a warning as `systemMessage`, once per window.
//
// A prompt that is `/pace` or `$pace` (the pace skill by name; the custom prompt sends `/pace <args>`) is pace's
// (core/api.ts routes it for Codex as a host): its answer blocks the prompt, so the model never gets it, except auto mode's start and
// resume, which go on to Codex with auto mode's instructions. At a turn's end (Stop, run synchronously) auto mode
// decides (core/auto.ts): the next prompt keeps Codex going, a short hold is waited out in the hook, a longer one
// pauses the run. In Herdr every view opens there first (.agents/decisions/0001-herdr-first.md).

import { execFileSync } from 'node:child_process'
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import type { PaceAuto } from '../../types'
import { alertsOf } from '../../core/alerts.ts'
import { continuePrompt, decide, protocol, resumed, startPrompt } from '../../core/auto.ts'
import { commandOf } from '../../core/command.ts'
import { FEED_STALE, FEEDS_DIR, feedFile, feedOf, type PaceFeed } from '../../core/host.ts'
import { snapshotOf } from '../../core/model.ts'
import { plainText, plansFor, route, stepOf, viewLines, type Host, type PaceAction, type PaceView } from '../../core/api.ts'
import { paceArgsOf } from '../../core/command.ts'
import { emailOfJwt } from '../../core/account.ts'
import { accountFor } from '../account.ts'
import { openInHerdr } from './open.ts'
import { hookInputOf, nextFeed, rolloutOf, type HookInput } from './rollout.ts'

/** Where the hook keeps how far into a session's rollout it has read, relative to the home directory */
const cursorFile = (session: string) => `.local/state/pace/codex/${session.replace(/[^A-Za-z0-9_-]/g, '_')}.json`

/** Where the hook keeps the warnings already said, shared by Codex's sessions, relative to the home directory */
const ALERTED_FILE = '.local/state/pace/codex/alerted.json'
/** How long the Stop hook may wait out a hold: under the 600 seconds Codex gives a hook by default */
const HOOK_BUDGET_MS = 9 * 60_000
/** Columns a view drawn into an answer takes */
const TEXT_COLS = 90

const root = join(import.meta.dirname, '../..')

/** What a hook says back to Codex, as the event's JSON */
type Output = { decision?: 'block'; reason?: string; systemMessage?: string; hookSpecificOutput?: { hookEventName: string; additionalContext: string } }

/** How long to wait for another hook's lock, and when a lock left behind counts as abandoned */
const LOCK_WAIT_MS = 2000
const LOCK_STALE_MS = 10_000

type Cursor = { path: string; offset: number }

function cursorOf(path: string): Cursor | null {
  try {
    const c = JSON.parse(readFileSync(path, 'utf8')) as Partial<Cursor>
    return typeof c.path === 'string' && typeof c.offset === 'number' ? { path: c.path, offset: c.offset } : null
  } catch {
    return null
  }
}

/** The rollout's whole lines from `offset` on, and the offset after the last of them; a torn last line waits */
function readFrom(path: string, offset: number): { text: string; offset: number } {
  const size = statSync(path).size
  const from = size < offset ? 0 : offset
  const fd = openSync(path, 'r')
  try {
    const bytes = Buffer.alloc(size - from)
    readSync(fd, bytes, 0, bytes.length, from)
    const end = bytes.lastIndexOf(0x0a) + 1
    return { text: bytes.subarray(0, end).toString('utf8'), offset: from + end }
  } finally {
    closeSync(fd)
  }
}

function writeAtomically(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(`${path}.tmp`, text)
  renameSync(`${path}.tmp`, path)
}

/** Runs `body` holding the session's lock; gives up on a lock it cannot get, rather than hold Codex up */
function withLock(path: string, body: () => void): void {
  mkdirSync(dirname(path), { recursive: true })
  const until = Date.now() + LOCK_WAIT_MS
  for (;;) {
    try {
      closeSync(openSync(path, 'wx'))
      break
    } catch {
      if (existsSync(path) && Date.now() - statSync(path).mtimeMs > LOCK_STALE_MS) rmSync(path, { force: true })
      else if (Date.now() > until) return
      else Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20)
    }
  }
  try {
    body()
  } finally {
    rmSync(path, { force: true })
  }
}

/** The email Codex is signed in with: its id token's claim; null signed out or on an API key */
function codexEmail(home: string): string | null {
  const auth = readJson(join(home, '.codex/auth.json')) as { tokens?: { id_token?: unknown } } | null
  return typeof auth?.tokens?.id_token === 'string' ? emailOfJwt(auth.tokens.id_token) : null
}

/** The other live feeds, whose history on Codex's quota this session's feed carries too: Codex's, and pi's signed in with ChatGPT */
function siblingsOf(home: string, session: string, now: number): PaceFeed[] {
  const dir = join(home, FEEDS_DIR)
  if (!existsSync(dir)) return []
  const own = feedFile('codex', session).split('/').pop()
  return readdirSync(dir)
    .filter(name => name.endsWith('.json') && name !== own)
    .flatMap(name => {
      try {
        const feed = feedOf(readFileSync(join(dir, name), 'utf8'))
        return feed && feed.at >= now - FEED_STALE ? [feed] : []
      } catch {
        return []
      }
    })
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

/** The session's feed after the event; written, and returned */
function update(home: string, input: HookInput): PaceFeed {
  const feedPath = join(home, feedFile('codex', input.session))
  const cursorPath = join(home, cursorFile(input.session))
  const last = cursorOf(cursorPath)
  const start = last && last.path === input.transcript ? last.offset : 0
  const read = input.transcript && existsSync(input.transcript) ? readFrom(input.transcript, start) : { text: '', offset: start }
  const prev = existsSync(feedPath) ? feedOf(readFileSync(feedPath, 'utf8')) : null
  const now = Date.now()
  const feed = nextFeed(prev, input, rolloutOf(read.text), now, process.env.HC_TERMINAL_ID || undefined, siblingsOf(home, input.session, now), accountFor(home, 'codex', codexEmail(home)))
  writeAtomically(feedPath, JSON.stringify(feed))
  if (input.transcript) writeAtomically(cursorPath, JSON.stringify({ path: input.transcript, offset: read.offset }))
  return feed
}

/** The feed with auto mode's run set, or ended with null; written */
function withAuto(home: string, feed: PaceFeed, auto: PaceAuto | null): PaceFeed {
  const { auto: _, ...rest } = feed.snapshot
  const next = { ...feed, snapshot: auto ? { ...rest, auto } : rest }
  writeAtomically(join(home, feedFile('codex', feed.session)), JSON.stringify(next))
  return next
}

/** A plan's text, as named from the session's folder; empty when it cannot be read */
function planText(cwd: string, plan: string): string {
  try {
    return readFileSync(join(cwd, plan), 'utf8')
  } catch {
    return ''
  }
}

/** A view drawn as text, for an answer */
function viewText(home: string, feed: PaceFeed, view: PaceView, files: readonly string[] = []): string {
  const now = Date.now()
  const plans = view === 'plan' ? plansFor(feed, files).map(plan => ({ plan, text: planText(feed.cwd, plan) })) : []
  return plainText(viewLines(view, { feed, others: view === 'fleet' ? siblingsOf(home, feed.session, now) : [], plans, now, cols: TEXT_COLS }))
}

const tmux = (command: string) => execFileSync('tmux', ['split-window', '-h', '-d', '-l', '64', command], { stdio: 'ignore', timeout: 5000 })

/** The command that shows `view` live, in a split or a window */
function liveCommand(home: string, feed: PaceFeed, view: PaceView, files?: readonly string[]): string {
  const feedPath = join(home, feedFile('codex', feed.session))
  if (view !== 'plan') return `node '${join(root, 'bin/band.ts')}' ${view === 'pane' ? '--pane ' : view === 'fleet' ? '--fleet ' : ''}'${feedPath}'`
  // The timeline's sidebar reads a plan feed: the plans shown, and auto mode's run on the first
  const [plan, also] = plansFor(feed, files ?? [])
  const planFeed = join(home, `.local/state/pace/codex/${feed.session.replace(/[^A-Za-z0-9_-]/g, '_')}.plan.json`)
  const entry = (p: string) => ({ plan: p, path: join(feed.cwd, p), auto: feed.snapshot.auto?.plan === p ? feed.snapshot.auto : null })
  writeAtomically(planFeed, JSON.stringify({ ...entry(plan!), at: Date.now(), ...(also ? { also: entry(also) } : {}) }))
  return `node '${join(root, 'bin/plan-viewer.ts')}' '${planFeed}'`
}

/** Codex as pace's host: no pane or band of its own, so a split, a window or the answer; it can only be sent prompts */
function codexHost(): Host {
  const surfaces: Host['surfaces'] = [...(process.env.HC_TERMINAL_ID ? ['herdr' as const] : []), ...(process.env.TMUX ? ['split' as const] : []), 'answer', ...(process.platform === 'darwin' ? ['window' as const] : [])]
  return { name: 'Codex', input: 'prompt', surfaces, drives: ['prompt'], cache: false, holdUpTo: HOOK_BUDGET_MS }
}

/** A view opened on one of Codex's surfaces, or Herdr's with its fallback; what to say back */
function show(home: string, feed: PaceFeed, a: Extract<PaceAction, { kind: 'open' }>): string {
  const note = a.note ? `${a.note}\n\n` : ''
  if (a.surface === 'herdr') {
    const r = openInHerdr(a.view === 'pane' ? '' : a.view, 'codex', 'Codex', feed.account)
    return r.opened || !a.fallback || a.fallback.kind !== 'open' ? r.text : `${r.text}\n\n${show(home, feed, a.fallback)}`
  }
  if (a.surface === 'split') {
    try {
      tmux(liveCommand(home, feed, a.view, a.files))
      return `${note}Pace opened in a tmux split; q there closes it`
    } catch {
      return note + viewText(home, feed, a.view, a.files)
    }
  }
  if (a.surface === 'window') {
    const file = join(home, `.local/state/pace/codex/${feed.session.replace(/[^A-Za-z0-9_-]/g, '_')}.command`)
    writeAtomically(file, `#!/bin/sh\nexec ${liveCommand(home, feed, a.view, a.files)}\n`)
    chmodSync(file, 0o755)
    try {
      execFileSync('open', [file], { stdio: 'ignore', timeout: 5000 })
      return `${note}Pace window opened; q closes it`
    } catch {
      return note + viewText(home, feed, a.view, a.files)
    }
  }
  return note + viewText(home, feed, a.view, a.files)
}

const block = (reason: string): Output => ({ decision: 'block', reason })
const goOn = (context: string): Output => ({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: context } })
const NOT_RUNNING = 'Auto mode is not running: /pace auto <plan file> starts it'

/** `/pace <args>` in Codex, carried out; what to say back */
function command(home: string, feed: PaceFeed, args: string): Output {
  const a = route(commandOf(args), codexHost())
  const auto = feed.snapshot.auto ?? null
  switch (a.kind) {
    case 'say': case 'refresh': case 'prefs': return block(a.text)
    case 'open': return block(show(home, feed, a))
    case 'close': return block('Close the pace split with q there')
    case 'ultra': case 'preview': return block('Ultra pace is not in Codex')
    case 'auto':
      withAuto(home, feed, { plan: a.plan, turns: 1, max: a.max })
      return goOn(`${protocol()}\n\n${startPrompt(a.plan)}`)
    case 'resume': {
      if (!auto) return block(NOT_RUNNING)
      withAuto(home, feed, resumed(auto))
      return goOn(`${protocol()}\n\n${continuePrompt(auto.plan, snapshotOf(feed.snapshot, Date.now()))}`)
    }
    case 'stop':
      withAuto(home, feed, null)
      return block(a.text)
    case 'burst': {
      if (!auto) return block(NOT_RUNNING)
      const { burst: _, ...rest } = auto
      withAuto(home, feed, a.on ? { ...rest, burst: true } : rest)
      return block(a.on
        ? 'Burst on: auto mode no longer holds for pacing, only for a quota gassed out. /pace auto burst off brings the holds back'
        : 'Burst off: auto mode holds again while the rate would gas a quota out')
    }
  }
}

const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, ms))

/** Auto mode at a turn's end: the next prompt, a hold waited out, or the run paused or ended */
function atStop(home: string, input: HookInput, first: PaceFeed): Output {
  const deadline = Date.now() + HOOK_BUDGET_MS
  let feed = first
  let answer = input.answer ?? ''
  for (;;) {
    const auto = feed.snapshot.auto
    if (!auto || auto.paused) return {}
    const now = Date.now()
    const step = stepOf(decide({ auto, snap: snapshotOf(feed.snapshot, now), answer, aborted: false }), { ...codexHost(), holdUpTo: deadline - now }, now)
    if (step.kind === 'send') {
      withAuto(home, feed, { ...auto, turns: auto.turns + 1 })
      return block(step.prompt)
    }
    if (step.kind === 'stop') {
      withAuto(home, feed, null)
      return { systemMessage: step.message }
    }
    if (step.kind === 'pause') {
      withAuto(home, feed, { ...auto, paused: true, why: step.message, ...(step.heldUntil != null ? { heldUntil: step.heldUntil } : {}) })
      return { systemMessage: step.message }
    }
    // A hold waited out here: then decide again on fresh figures, with no turn to judge
    sleep(step.until - now)
    feed = locked(home, input, () => update(home, { ...input, event: 'PostToolUse' })) ?? feed
    answer = ''
  }
}

/** The warnings not yet said in this window, said once across Codex's sessions */
function warnings(home: string, feed: PaceFeed): string | null {
  const path = join(home, ALERTED_FILE)
  const said = readJson(path)
  const seen = new Set<string>(Array.isArray(said) ? said.filter((x): x is string => typeof x === 'string') : [])
  const fresh = alertsOf(snapshotOf(feed.snapshot, Date.now())).filter(a => !seen.has(a.id))
  if (!fresh.length) return null
  for (const a of fresh) seen.add(a.id)
  writeAtomically(path, JSON.stringify([...seen].slice(-200)))
  return fresh.map(a => `pace: ${a.text}`).join('\n')
}

/** Runs `body` holding the session's lock; null when the lock could not be had */
function locked<T>(home: string, input: HookInput, body: () => T): T | null {
  let out: T | null = null
  withLock(join(home, `${cursorFile(input.session)}.lock`), () => { out = body() })
  return out
}

function main(): void {
  const input = hookInputOf(readFileSync(0, 'utf8'))
  if (!input) return
  const home = homedir()
  const feed = locked(home, input, () => update(home, input))
  if (!feed) return
  const args = input.event === 'UserPromptSubmit' ? paceArgsOf(input.prompt ?? '') : null
  let out: Output = {}
  if (args != null) out = command(home, feed, args)
  else if (input.event === 'Stop') out = atStop(home, input, feed)
  else if (input.event === 'Interrupt' && feed.snapshot.auto && !feed.snapshot.auto.paused) {
    withAuto(home, feed, { ...feed.snapshot.auto, paused: true, why: 'You interrupted: /pace auto resume picks the plan back up' })
  }
  const warning = warnings(home, feed)
  if (warning) out = { ...out, systemMessage: out.systemMessage ? `${out.systemMessage}\n${warning}` : warning }
  if (Object.keys(out).length) process.stdout.write(JSON.stringify(out))
}

try {
  main()
} catch {
  // A feed not written this time is written on the next event
}
