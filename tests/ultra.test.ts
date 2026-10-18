import { describe, expect, test } from 'claude-code/testing'

import type { PaceAuto, PaceGear, PaceQuota, PaceSnapshot, PaceUltra } from '../types'
import type { Step } from '../hooks/plan.ts'
import { decideUltra, fanoutPrompt, ultraProtocol, type UltraInput } from '../hooks/ultra.ts'

const NOW = Date.UTC(2026, 9, 17, 12, 0, 0)
const H = 3600_000

const quota = (over: Partial<PaceQuota> = {}, rate: Partial<PaceQuota['rate']> = {}): PaceQuota => ({
  key: 'five_hour', name: '5-hour window', percent: 40, status: 'onPace', resetsAt: NOW + 2 * H, runOutAt: null,
  rate: { level: 'ok', promptsPerHour: 6, usdPerHour: 10, usdBudgetPerHour: 30, percentPerHour: 10, percentBudgetPerHour: 30, percentAtReset: null, costPerPrompt: 1, emptyIn: null, ...rate },
  ...over,
})

const snap = (over: Partial<PaceSnapshot> = {}): PaceSnapshot => ({
  at: NOW,
  quotas: [quota()],
  cache: { tokens: 200_000, window: 1_000_000, ttl: '1h', secondsLeft: 3000, nextWarm: 20_000, nextCold: 400_000, nextWarmUsd: null, nextColdUsd: null },
  spend: { usdPerHour: 10, sessions: 1, usdPerPrompt: 1 },
  gassedOut: false, advice: [], modes: { onPace: false, auto: null },
  ...over,
})

const CRUISE: PaceGear = { model: 'opus', effort: 'high', subagents: 2, subagentModel: 'sonnet', fanout: false }
const ULTRA: PaceUltra = {
  goal: 'pace ships 1.0 with CI green.', check: 'claude plugin test .', phase: 'work',
  sinceReview: 0, quietReviews: 0, checkFails: 0, models: { floor: 'sonnet', ceiling: 'opus' },
  gear: CRUISE, headroomStreak: 0,
}

const run = (ultra: Partial<PaceUltra> = {}, auto: Partial<PaceAuto> = {}): PaceAuto => ({ plan: 'PLAN.md', turns: 3, max: 80, ultra: { ...ULTRA, ...ultra }, ...auto })

const input = (over: Partial<UltraInput> = {}): UltraInput => ({
  auto: run(), snap: snap(), answer: 'Ticked a step.\nPACE: NEXT', aborted: false, model: 'claude-opus-5-5',
  effort: 'high', progressed: true, ticked: true, lock: [], ...over,
})

const prompt = (d: ReturnType<typeof decideUltra>) => ('prompt' in d ? d.prompt : '')

describe('ultra pace\'s phases', () => {
  test('the plan turn is followed by work on the first step', () => {
    const d = decideUltra(input({ auto: run({ phase: 'plan' }), ticked: false }))
    expect(d.kind).toBe('continue')
    expect(d.ultra.phase).toBe('work')
    expect(prompt(d)).toContain('PLAN.md')
  })

  test('work goes on step by step, counting the work turns since the last review', () => {
    const d = decideUltra(input({ auto: run({ sinceReview: 1 }) }))
    expect(d.ultra).toMatchObject({ phase: 'work', sinceReview: 2 })
  })

  test('every fifth work turn is followed by a review of the plan against the goal', () => {
    const d = decideUltra(input({ auto: run({ sinceReview: 4 }) }))
    expect(d.ultra).toMatchObject({ phase: 'review', sinceReview: 0 })
    expect(prompt(d)).toMatch(/review/i)
  })

  test('a turn that asks for a review gets one, its reason in the prompt', () => {
    const d = decideUltra(input({ answer: 'PACE: REPLAN the parser needs splitting first' }))
    expect(d.ultra.phase).toBe('review')
    expect(prompt(d)).toContain('the parser needs splitting first')
  })

  test('a broken lock is followed by a review naming the steps, to restore them or log why', () => {
    const d = decideUltra(input({ lock: ['Write the CI workflow'] }))
    expect(d.ultra.phase).toBe('review')
    expect(prompt(d)).toContain('Write the CI workflow')
  })

  test('a turn without progress is followed by a review rather than another try', () => {
    const d = decideUltra(input({ progressed: false, ticked: false }))
    expect(d.ultra.phase).toBe('review')
  })

  test('a review is followed by work', () => {
    expect(decideUltra(input({ auto: run({ phase: 'review' }), ticked: false })).ultra.phase).toBe('work')
  })
})

