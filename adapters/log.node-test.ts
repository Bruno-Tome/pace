// The log on disk (adapters/log.ts), in a scratch home: appended a line at a time, read on from where it was left,
// pruned by whole day folders, and feeds read back hydrated from it. Run by Node: `node --test adapters/log.node-test.ts`.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from '../testing/node.ts'
import { FEEDS_DIR, feedFile, type PaceFeed } from '../core/host.ts'
import { LOG_DIR, logFile } from '../core/log.ts'
import { appendLog, LogReader, pruneLog, readFeeds, sessionFeeds, writeFeed } from './log.ts'

const NOW = Date.UTC(2026, 10, 6, 12)
const MIN = 60_000
const DAY = 24 * 60 * MIN
const scratch = () => mkdtempSync(join(tmpdir(), 'pace-log-'))
const head = { provider: 'codex' as const, session: 's1' }
const feed = (session: string, over: Partial<PaceFeed> = {}): PaceFeed => ({
  version: 1, host: 'codex', provider: 'codex', session, cwd: '/w', at: NOW - MIN, snapshot: { samples: [], prompts: [], cache: null }, ...over,
})

describe('appending to a session\'s log', () => {
  test('adds a line an event to the day\'s file, the header once', () => {
    const home = scratch()
    appendLog(home, 'codex', head, [{ at: NOW, prompt: true }], NOW)
    appendLog(home, 'codex', head, [{ at: NOW + MIN, usd: 1 }], NOW + MIN)
    const lines = readFileSync(join(home, logFile('codex', 's1', NOW)), 'utf8').trim().split('\n')
    expect(lines.length).toBe(3)
  })

  test('a process that starts again goes on under the header already there', () => {
    const home = scratch()
    appendLog(home, 'codex', head, [{ at: NOW, prompt: true }], NOW)
    // A new process: nothing remembered of the file
    appendLog(home, 'codex', head, [{ at: NOW + MIN, prompt: true }], NOW + MIN, new Map())
    expect(readFileSync(join(home, logFile('codex', 's1', NOW)), 'utf8').trim().split('\n').length).toBe(3)
  })

  test('appends nothing for no events', () => {
    const home = scratch()
    appendLog(home, 'codex', head, [], NOW)
    expect(existsSync(join(home, logFile('codex', 's1', NOW)))).toBe(false)
  })
})

describe('reading the log', () => {
  /** The spend a reader's history gives a feed on the quota */
  const spent = (reader: LogReader, home: string, now: number) =>
    (reader.read(home, now).hydrate([feed('s1')], now)[0]!.snapshot.spend ?? []).reduce((n, s) => n + s.usd, 0)

  test('reads on from where it was left: the lines added since, each once', () => {
    const home = scratch()
    const reader = new LogReader()
    appendLog(home, 'codex', head, [{ at: NOW, usd: 1 }], NOW)
    expect(spent(reader, home, NOW)).toBe(1)
    appendLog(home, 'codex', head, [{ at: NOW + MIN, usd: 2 }], NOW + MIN)
    expect(spent(reader, home, NOW + MIN)).toBe(3)
  })

  test('leaves a line cut short for the next read', () => {
    const home = scratch()
    const reader = new LogReader()
    appendLog(home, 'codex', head, [{ at: NOW, usd: 1 }], NOW)
    const path = join(home, logFile('codex', 's1', NOW))
    writeFileSync(path, `${readFileSync(path, 'utf8')}{"at":${NOW + MIN},"us`)
    expect(spent(reader, home, NOW)).toBe(1)
    writeFileSync(path, `${readFileSync(path, 'utf8')}d":2}\n`)
    expect(spent(reader, home, NOW + MIN)).toBe(3)
  })

  test('reads the days kept, not older ones', () => {
    const home = scratch()
    appendLog(home, 'codex', head, [{ at: NOW - 20 * DAY, usd: 1 }], NOW - 20 * DAY)
    appendLog(home, 'codex', head, [{ at: NOW - 2 * DAY, usd: 2 }], NOW - 2 * DAY)
    expect(spent(new LogReader(), home, NOW)).toBe(2)
  })

  test('a finished day is folded once into its checkpoint, and read from it after', () => {
    const home = scratch()
    appendLog(home, 'codex', head, [{ at: NOW - 3 * DAY, usd: 2 }], NOW - 3 * DAY)
    pruneLog(home, NOW)
    const dir = join(home, LOG_DIR, '2026-11-03')
    expect(existsSync(join(dir, 'checkpoint.json'))).toBe(true)
    // The day's lines no longer read: the checkpoint stands for them
    writeFileSync(join(dir, 'codex-s1.jsonl'), '')
    expect(spent(new LogReader(), home, NOW)).toBe(2)
  })

  test('yesterday gets no checkpoint yet: a late line can still land there', () => {
    const home = scratch()
    appendLog(home, 'codex', head, [{ at: NOW - DAY, usd: 2 }], NOW - DAY)
    pruneLog(home, NOW)
    expect(existsSync(join(home, LOG_DIR, '2026-11-05', 'checkpoint.json'))).toBe(false)
  })
})

