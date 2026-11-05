import { describe, expect, test } from 'claude-code/testing'
import type { PaceFeed } from '../core/host.ts'
import type { Snapshot } from '../core/model.ts'
import { meter, sameQuota, type Metered } from '../core/meter.ts'

const NOW = Date.UTC(2026, 10, 5, 12)
const MIN = 60_000
const H = 60 * MIN

const reading = (at: number, percent: number, estimated?: true): Snapshot => ({
  samples: [{ at, quotas: { five_hour: { percent, resetsAt: NOW + 2 * H, ...(estimated ? { estimated } : {}) } } }],
  prompts: [],
  cache: null,
})
const feed = (over: Partial<PaceFeed>): PaceFeed => ({
  version: 1, host: 'codex', provider: 'codex', session: 'c1', cwd: '/w', at: NOW - MIN, snapshot: reading(NOW - MIN, 30), ...over,
})
const ev = (over: Partial<Metered>): Metered => ({ host: 'pi', provider: 'codex', session: 'p1', cwd: '/w', now: NOW, ...over })
const PLAIN = { cache: false, estimate: false }

describe('a quota is its provider and its account', () => {
  test('feeds on one provider share a quota when their accounts match, or when either names none', () => {
    expect(sameQuota(feed({ account: 'a1' }), { provider: 'codex', account: 'a1' })).toBe(true)
    expect(sameQuota(feed({ account: 'a1' }), { provider: 'codex', account: 'a2' })).toBe(false)
    expect(sameQuota(feed({}), { provider: 'codex', account: 'a2' })).toBe(true)
    expect(sameQuota(feed({ account: 'a1' }), { provider: 'claude', account: 'a1' })).toBe(false)
  })

  test('every harness on the quota shares its readings and prompts; another account\'s stay its own', () => {
    const mine = feed({ host: 'claude', provider: 'codex', session: 'x', account: 'a1', snapshot: { ...reading(NOW - MIN, 40), prompts: [NOW - 2 * MIN] } })
    const theirs = feed({ session: 'c2', account: 'a2', snapshot: { ...reading(NOW - 30_000, 90), prompts: [NOW - 3 * MIN] } })
    const f = meter(null, ev({ account: 'a1', prompted: true }), [mine, theirs], PLAIN)
    expect(f.snapshot.samples.map(s => s.quotas.five_hour!.percent)).toEqual([40])
    expect(f.snapshot.prompts).toEqual([NOW - 2 * MIN, NOW])
    expect(f.account).toBe('a1')
  })

  test('the session\'s own last feed is not another session', () => {
    const own = feed({ host: 'pi', session: 'p1', snapshot: { ...reading(NOW - MIN, 30), prompts: [NOW - MIN] } })
    const f = meter(own, ev({}), [own], PLAIN)
    expect(f.snapshot.prompts).toEqual([NOW - MIN])
  })

  test('starts over when the session moves to another quota', () => {
    const own = feed({ host: 'pi', session: 'p1', provider: 'claude' })
    expect(meter(own, ev({}), [], PLAIN).snapshot.samples).toEqual([])
  })
})

describe('what the host was told', () => {
  test('its readings join the history; an estimate of another feed never does', () => {
    const est = feed({ host: 'pi', session: 'p2', snapshot: reading(NOW - MIN, 55, true) })
    const told = [{ at: NOW, quotas: { five_hour: { percent: 31, resetsAt: NOW + 2 * H } } }]
    const f = meter(null, ev({ host: 'codex', session: 'c9', samples: told }), [est, feed({})], PLAIN)
    expect(f.snapshot.samples.map(s => s.quotas.five_hour!.percent)).toEqual([30, 31])
  })

  test('the spend of every harness on the quota is shared, and a reply\'s cost is added', () => {
    const claude = feed({ host: 'claude', session: 'k1', snapshot: { ...reading(NOW - MIN, 30), spend: [{ t: NOW - MIN, id: 'k1', usd: 2 }] } })
    const f = meter(null, ev({ spent: 0.5 }), [claude], { cache: true, estimate: true })
    expect(f.snapshot.spend!.reduce((a, s) => a + s.usd, 0)).toBe(2.5)
  })

  test('a host that reports no dollars writes no spend', () => {
    expect(meter(null, ev({ host: 'codex' }), [], PLAIN).snapshot.spend).toBeUndefined()
  })

  test('a reply that touched the cache starts its timer; a host with no cache says so', () => {
    const f = meter(null, ev({ cached: { tokens: 50_000, ttl: '1h' }, context: { tokens: 60_000, window: 200_000 } }), [], { cache: true, estimate: false })
    expect(f.snapshot.cache).toEqual({ at: NOW, tokens: 50_000, window: 200_000, ttl: '1h' })
    expect(f.snapshot.noCache).toBeUndefined()
    const g = meter(null, ev({ cached: { tokens: 50_000, ttl: '1h' } }), [], PLAIN)
    expect(g.snapshot.cache).toBeNull()
    expect(g.snapshot.noCache).toBe(true)
  })

  test('the context stands until a new one is told; null tokens after a compaction keep the last', () => {
    const own = feed({ host: 'pi', session: 'p1', context: { tokens: 9000, window: 100_000 } })
    expect(meter(own, ev({ context: { tokens: null, window: 100_000 } }), [], PLAIN).context).toEqual({ tokens: 9000, window: 100_000 })
    expect(meter(own, ev({ context: { tokens: 12_000, window: 100_000 } }), [], PLAIN).context).toEqual({ tokens: 12_000, window: 100_000 })
  })

  test('auto mode\'s run and the Herdr terminal are carried', () => {
    const auto = { plan: 'ROADMAP.md', turns: 3, max: 40 }
    const own = feed({ host: 'pi', session: 'p1', snapshot: { ...reading(NOW - MIN, 30), auto } })
    const f = meter(own, ev({ terminal: 't8' }), [], PLAIN)
    expect(f.snapshot.auto).toEqual(auto)
    expect(f.terminal).toBe('t8')
  })
})

describe('a host told no readings estimates them', () => {
  test('from its spend once a capacity is known, marked as an estimate', () => {
    const capacities = { five_hour: { usd: 10, at: NOW - H, source: 'limit' as const } }
    const f = meter(null, ev({ prompted: true, spent: 2 }), [], { cache: true, estimate: true, capacities })
    expect(f.snapshot.estimated).toBe(true)
    expect(f.snapshot.samples.at(-1)!.quotas.five_hour!.percent).toBe(20)
  })

  test('not while a real reading is fresh', () => {
    const capacities = { five_hour: { usd: 10, at: NOW - H, source: 'limit' as const } }
    const f = meter(null, ev({ spent: 2 }), [feed({ snapshot: reading(NOW - 5 * MIN, 30) })], { cache: true, estimate: true, capacities })
    expect(f.snapshot.samples.map(s => s.quotas.five_hour!.percent)).toEqual([30])
  })
})
