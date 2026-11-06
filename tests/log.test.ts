import { describe, expect, test } from 'claude-code/testing'

import type { PaceFeed } from '../core/host.ts'
import { checkpointDays, checkpointFrom, checkpointOf, entriesOf, eventsOf, expiredDays, History, hydrate, logDays, logFile, logText, parseLog, slim, type LogHead } from '../core/log.ts'
import type { Metered } from '../core/meter.ts'

const NOW = Date.UTC(2026, 10, 6, 12)
const MIN = 60_000
const H = 60 * MIN
const DAY = 24 * H

const reading = (at: number, percent: number) => ({ at, quotas: { five_hour: { percent, resetsAt: NOW + 2 * H } } })
const head = (session: string, account?: string): LogHead => ({ provider: 'codex', session, ...(account ? { account } : {}) })
const feed = (session: string, over: Partial<PaceFeed> = {}): PaceFeed => ({
  version: 1, host: 'codex', provider: 'codex', session, cwd: '/w', at: NOW - MIN,
  snapshot: { samples: [], prompts: [], cache: null }, ...over,
})
/** A session's log as written: its header, then its events */
const logOf = (h: LogHead, events: Parameters<typeof logText>[1]) => entriesOf(logText(h, events, null).text)
const total = (f: PaceFeed) => (f.snapshot.spend ?? []).reduce((n, s) => n + s.usd, 0)

describe('a session\'s log', () => {
  test('is a file a day for each session, under the log folder', () => {
    expect(logFile('codex', 'a/b c', NOW)).toBe('.local/state/pace/log/2026-11-06/codex-a_b_c.jsonl')
  })

  test('takes the events a host metered: the prompt, the readings it was told, what the reply cost', () => {
    const e: Metered = { host: 'pi', provider: 'codex', session: 'p1', cwd: '/w', now: NOW, prompted: true, samples: [reading(NOW, 30)], spent: 0.25 }
    expect(eventsOf(e)).toEqual([{ at: NOW, prompt: true }, { at: NOW, quotas: reading(NOW, 30).quotas }, { at: NOW, usd: 0.25 }])
  })

  test('never logs an estimate, nor a reply that cost nothing', () => {
    const estimate = { at: NOW, quotas: { five_hour: { percent: 30, resetsAt: NOW + H, estimated: true as const } } }
    expect(eventsOf({ host: 'pi', provider: 'codex', session: 'p1', cwd: '/w', now: NOW, samples: [estimate], spent: 0 })).toEqual([])
  })

  test('writes its header once, then a line an event, and again only when the quota changes', () => {
    const first = logText(head('s1'), [{ at: NOW, prompt: true }], null)
    expect(first.text.split('\n').filter(Boolean).length).toBe(2)
    const again = logText(head('s1'), [{ at: NOW + MIN, prompt: true }], first.head)
    expect(again.text.split('\n').filter(Boolean).length).toBe(1)
    const moved = logText(head('s1', 'a2'), [{ at: NOW + 2 * MIN, prompt: true }], again.head)
    expect(moved.text.split('\n').filter(Boolean).length).toBe(2)
    expect(entriesOf(first.text + again.text + moved.text).map(e => e.account ?? null)).toEqual([null, null, 'a2'])
  })

  test('reads back what was written, and drops a line cut short mid-write or that is not an event', () => {
    const { text } = logText(head('s1'), [{ at: NOW, usd: 0.5, model: 'gpt-5' }, { at: NOW, prompt: true, model: 'gpt-5' }], null)
    expect(entriesOf(`${text}{"at":${NOW},"us`)).toEqual([
      { provider: 'codex', session: 's1', event: { at: NOW, usd: 0.5, model: 'gpt-5' } },
      { provider: 'codex', session: 's1', event: { at: NOW, prompt: true, model: 'gpt-5' } },
    ])
    expect(entriesOf(`{"at":1}\n${text}`).length).toBe(2)
    expect(entriesOf('')).toEqual([])
  })

  test('read on from where it was read, under the header in force there', () => {
    const first = logText(head('s1'), [{ at: NOW, prompt: true }], null)
    const read = parseLog(first.text, null)
    const more = logText(head('s1'), [{ at: NOW + MIN, usd: 1 }], first.head)
    expect(parseLog(more.text, read.head).entries).toEqual([{ provider: 'codex', session: 's1', event: { at: NOW + MIN, usd: 1 } }])
  })
})

