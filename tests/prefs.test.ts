import { expect, test } from 'claude-code/testing'

import type { PaceUltra } from '../types'
import { prefsFrom } from '../hooks/prefs.ts'

const ULTRA: PaceUltra = {
  goal: 'pace ships 1.0 with CI green.', check: 'claude plugin test .',
  phase: 'work', sinceReview: 2, quietReviews: 0, checkFails: 1,
  models: { floor: 'sonnet', ceiling: 'opus' },
  gear: { model: 'opus', effort: 'xhigh', subagents: 3, subagentModel: 'sonnet', fanout: true },
  headroomStreak: 1,
  fanout: { agentIds: ['a1', 'a2'], steps: ['Bump plugin.json', 'Move Unreleased'] },
  due: { reason: 'the goal\'s check failed', tail: '1 fail' },
}
const RUN = { plan: 'PLAN.md', turns: 7, max: 80 }

test('an ultra pace run reads back whole from a session\'s stored modes', () => {
  expect(prefsFrom({}, { at: 0, auto: { ...RUN, ultra: ULTRA } }).auto).toEqual({ ...RUN, ultra: ULTRA })
})

test('a run stored by an older pace, without ultra pace, reads as plain auto mode', () => {
  expect(prefsFrom({}, { at: 0, auto: RUN }).auto).toEqual(RUN)
})

test('an ultra pace run that does not parse is dropped, leaving the plain auto mode run', () => {
  const broken = [
    { ...ULTRA, goal: 3 },
    { ...ULTRA, phase: 'dream' },
    { ...ULTRA, gear: { ...ULTRA.gear, effort: 'maximum' } },
    { ...ULTRA, models: null },
    'ultra',
  ]
  for (const ultra of broken) expect(prefsFrom({}, { at: 0, auto: { ...RUN, ultra } }).auto).toEqual(RUN)
})

test('a fan-out or a review owed that does not parse is left out, the rest of the run kept', () => {
  const { fanout: _, ...noFanout } = ULTRA
  expect(prefsFrom({}, { at: 0, auto: { ...RUN, ultra: { ...ULTRA, fanout: { agentIds: 'a1' } } } }).auto).toEqual({ ...RUN, ultra: noFanout })
  const { due: __, ...noDue } = ULTRA
  expect(prefsFrom({}, { at: 0, auto: { ...RUN, ultra: { ...ULTRA, due: { tail: 'x' } } } }).auto).toEqual({ ...RUN, ultra: noDue })
})