describe('the goal check', () => {
  test('a turn that claims the goal asks pace to run the check captured at the start', () => {
    for (const answer of ['All criteria hold.\nPACE: GOAL', 'Finished.\nPACE: DONE']) {
      const d = decideUltra(input({ answer }))
      expect(d).toMatchObject({ kind: 'check', command: 'claude plugin test .' })
    }
  })

  test('the check runs even while a quota is gassed out: it costs no quota', () => {
    const out = snap({ quotas: [quota({ status: 'gassedOut', percent: 100 })] })
    expect(decideUltra(input({ answer: 'PACE: GOAL', snap: out })).kind).toBe('check')
  })

  test('a check that passes stops the run: the goal is reached', () => {
    const d = decideUltra(input({ answer: 'PACE: GOAL', check: { ok: true, tail: 'ok' } }))
    expect(d.kind).toBe('stop')
    expect('why' in d && d.why).toContain('Goal reached')
  })

  test('a check that fails is followed by a review carrying the end of its output', () => {
    const d = decideUltra(input({ answer: 'PACE: GOAL', check: { ok: false, tail: '(fail) the cache key\n1 fail' } }))
    expect(d.kind).toBe('continue')
    expect(d.ultra).toMatchObject({ phase: 'review', checkFails: 1 })
    expect(prompt(d)).toContain('(fail) the cache key')
  })

  test('three failed checks in a row stop the run', () => {
    const d = decideUltra(input({ auto: run({ checkFails: 2 }), answer: 'PACE: GOAL', check: { ok: false, tail: '1 fail' } }))
    expect(d.kind).toBe('stop')
    expect('why' in d && d.why).toMatch(/check failed 3 times/)
  })

  test('with no check, a claimed goal is verified line by line, and a second claim stops the run', () => {
    const first = decideUltra(input({ auto: run({ check: null }), answer: 'PACE: GOAL' }))
    expect(first.ultra.phase).toBe('verify')
    expect(prompt(first)).toMatch(/Done when/)
    const second = decideUltra(input({ auto: run({ check: null, phase: 'verify' }), answer: 'PACE: GOAL' }))
    expect(second.kind).toBe('stop')
    expect('why' in second && second.why).toContain('Goal verified')
  })

  test('a verification that finds a gap goes back to work', () => {
    expect(decideUltra(input({ auto: run({ check: null, phase: 'verify' }), answer: 'Added two steps.\nPACE: NEXT' })).ultra.phase).toBe('work')
  })
})

describe('ultra pace\'s guards', () => {
  test('three reviews in a row with no new tick stop the run', () => {
    const d = decideUltra(input({ auto: run({ phase: 'work', quietReviews: 2 }), answer: 'PACE: REPLAN still stuck', ticked: false }))
    expect(d.kind).toBe('stop')
    expect('why' in d && d.why).toMatch(/3 reviews/)
  })

  test('a tick clears the quiet reviews', () => {
    expect(decideUltra(input({ auto: run({ quietReviews: 2 }) })).ultra.quietReviews).toBe(0)
  })

  test('the turn cap stops it, and says how to go on', () => {
    const d = decideUltra(input({ auto: run({}, { turns: 80, max: 80 }) }))
    expect(d.kind).toBe('stop')
    expect('why' in d && d.why).toContain('/pace ultra resume')
  })
})