describe('feeds hydrated from the log', () => {
  test('every feed on a quota gets its whole history, each event counted once', () => {
    const log = [
      ...logOf(head('s1'), [{ at: NOW - 3 * MIN, quotas: reading(NOW - 3 * MIN, 20).quotas }, { at: NOW - 3 * MIN, prompt: true }, { at: NOW - 3 * MIN, usd: 1 }]),
      ...logOf(head('s2'), [{ at: NOW - 2 * MIN, quotas: reading(NOW - 2 * MIN, 25).quotas }, { at: NOW - 2 * MIN, prompt: true }, { at: NOW - 2 * MIN, usd: 2 }]),
    ]
    const [a, b] = hydrate([feed('s1'), feed('s2')], log, NOW)
    for (const f of [a!, b!]) {
      expect(f.snapshot.samples.map(s => s.quotas.five_hour!.percent)).toEqual([20, 25])
      expect(f.snapshot.prompts).toEqual([NOW - 3 * MIN, NOW - 2 * MIN])
      expect(total(f)).toBe(3)
    }
  })

  test('two costs in one minute of one session add up', () => {
    const [f] = hydrate([feed('s1')], logOf(head('s1'), [{ at: NOW - MIN, usd: 1 }, { at: NOW - MIN + 1000, usd: 0.5 }]), NOW)
    expect(total(f!)).toBe(1.5)
  })

  test('another provider\'s and another account\'s history stay their own', () => {
    const log = [
      ...logOf(head('s1', 'a1'), [{ at: NOW - MIN, quotas: reading(NOW - MIN, 20).quotas }]),
      ...logOf(head('s2', 'a2'), [{ at: NOW - MIN, quotas: reading(NOW - MIN, 90).quotas }]),
      ...logOf({ provider: 'claude', session: 'k1' }, [{ at: NOW - MIN, usd: 5 }]),
    ]
    const [f] = hydrate([feed('s1', { account: 'a1' })], log, NOW)
    expect(f!.snapshot.samples.map(s => s.quotas.five_hour!.percent)).toEqual([20])
    expect(total(f!)).toBe(0)
  })

  test('a feed that cannot tell its account borrows no account\'s readings while its provider has two here; prompts still pool', () => {
    const log = [
      ...logOf(head('s1', 'a1'), [{ at: NOW - MIN, quotas: reading(NOW - MIN, 20).quotas }, { at: NOW - MIN, prompt: true }]),
      ...logOf(head('s2', 'a2'), [{ at: NOW - 2 * MIN, quotas: reading(NOW - 2 * MIN, 90).quotas }]),
      ...logOf(head('s3'), [{ at: NOW - 3 * MIN, quotas: reading(NOW - 3 * MIN, 50).quotas }]),
    ]
    const feeds = [feed('s1', { account: 'a1' }), feed('s2', { account: 'a2' }), feed('s3')]
    const [, , none] = hydrate(feeds, log, NOW)
    expect(none!.snapshot.samples.map(s => s.quotas.five_hour!.percent)).toEqual([50])
    expect(none!.snapshot.prompts).toEqual([NOW - MIN])
    // With one account here, it is that account's
    const [, sole] = hydrate([feed('s1', { account: 'a1' }), feed('s3')], log, NOW)
    expect(sole!.snapshot.samples.map(s => s.quotas.five_hour!.percent)).toEqual([50, 20])
  })

  test('an older feed\'s own history still counts, for every feed on its quota', () => {
    const old = feed('s0', { at: NOW - 2 * H, snapshot: { samples: [reading(NOW - 2 * H, 10)], prompts: [NOW - 2 * H], cache: null, spend: [{ t: NOW - 2 * H, id: 's0', usd: 4, h: true }] } })
    const [, f] = hydrate([old, feed('s1')], logOf(head('s1'), [{ at: NOW - MIN, usd: 1 }]), NOW)
    expect(f!.snapshot.samples.map(s => s.quotas.five_hour!.percent)).toEqual([10])
    expect(f!.snapshot.prompts).toEqual([NOW - 2 * H])
    expect(total(f!)).toBe(5)
  })

  test('prompts by model come back for the model they went to', () => {
    const [f] = hydrate([feed('s1')], logOf(head('s1'), [{ at: NOW - MIN, prompt: true, model: 'opus' }]), NOW)
    expect(f!.snapshot.modelPrompts).toEqual({ opus: [NOW - MIN] })
  })

  test('a feed keeps its live state: context, cache, auto mode', () => {
    const live = feed('s1', { context: { tokens: 10, window: 100 }, snapshot: { samples: [], prompts: [], cache: { at: NOW, tokens: 5, window: 100, ttl: '5m' }, auto: null } })
    const [f] = hydrate([live], [], NOW)
    expect(f!.context).toEqual({ tokens: 10, window: 100 })
    expect(f!.snapshot.cache).toEqual(live.snapshot.cache)
  })
})

