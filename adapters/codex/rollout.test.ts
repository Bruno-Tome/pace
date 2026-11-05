import { describe, expect, test } from 'claude-code/testing'

import type { PaceFeed } from '../../core/host.ts'
import { FIVE_RESET_S, hookInput, message, sessionMeta, taskStarted, tokenCount, tokenCountNoInfo, tokenCountPremium, WEEK_RESET_S } from './fixtures.ts'
import { hookInputOf, nextFeed, rolloutOf } from './rollout.ts'

const NOW = Date.UTC(2026, 9, 17, 12, 0, 0)
const MIN = 60_000
const lines = (...list: string[]) => `${list.join('\n')}\n`

describe('a Codex rollout', () => {
  test('a token count is a reading: primary the 5-hour window, secondary the week, resets in seconds', () => {
    const { samples } = rolloutOf(lines(sessionMeta(NOW - 2 * MIN), taskStarted(NOW - MIN), message(NOW - MIN), tokenCount(NOW, 12, 40)))
    expect(samples).toEqual([{
      at: NOW,
      quotas: { five_hour: { percent: 12, resetsAt: FIVE_RESET_S * 1000 }, seven_day: { percent: 40, resetsAt: WEEK_RESET_S * 1000 } },
    }])
  })

  test('the context is the last reply\'s tokens against the model\'s window', () => {
    const { context } = rolloutOf(lines(tokenCount(NOW - MIN, 10, 40, 19_011), tokenCount(NOW, 11, 40, 64_600)))
    expect(context).toEqual({ tokens: 64_600, window: 258_400 })
  })

  test('a token count before any reply still reads the quotas, and says nothing of the context', () => {
    const read = rolloutOf(lines(tokenCountNoInfo(NOW, 3, 20)))
    expect(read.samples.length).toBe(1)
    expect(read.context).toBeNull()
  })

  test('reads the codex limit alone: the premium limit\'s empty windows, and any other limit, are left out', () => {
    const other = tokenCount(NOW - MIN, 99, 99).replace('"limit_id":"codex"', '"limit_id":"other"')
    expect(rolloutOf(lines(tokenCountPremium(NOW - 2 * MIN), other)).samples).toEqual([])
  })

  test('drops what it cannot read: a torn line, junk, a token count with no rate limits', () => {
    const noLimits = JSON.stringify({ timestamp: new Date(NOW).toISOString(), type: 'event_msg', payload: { type: 'token_count', info: null, rate_limits: null } })
    const read = rolloutOf(lines('not json', '{"type":"event_msg","payload":{"type":"token_c', noLimits, tokenCount(NOW, 5, 9)))
    expect(read.samples.length).toBe(1)
    expect(read.samples[0]!.quotas.five_hour!.percent).toBe(5)
  })
})

describe('a Codex hook', () => {
  test('reads what Codex 0.161 sends on stdin: the event, the session, its rollout and folder', () => {
    expect(hookInputOf(hookInput('UserPromptSubmit', '/r/rollout.jsonl'))).toEqual({
      event: 'UserPromptSubmit', session: '01a1aa40-0781-75c2-a5ae-6367b424026e', transcript: '/r/rollout.jsonl', cwd: '/work/pace', prompt: 'p',
    })
    expect(hookInputOf(hookInput('SessionStart', null))!.transcript).toBeNull()
    expect(hookInputOf('{}')).toBeNull()
    expect(hookInputOf('nope')).toBeNull()
  })

  test('a submitted prompt counts as a prompt; the other events only read the rollout', () => {
    const prompt = nextFeed(null, hookInputOf(hookInput('UserPromptSubmit', null))!, { samples: [], context: null }, NOW)
    expect(prompt.snapshot.prompts).toEqual([NOW])
    const stop = nextFeed(prompt, hookInputOf(hookInput('Stop', null))!, { samples: [], context: null }, NOW + MIN)
    expect(stop.snapshot.prompts).toEqual([NOW])
    expect(stop.at).toBe(NOW + MIN)
  })

  test('a session carries its harness\'s history: the other Codex sessions\' readings and prompts join its own', () => {
    const input = hookInputOf(hookInput('Stop', null))!
    const sibling = nextFeed(null, { ...input, session: 'other', event: 'UserPromptSubmit', prompt: 'p' }, rolloutOf(lines(tokenCount(NOW - 5 * MIN, 30, 41))), NOW - 5 * MIN)
    const own = nextFeed(null, input, rolloutOf(lines(tokenCount(NOW, 33, 42))), NOW, undefined, [sibling])
    expect(own.snapshot.samples.map(s => s.quotas.five_hour!.percent)).toEqual([30, 33])
    expect(own.snapshot.prompts).toEqual([NOW - 5 * MIN])
  })

  test('a /pace prompt is pace\'s, so it does not count as a prompt', () => {
    const input = { ...hookInputOf(hookInput('UserPromptSubmit', null))!, prompt: '/pace band' }
    expect(nextFeed(null, input, { samples: [], context: null }, NOW).snapshot.prompts).toEqual([])
  })

  test('the feed is Codex\'s: its readings added to the last feed\'s, the context kept until a new one, the terminal named', () => {
    const before: PaceFeed = nextFeed(null, hookInputOf(hookInput('Stop', null))!, rolloutOf(lines(tokenCount(NOW - 10 * MIN, 10, 40))), NOW - 10 * MIN)
    const after = nextFeed(before, hookInputOf(hookInput('PostToolUse', null))!, rolloutOf(lines(tokenCountNoInfo(NOW, 14, 41))), NOW, 't9')
    expect(after).toMatchObject({ version: 1, host: 'codex', provider: 'codex', session: '01a1aa40-0781-75c2-a5ae-6367b424026e', cwd: '/work/pace', terminal: 't9', at: NOW })
    expect(after.snapshot.samples.map(s => s.quotas.five_hour!.percent)).toEqual([10, 14])
    expect(after.context).toEqual({ tokens: 19_011, window: 258_400 })
    // Codex reports no prompt cache: the band leaves its row out
    expect(after.snapshot.cache).toBeNull()
    expect(after.snapshot.noCache).toBe(true)
  })
})
