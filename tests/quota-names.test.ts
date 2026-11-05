import { describe, expect, test } from 'claude-code/testing'

import { drawsOn, isPerModel, isWeekly, modelName, quotaKeys, quotaName, shortName, theName, windowOf } from '../core/quota.ts'

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

describe('a model\'s own 5-hour window, as Antigravity has one per model', () => {
  test('is a model\'s quota, five hours long, named for the model', () => {
    expect(isPerModel('five_hour_gemini_3_8_flash')).toBe(true)
    expect(isWeekly('five_hour_gemini_3_8_flash')).toBe(false)
    expect(windowOf('five_hour_gemini_3_8_flash')).toBe(5 * 3600)
    expect(quotaName('five_hour_gemini_3_8_flash', 'Gemini 3.8 Flash')).toBe('5-hour · Gemini 3.8 Flash')
    expect(shortName('five_hour_claude_sonnet', 'Claude Sonnet')).toBe('Claude Sonnet 5h')
    expect(modelName('five_hour_claude_sonnet', 'Claude Sonnet')).toBe('Claude Sonnet')
    expect(theName('5-hour · Claude Sonnet')).toBe('the 5-hour · Claude Sonnet')
  })

  test('is drawn on by that model alone', () => {
    expect(drawsOn('five_hour_gemini_3_8_flash', 'gemini-3.8-flash-high')).toBe(true)
    expect(drawsOn('five_hour_gemini_3_8_flash', 'claude-sonnet-4-6')).toBe(false)
  })

  test('is known once read with a reset, after the shared quotas and before the weeks', () => {
    const at = 0
    const r = { percent: 10, resetsAt: 3600_000 }
    expect(quotaKeys([{ at, quotas: { seven_day_x: r, five_hour_gemini: r, five_hour: r, seven_day: r } }])).toEqual(['five_hour', 'seven_day', 'five_hour_gemini', 'seven_day_x'])
  })
})
