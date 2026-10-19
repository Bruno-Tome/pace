import { expect, test } from 'claude-code/testing'

import { keyOf } from '../hooks/timeline.ts'

test('the arrows and the page keys are scroll keys', () => {
  expect(keyOf('\x1b[A')).toBe('up')
  expect(keyOf('\x1b[B')).toBe('down')
  expect(keyOf('\x1b[5~')).toBe('pageup')
  expect(keyOf('\x1b[6~')).toBe('pagedown')
})

test('Home and End in both of the forms terminals send', () => {
  expect(keyOf('\x1b[H')).toBe('home')
  expect(keyOf('\x1b[1~')).toBe('home')
  expect(keyOf('\x1b[F')).toBe('end')
  expect(keyOf('\x1b[4~')).toBe('end')
})

test('j, k, g, G and space stand for themselves', () => {
  for (const k of ['j', 'k', 'g', 'G', ' ']) expect(keyOf(k)).toBe(k)
})

test('the mouse wheel in SGR form scrolls a line either way', () => {
  expect(keyOf('\x1b[<64;10;5M')).toBe('up')
  expect(keyOf('\x1b[<65;10;5M')).toBe('down')
})

test('anything else is no scroll: another letter, a click, q', () => {
  for (const k of ['x', 'q', '\x1b[<0;10;5M', '\x1b[C']) expect(keyOf(k)).toBeNull()
})
