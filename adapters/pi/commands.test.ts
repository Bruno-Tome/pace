import { describe, expect, test } from 'claude-code/testing'

import { thinkingFor } from './commands.ts'

describe('on pace mode\'s thinking level in pi', () => {
  test('one step lower while the rate would gas a quota out, never below minimal; off stays off', () => {
    expect(thinkingFor('high', true)).toBe('medium')
    expect(thinkingFor('xhigh', true)).toBe('high')
    expect(thinkingFor('minimal', true)).toBe('minimal')
    expect(thinkingFor('off', true)).toBe('off')
    expect(thinkingFor('high', false)).toBe('high')
  })
})
