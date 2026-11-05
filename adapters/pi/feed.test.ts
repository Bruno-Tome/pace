import { describe, expect, test } from 'claude-code/testing'

import type { PaceFeed } from '../../core/host.ts'
import type { Capacities } from '../../core/estimate.ts'
import type { Snapshot } from '../../core/model.ts'
import { isLimit, nextFeed, providerOf, type PiEvent } from './feed.ts'

const NOW = Date.UTC(2026, 10, 5, 12, 0, 0)
const MIN = 60_000
const H = 60 * MIN

/** The 5-hour window at `percent`, read at `at` */
const reading = (at: number, percent: number): Snapshot => ({
  samples: [{ at, quotas: { five_hour: { percent, resetsAt: NOW + 2 * H } } }],
  prompts: [],
  cache: null,
})

const feed = (over: Partial<PaceFeed>): PaceFeed => ({
  version: 1, host: 'codex', provider: 'codex', session: 'c1', cwd: '/work/pace', at: NOW - MIN, snapshot: reading(NOW - MIN, 30), ...over,
})

const event = (over: Partial<PiEvent>): PiEvent => ({
  session: 'p1', provider: 'codex', cwd: '/work/pace', now: NOW, prompted: false, spent: 0, context: null, ...over,
})

describe('the quota a pi session spends', () => {
  test('is Codex\'s when signed in with ChatGPT, Claude\'s when signed in with Claude', () => {
    expect(providerOf('openai', true)).toBe('codex')
    expect(providerOf('openai-codex', true)).toBe('codex')
    expect(providerOf('anthropic', true)).toBe('claude')
  })

  test('is none on an API key or any other provider: pace has no quota to pace there', () => {
    expect(providerOf('openai', false)).toBeNull()
    expect(providerOf('anthropic', false)).toBeNull()
    expect(providerOf('groq', true)).toBeNull()
    expect(providerOf(undefined, true)).toBeNull()
  })
})

describe('a pi session\'s feed', () => {
  test('borrows the readings of the live feeds on its provider: pi itself is told none', () => {
    const f = nextFeed(null, event({}), [feed({}), feed({ host: 'claude', provider: 'claude', session: 'k1', snapshot: reading(NOW - MIN, 80) })])
    expect(f).toMatchObject({ version: 1, host: 'pi', provider: 'codex', session: 'p1', cwd: '/work/pace', at: NOW })
    expect(f.snapshot.samples.map(s => s.quotas.five_hour!.percent)).toEqual([30])
    expect(f.snapshot.noCache).toBe(true)
  })

  test('counts a prompt, and carries the prompts of the other sessions on its provider', () => {
    const codex = feed({ snapshot: { ...reading(NOW - MIN, 30), prompts: [NOW - 10 * MIN] } })
    const f = nextFeed(null, event({ prompted: true }), [codex])
    expect(f.snapshot.prompts).toEqual([NOW - 10 * MIN, NOW])
  })

  test('keeps what it carried before, and the context of the last reply', () => {
    const prev = nextFeed(null, event({ now: NOW - 5 * MIN, prompted: true, context: { tokens: 9_000, contextWindow: 272_000 } }), [feed({})])
    const f = nextFeed(prev, event({}), [])
    expect(f.snapshot.prompts).toEqual([NOW - 5 * MIN])
    expect(f.snapshot.samples.length).toBe(1)
    // Right after a compaction pi does not know the tokens yet: the last known context stands
    expect(nextFeed(prev, event({ context: { tokens: null, contextWindow: 272_000 } }), []).context).toEqual({ tokens: 9_000, window: 272_000 })
  })

  test('starts over when the session moves to another provider: Claude\'s history is not Codex\'s', () => {
    const prev = nextFeed(null, event({ prompted: true }), [feed({})])
    const f = nextFeed(prev, event({ provider: 'claude' }), [])
    expect(f.provider).toBe('claude')
    expect(f.snapshot.samples).toEqual([])
    expect(f.snapshot.prompts).toEqual([])
  })

  test('carries its Herdr terminal when it runs in Herdr', () => {
    expect(nextFeed(null, event({ terminal: 't7' }), []).terminal).toBe('t7')
    expect('terminal' in nextFeed(null, event({}), [])).toBe(false)
  })
})

