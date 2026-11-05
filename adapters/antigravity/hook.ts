// The Antigravity hook: run by Antigravity's language server on PreInvocation and Stop, the event named on its command
// line (`node adapters/antigravity/hook.ts PreInvocation`) and the payload's JSON on stdin. Asks the language server
// that runs it for each model's quota, at most once a minute, keeps the history every Antigravity conversation
// shares, ~/.local/state/pace/antigravity/history.json, and writes the conversation's feed,
// ~/.local/state/pace/feeds/antigravity-<conversation>.json, for the band and Herdr's fleet.
//
// Hooks block Antigravity's agent, so the hook keeps short timeouts, prints one JSON object as Antigravity requires,
// and always exits 0: pace never gets in Antigravity's way. Parallel conversations share the history, so a lock keeps
// one writer at a time.
//
// The one message it answers is pace's own, `/pace`, routed by the core (core/api.ts) for Antigravity as a host: once
// per run, as the message of the turn it ends before the model is called, so never in the conversation. A view opens
// in Herdr first (.agents/decisions/0001-herdr-first.md), else in a Terminal window running bin/band.ts, else as text.
//
// The CLI runs its language server inside `agy`, and gives no hook its CSRF token: started with
// `ANTIGRAVITY_CSRF_TOKEN` set, `agy` takes that one, and its hooks inherit it (.agents/decisions/0020-antigravity-cli.md).

import { execFileSync } from 'node:child_process'
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import type { PaceSample } from '../../types'
import { plainText, route, viewLines, type Host, type PaceAction, type PaceView } from '../../core/api.ts'
import { commandOf } from '../../core/command.ts'
import { FEED_STALE, FEEDS_DIR, feedOf, type PaceFeed } from '../../core/host.ts'
import { openInHerdr } from '../codex/open.ts'
import { bandArgs } from './commands.ts'
import { feedOfHistory, historyOf, hookInputOf, nextHistory, paceArgOf, type History } from './feed.ts'
import { readingNow } from './server.ts'
import { accountFor } from '../account.ts'

/** Where Antigravity's conversations keep their history, its lock, and the script a terminal window runs, relative to the home directory */
const STATE_DIR = '.local/state/pace/antigravity'
const HISTORY_FILE = `${STATE_DIR}/history.json`
const VIEW_SCRIPT = `${STATE_DIR}/view.command`

/** Antigravity's feed file, relative to the home directory */
const feedFile = (session: string) => `${FEEDS_DIR}/antigravity-${session.replace(/[^A-Za-z0-9_-]/g, '_')}.json`

/** The width a view drawn as text takes */
const TEXT_COLS = 90

/** How often the language server is asked for the readings */
const ASK_EVERY_MS = 60_000
/** How long one question to the language server may take: the agent waits for the hook */
const LOCK_WAIT_MS = 2000
const LOCK_STALE_MS = 10_000

const answer = (o: object) => process.stdout.write(JSON.stringify(o))

/** A command's output; '' when it fails or is not there */
function run(cmd: string, args: readonly string[]): string {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    return ''
  }
}

function writeAtomically(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(`${path}.tmp`, text)
  renameSync(`${path}.tmp`, path)
}

/** Runs `body` holding the lock; gives up on a lock it cannot get, rather than hold Antigravity up */
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

const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

/** Antigravity as pace's host: no surface a hook draws in but its answer, a window beside it, Herdr's; pace cannot drive it yet */
function agyHost(): Host {
  const surfaces: Host['surfaces'] = [...(process.env.HC_TERMINAL_ID ? ['herdr' as const] : []), ...(process.platform === 'darwin' ? ['window' as const] : []), 'answer']
  return { name: 'Antigravity', input: 'prompt', surfaces, drives: [], cache: false }
}

