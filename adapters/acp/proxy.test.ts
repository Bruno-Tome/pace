import { describe, expect, test } from 'claude-code/testing'

import { answerPrompt, fromAgent, fromClient, PROXY_START, sendPrompt, setOption } from './proxy.ts'

const S = PROXY_START
const prompt = (id: number, text: string) => ({ jsonrpc: '2.0' as const, id, method: 'session/prompt', params: { sessionId: 's1', prompt: [{ type: 'text', text }] } })
const update = (u: object) => ({ jsonrpc: '2.0' as const, method: 'session/update', params: { sessionId: 's1', update: u } })

describe('what the client sends', () => {
  test('a prompt goes on to the agent, and counts', () => {
    const [, out] = fromClient(S, prompt(3, 'fix the tests'))
    expect(out.toAgent).toEqual([prompt(3, 'fix the tests')])
    expect(out.meter).toEqual([{ kind: 'prompt', session: 's1' }])
  })

  test('/pace never reaches the agent: it is pace\'s, answered by pace', () => {
    const [s, out] = fromClient(S, prompt(4, '/pace fleet'))
    expect(out.toAgent).toEqual([])
    expect(out.meter).toEqual([])
    expect(out.command).toEqual({ id: 4, session: 's1', args: 'fleet' })
    expect(s.pending).toEqual({})
  })

  test('a new session\'s folder is kept for its feed', () => {
    const [s, out] = fromClient(S, { jsonrpc: '2.0', id: 1, method: 'session/new', params: { cwd: '/work/pace', mcpServers: [] } })
    expect(out.toAgent.length).toBe(1)
    expect(s.newAt[1]).toBe('/work/pace')
  })
})

describe('what the agent sends', () => {
  test('a new session: its id, its folder, its model and thinking options', () => {
    const [s0] = fromClient(S, { jsonrpc: '2.0', id: 1, method: 'session/new', params: { cwd: '/work/pace', mcpServers: [] } })
    const result = { sessionId: 's1', configOptions: [
      { id: 'model', category: 'model', type: 'select', currentValue: 'm1', options: [{ value: 'm1', name: 'M1' }, { value: 'm2', name: 'M2' }] },
      { id: 'thought_level', category: 'thought_level', type: 'select', currentValue: 'high', options: [{ value: 'low' }, { value: 'high' }] },
    ] }
    const [s, out] = fromAgent(s0, { jsonrpc: '2.0', id: 1, result })
    expect(out.toClient).toEqual([{ jsonrpc: '2.0', id: 1, result }])
    expect(out.meter).toEqual([{ kind: 'session', session: 's1', cwd: '/work/pace' }])
    expect(s.options.s1).toEqual({ model: { id: 'model', current: 'm1', values: ['m1', 'm2'] }, thought: { id: 'thought_level', current: 'high', values: ['low', 'high'] } })
  })

  test('a session the client loads or resumes is metered as a new one is, once the agent has it', () => {
    for (const method of ['session/load', 'session/resume']) {
      const [s0] = fromClient(S, { jsonrpc: '2.0', id: 5, method, params: { sessionId: 'old', cwd: '/work/pace', mcpServers: [] } })
      const [, out] = fromAgent(s0, { jsonrpc: '2.0', id: 5, result: {} })
      expect(out.meter).toEqual([{ kind: 'session', session: 'old', cwd: '/work/pace' }])
      const [, failed] = fromAgent(s0, { jsonrpc: '2.0', id: 5, error: { code: -32000, message: 'no such session' } })
      expect(failed.meter).toEqual([])
    }
  })

  test('usage: the context, and what the session\'s cost grew by', () => {
    const [s1, a] = fromAgent(S, update({ sessionUpdate: 'usage_update', used: 53_000, size: 200_000, cost: { amount: 0.05, currency: 'USD' } }))
    const [, b] = fromAgent(s1, update({ sessionUpdate: 'usage_update', used: 60_000, size: 200_000, cost: { amount: 0.08, currency: 'USD' } }))
    expect(a.meter).toEqual([{ kind: 'usage', session: 's1', context: { tokens: 53_000, window: 200_000 }, spent: 0.05 }])
    expect(b.meter[0]).toMatchObject({ spent: 0.03 })
    expect(a.toClient.length).toBe(1)
  })

  test('a cost in another currency is not counted as dollars', () => {
    const [, out] = fromAgent(S, update({ sessionUpdate: 'usage_update', used: 1, size: 2, cost: { amount: 1, currency: 'EUR' } }))
    expect(out.meter).toEqual([{ kind: 'usage', session: 's1', context: { tokens: 1, window: 2 }, spent: 0 }])
  })

  test('the commands it offers gain /pace', () => {
    const [, out] = fromAgent(S, update({ sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'compact', description: 'Compact' }] }))
    const cmds = (out.toClient[0] as any).params.update.availableCommands.map((c: { name: string }) => c.name)
    expect(cmds).toEqual(['compact', 'pace'])
  })

  test('a prompt\'s end says how the turn ended, with what the agent said in it', () => {
    const [s0] = fromClient(S, prompt(7, 'go'))
    const [s1] = fromAgent(s0, update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done. ' } }))
    const [s2] = fromAgent(s1, update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Next?' } }))
    const [s3, out] = fromAgent(s2, { jsonrpc: '2.0', id: 7, result: { stopReason: 'end_turn' } })
    expect(out.turnEnd).toEqual({ session: 's1', stopReason: 'end_turn', answer: 'Done. Next?' })
    expect(out.toClient).toEqual([{ jsonrpc: '2.0', id: 7, result: { stopReason: 'end_turn' } }])
    expect(s3.pending).toEqual({})
  })
})

describe('what pace sends itself', () => {
  test('/pace\'s answer, shown to the user as the turn\'s message, the turn ended', () => {
    expect(answerPrompt('s1', 4, 'Pace opened in Herdr')).toEqual([
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Pace opened in Herdr' } }),
      { jsonrpc: '2.0', id: 4, result: { stopReason: 'end_turn' } },
    ])
  })

  test('auto mode\'s next prompt, on an id of pace\'s own; its answer goes to no client', () => {
    const [s, msg] = sendPrompt(S, 's1', 'next step')
    expect(msg).toEqual({ jsonrpc: '2.0', id: 'pace-1', method: 'session/prompt', params: { sessionId: 's1', prompt: [{ type: 'text', text: 'next step' }] } })
    const [, out] = fromAgent(s, { jsonrpc: '2.0', id: 'pace-1', result: { stopReason: 'end_turn' } })
    expect(out.toClient).toEqual([])
    expect(out.turnEnd).toMatchObject({ session: 's1', stopReason: 'end_turn' })
  })

  test('a gear: a config option set on an id of pace\'s own', () => {
    const [, msg] = setOption(S, 's1', 'thought_level', 'low')
    expect(msg).toEqual({ jsonrpc: '2.0', id: 'pace-1', method: 'session/set_config_option', params: { sessionId: 's1', configId: 'thought_level', value: 'low' } })
  })
})
