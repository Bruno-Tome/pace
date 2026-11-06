// The log on disk for the Node hosts (.agents/decisions/0024-append-only-log.md): a session's events appended to its
// day's file, the log read on from where a reader left it, feeds written slim and read back hydrated, and what is
// past keeping deleted by whole files. The rules are core/log.ts's.

import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'

import { FEED_STALE, FEEDS_DIR, feedOf, type PaceFeed, type PaceHost } from '../core/host.ts'
import { Activity, activityOf } from '../core/activity.ts'
import { repoOfGitDir } from '../core/dims.ts'
import { checkpointDays, checkpointFrom, checkpointOf, expiredDays, headLine, History, LOG_DIR, logDay, logDays, logFile, logText, parseLog, slim, type Checkpoint, type LogEntry, type LogEvent, type LogHead } from '../core/log.ts'

/** A finished day's checkpoint, in its folder (core/log.ts) */
const CHECKPOINT = 'checkpoint.json'

const DAY = 24 * 3600_000
/** A feed not written for this long is of a session long ended: its history is in the log, or past keeping */
const FEED_KEPT = 8 * DAY

/** The header last written to each file this process appended to */
const written = new Map<string, string>()

/** The header in force at the end of a log already on disk; null when there is none */
function lastHead(path: string): string | null {
  if (!existsSync(path)) return null
  const head = parseLog(readFileSync(path, 'utf8'), null).head
  return head ? headLine(head) : null
}

/** Each folder's repo as git says it, asked once a process (a worktree's is the repo it belongs to) */
const repos = new Map<string, string | null>()

function repoAt(cwd: string): string | null {
  if (!repos.has(cwd)) {
    let repo: string | null = null
    try {
      repo = repoOfGitDir(execFileSync('git', ['-C', cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 }))
    } catch {}
    repos.set(cwd, repo)
  }
  return repos.get(cwd)!
}

/** Lines from before headers named the repo, given it now, as git says it */
const withRepos = (entries: LogEntry[]): LogEntry[] => entries.map(e => (e.cwd && !e.repo && repoAt(e.cwd) ? { ...e, repo: repoAt(e.cwd)! } : e))

/** Appends `events` to the session's log for the day of `now`, its header first where the file needs one */
export function appendLog(home: string, host: PaceHost, head: LogHead, events: readonly LogEvent[], now: number, memo: Map<string, string> = written): void {
  if (!events.length) return
  const repo = head.cwd && !head.repo ? repoAt(head.cwd) : null
  if (repo) head = { ...head, repo }
  const path = join(home, logFile(host, head.session, now))
  const { text, head: after } = logText(head, events, memo.has(path) ? memo.get(path)! : lastHead(path))
  mkdirSync(dirname(path), { recursive: true })
  appendFileSync(path, text)
  memo.set(path, after)
}

/**
 * The log of the days kept, read into a History (core/log.ts) doing no work twice: a finished day from its checkpoint,
 * the open days' files read on from where this reader left each one. A long-lived reader reads only what was added,
 * and the history works out only the quotas it touched
 */
export class LogReader {
  readonly history = new History()
  /** Activity over all of history (core/activity.ts), fed by the same lines */
  private act = new Activity()
  /** The days beyond history's nine read for activity, once each */
  private actDone = new Set<string>()
  private files = new Map<string, { offset: number; head: LogHead | null }>()
  /** The finished days read whole, from their checkpoint or their files */
  private done = new Set<string>()

  read(home: string, now: number): History {
    const yesterday = logDay(now - DAY)
    this.history.forget(now)
    for (const day of logDays(now)) {
      if (this.done.has(day)) continue
      const dir = join(home, LOG_DIR, day)
      if (!existsSync(dir)) continue
      const cp = day < yesterday ? checkpointIn(dir) : null
      if (cp) {
        this.history.setCheckpoint(cp)
        this.activityOfDay(day, dir, cp)
        this.done.add(day)
        continue
      }
      for (const name of readdirSync(dir).filter(n => n.endsWith('.jsonl'))) {
        const entries = this.readOn(join(dir, name))
        this.history.append(entries)
        this.act.append(entries)
      }
      // A day before yesterday is not written again: read once
      if (day < yesterday) this.done.add(day)
    }
    return this.history
  }

  /**
   * Activity over every day there is: the nine days history reads as they are read, every other day once, from its
   * checkpoint, or from its lines where it has none yet
   */
  activity(home: string, now: number): Activity {
    this.read(home, now)
    const root = join(home, LOG_DIR)
    if (!existsSync(root)) return this.act
    const recent = logDays(now)
    for (const day of readdirSync(root).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d) && !recent.includes(d))) {
      if (this.actDone.has(day)) continue
      const dir = join(root, day)
      this.activityOfDay(day, dir, checkpointIn(dir))
      this.actDone.add(day)
    }
    return this.act
  }

  /** A finished day's activity: its checkpoint's, or its lines' while the checkpoint has none */
  private activityOfDay(day: string, dir: string, cp: Checkpoint | null): void {
    if (cp?.activity) this.act.setDay(day, cp.activity)
    else this.act.setDay(day, activityOf(readdirSync(dir).filter(n => n.endsWith('.jsonl')).flatMap(n => parseLog(readFileSync(join(dir, n), 'utf8'), null).entries)))
  }

  /** The lines added to a file since it was last read, up to its last whole line */
  private readOn(path: string): LogEntry[] {
    const f = this.files.get(path) ?? { offset: 0, head: null }
    const size = statSync(path).size
    // A file only grows; one read shorter is being written over, and is read on next time
    if (size <= f.offset) return []
    const buf = Buffer.alloc(size - f.offset)
    const fd = openSync(path, 'r')
    try {
      readSync(fd, buf, 0, buf.length, f.offset)
    } finally {
      closeSync(fd)
    }
    const whole = buf.lastIndexOf(0x0a) + 1
    if (whole === 0) return []
    const read = parseLog(buf.subarray(0, whole).toString('utf8'), f.head)
    this.files.set(path, { offset: f.offset + whole, head: read.head })
    return withRepos(read.entries)
  }
}

