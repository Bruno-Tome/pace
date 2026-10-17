import { describe, expect, test } from 'claude-code/testing'

import type { PaceQuota, PaceSnapshot } from '../types'
import { answerQuestions, decide, markerOf, protocol, upkeep, warmModeFor } from '../hooks/auto.ts'

const NOW = Date.UTC(2026, 9, 17, 12, 0, 0)
const H = 3600_000

const quota = (over: Partial<PaceQuota> = {}): PaceQuota => ({
  key: 'five_hour', name: '5-hour window', percent: 40, status: 'onPace', resetsAt: NOW + 2 * H, runOutAt: null,
  rate: { level: 'ok', promptsPerHour: 6, usdPerHour: 10, usdBudgetPerHour: 30, costPerPrompt: 1, emptyIn: null },
  ...over,
})

const snap = (over: Partial<PaceSnapshot> = {}): PaceSnapshot => ({
  at: NOW,
  quotas: [quota()],
  cache: { tokens: 200_000, window: 1_000_000, ttl: '1h', secondsLeft: 3000, nextWarm: 20_000, nextCold: 400_000, nextWarmUsd: null, nextColdUsd: null },
  spend: { usdPerHour: 10, sessions: 1, usdPerPrompt: 1 },
  gassedOut: false,
  advice: [],
  ...over,
})

const AUTO = { plan: 'ROADMAP.md', turns: 3, max: 40 }

describe('auto mode', () => {
  test('reads how a turn ended from its last PACE line', () => {
    expect(markerOf('Did step 2.\nPACE: NEXT')).toEqual({ kind: 'next' })
    expect(markerOf('All done.\nPACE: DONE')).toEqual({ kind: 'done' })
    expect(markerOf('PACE: BLOCKED needs an API key')).toEqual({ kind: 'blocked', reason: 'needs an API key' })
    expect(markerOf('no marker at all')).toEqual({ kind: 'next' })
  })

  test('continues with the next step, the pacing it should know about in the prompt', () => {
    const d = decide({ auto: AUTO, snap: snap(), answer: 'PACE: NEXT', aborted: false })
    expect(d.kind).toBe('continue')
    expect(d.kind === 'continue' && d.prompt).toContain('ROADMAP.md')
    const over = decide({ auto: AUTO, snap: snap({ quotas: [quota(), quota({ key: 'seven_day_fable', name: 'Week · Fable', status: 'over' })] }), answer: '', aborted: false })
    expect(over.kind === 'continue' && over.prompt).toMatch(/Week · Fable is over pace.*subagents/)
  })

  test('stops when the plan is done or blocked, at the turn cap, and pauses when you interrupt', () => {
    expect(decide({ auto: AUTO, snap: snap(), answer: 'PACE: DONE', aborted: false })).toMatchObject({ kind: 'stop', why: 'Plan done: ROADMAP.md' })
    expect(decide({ auto: AUTO, snap: snap(), answer: 'PACE: BLOCKED no key', aborted: false })).toMatchObject({ kind: 'stop', why: 'Blocked: no key' })
    expect(decide({ auto: { ...AUTO, turns: 40 }, snap: snap(), answer: '', aborted: false }).kind).toBe('stop')
    expect(decide({ auto: AUTO, snap: snap(), answer: '', aborted: true }).kind).toBe('pause')
  })

  test('holds until a gassed-out quota resets, and while the rate would gas one out before its reset', () => {
    const out = decide({ auto: AUTO, snap: snap({ gassedOut: true, quotas: [quota({ percent: 100, status: 'gassedOut' })] }), answer: '', aborted: false })
    expect(out).toMatchObject({ kind: 'hold', until: NOW + 2 * H + 60_000 })
    expect(out.kind === 'hold' && out.why).toContain('Gassed out')
    const fast = decide({ auto: AUTO, snap: snap({ quotas: [quota({ rate: { ...quota().rate, level: 'fast', emptyIn: 1800 } })] }), answer: '', aborted: false })
    expect(fast).toMatchObject({ kind: 'hold', until: NOW + 15 * 60_000 })
    expect(fast.kind === 'hold' && fast.why).toContain('gasses out in 30m')
  })

  test('hands off to a fresh context when this one is heavy, or cold and large', () => {
    const heavy = snap({ cache: { ...snap().cache!, tokens: 650_000 } })
    const d = decide({ auto: AUTO, snap: heavy, answer: '', aborted: false })
    expect(d.kind).toBe('handoff')
    expect(d.kind === 'handoff' && d.prompt).toContain('.pace/handoff.md')
    const cold = snap({ cache: { ...snap().cache!, tokens: 150_000, secondsLeft: 0 } })
    expect(decide({ auto: AUTO, snap: cold, answer: '', aborted: false }).kind).toBe('handoff')
  })

  test('its instructions are fixed text, so the system prompt stays cached', () => {
    expect(protocol()).toBe(protocol())
    expect(protocol()).toMatch(/PACE: NEXT/)
    expect(protocol()).toMatch(/subagent/i)
    expect(protocol()).toMatch(/\.pace\/handoff\.md/)
  })

  test('answers a question for you with the recommended option, else the first', () => {
    expect(answerQuestions([
      { question: 'Which?', header: 'h', multiSelect: false, options: [{ label: 'A' }, { label: 'B (Recommended)' }] },
      { question: 'Name?', header: 'h', multiSelect: false, options: [{ label: 'X' }, { label: 'Y' }] },
      { question: 'How many?', header: 'h', kind: 'number', multiSelect: false, options: [], min: 1, max: 9, defaultValue: 3 },
    ])).toEqual({ 'Which?': 'B (Recommended)', 'Name?': 'X', 'How many?': '3' })
  })
})

describe('on pace mode', () => {
  test('compacts a heavy context while its cache is still warm, the cheapest moment to', () => {
    expect(upkeep(snap({ cache: { ...snap().cache!, tokens: 650_000 } }))).toBe('compact')
    expect(upkeep(snap())).toBeNull()
    expect(upkeep(snap({ cache: { ...snap().cache!, tokens: 650_000, secondsLeft: 0 } }))).toBeNull()
  })

  test('keeps an idle cache warm: compacting a large context, pinging a small one, your own warm mode first', () => {
    expect(warmModeFor({ onPace: true, warm: 'off' }, snap({ cache: { ...snap().cache!, tokens: 400_000 } }))).toBe('compact')
    expect(warmModeFor({ onPace: true, warm: 'off' }, snap())).toBe('ping')
    expect(warmModeFor({ onPace: true, warm: 'ping' }, snap({ cache: { ...snap().cache!, tokens: 400_000 } }))).toBe('ping')
    expect(warmModeFor({ onPace: false, warm: 'off' }, snap())).toBe('off')
  })
})
