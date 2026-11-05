// The Codex hook: run by Codex on SessionStart, UserPromptSubmit, PostToolUse and Stop with the event's JSON on
// stdin. Reads the session's rollout on from where it last stopped and writes the session's feed,
// ~/.local/state/pace/feeds/codex-<session>.json, for the band and Herdr's fleet. Run by Node, which strips the
// types: `node adapters/codex/hook.ts`.
//
// It says nothing on stdout (Codex would add it to the conversation) and always exits 0: pace never gets in
// Codex's way. Async hooks can overlap, so a lock keeps one writer at a time.
//
// The one prompt it answers is pace's own: `/pace`, `$pace` (the pace skill by name), alone or with `band` or
// `fleet` (the custom prompt adapters/codex/pace.md sends one as `/prompts:pace`). In Herdr it opens that view of
// the pace mod beside the session (open.ts); either way it blocks the prompt, so the model never gets it.

import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { FEED_STALE, FEEDS_DIR, feedFile, feedOf, type PaceFeed } from '../../core/host.ts'
import { openInHerdr } from './open.ts'
import { hookInputOf, nextFeed, paceArgOf, rolloutOf, type HookInput } from './rollout.ts'

/** Where the hook keeps how far into a session's rollout it has read, relative to the home directory */
const cursorFile = (session: string) => `.local/state/pace/codex/${session.replace(/[^A-Za-z0-9_-]/g, '_')}.json`

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

/** The other live Codex sessions' feeds, whose history this session's feed carries too */
function siblingsOf(home: string, session: string, now: number): PaceFeed[] {
  const dir = join(home, FEEDS_DIR)
  if (!existsSync(dir)) return []
  const own = feedFile('codex', session).split('/').pop()
  return readdirSync(dir)
    .filter(name => name.startsWith('codex-') && name.endsWith('.json') && name !== own)
    .flatMap(name => {
      try {
        const feed = feedOf(readFileSync(join(dir, name), 'utf8'))
        return feed && feed.at >= now - FEED_STALE ? [feed] : []
      } catch {
        return []
      }
    })
}

function update(home: string, input: HookInput): void {
  const feedPath = join(home, feedFile('codex', input.session))
  const cursorPath = join(home, cursorFile(input.session))
  const last = cursorOf(cursorPath)
  const start = last && last.path === input.transcript ? last.offset : 0
  const read = input.transcript && existsSync(input.transcript) ? readFrom(input.transcript, start) : { text: '', offset: start }
  const prev = existsSync(feedPath) ? feedOf(readFileSync(feedPath, 'utf8')) : null
  const now = Date.now()
  const feed = nextFeed(prev, input, rolloutOf(read.text), now, process.env.HC_TERMINAL_ID || undefined, siblingsOf(home, input.session, now))
  writeAtomically(feedPath, JSON.stringify(feed))
  if (input.transcript) writeAtomically(cursorPath, JSON.stringify({ path: input.transcript, offset: read.offset }))
}

function main(): void {
  const input = hookInputOf(readFileSync(0, 'utf8'))
  if (!input) return
  const home = homedir()
  withLock(join(home, `${cursorFile(input.session)}.lock`), () => update(home, input))
  const arg = input.event === 'UserPromptSubmit' ? paceArgOf(input.prompt ?? '') : null
  if (arg != null) process.stdout.write(JSON.stringify({ decision: 'block', reason: openInHerdr(arg).text }))
}

try {
  main()
} catch {
  // A feed not written this time is written on the next event
}
