import { describe, expect, test } from 'claude-code/testing'

import { byProvider, byRepo, byUrgency, fleetModel, groupLines, memberLine, qlFeedOf, recommendLine, type FleetMember, type HerdrAgent, type QlSession } from '../core/fleet.ts'
import type { PaceFeed } from '../core/host.ts'
import type { Snapshot } from '../core/model.ts'
import type { Line } from '../core/view.ts'

const NOW = Date.UTC(2026, 10, 5, 12, 0, 0)
const MIN = 60_000
const H = 60 * MIN
const DAY = 24 * H

/** The 5-hour window at `five` with half of it gone, and the week at `week` with half of it gone */
const quotas = (five: number, week: number, at = NOW): Snapshot => ({
  samples: [{ at, quotas: { five_hour: { percent: five, resetsAt: at + 2.5 * H }, seven_day: { percent: week, resetsAt: at + 3.5 * DAY } } }],
  prompts: [],
  cache: null,
})

const pace = (over: Partial<PaceFeed>): PaceFeed => ({
  version: 1, host: 'claude', provider: 'claude', session: 's', cwd: '/work/pace', at: NOW, snapshot: quotas(30, 30), ...over,
})

const herdr = (over: Partial<HerdrAgent>): HerdrAgent => ({
  address: 't1', status: 'working', app: 'claude-code', title: 'claude', cwd: '/work/pace', branch: 'main', ctx: null, ...over,
})

const ql = (over: Partial<QlSession>): QlSession => ({
  host: 'codex', session: 'q', terminal: 't2', cwd: '/work/ql', at: NOW,
  state: 'working', since: NOW - 5 * MIN, repo: 'me/ql', tree: 'ql', edited: 2, read: 3, ...over,
})

describe('reading a ql feed', () => {
  test('what the fleet needs of it: state, since, repo, tree and the files edited and read', () => {
    const feed = {
      version: 1, host: 'codex', session: 'q', terminal: 't2', cwd: '/work/ql', at: NOW,
      state: {
        state: 'blocked', since: NOW - MIN, agents: [], repo: 'me/ql', tree: 'ql', durations: {}, open: {},
        files: { '/work/ql/a.ts': { reads: 1, edits: 2, last: NOW }, '/work/ql/b.ts': { reads: 4, edits: 0, last: NOW } },
      },
    }
    expect(qlFeedOf(feed)).toEqual({
      host: 'codex', session: 'q', terminal: 't2', cwd: '/work/ql', at: NOW,
      state: 'blocked', since: NOW - MIN, repo: 'me/ql', tree: 'ql', edited: 1, read: 1,
    })
  })

  test('null for anything that is not one', () => {
    expect(qlFeedOf(null)).toBeNull()
    expect(qlFeedOf({ version: 2 })).toBeNull()
    expect(qlFeedOf({ version: 1, host: 'codex', session: 'q', cwd: '/x', at: NOW, state: { state: 1 } })).toBeNull()
  })
})