/** Opens bin/band.ts in a Terminal window of its own: whether it did */
function openWindow(home: string, view: PaceView, feed: string): boolean {
  const script = join(home, VIEW_SCRIPT)
  const band = join(import.meta.dirname, '../../bin/band.ts')
  writeAtomically(script, ['#!/bin/sh', "printf '\\033]0;Pace\\007'", `exec ${[process.execPath, band, ...bandArgs(view, feed)].map(shellQuote).join(' ')}`, ''].join('\n'))
  chmodSync(script, 0o755)
  try {
    execFileSync('open', ['-a', 'Terminal', script], { stdio: 'ignore', timeout: 5000 })
    return true
  } catch {
    return false
  }
}

/** The live feeds, for the fleet */
function feedsIn(home: string, now: number): PaceFeed[] {
  const dir = join(home, FEEDS_DIR)
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter(n => n.endsWith('.json')).flatMap(n => {
    try {
      const f = feedOf(readFileSync(join(dir, n), 'utf8'))
      return f && f.at >= now - FEED_STALE ? [f] : []
    } catch {
      return []
    }
  })
}

/** Carries out `/pace`'s action for the conversation whose feed is at `path`; what to say back */
function carryOut(home: string, a: PaceAction, path: string): string {
  if (a.kind === 'say' || a.kind === 'refresh' || a.kind === 'prefs') return a.text
  if (a.kind !== 'open') return 'Antigravity cannot do that yet'
  if (a.surface === 'herdr') {
    const own = existsSync(path) ? feedOf(readFileSync(path, 'utf8')) : null
    const r = openInHerdr(a.view === 'pane' ? '' : a.view, 'antigravity', 'Antigravity', own?.account)
    if (r.opened || !a.fallback) return r.text
    return `Could not open pace in Herdr: ${carryOut(home, a.fallback, path)}`
  }
  if (a.surface === 'window' && openWindow(home, a.view, path)) return 'Pace opened in a terminal window; q closes it'
  const now = Date.now()
  const feed = feedOf(readFileSync(path, 'utf8'))
  if (!feed) return 'pace has nothing to show yet'
  return plainText(viewLines(a.view, { feed, others: a.view === 'fleet' ? feedsIn(home, now).filter(f => f.session !== feed.session) : [], plans: [], now, cols: TEXT_COLS }))
}

async function main(): Promise<void> {
  const input = hookInputOf(readFileSync(0, 'utf8'), process.argv[2] ?? '')
  if (!input) return void answer({})
  const home = homedir()
  const now = Date.now()
  const arg = input.event === 'PreInvocation' ? paceArgOf(input.lastInput) : null
  const action = arg != null ? route(commandOf(arg), agyHost()) : null
  const historyPath = join(home, HISTORY_FILE)
  const before: History = existsSync(historyPath) ? historyOf(readFileSync(historyPath, 'utf8')) : historyOf('')
  const fresh = (before.samples.at(-1)?.at ?? -Infinity) >= now - ASK_EVERY_MS && action?.kind !== 'refresh'
  const read = fresh ? null : await readingNow(before.samples, now)
  const account = read ? accountFor(home, 'antigravity', read.email) : undefined
  const feed = join(home, feedFile(input.session))
  let firstOfRun = false
  withLock(`${historyPath}.lock`, () => {
    const h = existsSync(historyPath) ? historyOf(readFileSync(historyPath, 'utf8')) : before
    firstOfRun = !h.runs.includes(`${input.session}:${input.run}`)
    const next = { ...nextHistory(h, input, read?.sample ?? null, now), ...(account ? { account } : {}) }
    writeAtomically(historyPath, JSON.stringify(next))
    writeAtomically(feed, JSON.stringify(feedOfHistory(next, input, now, process.env.HC_TERMINAL_ID || undefined)))
  })
  if (!action) return void answer({})
  if (!firstOfRun) return void answer({ terminationBehavior: 'terminate' })
  answer({ injectSteps: [{ errorMessage: { userMessage: carryOut(home, action, feed) } }], terminationBehavior: 'terminate' })
}

main().catch(() => answer({}))
