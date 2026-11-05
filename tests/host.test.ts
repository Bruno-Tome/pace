import { describe, expect, test } from 'claude-code/testing'

import { FEED_STALE, feedFile, feedFor, feedOf, fleetOf, type PaceFeed } from '../core/host.ts'
import type { Snapshot } from '../core/model.ts'

const NOW = Date.UTC(2026, 9, 17, 12, 0, 0)
const MIN = 60_000
const H = 60 * MIN

/** The 5-hour window at `percent`, read at `at`, half of it gone */
const fiveHour = (at: number, percent: number): Snapshot => ({
  samples: [{ at, quotas: { five_hour: { percent, resetsAt: NOW + 2.5 * H } } }],
  prompts: [],
  cache: null,
})

const feed = (over: Partial<PaceFeed>): PaceFeed => ({
  version: 1, host: 'claude', provider: 'claude', session: 's1', cwd: '/work/pace', at: NOW, snapshot: fiveHour(NOW, 50), ...over,
})

describe('a feed', () => {
  test('lives in one file per host session, under the state folder', () => {
    expect(feedFile('claude', 'session-a')).toBe('.local/state/pace/feeds/claude-session-a.json')
    expect(feedFile('codex', '../../etc/x')).toBe('.local/state/pace/feeds/codex-______etc_x.json')
  })

  test('reads back what a host wrote', () => {
    const written = feed({ terminal: 't3', context: { tokens: 50_000, window: 200_000 }, snapshot: { ...fiveHour(NOW, 50), noCache: true } })
    expect(feedOf(JSON.stringify(written))).toEqual(written)
  })

  test('reads back an Antigravity conversation\'s, its quotas Antigravity\'s own', () => {
    const written = feed({ host: 'antigravity', provider: 'antigravity', session: 'conv-1', snapshot: { ...fiveHour(NOW, 50), noCache: true } })
    expect(feedOf(JSON.stringify(written))).toEqual(written)
  })

  test('reads back a Hermes session\'s, in a chat as a bot or at the terminal', () => {
    const written = feed({ host: 'hermes', provider: 'codex', session: '20261105_120000_ab12', snapshot: { ...fiveHour(NOW, 50), noCache: true } })
    expect(feedOf(JSON.stringify(written))).toEqual(written)
  })

  test('reads back the account it spends, and reads a feed with none as before', () => {
    const written = feed({ account: '1233abcd5678ef90' })
    expect(feedOf(JSON.stringify(written))).toEqual(written)
    expect(feedOf(JSON.stringify({ ...written, account: 7 }))!.account).toBeUndefined()
  })

  test('reads back a pi session\'s, which names the provider whose quota it spends', () => {
    // pi signed in with ChatGPT spends Codex's quota
    const written = feed({ host: 'pi', provider: 'codex', session: 'p1', context: { tokens: 9_000, window: 272_000 }, snapshot: { ...fiveHour(NOW, 50), noCache: true } })
    expect(feedFile('pi', 'p1')).toBe('.local/state/pace/feeds/pi-p1.json')
    expect(feedOf(JSON.stringify(written))).toEqual(written)
  })

  test('says when its host estimates its quotas from spend, and keeps the spend it estimates from', () => {
    const written = feed({ host: 'pi', provider: 'codex', snapshot: { samples: [], prompts: [NOW - H], cache: null, noCache: true, estimated: true, spend: [{ t: NOW - H, id: 'p1', usd: 3.2 }] } })
    expect(feedOf(JSON.stringify(written))).toEqual(written)
  })

  test('is dropped when it does not parse as one', () => {
    expect(feedOf('{not json')).toBeNull()
    expect(feedOf(JSON.stringify({ ...feed({}), version: 2 }))).toBeNull()
    expect(feedOf(JSON.stringify({ ...feed({}), session: 7 }))).toBeNull()
    expect(feedOf(JSON.stringify({ ...feed({}), provider: 'gemini' }))).toBeNull()
    expect(feedOf(JSON.stringify({ ...feed({}), snapshot: null }))).toBeNull()
  })

  test('keeps what parses of a partial one: bad readings, prompts and a bad terminal or context left out', () => {
    const partial = {
      ...feed({}),
      terminal: 4,
      context: { tokens: 'many', window: 200_000 },
      snapshot: { samples: [{ at: NOW, quotas: { five_hour: { percent: 'x' } } }, fiveHour(NOW, 50).samples[0]], prompts: [NOW, 'p'], cache: 'warm' },
    }
    const read = feedOf(JSON.stringify(partial))!
    expect(read.snapshot.samples).toEqual(fiveHour(NOW, 50).samples)
    expect(read.snapshot.prompts).toEqual([NOW])
    expect(read.snapshot.cache).toBeNull()
    expect(read.terminal).toBeUndefined()
    expect(read.context).toBeUndefined()
  })
})