describe('a slim feed', () => {
  test('is written with its history left to the log, and its live state kept', () => {
    const fat = feed('s1', { context: { tokens: 1, window: 2 }, snapshot: { samples: [reading(NOW, 1)], prompts: [NOW], modelPrompts: { opus: [NOW] }, cache: null, spend: [{ t: NOW, id: 's1', usd: 1 }], onPace: true } })
    const s = slim(fat)
    expect(s.snapshot).toEqual({ samples: [], prompts: [], cache: null, onPace: true })
    expect(s.context).toEqual({ tokens: 1, window: 2 })
  })
})

describe('the days the log keeps', () => {
  test('reads the last nine days, today\'s too', () => {
    const days = logDays(NOW)
    expect(days.length).toBe(9)
    expect(days.at(-1)).toBe('2026-11-06')
    expect(days[0]).toBe('2026-10-29')
  })

  test('deletes only the day folders older than that', () => {
    expect(expiredDays(['2026-10-28', '2026-10-29', '2026-11-06', 'junk'], NOW + 0 * DAY)).toEqual(['2026-10-28'])
  })
})

describe('checkpoints: a finished day folded once', () => {
  const D = Date.UTC(2026, 10, 3, 12)
  const day = [
    ...logOf(head('s1'), [{ at: D, quotas: reading(D, 20).quotas }, { at: D, prompt: true, model: 'gpt-5' }, { at: D, usd: 1 }, { at: D + MIN, usd: 2 }]),
    ...logOf(head('s2', 'a1'), [{ at: D + H, quotas: reading(D + H, 30).quotas }, { at: D + H, usd: 4 }]),
  ]

  test('a feed hydrated from a day\'s checkpoint is hydrated as from the day\'s events', () => {
    const fromCheckpoint = new History()
    fromCheckpoint.setCheckpoint(checkpointOf('2026-11-03', day))
    const [a] = fromCheckpoint.hydrate([feed('s9', { account: 'a1' })], NOW)
    const [b] = hydrate([feed('s9', { account: 'a1' })], day, NOW)
    expect(a!.snapshot.samples).toEqual(b!.snapshot.samples)
    expect(a!.snapshot.prompts).toEqual(b!.snapshot.prompts)
    expect(total(a!)).toBe(7)
    expect(total(b!)).toBe(7)
  })

  test('is written as JSON and read back; anything else reads as none', () => {
    const cp = checkpointOf('2026-11-03', day)
    expect(checkpointFrom(JSON.stringify(cp))).toEqual(cp)
    expect(checkpointFrom('{"version":1')).toBe(null)
    expect(checkpointFrom('{"version":1,"day":"2026-11-03","parts":7}')).toBe(null)
  })

  test('only days before yesterday get one: a late line can still land in yesterday\'s file', () => {
    expect(checkpointDays(['2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06'], NOW)).toEqual(['2026-11-03', '2026-11-04'])
  })
})

