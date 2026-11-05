import { describe, expect, test } from 'claude-code/testing'

import { cacheTtlOf, hermesHost, quotaOf, readingsOf } from './events.ts'

const NOW = Date.UTC(2026, 10, 5, 12)
const iso = (ms: number) => new Date(ms).toISOString()

describe('the quota a Hermes session spends', () => {
  test('is Claude\'s on Anthropic, Codex\'s on ChatGPT; none on any other provider', () => {
    expect(quotaOf('anthropic')).toBe('claude')
    expect(quotaOf('openai-codex')).toBe('codex')
    expect(quotaOf('openrouter')).toBeNull()
    expect(quotaOf('')).toBeNull()
  })

  test('keeps a prompt cached as each provider does by default', () => {
    expect(cacheTtlOf('claude')).toBe('5m')
    expect(cacheTtlOf('codex')).toBe('1h')
  })
})

describe('Hermes\'s account windows, as pace\'s readings', () => {
  test('Anthropic\'s: the session, the week, a model\'s week', () => {
    const s = readingsOf([
      { label: 'Current session', used_percent: 42, reset_at: iso(NOW + 3600_000) },
      { label: 'Current week', used_percent: 30.5, reset_at: iso(NOW + 86400_000) },
      { label: 'Opus week', used_percent: 12, reset_at: iso(NOW + 86400_000), scope: 'model' },
    ], NOW)!
    expect(s.at).toBe(NOW)
    expect(Object.keys(s.quotas).sort()).toEqual(['five_hour', 'seven_day', 'seven_day_opus'])
    expect(s.quotas.five_hour).toMatchObject({ percent: 42, resetsAt: NOW + 3600_000 })
    expect(s.quotas.seven_day_opus!.name).toBe('Opus')
  })

  test('Codex\'s: the session and the weekly window', () => {
    const s = readingsOf([{ label: 'Session', used_percent: 5, reset_at: iso(NOW + 60_000) }, { label: 'Weekly', used_percent: 9, reset_at: iso(NOW + 600_000) }], NOW)!
    expect(Object.keys(s.quotas).sort()).toEqual(['five_hour', 'seven_day'])
  })

  test('leaves out what is not a window pace paces, or has no figure', () => {
    expect(readingsOf([{ label: 'API key quota', used_percent: 3 }, { label: 'Subscription', used_percent: 1 }, { label: 'Current week', used_percent: null }], NOW)).toBeNull()
    expect(readingsOf('junk' as never, NOW)).toBeNull()
  })
})

describe('Hermes as pace\'s host', () => {
  test('in a session: Herdr, a tmux split and a window where it has them, and the command\'s answer; pace sends its prompts', () => {
    const h = hermesHost('session', { herdr: true, tmux: true, mac: true })
    expect(h.surfaces).toEqual(['herdr', 'split', 'answer', 'window'])
    expect(h.drives).toEqual(['prompt'])
    expect(h.name).toBe('Hermes')
  })

  test('as a bot: the chat alone, where every answer goes', () => {
    const h = hermesHost('bot', { herdr: true, tmux: true, mac: true })
    expect(h.surfaces).toEqual(['answer'])
    expect(h.name).toBe('Hermes (bot)')
  })
})