describe('the fleet', () => {
  test('one row per quota: two accounts of one provider are two rows, each named by number and id', () => {
    const fleet = fleetOf([
      feed({ host: 'codex', provider: 'codex', account: 'aaaa000011112222', session: 'a', snapshot: fiveHour(NOW, 30) }),
      feed({ host: 'codex', provider: 'codex', account: 'bbbb000011112222', session: 'b', snapshot: fiveHour(NOW, 80) }),
    ], NOW, { codex: ['bbbb000011112222', 'aaaa000011112222'] })
    expect(fleet.map(r => [r.account, r.name])).toEqual([['aaaa000011112222', 'Codex account 2 · aaaa00…'], ['bbbb000011112222', 'Codex account 1 · bbbb00…']])
  })

  test('a feed that names no account joins the one account its provider has; with none named, the row is the provider\'s', () => {
    const fleet = fleetOf([
      feed({ host: 'codex', provider: 'codex', account: 'aaaa000011112222', session: 'a', snapshot: fiveHour(NOW, 30) }),
      feed({ host: 'pi', provider: 'codex', session: 'p', snapshot: fiveHour(NOW - 1000, 30) }),
      feed({ host: 'claude', provider: 'claude', session: 'k', snapshot: fiveHour(NOW, 10) }),
    ], NOW)
    const codex = fleet.find(r => r.provider === 'codex')!
    expect(fleet.length).toBe(2)
    expect(codex.agents.map(a => a.host).sort()).toEqual(['codex', 'pi'])
    expect(codex.name).toBe('Codex account 1 · aaaa00…')
    expect(fleet.find(r => r.provider === 'claude')!.name).toBe('Claude')
  })

  test('one row per provider: two hosts\' 5-hour windows never mix', () => {
    const fleet = fleetOf([
      feed({ session: 'a', snapshot: fiveHour(NOW, 30) }),
      feed({ host: 'codex', provider: 'codex', session: 'b', snapshot: fiveHour(NOW, 70) }),
    ], NOW)
    expect(fleet.map(row => row.provider).sort()).toEqual(['claude', 'codex'])
    expect(fleet.find(row => row.provider === 'claude')!.quotas[0]).toMatchObject({ key: 'five_hour', percent: 30 })
    expect(fleet.find(row => row.provider === 'codex')!.quotas[0]).toMatchObject({ key: 'five_hour', percent: 70 })
  })

  test('the newest reading of a provider wins, whichever session read it', () => {
    const fleet = fleetOf([
      feed({ session: 'a', snapshot: fiveHour(NOW - MIN, 45) }),
      feed({ session: 'b', snapshot: fiveHour(NOW - 10 * MIN, 40) }),
    ], NOW)
    expect(fleet.length).toBe(1)
    expect(fleet[0]!.quotas[0]!.percent).toBe(45)
  })

  test('a stale feed is dropped, and a provider with nothing else goes with it', () => {
    const fleet = fleetOf([
      feed({ session: 'a' }),
      feed({ host: 'codex', provider: 'codex', session: 'b', at: NOW - FEED_STALE - 1 }),
    ], NOW)
    expect(fleet.map(row => row.provider)).toEqual(['claude'])
  })

  test('the provider with the most room comes first, each with its pace status and headroom', () => {
    const fleet = fleetOf([
      // 90% used with half the window gone: over pace, so ease off
      feed({ host: 'claude', session: 'a', snapshot: fiveHour(NOW, 90) }),
      // 10% used with half the window gone: under pace, room to push
      feed({ host: 'codex', provider: 'codex', session: 'b', snapshot: fiveHour(NOW, 10) }),
    ], NOW)
    expect(fleet.map(row => [row.provider, row.headroom])).toEqual([['codex', 'push'], ['claude', 'ease']])
    expect(fleet.map(row => row.quotas[0]!.status)).toEqual(['under', 'over'])
  })

  test('lists the agents on each provider, newest first, with their terminal and context use', () => {
    const fleet = fleetOf([
      feed({ session: 'old', at: NOW - 5 * MIN, cwd: '/work/a' }),
      feed({ session: 'new', terminal: 't7', cwd: '/work/b', context: { tokens: 50_000, window: 200_000 } }),
    ], NOW)
    expect(fleet[0]!.agents).toEqual([
      { host: 'claude', session: 'new', terminal: 't7', cwd: '/work/b', at: NOW, context: { tokens: 50_000, window: 200_000, percent: 25 } },
      { host: 'claude', session: 'old', terminal: null, cwd: '/work/a', at: NOW - 5 * MIN, context: null },
    ])
  })
})