describe('history worked out once', () => {
  test('hydrating again with nothing new gives back the same feeds: no work, nothing to draw again', () => {
    const h = new History()
    h.append(logOf(head('s1'), [{ at: NOW - MIN, prompt: true }]))
    const feeds = [feed('s1'), feed('k1', { host: 'claude', provider: 'claude' })]
    const first = h.hydrate(feeds, NOW)
    const again = h.hydrate(feeds, NOW + 1000)
    expect(again[0]).toBe(first[0])
    expect(again[1]).toBe(first[1])
  })

  test('an event on one quota leaves every other quota\'s feeds as they were', () => {
    const h = new History()
    const feeds = [feed('s1'), feed('k1', { host: 'claude', provider: 'claude' })]
    const first = h.hydrate(feeds, NOW)
    h.append(logOf(head('s1'), [{ at: NOW, prompt: true }]))
    const after = h.hydrate(feeds, NOW)
    expect(after[0]!.snapshot.prompts).toEqual([NOW])
    expect(after[1]).toBe(first[1])
  })

  test('forgets the days past keeping', () => {
    const h = new History()
    h.append(logOf(head('s1'), [{ at: NOW - 20 * DAY, usd: 1 }, { at: NOW - MIN, usd: 2 }]))
    h.forget(NOW)
    const [f] = h.hydrate([feed('s1')], NOW)
    expect(total(f!)).toBe(2)
  })
})

describe('tokens in the log', () => {
  const tokens = { input: 1200, output: 340, cacheRead: 50_000, cacheWrite: 800, reasoning: 120 }

  test('a reply\'s tokens are an event of their own, with the model that answered', () => {
    const e: Metered = { host: 'pi', provider: 'codex', session: 'p1', cwd: '/w', now: NOW, tokens, model: 'gpt-5' }
    expect(eventsOf(e)).toEqual([{ at: NOW, tokens, model: 'gpt-5' }])
  })

  test('are written and read back, under a header that names the harness and the folder', () => {
    const { text } = logText({ provider: 'codex', session: 's1', host: 'pi', cwd: '/work/pace' }, [{ at: NOW, tokens, model: 'gpt-5' }], null)
    expect(entriesOf(text)).toEqual([{ provider: 'codex', session: 's1', host: 'pi', cwd: '/work/pace', event: { at: NOW, tokens, model: 'gpt-5' } }])
  })

  test('a header may name the repo too, a worktree\'s', () => {
    const { text } = logText({ provider: 'codex', session: 's1', cwd: '/w/.maestro/worktrees/x', repo: 'maestro' }, [{ at: NOW, prompt: true }], null)
    expect(entriesOf(text)[0]!.repo).toBe('maestro')
  })

  test('a header from before names neither, and reads as before', () => {
    expect(entriesOf(`{"q":"codex","s":"s1"}\n{"at":${NOW},"p":1}\n`)).toEqual([{ provider: 'codex', session: 's1', event: { at: NOW, prompt: true } }])
  })

  test('count for nothing in a quota\'s history: its readings, prompts and spend are as without them', () => {
    const [f] = hydrate([feed('s1')], logOf(head('s1'), [{ at: NOW - MIN, tokens, model: 'gpt-5' }, { at: NOW - MIN, usd: 1 }]), NOW)
    expect(f!.snapshot.prompts).toEqual([])
    expect(total(f!)).toBe(1)
  })
})
