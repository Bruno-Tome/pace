import { describe, expect, test } from 'claude-code/testing'

import type { PaceGear } from '../types'
import { HANDOFF_FILE } from '../hooks/auto.ts'
import {
  closingPrompt,
  FANOUT_DIR,
  fanoutPrompt,
  gearNote,
  integratePrompt,
  planPrompt,
  reviewPrompt,
  ultraProtocol,
  verifyPrompt,
  workPrompt,
} from '../hooks/ultra.ts'

const PLAN = 'PLAN.md'
const GEAR: PaceGear = { model: 'opus', effort: 'high', subagents: 2, subagentModel: 'sonnet', fanout: false }

describe('the prompts ultra pace sends', () => {
  test('each names the plan file it works from', () => {
    for (const p of [planPrompt(PLAN), workPrompt(PLAN), reviewPrompt(PLAN, 'why'), integratePrompt(PLAN, ['a']), verifyPrompt(PLAN), closingPrompt(PLAN, 'g')])
      expect(p).toContain(PLAN)
  })

  test('a review says why, and adds the check output only when there is one', () => {
    expect(reviewPrompt(PLAN, 'five turns since the last')).toContain('against its goal: five turns since the last.')
    expect(reviewPrompt(PLAN, 'x')).not.toContain('```')
    expect(reviewPrompt(PLAN, 'x', '')).not.toContain('```')
    expect(reviewPrompt(PLAN, 'x', '2 failed')).toContain('```\n2 failed\n```')
  })

  test('integrating quotes each step and points at the reports', () => {
    const p = integratePrompt(PLAN, ['write tests', 'fix bug'])
    expect(p).toContain('"write tests", "fix bug"')
    expect(p).toContain(`${FANOUT_DIR}/`)
  })

  test('the closing report carries the goal and its five headings', () => {
    const p = closingPrompt(PLAN, 'All green.')
    expect(p).toContain('All green.')
    for (const h of ['What got done', 'Why it stopped', 'What needs you', 'How to do it', 'The plan now']) expect(p).toContain(`**${h}**`)
  })

  test('verifying asks for the PACE: GOAL line', () => {
    expect(verifyPrompt(PLAN)).toContain('PACE: GOAL')
  })
})

describe('the prompt for a subagent on a fan-out', () => {
  test('it holds the goal, the one step and a report path numbered by step', () => {
    const p = fanoutPrompt('ship it', 'write tests', 3)
    expect(p).toContain('toward this goal: ship it')
    expect(p).toContain('Your step, and only this step: write tests')
    expect(p).toContain(`${FANOUT_DIR}/3.md`)
    expect(p).toContain('Do not tick the plan')
  })
})

describe('the gear in each prompt', () => {
  test('several subagents may take searches, reads and independent steps', () => {
    expect(gearNote(GEAR)).toBe(' Pace allows 2 subagents on sonnet: delegate searches, reads and independent steps.')
  })

  test('one subagent is singular and kept to searches and reads', () => {
    expect(gearNote({ ...GEAR, subagents: 1, subagentModel: 'haiku' })).toBe(' Pace allows 1 subagent on haiku: keep it to searches and reads, the rest inline.')
  })

  test('no subagents says none, and names no model', () => {
    const note = gearNote({ ...GEAR, subagents: 0 })
    expect(note).toContain('no subagents')
    expect(note).not.toContain('sonnet')
  })
})

describe('ultra pace\'s instructions', () => {
  test('they are fixed text, so the prompt cache keeps them', () => {
    expect(ultraProtocol()).toBe(ultraProtocol())
  })

  test('they name the handoff file and every PACE line', () => {
    const p = ultraProtocol()
    expect(p).toContain(HANDOFF_FILE)
    for (const l of ['PACE: NEXT', 'PACE: WAITING', 'PACE: REPLAN', 'PACE: GOAL', 'PACE: BLOCKED']) expect(p).toContain(l)
  })
})