describe('ultra pace defers to auto mode', () => {
  test('an interrupt pauses, a block stops, a gassed-out quota holds, background work waits', () => {
    expect(decideUltra(input({ aborted: true })).kind).toBe('pause')
    expect(decideUltra(input({ answer: 'PACE: BLOCKED needs a key' })).kind).toBe('stop')
    const out = snap({ quotas: [quota({ status: 'gassedOut', percent: 100 })] })
    expect(decideUltra(input({ snap: out })).kind).toBe('hold')
    expect(decideUltra(input({ answer: 'PACE: WAITING the suite' })).kind).toBe('wait')
  })

  test('a review owed when auto mode holds is carried through the hold, and comes once it ends', () => {
    const out = snap({ quotas: [quota({ status: 'gassedOut', percent: 100 })] })
    const held = decideUltra(input({ snap: out, answer: 'PACE: GOAL', check: { ok: false, tail: '(fail) the cache key' } }))
    expect(held.kind).toBe('hold')
    expect(held.ultra.due).toEqual({ reason: 'the goal\'s check failed', tail: '(fail) the cache key' })
    // The hold ends: pace decides again with no turn to judge
    const after = decideUltra(input({ auto: run(held.ultra), answer: '', progressed: undefined, ticked: false }))
    expect(after.ultra.phase).toBe('review')
    expect(after.ultra.due).toBeUndefined()
    expect(prompt(after)).toContain('(fail) the cache key')
  })

  test('a hold ending is no work turn: the count since the last review stays', () => {
    const out = snap({ quotas: [quota({ status: 'gassedOut', percent: 100 })] })
    const held = decideUltra(input({ snap: out, auto: run({ sinceReview: 1 }) }))
    expect(held.ultra.sinceReview).toBe(2)
    expect(decideUltra(input({ auto: run(held.ultra), answer: '', progressed: undefined, ticked: false })).ultra.sinceReview).toBe(2)
  })

  test('a heavy context hands off, the prompt still on the phase', () => {
    const heavy = snap({ cache: { ...snap().cache!, tokens: 700_000 } })
    const d = decideUltra(input({ snap: heavy, auto: run({ sinceReview: 4 }) }))
    expect(d.kind).toBe('handoff')
    expect(d.ultra.phase).toBe('review')
    expect(prompt(d)).toContain('.pace/handoff.md')
    expect(prompt(d)).toContain('The goal: pace ships 1.0 with CI green.')
  })
})

describe('the gear carried forward', () => {
  test('room to push counts toward a higher gear, which comes on the second decision', () => {
    const under = snap({ quotas: [quota({ status: 'under' })] })
    const first = decideUltra(input({ snap: under }))
    expect(first.ultra).toMatchObject({ gear: CRUISE, headroomStreak: 1 })
    const second = decideUltra(input({ snap: under, auto: run({ headroomStreak: 1 }) }))
    expect(second.ultra.gear).toMatchObject({ effort: 'xhigh', subagents: 3, fanout: true })
  })

  test('a handoff starts a cold context, so the gear\'s model can change there', () => {
    const heavyOver = snap({ quotas: [quota({ status: 'over' })], cache: { ...snap().cache!, tokens: 700_000 } })
    expect(decideUltra(input({ snap: heavyOver })).ultra.gear.model).toBe('sonnet')
    // The same gear down on a warm cache keeps the model
    expect(decideUltra(input({ snap: snap({ quotas: [quota({ status: 'over' })] }) })).ultra.gear.model).toBe('opus')
  })
})

