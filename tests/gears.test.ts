import { describe, expect, test } from 'claude-code/testing'

import { CLAUDE_LADDER, gearOf, ladderFor } from '../core/gears.ts'
import { shiftGears, startGears } from '../core/throttle.ts'

describe('a provider\'s ladder', () => {
  test('ranks the models a host offers, lightest first, by the provider\'s families; one it does not know stays last in its order', () => {
    expect(ladderFor('antigravity', ['claude-opus-4-6-thinking', 'gemini-3.8-flash', 'gpt-oss-120b-medium', 'claude-sonnet-4-6'], ['low', 'medium', 'high']).models)
      .toEqual(['gemini-3.8-flash', 'gpt-oss-120b-medium', 'claude-sonnet-4-6', 'claude-opus-4-6-thinking'])
    expect(ladderFor('codex', ['gpt-5.6-sol', 'gpt-5.4-mini'], []).models).toEqual(['gpt-5.4-mini', 'gpt-5.6-sol'])
    expect(ladderFor('claude', ['claude-opus-5-5', 'claude-haiku-5-5', 'claude-sonnet-5-5'], []).models).toEqual(['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5'])
  })

  test('takes the thinking levels as offered, with the provider\'s when the host names none', () => {
    expect(ladderFor('antigravity', [], ['low', 'medium', 'high']).efforts).toEqual(['low', 'medium', 'high'])
    expect(ladderFor('claude', [], []).efforts).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
  })

  test('Claude\'s is the one ultra pace has climbed', () => {
    expect(CLAUDE_LADDER.models).toEqual(['haiku', 'sonnet', 'opus', 'fable'])
    expect(CLAUDE_LADDER.sub).toEqual({ light: 'haiku', mid: 'sonnet' })
  })
})

describe('a gear on a ladder', () => {
  const ladder = ladderFor('antigravity', ['gemini-3.8-flash', 'claude-sonnet-4-6', 'claude-opus-4-6-thinking'], ['low', 'medium', 'high'])
  const bounds = { floor: 'claude-sonnet-4-6', ceiling: 'claude-opus-4-6-thinking', model: 'claude-sonnet-4-6', effort: 'medium' }

  test('push: the ceiling, the most thinking short of the top where there is more than one step above the user\'s', () => {
    expect(gearOf('push', ladder, bounds)).toMatchObject({ model: 'claude-opus-4-6-thinking', effort: 'high' })
  })

  test('cruise: the user\'s model and thinking', () => {
    expect(gearOf('cruise', ladder, bounds)).toMatchObject({ model: 'claude-sonnet-4-6', effort: 'medium' })
  })

  test('ease: the floor, one step less thinking', () => {
    expect(gearOf('ease', ladder, bounds)).toMatchObject({ model: 'claude-sonnet-4-6', effort: 'low' })
  })

  test('on Claude\'s ladder, the gears ultra pace has always had', () => {
    const b = { floor: 'sonnet', ceiling: 'opus', model: 'opus', effort: 'high' }
    expect(gearOf('push', CLAUDE_LADDER, b)).toEqual({ model: 'opus', effort: 'xhigh', subagents: 3, subagentModel: 'sonnet', fanout: true })
    expect(gearOf('cruise', CLAUDE_LADDER, b)).toEqual({ model: 'opus', effort: 'high', subagents: 2, subagentModel: 'sonnet', fanout: false })
    expect(gearOf('ease', CLAUDE_LADDER, b)).toEqual({ model: 'sonnet', effort: 'medium', subagents: 1, subagentModel: 'haiku', fanout: false })
  })
})

describe('ultra pace\'s gears on a host other than Claude Code', () => {
  const ladder = ladderFor('codex', ['gpt-5.4-mini', 'gpt-5.6-sol'], ['minimal', 'low', 'medium', 'high', 'xhigh'])

  test('a run starts cruising on the user\'s model and thinking, between the ladder\'s second rung and its top', () => {
    const g = startGears(ladder, 'gpt-5.6-sol', 'medium')
    expect(g).toMatchObject({ floor: 'gpt-5.6-sol', ceiling: 'gpt-5.6-sol', model: 'gpt-5.6-sol', effort: 'medium', streak: 0 })
    expect(g.gear).toMatchObject({ model: 'gpt-5.6-sol', effort: 'medium' })
    expect(startGears(ladder, 'gpt-5.6-sol', 'medium', 'mini', 'sol')).toMatchObject({ floor: 'gpt-5.4-mini', ceiling: 'gpt-5.6-sol' })
  })

  test('drops at once to ease when a quota runs ahead: the floor, one step less thinking, for the host to set', () => {
    const g = startGears(ladder, 'gpt-5.6-sol', 'medium', 'mini', 'sol')
    const { gears, set } = shiftGears(g, 'ease', ladder, true)
    expect(set).toEqual({ model: 'gpt-5.4-mini', effort: 'low' })
    expect(gears.gear).toMatchObject({ model: 'gpt-5.4-mini', effort: 'low' })
  })

  test('climbs back one notch only after two turns with room, and keeps the model while the cache is warm', () => {
    let g = shiftGears(startGears(ladder, 'gpt-5.6-sol', 'medium', 'mini', 'sol'), 'ease', ladder, true).gears
    const once = shiftGears(g, 'push', ladder, false)
    expect(once.set).toEqual({})
    g = once.gears
    const twice = shiftGears(g, 'push', ladder, false)
    expect(twice.set).toEqual({ effort: 'medium' })
  })
})
