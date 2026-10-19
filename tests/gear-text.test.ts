import { describe, expect, test } from 'claude-code/testing'

import type { PaceGear } from '../types'
import { gearText, notchName, startingGear } from '../hooks/throttle.ts'

const PUSH: PaceGear = { model: 'claude-opus-5-5', effort: 'xhigh', subagents: 3, subagentModel: 'sonnet', fanout: true }
const CRUISE: PaceGear = { model: 'opus', effort: 'high', subagents: 2, subagentModel: 'sonnet', fanout: false }
const EASE: PaceGear = { model: 'sonnet', effort: 'medium', subagents: 1, subagentModel: 'haiku', fanout: false }

describe('naming the gear', () => {
  test('each notch by what never waits on the cache, its main model aside', () => {
    expect(notchName(PUSH)).toBe('push')
    expect(notchName(CRUISE)).toBe('cruise')
    expect(notchName(EASE)).toBe('ease')
    // A gear down whose main model waits for a cold cache is still the gear down
    expect(notchName({ ...EASE, model: 'claude-opus-5-5' })).toBe('ease')
  })

  test('a gear of no notch reads as cruise', () => {
    expect(notchName({ ...CRUISE, subagents: 7 })).toBe('cruise')
  })
})

describe('a gear in a few words', () => {
  test('the notch, the main model\'s family and effort, and the subagents', () => {
    expect(gearText(PUSH)).toBe('push · opus xhigh · 3 agents')
    expect(gearText(EASE)).toBe('ease · sonnet medium · 1 agent')
  })

  test('an alias reads as itself, and a model of no family pace knows reads in full', () => {
    expect(gearText(CRUISE)).toBe('cruise · opus high · 2 agents')
    expect(gearText({ ...CRUISE, model: 'my-model-1' })).toBe('cruise · my-model-1 high · 2 agents')
  })
})

describe('the gear a run starts in', () => {
  test('cruise at the user\'s model and effort, two subagents on sonnet, no fan-out', () => {
    expect(startingGear({ floor: 'sonnet', ceiling: 'claude-fable-5-1', model: 'claude-fable-5-1', effort: 'medium' }))
      .toEqual({ model: 'claude-fable-5-1', effort: 'medium', subagents: 2, subagentModel: 'sonnet', fanout: false })
  })
})
