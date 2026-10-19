import { describe, expect, test } from 'claude-code/testing'

import { drawsOn, isPerModel, isWeekly, modelName, theName } from '../hooks/quota.ts'

describe('which quotas a model draws on', () => {
  test('the 5-hour window and the all-models week, whatever the model', () => {
    for (const model of ['claude-opus-5-5', 'claude-haiku-5-5', undefined]) {
      expect(drawsOn('five_hour', model)).toBe(true)
      expect(drawsOn('seven_day', model)).toBe(true)
    }
  })

  test('a model\'s own week only for that model, by family, whatever its version or case', () => {
    expect(drawsOn('seven_day_fable', 'claude-fable-5-1')).toBe(true)
    expect(drawsOn('seven_day_fable', 'Claude-FABLE-6')).toBe(true)
    expect(drawsOn('seven_day_fable', 'claude-opus-5-5')).toBe(false)
    expect(drawsOn('seven_day_opus', 'claude-haiku-5-5')).toBe(false)
  })

  test('every week while the model is not known, so no quota goes unwatched', () => {
    expect(drawsOn('seven_day_fable', undefined)).toBe(true)
  })
})

describe('what kind of quota a key is', () => {
  test('weekly: the all-models week and every model\'s own; per model: only the latter', () => {
    expect([isWeekly('five_hour'), isWeekly('seven_day'), isWeekly('seven_day_fable')]).toEqual([false, true, true])
    expect([isPerModel('five_hour'), isPerModel('seven_day'), isPerModel('seven_day_fable')]).toEqual([false, false, true])
  })
})

describe('names', () => {
  test('mid-sentence: the window as it is, a week lower-cased', () => {
    expect(theName('5-hour window')).toBe('the 5-hour window')
    expect(theName('Week · Fable')).toBe('the week · Fable')
    expect(theName('Week · all models')).toBe('the week · all models')
  })

  test('a week\'s model alone: the reading\'s own name, else the key\'s, title-cased; "All models" for the shared week', () => {
    expect(modelName('seven_day_fable', 'Fable')).toBe('Fable')
    expect(modelName('seven_day_opus')).toBe('Opus')
    expect(modelName('seven_day_claude_design')).toBe('Claude Design')
    expect(modelName('seven_day')).toBe('All models')
    expect(modelName('five_hour')).toBe('5-hour')
  })
})