/** A day folder's checkpoint; null when there is none, or it does not read */
function checkpointIn(dir: string): Checkpoint | null {
  const path = join(dir, CHECKPOINT)
  return existsSync(path) ? checkpointFrom(readFileSync(path, 'utf8')) : null
}

/** One reader for each home in the process: a host that reads again reads only what was added */
const readers = new Map<string, LogReader>()
const readerOf = (home: string) => readers.get(home) ?? readers.set(home, new LogReader()).get(home)!

/** Each feed file as last parsed, by path: parsed again only once its size or time changed */
const parsed = new Map<string, { size: number; mtimeMs: number; feed: PaceFeed | null }>()

/** A feed file, parsed again only when it changed; the same object while it is the same */
function feedAt(path: string): PaceFeed | null {
  try {
    const { size, mtimeMs } = statSync(path)
    const known = parsed.get(path)
    if (known && known.size === size && known.mtimeMs === mtimeMs) return known.feed
    const feed = feedOf(readFileSync(path, 'utf8'))
    parsed.set(path, { size, mtimeMs, feed })
    return feed
  } catch {
    return null
  }
}

/** One feed, read from anywhere, with its quota's history filled in from the log and the feeds beside it */
export function withHistory(home: string, feed: PaceFeed, now: number, from: LogReader = readerOf(home)): PaceFeed {
  return from.read(home, now).hydrate([feed, ...rawFeeds(home)], now)[0]!
}

/** Every feed in the feeds folder that parses, as written */
function rawFeeds(home: string): PaceFeed[] {
  const dir = join(home, FEEDS_DIR)
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter(n => n.endsWith('.json')).flatMap(n => feedAt(join(dir, n)) ?? [])
}

/** Every feed in the feeds folder that parses, its quota's history filled in from the log */
export function readFeeds(home: string, now: number, from: LogReader = readerOf(home)): PaceFeed[] {
  return from.read(home, now).hydrate(rawFeeds(home), now)
}

/**
 * A session's own feed and the other live ones, each with its quota's history: `own` picks the session's feed out (a
 * host that restarts carries on from it), the others are those written within FEED_STALE
 */
export function sessionFeeds(home: string, now: number, own: (f: PaceFeed) => boolean, from: LogReader = readerOf(home)): { own: PaceFeed | null; others: PaceFeed[] } {
  const all = readFeeds(home, now, from)
  return { own: all.find(own) ?? null, others: all.filter(f => !own(f) && f.at >= now - FEED_STALE) }
}

/** Writes a feed slim to `path`, whole, by a rename so no reader sees it half written */
export function writeFeed(path: string, feed: PaceFeed): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(`${path}.tmp`, JSON.stringify(slim(feed)))
  renameSync(`${path}.tmp`, path)
}

/** Deletes the day folders past keeping, and the feeds not written for eight days; at most once a day */
export function pruneLog(home: string, now: number): void {
  const root = join(home, LOG_DIR)
  const marker = join(root, '.pruned')
  if (existsSync(marker) && readFileSync(marker, 'utf8') === logDay(now)) return
  if (existsSync(root)) {
    // A finished day folded once, so no reader folds it again; its checkpoint kept for good (ADR 0025)
    for (const day of checkpointDays(readdirSync(root), now)) {
      const dir = join(root, day)
      const raw = readdirSync(dir).filter(n => n.endsWith('.jsonl'))
      // One from before activity is folded again while its lines are there
      if (raw.length && !checkpointIn(dir)?.activity) {
        const entries = withRepos(raw.flatMap(n => parseLog(readFileSync(join(dir, n), 'utf8'), null).entries))
        writeFileSync(join(dir, `${CHECKPOINT}.tmp`), JSON.stringify(checkpointOf(day, entries)))
        renameSync(join(dir, `${CHECKPOINT}.tmp`), join(dir, CHECKPOINT))
      }
      // Past nine days the checkpoint stands for the day: its raw lines go
      if (expiredDays([day], now).length && checkpointIn(dir)?.activity) for (const n of raw) unlinkSync(join(dir, n))
    }
  }
  const feeds = join(home, FEEDS_DIR)
  if (existsSync(feeds)) {
    for (const name of readdirSync(feeds).filter(n => n.endsWith('.json'))) {
      const path = join(feeds, name)
      if (statSync(path).mtimeMs < now - FEED_KEPT) unlinkSync(path)
    }
  }
  mkdirSync(root, { recursive: true })
  writeFileSync(marker, logDay(now))
}