describe('the feed a band draws', () => {
  const feeds = [
    feed({ session: 'old', at: NOW - 10 * MIN, terminal: 't2' }),
    feed({ host: 'codex', provider: 'codex', session: 'new', at: NOW - MIN }),
    feed({ session: 'gone', at: NOW - FEED_STALE - 1, terminal: 't9' }),
  ]

  test('is the one of the terminal it is asked for', () => {
    expect(feedFor(feeds, NOW, 't2')!.session).toBe('old')
  })

  test('else the newest one still live', () => {
    expect(feedFor(feeds, NOW)!.session).toBe('new')
  })

  test('none for a terminal with no live feed', () => {
    expect(feedFor(feeds, NOW, 't9')).toBeNull()
    expect(feedFor([], NOW)).toBeNull()
  })
})

describe('a harness\'s snapshot', () => {
  test('is the history of its session with the newest reading: each session carries its harness\'s whole history', () => {
    const fleet = fleetOf([
      feed({ session: 'a', snapshot: { ...fiveHour(NOW - 10 * MIN, 40), prompts: [NOW - 5 * MIN] } }),
      feed({ session: 'b', at: NOW - 3 * MIN, snapshot: { ...fiveHour(NOW - MIN, 45), prompts: [NOW - 5 * MIN, NOW - 2 * MIN] } }),
      feed({ host: 'codex', provider: 'codex', session: 'c', snapshot: { ...fiveHour(NOW, 90), prompts: [NOW - MIN] } }),
    ], NOW)
    const claude = fleet.find(row => row.provider === 'claude')!.snapshot
    // b read last, though a wrote last: b's history speaks for Claude, and Codex's never mixes in
    expect(claude.samples.map(s => s.quotas.five_hour!.percent)).toEqual([45])
    expect(claude.prompts).toEqual([NOW - 5 * MIN, NOW - 2 * MIN])
  })

  test('has no prompt cache: each session keeps its own', () => {
    expect(fleetOf([feed({})], NOW)[0]!.snapshot.noCache).toBe(true)
  })
})

describe('the agents on a provider', () => {
  test('are one per terminal: a terminal that ran two sessions shows its newest alone', () => {
    const fleet = fleetOf([
      feed({ session: 'before', terminal: 't9', at: NOW - 7 * MIN }),
      feed({ session: 'now', terminal: 't9', at: NOW }),
      feed({ session: 'elsewhere', terminal: 't3', at: NOW - MIN }),
      // Outside Herdr there is no terminal to share: each session counts
      feed({ session: 'a' }),
      feed({ session: 'b', at: NOW - 2 * MIN }),
    ], NOW)
    expect(fleet[0]!.agents.map(a => a.session)).toEqual(['now', 'a', 'elsewhere', 'b'])
  })
})
