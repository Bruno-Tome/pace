import { describe, expect, test } from 'claude-code/testing'

import type { PaceSample } from '../../types'
import { EMPTY, feedOfHistory, historyOf, hookInputOf, nextHistory, paceArgOf, type HookInput } from './feed.ts'

const NOW = Date.UTC(2026, 10, 5, 12, 0, 0)
const MIN = 60_000
const H = 60 * MIN

/** What Antigravity sends a PreInvocation hook, in camelCase; proto3 leaves zeros out */
const payload = (over: object = {}) => JSON.stringify({
  conversationId: 'c1', workspacePaths: ['/work/pace'], transcriptPath: '/home/.gemini/antigravity/brain/c1/transcript.jsonl',
  modelName: 'Gemini 3.1 Pro (High)', lastUserInput: 'fix the tests', executionId: 'e1', invocationNum: 1, ...over,
})

const input = (over: Partial<HookInput> = {}): HookInput => ({
  event: 'PreInvocation', session: 'c1', cwd: '/work/pace', run: 'e1', lastInput: 'fix the tests', subagent: false, ...over,
})

const reading = (at: number, percent: number): PaceSample => ({ at, quotas: { five_hour_gemini_3_1_pro: { percent, resetsAt: NOW + 2 * H, name: 'Gemini 3.1 Pro' } } })

describe('a hook\'s input', () => {
  test('is the conversation, its folder, its run and what the user last sent', () => {
    expect(hookInputOf(payload(), 'PreInvocation')).toEqual(input())
  })

  test('a subagent\'s is its root conversation\'s', () => {
    expect(hookInputOf(payload({ conversationId: 's9', parentConversationId: 'c1', rootConversationId: 'c1' }), 'Stop')).toMatchObject({ event: 'Stop', session: 'c1', subagent: true })
  })

  test('a run with no id is told by the steps it started from, zero when proto3 leaves it out', () => {
    expect(hookInputOf(payload({ executionId: undefined, initialNumSteps: 12 }), 'PreInvocation')!.run).toBe('steps-12')
    expect(hookInputOf(payload({ executionId: undefined }), 'PreInvocation')!.run).toBe('steps-0')
  })

  test('is none for an event pace does not run on, or a payload that is not one', () => {
    expect(hookInputOf(payload(), 'PreToolUse')).toBeNull()
    expect(hookInputOf('not json', 'Stop')).toBeNull()
    expect(hookInputOf(JSON.stringify({ workspacePaths: [] }), 'Stop')).toBeNull()
  })
})

describe('pace\'s own prompt', () => {
  test('is /pace, alone or with its arguments', () => {
    expect(paceArgOf('/pace')).toBe('')
    expect(paceArgOf('  /pace fleet ')).toBe('fleet')
    expect(paceArgOf('/pace auto ROADMAP.md 20')).toBe('auto ROADMAP.md 20')
  })

  test('is the pace plugin\'s skill too, as agy names it: /pace:pace', () => {
    expect(paceArgOf('/pace:pace hide')).toBe('hide')
    expect(paceArgOf('/pace:pace')).toBe('')
  })

  test('is not a prompt that only mentions it', () => {
    expect(paceArgOf('/paced')).toBeNull()
    expect(paceArgOf('what does /pace do?')).toBeNull()
    expect(paceArgOf(null)).toBeNull()
  })
})

describe('Antigravity\'s history', () => {
  test('counts a prompt once per run: a run calls the model again and again', () => {
    const once = nextHistory(EMPTY, input(), null, NOW)
    const again = nextHistory(once, input({ lastInput: 'fix the tests' }), null, NOW + MIN)
    const next = nextHistory(again, input({ run: 'e2', lastInput: 'and the docs' }), null, NOW + 2 * MIN)
    expect(once.prompts).toEqual([NOW])
    expect(again.prompts).toEqual([NOW])
    expect(next.prompts).toEqual([NOW, NOW + 2 * MIN])
  })

  test('does not count a subagent\'s run, a Stop, or /pace: none is the user prompting the model', () => {
    let h = nextHistory(EMPTY, input({ subagent: true }), null, NOW)
    h = nextHistory(h, input({ event: 'Stop', run: 'e2' }), null, NOW)
    h = nextHistory(h, input({ run: 'e3', lastInput: '/pace fleet' }), null, NOW)
    expect(h.prompts).toEqual([])
  })

  test('keeps the readings it is given, a repeat left out', () => {
    let h = nextHistory(EMPTY, input(), reading(NOW, 40), NOW)
    h = nextHistory(h, input({ event: 'Stop' }), reading(NOW + MIN, 40), NOW + MIN)
    h = nextHistory(h, input({ event: 'Stop' }), reading(NOW + 2 * MIN, 45), NOW + 2 * MIN)
    expect(h.samples.map(s => s.quotas.five_hour_gemini_3_1_pro!.percent)).toEqual([40, 45])
  })

  test('reads back what parses of a stored one', () => {
    const h = nextHistory(EMPTY, input(), reading(NOW, 40), NOW)
    expect(historyOf(JSON.stringify(h))).toEqual(h)
    expect(historyOf(JSON.stringify({ samples: [{ at: 'x' }], prompts: [NOW, 'y'], runs: 'z' }))).toEqual({ samples: [], prompts: [NOW], runs: [] })
    expect(historyOf('{')).toEqual(EMPTY)
  })
})

describe('an Antigravity conversation\'s feed', () => {
  test('is the shared history under the conversation, with no cache and no dollars: Antigravity reports neither', () => {
    const h = nextHistory(EMPTY, input(), reading(NOW, 40), NOW)
    const f = feedOfHistory(h, input(), NOW)
    expect(f).toEqual({
      version: 1, host: 'antigravity', provider: 'antigravity', session: 'c1', cwd: '/work/pace', at: NOW,
      snapshot: { samples: h.samples, prompts: [NOW], cache: null, noCache: true },
    })
  })

  test('names the account the history was read for, and reads it back', () => {
    const h = { ...nextHistory(EMPTY, input(), reading(NOW, 40), NOW), account: '1233abcd5678ef90' }
    expect(feedOfHistory(h, input(), NOW).account).toBe('1233abcd5678ef90')
    expect(historyOf(JSON.stringify(h)).account).toBe('1233abcd5678ef90')
    expect(feedOfHistory(EMPTY, input(), NOW).account).toBeUndefined()
  })

  test('carries its Herdr terminal when it runs in Herdr', () => {
    expect(feedOfHistory(EMPTY, input(), NOW, 't7').terminal).toBe('t7')
  })
})