describe('the agents', () => {
  test('a pi agent counts under the provider its feed names, the one whose quota it spends', () => {
    const m = fleetModel({
      pace: [pace({ host: 'codex', provider: 'codex', session: 'c', terminal: 't2' }), pace({ host: 'pi', provider: 'codex', session: 'p', terminal: 't3' })],
      ql: [],
      agents: [herdr({ address: 't2', app: 'codex' }), herdr({ address: 't3', app: 'pi' })],
      now: NOW,
    })
    expect(m.agents.find(a => a.key === 't3')).toMatchObject({ host: 'pi', provider: 'codex' })
    expect(m.providers.find(p => p.provider === 'codex')!.agents).toEqual(['t2', 't3'])
  })

  test('one per Herdr agent, joined to its feeds by terminal: host, state, repo, branch, context and files', () => {
    const m = fleetModel({
      pace: [pace({ host: 'codex', provider: 'codex', session: 'c', terminal: 't2', context: { tokens: 50_000, window: 200_000 } })],
      ql: [ql({})],
      agents: [herdr({ address: 't2', app: 'codex', status: 'blocked', cwd: '/work/ql', branch: 'fix' })],
      now: NOW,
    })
    expect(m.agents).toEqual([{
      key: 't2', address: 't2', host: 'codex', provider: 'codex', session: 'c', title: 'claude', state: 'blocked', since: NOW - 5 * MIN,
      cwd: '/work/ql', repo: 'me/ql', branch: 'fix', context: 25, edited: 2, read: 3, stale: false,
    }])
  })

  test("Herdr's status wins over a feed's; a Claude agent's context comes from its ctx label when no feed has it", () => {
    const m = fleetModel({ pace: [], ql: [ql({ terminal: 't1', state: 'done' })], agents: [herdr({ ctx: 64 })], now: NOW })
    expect(m.agents[0]).toMatchObject({ host: 'claude', provider: 'claude', state: 'working', context: 64 })
  })

  test('an agent no feed knows: its folder for a repo, Herdr for the rest; a host with no quotas has no provider', () => {
    const m = fleetModel({ pace: [], ql: [], agents: [herdr({ address: 't5', app: 'gemini', cwd: '/work/site', branch: null })], now: NOW })
    expect(m.agents[0]).toMatchObject({ host: 'gemini', provider: null, repo: 'site', branch: null, context: null, edited: 0, since: null })
  })

  test('a live feed from outside Herdr is an agent too, with no terminal; a stale one is dropped', () => {
    const m = fleetModel({
      pace: [pace({ host: 'codex', provider: 'codex', session: 'out', at: NOW - MIN }), pace({ session: 'old', at: NOW - 7 * H })],
      ql: [ql({ session: 'out', terminal: undefined, state: 'done' })],
      agents: [],
      now: NOW,
    })
    expect(m.agents.map(a => [a.key, a.address, a.host, a.state])).toEqual([['codex-out', null, 'codex', 'done']])
  })
})

describe('the providers', () => {
  const m = fleetModel({
    pace: [
      pace({ session: 'a', terminal: 't1', snapshot: quotas(90, 40) }),
      pace({ host: 'codex', provider: 'codex', session: 'b', terminal: 't2', snapshot: quotas(10, 38) }),
    ],
    ql: [],
    agents: [herdr({}), herdr({ address: 't2', app: 'codex', status: 'idle' })],
    now: NOW,
  })

  test('one per provider: its 5-hour and weekly use, the room left in the tighter one, and its agents', () => {
    expect(m.providers.map(p => [p.provider, p.fiveHour?.percent, p.week?.percent, p.left, p.tightest, p.agents, p.working]))
      .toEqual([['codex', 10, 38, 62, 'week', ['t2'], 0], ['claude', 90, 40, 10, '5 hours', ['t1'], 1]])
  })

  test('the recommendation: the most room, and why in one line', () => {
    expect(m.recommended).toEqual({ provider: 'codex', why: 'Codex: 62% of the week left, 0 agents working' })
  })

  test('ties go to the provider with fewer agents working', () => {
    const tie = fleetModel({
      pace: [pace({ session: 'a', terminal: 't1' }), pace({ host: 'codex', provider: 'codex', session: 'b', terminal: 't2' })],
      ql: [],
      agents: [herdr({ status: 'working' }), herdr({ address: 't2', app: 'codex', status: 'done' })],
      now: NOW,
    })
    expect(tie.recommended?.provider).toBe('codex')
  })

  test('a provider whose readings no longer hold is stale and never recommended', () => {
    const stale = fleetModel({
      // Its feed written a minute ago, its newest reading 5½ hours old: what the 5-hour window holds now is unknown
      pace: [pace({ session: 'a', at: NOW - MIN, snapshot: quotas(10, 10, NOW - 5.5 * H) })],
      ql: [], agents: [], now: NOW,
    })
    expect(stale.providers[0]?.stale).toBe(true)
    expect(stale.recommended).toBeNull()
  })
})

