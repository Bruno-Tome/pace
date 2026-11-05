// pace's Hermes plugin end to end: the plugin loaded by Python with a fake Hermes context, the real bridge behind it,
// in a scratch home. Run by Node: `node --test adapters/hermes/plugin.node-test.ts`; needs python3.

import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from '../../testing/node.ts'
import { feedOf } from '../../core/host.ts'

delete process.env.HC_TERMINAL_ID
delete process.env.TMUX

/** Runs `body` (Python) with the plugin registered on a fake context; what it printed, as JSON */
function run(body: string, env: Record<string, string> = {}): { home: string; out: any } {
  const home = mkdtempSync(join(tmpdir(), 'pace-hermes-plugin-'))
  const plugins = join(home, 'plugins')
  cpSync(join(import.meta.dirname, 'plugin'), join(plugins, 'pace'), { recursive: true })
  writeFileSync(join(plugins, 'pace', 'pace.json'), JSON.stringify({ node: process.execPath, bridge: join(import.meta.dirname, '../../bin/pace-hermes.ts') }))
  writeFileSync(join(home, 'PLAN.md'), '- [ ] one\n- [ ] two\n')
  const script = `
import json, sys, time
sys.path.insert(0, ${JSON.stringify(plugins)})
import pace
class Ctx:
    def __init__(self): self.hooks, self.commands, self.injected = {}, {}, []
    def register_hook(self, name, cb): self.hooks[name] = cb
    def register_command(self, name, fn, **kw): self.commands[name] = fn
    def inject_message(self, text, role='user', session_key=None, origin=None): self.injected.append({'text': text, 'key': session_key}); return True
ctx = Ctx()
pace.register(ctx)
out = {}
${body}
time.sleep(0.5)
print(json.dumps(out))
`
  const r = spawnSync('python3', ['-c', script], { cwd: home, env: { ...process.env, HOME: home, ...env }, encoding: 'utf8', timeout: 30_000 })
  return { home, out: JSON.parse(r.stdout.trim().split('\n').at(-1) || '{}') }
}

const USAGE = "usage={'input_tokens': 2000, 'cache_read_tokens': 8000, 'cache_write_tokens': 0}, context_length=272000"

describe('pace\'s Hermes plugin', () => {
  test('registers /pace and the hooks it meters with', () => {
    const { out } = run(`out['hooks'] = sorted(ctx.hooks); out['commands'] = sorted(ctx.commands)`)
    expect(out.hooks).toEqual(['post_api_request', 'post_auxiliary_call', 'post_llm_call', 'pre_llm_call'])
    expect(out.commands).toEqual(['pace'])
  })

  test('in a session, meters prompts and usage into the session\'s feed, and answers /pace in place', () => {
    const { home, out } = run(`
ctx.hooks['pre_llm_call'](session_id='h1', user_message='fix the tests')
ctx.hooks['post_api_request'](session_id='h1', provider='openai-codex', model='gpt-5.6-sol', ${USAGE})
out['answer'] = ctx.commands['pace']('hide')
`)
    expect(out.answer).toBe('Hermes has no band of its own: /pace band opens one beside it')
    const feed = feedOf(readFileSync(join(home, '.local/state/pace/feeds/hermes-h1-codex.json'), 'utf8'))!
    expect(feed).toMatchObject({ host: 'hermes', provider: 'codex', session: 'h1', context: { tokens: 10_000, window: 272_000 } })
    expect(feed.snapshot.prompts.length).toBe(1)
  })

  test('as a bot, auto mode\'s prompts go into the chat the run was started from', () => {
    const { out } = run(`
ctx.hooks['pre_llm_call'](session_id='h1', user_message='hi')
ctx.hooks['post_api_request'](session_id='h1', provider='openai-codex', model='gpt-5.6-sol', ${USAGE})
out['answer'] = ctx.commands['pace']('auto PLAN.md')
time.sleep(0.5)
out['injected'] = ctx.injected
`, { HERMES_SESSION_PLATFORM: 'telegram', HERMES_SESSION_KEY: 'agent:main:telegram:dm:42' })
    expect(out.answer).toBe('Auto mode on: PLAN.md')
    expect(out.injected[0].key).toBe('agent:main:telegram:dm:42')
    expect(out.injected[0].text).toContain('Work through the plan in PLAN.md')
  })

  test('a subagent\'s turns are not prompts of yours, its calls are its parent\'s, and /pace still answers for your session', () => {
    const { home, out } = run(`
ctx.hooks['pre_llm_call'](session_id='h1', user_message='fix the tests')
ctx.hooks['post_api_request'](session_id='h1', provider='openai-codex', model='gpt-5.6-sol', ${USAGE})
ctx.hooks['pre_llm_call'](session_id='c1', user_message='search the repo', parent_session_id='h1', platform='subagent')
ctx.hooks['post_api_request'](session_id='c1', provider='openai-codex', model='gpt-5.4-mini', platform='subagent', usage={'input_tokens': 50000}, context_length=128000)
ctx.hooks['post_auxiliary_call'](session_id='h1', provider='openai-codex', model='gpt-5.4-mini', aux_task='compression', usage={'input_tokens': 90000}, context_length=128000)
out['answer'] = ctx.commands['pace']('pane')
`)
    expect(existsSync(join(home, '.local/state/pace/feeds/hermes-c1-codex.json'))).toBe(false)
    const feed = feedOf(readFileSync(join(home, '.local/state/pace/feeds/hermes-h1-codex.json'), 'utf8'))!
    expect(feed.snapshot.prompts.length).toBe(1)
    expect(feed.context).toEqual({ tokens: 10_000, window: 272_000 })
    expect(out.answer).toContain('hermes · pace')
  })

  test('after the bridge restarts, a bot\'s session is still a bot\'s: the plugin tells the new bridge again', () => {
    const { out } = run(`
ctx.hooks['pre_llm_call'](session_id='h1', user_message='hi')
ctx.hooks['post_api_request'](session_id='h1', provider='openai-codex', model='gpt-5.6-sol', ${USAGE})
time.sleep(0.3)
pace._state['proc'].kill(); pace._state['proc'].wait()
ctx.hooks['post_api_request'](session_id='h1', provider='openai-codex', model='gpt-5.6-sol', ${USAGE})
out['answer'] = ctx.commands['pace']('window')
`, { HERMES_SESSION_PLATFORM: 'telegram', HERMES_SESSION_KEY: 'agent:main:telegram:dm:42' })
    expect(out.answer).toContain('Hermes (bot) has no window of its own')
  })

  test('a /pace prompt is not counted, and a provider pace does not pace writes nothing', () => {
    const { home } = run(`
ctx.hooks['pre_llm_call'](session_id='h1', user_message='/pace fleet')
ctx.hooks['post_api_request'](session_id='h1', provider='openrouter', model='x', ${USAGE})
`)
    expect(existsSync(join(home, '.local/state/pace/feeds/hermes-h1-codex.json'))).toBe(false)
  })
})