describe('fan-out', () => {
  const PUSH: PaceGear = { model: 'opus', effort: 'xhigh', subagents: 3, subagentModel: 'sonnet', fanout: true }
  const under = snap({ quotas: [quota({ status: 'under' })] })
  const step = (text: string, state: Step['state'], parallel = false): Step => ({ text, state, section: 'Steps', ...(parallel ? { parallel: true as const } : {}) })
  const STEPS = [step('Write CI', 'done'), step('Bump plugin.json', 'next', true), step('Move Unreleased', 'next', true), step('Tag it', 'next', true), step('Write docs', 'next', true), step('Push', 'next')]
  const pushing = (over: Partial<UltraInput> = {}) => input({ snap: under, auto: run({ gear: PUSH }), steps: STEPS, ...over })

  test('in push, after a step is done, the parallel steps go to subagents, as many as the gear allows', () => {
    const d = decideUltra(pushing())
    // Four parallel steps ahead, three subagents in push
    const out = ['Bump plugin.json', 'Move Unreleased', 'Tag it']
    expect(d).toMatchObject({ kind: 'fanout', steps: out })
    expect(d.ultra).toMatchObject({ phase: 'fanout', fanout: { agentIds: [], steps: out } })
  })

  test('no fan-out in a gear without it, with no parallel step, or when a review is due', () => {
    expect(decideUltra(pushing({ auto: run({ gear: CRUISE }) })).kind).toBe('continue')
    expect(decideUltra(pushing({ steps: STEPS.map(s => ({ ...s, parallel: undefined })) })).kind).toBe('continue')
    expect(decideUltra(pushing({ auto: run({ gear: PUSH, sinceReview: 4 }) })).ultra.phase).toBe('review')
  })

  test('while subagents are out, pace waits for all of them to report', () => {
    const out = run({ gear: PUSH, phase: 'fanout', fanout: { agentIds: ['a1', 'a2'], steps: ['Bump plugin.json', 'Move Unreleased'] } })
    const d = decideUltra(pushing({ auto: out, agentsDone: false, ticked: false }))
    expect(d.kind).toBe('wait')
    expect(d.ultra.phase).toBe('fanout')
  })

  test('once every subagent reported, a turn integrates their work, then work goes on', () => {
    const out = run({ gear: PUSH, phase: 'fanout', fanout: { agentIds: ['a1', 'a2'], steps: ['Bump plugin.json', 'Move Unreleased'] } })
    const d = decideUltra(pushing({ auto: out, agentsDone: true, ticked: false }))
    expect(d.kind).toBe('continue')
    expect(d.ultra.phase).toBe('integrate')
    expect(d.ultra.fanout).toBeUndefined()
    expect(prompt(d)).toContain('Bump plugin.json')
    expect(prompt(d)).toContain('.pace/fanout/')
    expect(decideUltra(input({ auto: run({ phase: 'integrate' }) })).ultra.phase).toBe('work')
  })
})

describe('ultra pace\'s prompts', () => {
  test('every prompt says what the gear allows in subagents, next to the pacing note', () => {
    // On pace: the gear stays at cruise, two subagents on sonnet
    expect(prompt(decideUltra(input()))).toContain('Pace allows 2 subagents on sonnet')
    const ease: PaceGear = { model: 'sonnet', effort: 'medium', subagents: 1, subagentModel: 'haiku', fanout: false }
    const over = snap({ quotas: [quota({ status: 'over' })] })
    const d = decideUltra(input({ snap: over, auto: run({ gear: ease, sinceReview: 4 }) }))
    expect(d.ultra.phase).toBe('review')
    expect(prompt(d)).toContain('Pace allows 1 subagent on haiku')
  })

  test('a subagent on a fan-out gets the goal, its one step, the rules, and where to write its report', () => {
    const text = fanoutPrompt('pace ships 1.0 with CI green.', 'Bump plugin.json', 2)
    expect(text).toContain('pace ships 1.0 with CI green.')
    expect(text).toContain('Bump plugin.json')
    expect(text).toContain('.pace/fanout/2.md')
    expect(text).toMatch(/red first/i)
    expect(text).toMatch(/do not tick/i)
  })

  test('its instructions are fixed text, so the system prompt stays cached, and name every marker', () => {
    expect(ultraProtocol()).toBe(ultraProtocol())
    for (const m of ['PACE: NEXT', 'PACE: WAITING', 'PACE: GOAL', 'PACE: REPLAN', 'PACE: BLOCKED', '## Revisions', '(parallel)', '.pace/handoff.md']) {
      expect(ultraProtocol()).toContain(m)
    }
  })
})

describe('ultra pace left waiting on the user', () => {
  test('a turn that ends on a question stops the run, and the instructions say to block instead', () => {
    const d = decideUltra(input({ answer: 'Which region should CI deploy to?' }))
    expect(d.kind).toBe('stop')
    expect('why' in d && d.why).toContain('waiting on you')
    expect(ultraProtocol()).toMatch(/hand the user a task or need their feedback[^\n]*PACE: BLOCKED/)
  })
})
