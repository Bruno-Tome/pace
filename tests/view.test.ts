import { expect, test } from 'claude-code/testing'

import { keyAction, screen, type Feed } from '../hooks/view.ts'

const NOW = Date.UTC(2026, 9, 17, 12, 0, 0)
const H = 3600_000
const plain = (s: string) => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')

const STATE: Feed = {
  samples: [
    { at: NOW - 2 * H, quotas: { five_hour: { percent: 20, resetsAt: NOW + 2 * H } } },
    { at: NOW, quotas: { five_hour: { percent: 60, resetsAt: NOW + 2 * H }, seven_day: { percent: 30, resetsAt: NOW + 72 * H } } },
  ],
  prompts: [NOW - 60_000],
  cache: { at: NOW - 10 * 60_000, tokens: 180_000, window: 1_000_000, ttl: '1h' },
  at: NOW,
}

test('the window fills the terminal: taller charts on a taller screen, no line wider than it', () => {
  const small = plain(screen(STATE, NOW, 100, 40)).split('\n')
  const big = plain(screen(STATE, NOW, 160, 70)).split('\n')
  expect(big.length).toBeLessThanOrEqual(70)
  expect(big.length).toBeGreaterThan(small.length)
  for (const l of big) expect([...l].length).toBeLessThanOrEqual(160)
  const text = big.join('\n')
  expect(text).toMatch(/[⠁-⣿]/)
  expect(text).toContain('5-hour window')
  expect(text).toContain('Cache & tokens')
  expect(text).toContain('q quits')
})

test('the window says how old its figures are', () => {
  expect(plain(screen(STATE, NOW + 3 * 60_000, 100, 40))).toContain('updated 3m ago')
})

const braille = (lines: string[]) => lines.filter(l => /[⠁-⣿]/.test(l)).length

test('a terminal over 180 columns puts the 5-hour and weekly charts side by side', () => {
  const wide = plain(screen(STATE, NOW, 200, 60)).split('\n')
  expect(wide.some(l => l.includes('5-hour window') && l.includes('Week · all models'))).toBe(true)
  for (const l of wide) expect([...l].length).toBeLessThanOrEqual(200)
  const narrow = plain(screen(STATE, NOW, 160, 60)).split('\n')
  expect(narrow.some(l => l.includes('5-hour window') && l.includes('Week · all models'))).toBe(false)
})

test('focusing a quota draws its chart alone, full-height, and the footer names the keys', () => {
  const all = plain(screen(STATE, NOW, 100, 40)).split('\n')
  const one = plain(screen(STATE, NOW, 100, 40, { focus: 2 })).split('\n')
  expect(one.length).toBeLessThanOrEqual(40)
  expect(one.join('\n')).toContain('Week · all models')
  expect(one.join('\n')).not.toContain('5-hour window')
  expect(braille(one)).toBeGreaterThan(20)
  expect(all.join('\n')).toMatch(/w warm · r refresh · 1–2 focus/)
  expect(one.join('\n')).toMatch(/2 again/)
})

test('focus on a quota that is not there draws the whole window', () => {
  expect(plain(screen(STATE, NOW, 100, 40, { focus: 3 }))).toContain('5-hour window')
})

test('the window\'s keys: a digit focuses its quota and again shows all, w and r go to the session, q quits', () => {
  expect(keyAction('2', undefined)).toEqual({ focus: 2 })
  expect(keyAction('2', 2)).toEqual({ focus: undefined })
  expect(keyAction('3', 2)).toEqual({ focus: 3 })
  expect(keyAction('w', 1)).toEqual({ send: 'warm' })
  expect(keyAction('r', undefined)).toEqual({ send: 'refresh' })
  expect(keyAction('q', undefined)).toEqual({ quit: true })
  expect(keyAction('\x03', undefined)).toEqual({ quit: true })
  expect(keyAction('x', 1)).toEqual({})
})
