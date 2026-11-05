import { describe, expect, test } from 'claude-code/testing'

import { AUTO_TURNS, commandOf, DEFAULT_PLAN, paceArgsOf, ULTRA_TURNS, USAGE } from '../core/command.ts'

describe('/pace and its arguments, as a command', () => {
  test('alone or with a place, opens a view', () => {
    expect(commandOf('')).toEqual({ kind: 'view', where: '' })
    for (const where of ['split', 'pane', 'window', 'band', 'fleet'] as const) expect(commandOf(where)).toEqual({ kind: 'view', where })
  })

  test('the plain ones: refresh, timeline, close, on pace mode, the band and the status line', () => {
    expect(commandOf('refresh')).toEqual({ kind: 'refresh' })
    expect(commandOf('timeline')).toEqual({ kind: 'timeline' })
    expect(commandOf('close')).toEqual({ kind: 'close' })
    expect(commandOf('on')).toEqual({ kind: 'onPace', on: true })
    expect(commandOf('off')).toEqual({ kind: 'onPace', on: false })
    expect(commandOf('show')).toEqual({ kind: 'band', show: true })
    expect(commandOf('hide')).toEqual({ kind: 'band', show: false })
    expect(commandOf('line on')).toEqual({ kind: 'line', on: true })
    expect(commandOf('LINE  off')).toEqual({ kind: 'line', on: false })
  })

  test('warm mode takes compact, ping or off, and says so for anything else', () => {
    expect(commandOf('warm ping')).toEqual({ kind: 'warm', mode: 'ping' })
    expect(commandOf('warm compact')).toEqual({ kind: 'warm', mode: 'compact' })
    expect(commandOf('warm off')).toEqual({ kind: 'warm', mode: 'off' })
    expect(commandOf('warm soon')).toEqual({ kind: 'error', text: 'Use /pace warm compact, ping or off' })
  })

  test('a plan\'s timeline names up to two files as written, or none', () => {
    expect(commandOf('plan')).toEqual({ kind: 'plan', files: [] })
    expect(commandOf('plan docs/PLAN.md  ROADMAP.md extra.md')).toEqual({ kind: 'plan', files: ['docs/PLAN.md', 'ROADMAP.md'] })
  })

  test('auto mode: a plan file and turns, the roadmap and its turns by default; off, resume and burst', () => {
    expect(commandOf('auto')).toEqual({ kind: 'auto', plan: DEFAULT_PLAN, max: AUTO_TURNS })
    expect(commandOf('auto docs/Plan.md 12')).toEqual({ kind: 'auto', plan: 'docs/Plan.md', max: 12 })
    expect(commandOf('auto PLAN.md 0')).toEqual({ kind: 'auto', plan: 'PLAN.md', max: 1 })
    expect(commandOf('auto off')).toEqual({ kind: 'stop', ultra: false })
    expect(commandOf('auto resume')).toEqual({ kind: 'resume' })
    expect(commandOf('auto burst')).toEqual({ kind: 'burst', on: true })
    expect(commandOf('auto burst on')).toEqual({ kind: 'burst', on: true })
    expect(commandOf('auto burst off')).toEqual({ kind: 'burst', on: false })
    expect(commandOf('auto a b c')).toEqual({ kind: 'error', text: 'Use /pace auto [plan file] [turns], /pace auto off or /pace auto resume' })
  })

  test('ultra pace: a plan, turns and the models it may use; off, resume and preview', () => {
    expect(commandOf('ultra')).toEqual({ kind: 'ultra', plan: DEFAULT_PLAN, max: ULTRA_TURNS })
    expect(commandOf('ultra PLAN.md 20 haiku..opus')).toEqual({ kind: 'ultra', plan: 'PLAN.md', max: 20, floor: 'haiku', ceiling: 'opus' })
    expect(commandOf('ultra off')).toEqual({ kind: 'stop', ultra: true })
    expect(commandOf('ultra resume')).toEqual({ kind: 'resume' })
    expect(commandOf('ultra preview')).toEqual({ kind: 'preview' })
    expect(commandOf('ultra a b c d')).toEqual({ kind: 'error', text: 'Use /pace ultra [plan file] [turns] [floor..ceiling], /pace ultra off or /pace ultra resume' })
  })

  test('anything else says what /pace takes', () => {
    expect(commandOf('faster')).toEqual({ kind: 'error', text: `Unknown argument "faster": use ${USAGE}` })
  })
})

describe('a prompt that is /pace', () => {
  test('is /pace or $pace (a skill by name), with any arguments; any other prompt is not', () => {
    expect(paceArgsOf('/pace')).toBe('')
    expect(paceArgsOf('  /pace band\n')).toBe('band')
    expect(paceArgsOf('  $pace auto PLAN.md 12 ')).toBe('auto PLAN.md 12')
    expect(paceArgsOf('/pace\nfleet')).toBe('fleet')
    expect(paceArgsOf('/pace band and fix the tests')).toBe('band and fix the tests')
    expect(paceArgsOf('/pacer')).toBeNull()
    expect(paceArgsOf('$paced')).toBeNull()
    expect(paceArgsOf('why is /pace slow')).toBeNull()
  })
})

describe('a turn count', () => {
  test('too large to be a number of turns is refused, so auto mode always stops', () => {
    const huge = '9'.repeat(400)
    expect(commandOf(`auto ROADMAP.md ${huge}`).kind).toBe('error')
    expect(commandOf(`ultra ROADMAP.md ${huge}`).kind).toBe('error')
    expect(commandOf('auto ROADMAP.md 1000')).toEqual({ kind: 'auto', plan: 'ROADMAP.md', max: 1000 })
  })
})