describe('a pi session\'s estimate', () => {
  // The 5-hour window holds $20, learned from a limit reached yesterday
  const capacities: Capacities = { five_hour: { usd: 20, at: NOW - 24 * H, source: 'limit' } }
  const quiet = feed({ snapshot: { samples: [], prompts: [], cache: null } })

  test('counts what a reply cost, and the spend of the other pi sessions on its provider', () => {
    const other = feed({ host: 'pi', session: 'p2', snapshot: { samples: [], prompts: [], cache: null, spend: [{ t: NOW - 30 * MIN, id: 'p2', usd: 2 }] } })
    const f = nextFeed(null, event({ prompted: true, spent: 3 }), [other], {})
    expect(f.snapshot.spend!.reduce((n, s) => n + s.usd, 0)).toBe(5)
    expect(f.snapshot.estimated).toBe(true)
  })

  test('is the newest reading once a window\'s capacity is known', () => {
    const f = nextFeed(null, event({ prompted: true, spent: 5 }), [quiet], capacities)
    expect(f.snapshot.samples.at(-1)).toEqual({ at: NOW, quotas: { five_hour: { percent: 25, resetsAt: NOW + 5 * H, estimated: true } } })
  })

  test('gives way to a real reading from the last ten minutes', () => {
    const f = nextFeed(null, event({ prompted: true, spent: 5 }), [feed({ snapshot: reading(NOW - 2 * MIN, 30) })], capacities)
    expect(f.snapshot.samples.map(s => s.quotas.five_hour!.percent)).toEqual([30])
  })

  test('is never history: the estimate carried before is dropped for this one', () => {
    const prev = nextFeed(null, event({ now: NOW - 5 * MIN, prompted: true, spent: 5 }), [quiet], capacities)
    const f = nextFeed(prev, event({ spent: 5 }), [], capacities)
    expect(f.snapshot.samples.length).toBe(1)
    expect(f.snapshot.samples[0]!.quotas.five_hour!.percent).toBe(50)
  })
})

describe('a usage limit reached', () => {
  test('is the error ChatGPT and Claude send when a subscription\'s limit is spent', () => {
    expect(isLimit('Codex error: {"code":"subscription_sharing_usage_limit_exceeded"}')).toBe(true)
    expect(isLimit('You\'ve hit your usage limit. Try again at 3:05 PM.')).toBe(true)
    expect(isLimit('429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit"}}')).toBe(false)
    expect(isLimit('OpenAI API error (400): model_not_found')).toBe(false)
    expect(isLimit(undefined)).toBe(false)
  })
})

describe('a pi session\'s prompt cache', () => {
  test('a reply that read or wrote the cache starts its timer: an hour, the context it holds, the model\'s window', () => {
    const f = nextFeed(null, event({ cached: 12_000, context: { tokens: 12_500, contextWindow: 272_000 } }), [])
    expect(f.snapshot.cache).toEqual({ at: NOW, tokens: 12_000, window: 272_000, ttl: '1h' })
    expect(f.snapshot.noCache).toBeUndefined()
  })

  test('stands until the next reply that touches it, and goes when the session moves to another provider', () => {
    const prev = nextFeed(null, event({ now: NOW - 10 * MIN, cached: 12_000, context: { tokens: 12_500, contextWindow: 272_000 } }), [])
    expect(nextFeed(prev, event({}), []).snapshot.cache).toEqual({ at: NOW - 10 * MIN, tokens: 12_000, window: 272_000, ttl: '1h' })
    expect(nextFeed(prev, event({ provider: 'claude' }), []).snapshot.cache).toBeNull()
  })

  test('is none before a reply has touched it', () => {
    const f = nextFeed(null, event({}), [])
    expect(f.snapshot.cache).toBeNull()
    expect(f.snapshot.noCache).toBe(true)
  })
})

describe('a pi session\'s auto mode run', () => {
  test('is carried from one feed to the next, as the band and the fleet read it', () => {
    const prev = nextFeed(null, event({}), [])
    const running = { ...prev, snapshot: { ...prev.snapshot, auto: { plan: 'PLAN.md', turns: 2, max: 40 } } }
    expect(nextFeed(running, event({ prompted: true }), []).snapshot.auto).toEqual({ plan: 'PLAN.md', turns: 2, max: 40 })
  })
})
