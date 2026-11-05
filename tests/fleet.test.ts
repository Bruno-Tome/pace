import { describe, expect, test } from 'claude-code/testing'

import { fleetOf, type FleetAgent, type PaceFeed } from '../core/host.ts'
import type { Snapshot } from '../core/model.ts'
import { agentLine, fleetLines, type Line } from '../core/view.ts'

const NOW = Date.UTC(2026, 9, 17, 12, 0, 0)
const MIN = 60_000
const H = 60 * MIN
const text = (line: Line) => line.map(s => s.t).join('')

/** The 5-hour window at `percent` with half of it gone, and the week at 20% with half of it gone: under pace */
const quotas = (percent: number): Snapshot => ({
  samples: [{ at: NOW, quotas: { five_hour: { percent, resetsAt: NOW + 2.5 * H }, seven_day: { percent: 20, resetsAt: NOW + 3.5 * 24 * H } } }],
  prompts: [],
  cache: null,
})

const feed = (over: Partial<PaceFeed>): PaceFeed => ({
  version: 1, host: 'claude', provider: 'claude', session: 's', cwd: '/work/pace', at: NOW, snapshot: quotas(50), ...over,
})

const agent = (over: Partial<FleetAgent>): FleetAgent => ({
  host: 'codex', session: 's', terminal: 't7', cwd: '/work/pace', at: NOW, context: { tokens: 50_000, window: 200_000, percent: 25 }, ...over,
})

describe('an agent in one line', () => {
  test('its host, its folder, its terminal and how full its context is', () => {
    expect(text(agentLine(agent({}), NOW))).toBe('codex · pace · t7 · ctx 25%')
  })

  test('says how long ago it last wrote, once that is a minute or more, and leaves out what it does not know', () => {
    expect(text(agentLine(agent({ terminal: null, context: null, at: NOW - 12 * MIN }), NOW))).toBe('codex · pace · 12m ago')
  })

  test('with its status where the host knows it: blocked in the warning color, working in the success color', () => {
    expect(text(agentLine(agent({}), NOW, 'working'))).toBe('codex · pace · t7 · ctx 25% · working')
    expect(agentLine(agent({}), NOW, 'blocked').find(s => s.t === 'blocked')!.color).toBe('warning')
    expect(agentLine(agent({}), NOW, 'working').find(s => s.t === 'working')!.color).toBe('success')
    expect(agentLine(agent({}), NOW, 'idle').find(s => s.t === 'idle')!.dim).toBe(true)
  })

  test('a context nearly full is a warning', () => {
    const line = agentLine(agent({ context: { tokens: 170_000, window: 200_000, percent: 85 } }), NOW)
    expect(line.find(s => s.t.includes('85%'))!.color).toBe('warning')
  })
})

describe('the fleet', () => {
  const fleet = fleetOf([
    // 90% used with half the window gone: over pace
    feed({ session: 'a', terminal: 't2', snapshot: quotas(90) }),
    // 10% used with half the window gone: under pace
    feed({ host: 'codex', provider: 'codex', session: 'b', terminal: 't7', snapshot: quotas(10), context: { tokens: 50_000, window: 200_000 } }),
  ], NOW)
  const lines = fleetLines(fleet, NOW, 100).map(text)

  test('each provider under its name and the room it leaves, the one with the most room first', () => {
    const heads = lines.filter(l => l.startsWith('Codex') || l.startsWith('Claude'))
    expect(heads).toEqual(['Codex · room to push', 'Claude · ease off'])
  })

  test('every quota of a provider with its pace, then the agents on it', () => {
    const codex = lines.slice(0, lines.indexOf('Claude · ease off'))
    expect(codex.some(l => l.includes('5h') && l.includes('10%') && l.includes('Under pace'))).toBe(true)
    expect(codex.some(l => l.includes('7d') && l.includes('20%'))).toBe(true)
    expect(codex).toContain('  codex · pace · t7 · ctx 25%')
    const claude = lines.slice(lines.indexOf('Claude · ease off'))
    expect(claude.some(l => l.includes('5h') && l.includes('90%') && l.includes('Over pace'))).toBe(true)
    expect(claude).toContain('  claude · pace · t2')
  })

  test('no feeds: says where the feeds come from', () => {
    expect(fleetLines([], NOW, 100).map(text)).toEqual(['No agents yet: pace shows each one here once it reports'])
  })

  test('no line wider than the room it is given', () => {
    expect(Math.max(...fleetLines(fleet, NOW, 60).map(l => [...text(l)].length))).toBeLessThanOrEqual(60)
  })
})
