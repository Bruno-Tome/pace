import { describe, expect, test } from 'claude-code/testing'

import { anyOf, chipKey, oneOf, toggled } from '../core/chips.ts'

describe('chips', () => {
  test('one of: the one picked is on', () => {
    expect(oneOf('range', 'Range', [{ value: 'day', label: 'Day' }, { value: 'week', label: 'Week' }], 'week')).toEqual({
      group: 'range', title: 'Range', chips: [{ group: 'range', value: 'day', label: 'Day', on: false }, { group: 'range', value: 'week', label: 'Week', on: true }],
    })
  })

  test('any of: "All" first, on while none is picked', () => {
    const row = anyOf('provider', 'Provider', [{ value: 'claude', label: 'Claude' }, { value: 'codex', label: 'Codex' }], [])
    expect(row.chips.map(c => [c.label, c.on])).toEqual([['All', true], ['Claude', false], ['Codex', false]])
    expect(anyOf('provider', 'Provider', [{ value: 'claude', label: 'Claude' }], ['claude']).chips.map(c => c.on)).toEqual([false, true])
  })

  test('a click adds a value or takes it away; "All" clears them', () => {
    expect(toggled(['a'], 'b')).toEqual(['a', 'b'])
    expect(toggled(['a', 'b'], 'a')).toEqual(['b'])
    expect(toggled(['a', 'b'], '')).toEqual([])
  })
})

describe('chips from the keyboard', () => {
  const rows = [
    oneOf('metric', 'Metric', [{ value: 'tokens', label: 'Tokens' }, { value: 'usd', label: 'Dollars' }], 'tokens'),
    oneOf('range', 'Range', [{ value: 'day', label: 'Day' }, { value: 'week', label: 'Week' }, { value: 'all', label: 'All' }], 'week'),
  ]

  test('left and right along a row, down and up between rows, staying where the row ends', () => {
    expect(chipKey(rows, 0, '\x1b[C').focus).toBe(1)
    expect(chipKey(rows, 1, '\x1b[C').focus).toBe(1)
    expect(chipKey(rows, 0, '\x1b[D').focus).toBe(0)
    expect(chipKey(rows, 1, '\x1b[B').focus).toBe(3)
    expect(chipKey(rows, 4, '\x1b[A').focus).toBe(1)
    expect(chipKey(rows, 4, '\x1b[B').focus).toBe(4)
  })

  test('enter or space presses the chip in focus; q quits', () => {
    expect(chipKey(rows, 4, '\r').chip).toMatchObject({ group: 'range', value: 'all' })
    expect(chipKey(rows, 1, ' ').chip).toMatchObject({ group: 'metric', value: 'usd' })
    expect(chipKey(rows, 0, 'q').quit).toBe(true)
  })
})