describe('the views', () => {
  const m = fleetModel({
    pace: [pace({ session: 'a', terminal: 't1', snapshot: quotas(20, 20) })],
    ql: [],
    agents: [
      herdr({ address: 't1', status: 'working', cwd: '/work/pace', branch: 'main' }),
      herdr({ address: 't2', status: 'done', cwd: '/work/pace', branch: 'main', ctx: 85 }),
      herdr({ address: 't3', status: 'blocked', cwd: '/work/ql', branch: 'main' }),
      herdr({ address: 't4', status: 'working', app: 'gemini', cwd: '/work/site', branch: 'dev' }),
    ],
    now: NOW,
  })

  test('by provider: each provider with its agents, then the agents on no provider', () => {
    expect(byProvider(m).map(g => [g.title, g.agents.map(a => a.key)])).toEqual([
      ['Claude', ['t1', 't2', 't3']],
      ['No quotas', ['t4']],
    ])
  })

  test('by provider, two accounts of one are two groups, each with the agents that spend it', () => {
    const two = fleetModel({
      pace: [
        pace({ host: 'codex', provider: 'codex', account: 'aaaa000011112222', session: 'a', terminal: 't1', snapshot: quotas(30, 30) }),
        pace({ host: 'codex', provider: 'codex', account: 'bbbb000011112222', session: 'b', terminal: 't2', snapshot: quotas(70, 70) }),
      ],
      ql: [],
      agents: [herdr({ address: 't1', app: 'codex', title: 'codex' }), herdr({ address: 't2', app: 'codex', title: 'codex' })],
      now: NOW,
    })
    expect(byProvider(two).map(g => [g.title, g.agents.map(a => a.key)])).toEqual([
      ['Codex account 1 · aaaa00…', ['t1']],
      ['Codex account 2 · bbbb00…', ['t2']],
    ])
  })

  test('by repo: who works where, two agents on one tree flagged', () => {
    expect(byRepo(m).map(g => [g.title, g.agents.map(a => a.key), g.clash])).toEqual([
      ['pace · main', ['t1', 't2'], true],
      ['ql · main', ['t3'], false],
      ['site · dev', ['t4'], false],
    ])
  })

  test('by urgency: blocked, then a context nearly full, then done, then working', () => {
    expect(byUrgency(m).map(g => [g.title, g.agents.map(a => a.key)])).toEqual([
      ['Blocked', ['t3']],
      ['Context ≥ 80%', ['t2']],
      ['Working', ['t1', 't4']],
    ])
  })
})

const text = (line: Line) => line.map(s => s.t).join('')

const member = (over: Partial<FleetMember>): FleetMember => ({
  key: 't2', address: 't2', host: 'codex', provider: 'codex', title: 'codex', state: 'blocked', since: NOW - 5 * MIN,
  cwd: '/work/ql', repo: 'me/ql', branch: 'fix', context: 25, edited: 2, read: 3, stale: false, ...over,
})

describe('drawing the fleet', () => {
  test('an agent in one line: its state and how long, its host, repo, branch, context and files', () => {
    expect(text(memberLine(member({}), NOW))).toBe('● blocked 5m  codex · me/ql · fix · ctx 25% · 2 edited, 3 read')
  })

  test('its state in its color; a context nearly full a warning; what is not known left out; stale said', () => {
    const line = memberLine(member({ state: 'working', since: null, branch: null, context: 85, edited: 0, read: 0, stale: true }), NOW)
    expect(text(line)).toBe('● working  codex · me/ql · ctx 85% · stale')
    expect(line[0]!.color).toBe('success')
    expect(line.find(s => s.t === 'ctx 85%')!.color).toBe('warning')
  })

  test('the recommendation, or why there is none', () => {
    expect(text(recommendLine({ agents: [], providers: [], recommended: { provider: 'codex', why: 'Codex: 62% of the week left, 0 agents working' } })))
      .toBe('Send work to Codex: 62% of the week left, 0 agents working')
    expect(text(recommendLine({ agents: [], providers: [], recommended: null }))).toBe('No provider has a live reading yet')
  })

  test("a provider's group: its quotas as pace draws them, then its agents; a repo shared by two flagged", () => {
    const m = fleetModel({ pace: [pace({ session: 'a', terminal: 't1' })], ql: [], agents: [herdr({}), herdr({ address: 't2' })], now: NOW })
    const lines = groupLines(byProvider(m)[0]!, NOW, 100).map(text)
    expect(lines[0]).toBe('Claude · room to push')
    expect(lines.filter(l => l.startsWith('  ● working')).length).toBe(2)
    expect(text(groupLines(byRepo(m)[0]!, NOW, 100)[0]!)).toBe('pace · main · 2 agents on one tree')
  })
})
