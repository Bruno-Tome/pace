// The log on disk for the Node hosts (.agents/decisions/0024-append-only-log.md): a session's events appended to its
// day's file, the log read on from where a reader left it, feeds written slim and read back hydrated, and what is
// past keeping deleted by whole files. The rules are core/log.ts's.

import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { FEED_STALE, FEEDS_DIR, feedOf, type PaceFeed, type PaceHost } from '../core/host.ts'
import { expiredDays, headLine, hydrate, LOG_DIR, logDay, logDays, logFile, logText, parseLog, slim, type LogEntry, type LogEvent, type LogHead } from '../core/log.ts'

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

/** Appends `events` to the session's log for the day of `now`, its header first where the file needs one */
export function appendLog(home: string, host: PaceHost, head: LogHead, events: readonly LogEvent[], now: number, memo: Map<string, string> = written): void {
  if (!events.length) return
  const path = join(home, logFile(host, head.session, now))
  const { text, head: after } = logText(head, events, memo.has(path) ? memo.get(path)! : lastHead(path))
  mkdirSync(dirname(path), { recursive: true })
  appendFileSync(path, text)
  memo.set(path, after)
}

/** The log of the days kept, read on from where this reader left each file: a long-lived reader reads only what was added */
export class LogReader {
  private files = new Map<string, { offset: number; head: LogHead | null; entries: LogEntry[] }>()

  read(home: string, now: number): LogEntry[] {
    const days = logDays(now)
    const seen = new Set<string>()
    for (const day of days) {
      const dir = join(home, LOG_DIR, day)
      if (!existsSync(dir)) continue
      for (const name of readdirSync(dir).filter(n => n.endsWith('.jsonl'))) {
        const path = join(dir, name)
        seen.add(path)
        this.readOn(path)
      }
    }
    for (const path of this.files.keys()) if (!seen.has(path)) this.files.delete(path)
    return [...this.files.values()].flatMap(f => f.entries)
  }

  /** What was added to a file since it was last read, up to its last whole line */
  private readOn(path: string): void {
    let f = this.files.get(path) ?? { offset: 0, head: null, entries: [] }
    const size = statSync(path).size
    // A file only grows; one that shrank was replaced, and is read again from its start
    if (size < f.offset) f = { offset: 0, head: null, entries: [] }
    if (size > f.offset) {
      const buf = Buffer.alloc(size - f.offset)
      const fd = openSync(path, 'r')
      try {
        readSync(fd, buf, 0, buf.length, f.offset)
      } finally {
        closeSync(fd)
      }
      const whole = buf.lastIndexOf(0x0a) + 1
      if (whole > 0) {
        const read = parseLog(buf.subarray(0, whole).toString('utf8'), f.head)
        f = { offset: f.offset + whole, head: read.head, entries: [...f.entries, ...read.entries] }
      }
    }
    this.files.set(path, f)
  }
}

/** One reader for the process: a host that reads again reads only what was added */
const reader = new LogReader()

/** One feed, read from anywhere, with its quota's history filled in from the log and the feeds beside it */
export function withHistory(home: string, feed: PaceFeed, now: number, from: LogReader = reader): PaceFeed {
  return hydrate([feed, ...readFeeds(home, now, from)], from.read(home, now), now)[0]!
}

/** Every feed in the feeds folder that parses, its quota's history filled in from the log */
export function readFeeds(home: string, now: number, from: LogReader = reader): PaceFeed[] {
  const dir = join(home, FEEDS_DIR)
  if (!existsSync(dir)) return []
  const feeds = readdirSync(dir).filter(n => n.endsWith('.json')).flatMap(n => {
    try {
      const f = feedOf(readFileSync(join(dir, n), 'utf8'))
      return f ? [f] : []
    } catch {
      return []
    }
  })
  return hydrate(feeds, from.read(home, now), now)
}

/**
 * A session's own feed and the other live ones, each with its quota's history: `own` picks the session's feed out (a
 * host that restarts carries on from it), the others are those written within FEED_STALE
 */
export function sessionFeeds(home: string, now: number, own: (f: PaceFeed) => boolean, from: LogReader = reader): { own: PaceFeed | null; others: PaceFeed[] } {
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
  if (existsSync(root)) for (const day of expiredDays(readdirSync(root), now)) rmSync(join(root, day), { recursive: true, force: true })
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
