// The shim's own checks: each matcher passes and fails as claude-code/testing's does. Run by Node:
// `node --test testing/node.node-test.ts`; not a *.test.ts, which Claude Code would load and cannot.

import { describe, expect, test } from './node.ts'

/** Whether the check throws, as a failed expectation does */
function fails(check: () => void): boolean {
  try {
    check()
    return false
  } catch {
    return true
  }
}

describe('toBe', () => {
  test('passes on the same value and fails on an equal copy', () => {
    expect(fails(() => expect(1).toBe(1))).toBe(false)
    expect(fails(() => expect(NaN).toBe(NaN))).toBe(false)
    expect(fails(() => expect({ a: 1 }).toBe({ a: 1 }))).toBe(true)
  })
})

describe('toEqual', () => {
  test('compares structure, deeply', () => {
    expect(fails(() => expect({ a: [1, { b: 'x' }] }).toEqual({ a: [1, { b: 'x' }] }))).toBe(false)
    expect(fails(() => expect({ a: [1, { b: 'x' }] }).toEqual({ a: [1, { b: 'y' }] }))).toBe(true)
    expect(fails(() => expect([1, 2]).toEqual([1, 2, 3]))).toBe(true)
  })

  test('ignores properties that hold undefined, on either side', () => {
    expect(fails(() => expect({ a: 1, b: undefined }).toEqual({ a: 1 }))).toBe(false)
    expect(fails(() => expect({ a: 1 }).toEqual({ a: 1, b: undefined }))).toBe(false)
    expect(fails(() => expect({ a: 1 }).toEqual({ a: 1, b: null }))).toBe(true)
  })

  test('tells an array from an object with the same keys', () => {
    expect(fails(() => expect(['x']).toEqual({ 0: 'x' }))).toBe(true)
  })
})

describe('toMatchObject', () => {
  test('passes when received holds at least the properties, deeply', () => {
    expect(fails(() => expect({ a: 1, b: { c: 2, d: 3 } }).toMatchObject({ b: { c: 2 } }))).toBe(false)
    expect(fails(() => expect({ a: 1 }).toMatchObject({ a: 2 }))).toBe(true)
    expect(fails(() => expect({ a: 1 }).toMatchObject({ b: 1 }))).toBe(true)
  })

  test('matches arrays element by element, at the same length', () => {
    expect(fails(() => expect([{ a: 1, b: 2 }]).toMatchObject([{ a: 1 }]))).toBe(false)
    expect(fails(() => expect([{ a: 1 }, { a: 2 }]).toMatchObject([{ a: 1 }]))).toBe(true)
  })
})

describe('toContain and toMatch', () => {
  test('a string by inclusion, an array by element', () => {
    expect(fails(() => expect('out in 1h04m').toContain('1h04m'))).toBe(false)
    expect(fails(() => expect(['a', 'b']).toContain('b'))).toBe(false)
    expect(fails(() => expect(['a', 'b']).toContain('c'))).toBe(true)
  })

  test('a RegExp by test, a string by inclusion', () => {
    expect(fails(() => expect('26 of 17%/h').toMatch(/\d+%\/h/))).toBe(false)
    expect(fails(() => expect('26 of 17%/h').toMatch('of 17'))).toBe(false)
    expect(fails(() => expect('26 of 17%/h').toMatch(/^17/))).toBe(true)
  })
})

describe('null, undefined and order', () => {
  test('toBeNull and toBeUndefined tell the two apart', () => {
    expect(fails(() => expect(null).toBeNull())).toBe(false)
    expect(fails(() => expect(undefined).toBeNull())).toBe(true)
    expect(fails(() => expect(undefined).toBeUndefined())).toBe(false)
    expect(fails(() => expect(null).toBeUndefined())).toBe(true)
  })

  test('the comparisons hold at their bounds', () => {
    expect(fails(() => expect(2).toBeGreaterThan(1))).toBe(false)
    expect(fails(() => expect(1).toBeGreaterThan(1))).toBe(true)
    expect(fails(() => expect(1).toBeGreaterThanOrEqual(1))).toBe(false)
    expect(fails(() => expect(1).toBeLessThan(1))).toBe(true)
    expect(fails(() => expect(1).toBeLessThanOrEqual(1))).toBe(false)
    expect(fails(() => expect(2).toBeLessThanOrEqual(1))).toBe(true)
  })
})

describe('.not', () => {
  test('negates every matcher', () => {
    expect(fails(() => expect(1).not.toBe(2))).toBe(false)
    expect(fails(() => expect(1).not.toBe(1))).toBe(true)
    expect(fails(() => expect('abc').not.toContain('b'))).toBe(true)
    expect(fails(() => expect({ a: 1, b: undefined }).not.toEqual({ a: 1 }))).toBe(true)
    expect(fails(() => expect('abc').not.toMatch(/z/))).toBe(false)
  })

  test('a failure names what was expected and what was received', () => {
    let message = ''
    try {
      expect({ a: 1 }).toEqual({ a: 2 })
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).toContain('toEqual')
    expect(message).toContain('a: 2')
    expect(message).toContain('a: 1')
  })
})