describe('feeds read back', () => {
  test('are hydrated from the log, and written slim', () => {
    const home = scratch()
    writeFeed(join(home, feedFile('codex', 's1')), feed('s1', { snapshot: { samples: [], prompts: [NOW - MIN], cache: null, spend: [{ t: NOW - MIN, id: 's1', usd: 9 }] } }))
    const written = JSON.parse(readFileSync(join(home, feedFile('codex', 's1')), 'utf8'))
    expect(written.snapshot.prompts).toEqual([])
    expect(written.snapshot.spend).toBe(undefined)
    appendLog(home, 'codex', head, [{ at: NOW - MIN, prompt: true }, { at: NOW - MIN, usd: 1 }], NOW)
    const [f] = readFeeds(home, NOW)
    expect(f!.snapshot.prompts).toEqual([NOW - MIN])
    expect(f!.snapshot.spend!.map(s => s.usd)).toEqual([1])
  })

  test('read again with nothing changed, the same feeds come back: nothing parsed or worked out again', () => {
    const home = scratch()
    writeFeed(join(home, feedFile('codex', 's1')), feed('s1'))
    appendLog(home, 'codex', head, [{ at: NOW - MIN, prompt: true }], NOW)
    const reader = new LogReader()
    const [a] = readFeeds(home, NOW, reader)
    const [b] = readFeeds(home, NOW + 1000, reader)
    expect(b).toBe(a)
  })
})

describe('a session\'s feeds', () => {
  test('its own, hydrated, so a host that restarts carries on from its history; and the other live ones', () => {
    const home = scratch()
    writeFeed(join(home, feedFile('codex', 's1')), feed('s1'))
    writeFeed(join(home, feedFile('codex', 's2')), feed('s2'))
    writeFeed(join(home, feedFile('codex', 'gone')), feed('gone', { at: NOW - 7 * 3600_000 }))
    appendLog(home, 'codex', head, [{ at: NOW - MIN, prompt: true }], NOW)
    const { own, others } = sessionFeeds(home, NOW, f => f.session === 's1')
    expect(own!.snapshot.prompts).toEqual([NOW - MIN])
    expect(others.map(f => f.session)).toEqual(['s2'])
  })
})

describe('pruning', () => {
  test('deletes the day folders past keeping and the feeds of sessions long ended, once a day', () => {
    const home = scratch()
    appendLog(home, 'codex', head, [{ at: NOW - 20 * DAY, usd: 1 }], NOW - 20 * DAY)
    appendLog(home, 'codex', head, [{ at: NOW, usd: 1 }], NOW)
    writeFeed(join(home, feedFile('codex', 'old')), feed('old'))
    writeFeed(join(home, feedFile('codex', 'new')), feed('new'))
    const old = join(home, feedFile('codex', 'old'))
    utimesSync(old, (NOW - 20 * DAY) / 1000, (NOW - 20 * DAY) / 1000)
    pruneLog(home, NOW)
    expect(existsSync(join(home, LOG_DIR, '2026-10-17'))).toBe(false)
    expect(existsSync(join(home, logFile('codex', 's1', NOW)))).toBe(true)
    expect(existsSync(old)).toBe(false)
    expect(existsSync(join(home, feedFile('codex', 'new')))).toBe(true)
    // Once a day: a folder past keeping made later the same day stays until tomorrow
    mkdirSync(join(home, LOG_DIR, '2026-10-01'), { recursive: true })
    pruneLog(home, NOW + MIN)
    expect(existsSync(join(home, LOG_DIR, '2026-10-01'))).toBe(true)
    expect(existsSync(join(home, FEEDS_DIR))).toBe(true)
  })
})
