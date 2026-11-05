// The ACP proxy end to end: a client's JSON-RPC in, a fake agent behind it, the feed and the answers out, in a scratch
// home. Run by Node: `node --test bin/pace-acp.node-test.ts`.

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from '../testing/node.ts'
import { feedOf } from '../core/host.ts'

const BIN = join(import.meta.dirname, 'pace-acp.ts')

// Whatever runs the tests: nothing here may reach the real Herdr or tmux
delete process.env.HC_TERMINAL_ID
delete process.env.TMUX

/** An ACP agent of the test's own: logs each method it gets, answers a session and a prompt, a prompt costing $0.50 */
function fakeAgent(dir: string): string {
  const path = join(dir, 'agent.mjs')
  writeFileSync(path, `
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
const send = m => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n')
appendFileSync(${JSON.stringify(join(dir, 'env.log'))}, String(process.env.ANTIGRAVITY_CSRF_TOKEN ?? '') + '\\n')
createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line)
  appendFileSync(${JSON.stringify(join(dir, 'agent.log'))}, (m.method ?? 'response') + ' ' + JSON.stringify(m.params?.prompt ?? '') + '\\n')
  if (m.method === 'initialize') send({ id: m.id, result: { protocolVersion: 1 } })
  if (m.method === 'session/new') send({ id: m.id, result: { sessionId: 's1', configOptions: process.env.FAKE_OPTIONS ? [
    { id: 'model', category: 'model', type: 'select', currentValue: 'claude-sonnet-4-6', options: [{ value: 'gemini-3.8-flash' }, { value: 'claude-sonnet-4-6' }, { value: 'claude-opus-4-6-thinking' }] },
    { id: 'thought_level', category: 'thought_level', type: 'select', currentValue: 'medium', options: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }] },
  ] : undefined } })
  if (m.method === 'session/prompt') {
    send({ method: 'session/update', params: { sessionId: 's1', update: { sessionUpdate: 'usage_update', used: 1000, size: 10000, cost: { amount: 0.5, currency: 'USD' } } } })
    send({ method: 'session/update', params: { sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok' } } } })
    send({ id: m.id, result: { stopReason: 'end_turn' } })
  }
})
`)
  return path
}

/** Runs the proxy before the fake agent, sends the client's messages a line each, and collects what comes back */
async function session(dir: string, args: string[], messages: object[], wait = 1500, env: Record<string, string> = {}): Promise<any[]> {
  const child = spawn(process.execPath, [BIN, ...args, '--', process.execPath, fakeAgent(dir)], { env: { ...process.env, HOME: dir, ...env } })
  let text = ''
  child.stdout.on('data', d => { text += d })
  // As a client does: each request's answer awaited before the next
  for (const m of messages as { id?: number }[]) {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n')
    for (let t = 0; t < 100 && m.id != null && !text.includes(`"id":${m.id},`); t++) await new Promise(r => setTimeout(r, 50))
  }
  await new Promise(r => setTimeout(r, wait))
  child.stdin.end()
  child.kill()
  return text.trim().split('\n').filter(Boolean).map(l => JSON.parse(l))
}

const START = [
  { id: 1, method: 'initialize', params: { protocolVersion: 1 } },
  { id: 2, method: 'session/new', params: { cwd: '/work/pace', mcpServers: [] } },
]
const ask = (id: number, text: string) => ({ id, method: 'session/prompt', params: { sessionId: 's1', prompt: [{ type: 'text', text }] } })

describe('pace between an ACP client and an agent', () => {
  test('passes the session through, and meters its prompts, cost and context into the feed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pace-acp-'))
    const got = await session(dir, ['--host', 'codex', '--provider', 'codex'], [...START, ask(3, 'fix the tests')])
    expect(got.find(m => m.id === 3)?.result).toEqual({ stopReason: 'end_turn' })
    const feed = feedOf(readFileSync(join(dir, '.local/state/pace/feeds/codex-s1.json'), 'utf8'))!
    expect(feed).toMatchObject({ host: 'codex', provider: 'codex', session: 's1', cwd: '/work/pace', context: { tokens: 1000, window: 10000 } })
    expect(feed.snapshot.prompts.length).toBe(1)
    expect(feed.snapshot.spend!.reduce((n, x) => n + x.usd, 0)).toBe(0.5)
  })

  test('answers /pace itself: the agent never gets it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pace-acp-'))
    const got = await session(dir, ['--host', 'codex', '--provider', 'codex'], [...START, ask(3, '/pace hide')])
    expect(got.find(m => m.id === 3)?.result).toEqual({ stopReason: 'end_turn' })
    const said = got.find(m => m.params?.update?.sessionUpdate === 'agent_message_chunk')
    expect(said.params.update.content.text).toContain('no band of its own')
    expect(readFileSync(join(dir, 'agent.log'), 'utf8')).not.toContain('session/prompt')
  })

  test('/pace ultra climbs the ladder the agent offers: its models and thinking levels', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pace-acp-'))
    writeFileSync(join(dir, 'PLAN.md'), '- [ ] one\n- [ ] two\n')
    const start = [START[0]!, { id: 2, method: 'session/new', params: { cwd: dir, mcpServers: [] } }]
    const got = await session(dir, ['--host', 'antigravity', '--provider', 'antigravity'], [...start, ask(3, '/pace ultra PLAN.md 10')], 800, { FAKE_OPTIONS: '1' })
    // The run's bounds: the second rung of the agent's models ranked (flash, sonnet, opus) up to its top
    const said = got.find(m => m.params?.update?.sessionUpdate === 'agent_message_chunk').params.update.content.text
    expect(said).toBe('Ultra pace on: PLAN.md, from claude-sonnet-4-6 to claude-opus-4-6-thinking')
    expect(readFileSync(join(dir, 'agent.log'), 'utf8')).toContain('session/prompt')
  })

  test('says ultra pace needs an agent that offers a model or a thinking level', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pace-acp-'))
    const got = await session(dir, ['--host', 'codex', '--provider', 'codex'], [...START, ask(3, '/pace ultra')])
    expect(got.find(m => m.params?.update?.sessionUpdate === 'agent_message_chunk').params.update.content.text).toContain('Ultra pace is not in')
  })

  test('starts agy with a CSRF token of its own, so pace can ask its server for the quotas', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pace-acp-'))
    await session(dir, ['--host', 'antigravity', '--provider', 'antigravity'], START, 300)
    expect(readFileSync(join(dir, 'env.log'), 'utf8').trim()).toMatch(/^[0-9a-f]{32,}$/)
    expect(existsSync(join(dir, '.local/state/pace/feeds/antigravity-s1.json'))).toBe(true)
  })
})
