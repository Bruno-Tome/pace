import { expect, test } from 'claude-code/testing'

import { isSessionKey, isStale, sessionKey, sessionOf, sharedOf } from '../hooks/prefs.ts'

const DAY = 24 * 60 * 60_000
const NOW = 1_700_000_000_000

test('a session key is the id under the session prefix, and is told from the shared key', () => {
  expect(sessionKey('abc-123')).toBe('session:abc-123')
  expect(isSessionKey(sessionKey('abc-123'))).toBe(true)
  expect(isSessionKey('prefs')).toBe(false)
  expect(isSessionKey('xsession:abc')).toBe(false)
  expect(isSessionKey('')).toBe(false)
})

test('the shared prefs carry the band, the line and the onboarding, never a session mode', () => {
  const p = { band: false, line: true, onboarded: true, warm: 'ping' as const, onPace: true, auto: null }
  expect(sharedOf(p)).toEqual({ band: false, line: true, onboarded: true })
})

test('the shared prefs leave out an onboarding that is not done', () => {
  expect(sharedOf({ band: true, line: true, onboarded: false })).toEqual({ band: true, line: true })
  expect('onboarded' in sharedOf({ band: true, line: true })).toBe(false)
})

test('a session keeps its modes with the time it changed them, and defaults the ones it has not set', () => {
  expect(sessionOf({ band: true, line: true }, NOW)).toEqual({ at: NOW, warm: 'off', onPace: false, auto: null })
  const auto = { plan: 'p.md', turns: 2, max: 9 }
  expect(sessionOf({ band: true, line: true, warm: 'compact', onPace: true, auto }, NOW)).toEqual({ at: NOW, warm: 'compact', onPace: true, auto })
})

test('a session is stale after 30 days, not before', () => {
  expect(isStale({ at: NOW - 29 * DAY }, NOW)).toBe(false)
  expect(isStale({ at: NOW - 30 * DAY }, NOW)).toBe(false) // exactly 30 days: still kept
  expect(isStale({ at: NOW - 30 * DAY - 1 }, NOW)).toBe(true)
})

test('what does not parse as a session is stale', () => {
  for (const v of [null, undefined, 'x', 7, [], {}, { at: '1' }, { at: NaN }, { at: Infinity }]) expect(isStale(v, NOW)).toBe(true)
})
