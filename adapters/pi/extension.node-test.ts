// The pi extension end to end: pi's events in, the session's feed and the band out, in a scratch home. pi is faked
// by what the extension uses of it. Run by Node: `node --test adapters/pi/extension.node-test.ts`.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from '../../testing/node.ts'
import { feedFile, feedOf } from '../../core/host.ts'
import extension from './extension.ts'

type Handler = (event: unknown, ctx: unknown) => unknown

const PATH = process.env.PATH

/** A pi of the test's own: its handlers, and what the extension drew in its widget and its footer */
function fakePi(o: { oauth?: boolean; provider?: string; cwd?: string } = {}) {
  const handlers = new Map<string, Handler[]>()
  const drawn = { widget: undefined as string[] | undefined, status: undefined as string | undefined, notes: [] as string[], overlay: undefined as string[] | undefined, compacted: 0, sent: [] as string[], models: [] as string[], thinking: [] as string[] }
  // The models pi offers on the sign-in: ChatGPT's two
  const models = [{ provider: 'openai', id: 'gpt-5.6-sol' }, { provider: 'openai', id: 'gpt-5.4-mini' }, { provider: 'anthropic', id: 'claude-opus-5-5' }]
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => unknown }>()
  const ctx = {
    cwd: o.cwd ?? '/work/pace', hasUI: true,
    model: { provider: o.provider ?? 'openai', id: 'gpt-5.6-sol' },
    modelRegistry: { isUsingOAuth: () => o.oauth ?? true, getAvailable: () => models, find: (provider: string, id: string) => models.find(m => m.provider === provider && m.id === id) },
    sessionManager: { getSessionId: () => 'p1' },
    getContextUsage: () => ({ tokens: 9_000, contextWindow: 272_000, percent: 3.3 }),
    compact: () => { drawn.compacted += 1 },
    isIdle: () => true,
    ui: {
      setWidget: (_key: string, lines: string[] | undefined) => { drawn.widget = lines },
      setStatus: (_key: string, text: string | undefined) => { drawn.status = text },
      notify: (text: string) => { drawn.notes.push(text) },
      custom: async (factory: (tui: unknown, theme: unknown, kb: unknown, done: () => void) => { render(width: number): string[] }) => {
        drawn.overlay = factory({ requestRender: () => {} }, {}, {}, () => {}).render(100)
      },
    },
  }
  const pi = {
    on: (name: string, h: Handler) => handlers.set(name, [...(handlers.get(name) ?? []), h]),
    registerCommand: (name: string, c: { handler: (args: string, ctx: unknown) => unknown }) => commands.set(name, c),
    sendUserMessage: (text: string) => { drawn.sent.push(text) },
    getThinkingLevel: () => 'medium',
    setThinkingLevel: (level: string) => { drawn.thinking.push(level) },
    setModel: async (m: { id: string }) => { drawn.models.push(m.id); ctx.model = { provider: 'openai', id: m.id }; return true },
  }
  const pace = async (args: string) => { await commands.get('pace')!.handler(args, ctx) }
  const fire = async (name: string, event: object = {}) => {
    let out: unknown
    for (const h of handlers.get(name) ?? []) out = (await h({ type: name, ...event }, ctx)) ?? out
    return out
  }
  return { pi, fire, drawn, pace }
}

/** A scratch home; with `codex`, a live Codex session's feed in it: the 5-hour window 40% used, a prompt five minutes ago */
function home(codex = false): string {
  const dir = mkdtempSync(join(tmpdir(), 'pace-pi-'))
  const now = Date.now()
  mkdirSync(join(dir, '.local/state/pace/feeds'), { recursive: true })
  if (codex) writeFileSync(join(dir, feedFile('codex', 'c1')), JSON.stringify({
    version: 1, host: 'codex', provider: 'codex', session: 'c1', cwd: '/work/api', at: now,
    snapshot: { samples: [{ at: now - 60_000, quotas: { five_hour: { percent: 40, resetsAt: now + 2 * 3600_000 } } }], prompts: [now - 300_000], cache: null, noCache: true },
  }))
  process.env.HOME = dir
  // Outside Herdr and tmux, whatever runs the tests: /pace must never reach the real apps
  delete process.env.HC_TERMINAL_ID
  delete process.env.TMUX
  return dir
}

/** A reply as pi ends it: what it cost, or the error that stopped it */
const reply = (o: { usd?: number; error?: string; cacheRead?: number; text?: string; aborted?: boolean }) => ({
  message: {
    role: 'assistant', content: [{ type: 'text', text: o.text ?? 'Done.' }],
    usage: { input: 500, cacheRead: o.cacheRead ?? 0, cacheWrite: 0, cost: { total: o.usd ?? 0 } },
    stopReason: o.aborted ? 'aborted' : o.error ? 'error' : 'stop', ...(o.error ? { errorMessage: o.error } : {}),
  },
})

/** ChatGPT's answer once a subscription's usage limit is reached, as pi reports it */
const LIMIT = 'Codex error: {"type":"usage_limit_reached","code":"subscription_sharing_usage_limit_exceeded"}'

const feedIn = (dir: string) => feedOf(readFileSync(join(dir, feedFile('pi', 'p1')), 'utf8'))!

describe('the pi extension', () => {
  test('stands alone: writes the session\'s feed with its prompts, its spend and its context', async () => {
    const dir = home()
    const { pi, fire } = fakePi()
    extension(pi)
    await fire('session_start', { reason: 'startup' })
    await fire('input', { text: 'fix the tests', source: 'interactive' })
    await fire('message_end', reply({ usd: 3.2 }))
    const feed = feedIn(dir)
    expect(feed).toMatchObject({ host: 'pi', provider: 'codex', session: 'p1', cwd: '/work/pace', context: { tokens: 9_000, window: 272_000 } })
    expect(feed.snapshot.prompts.length).toBe(1)
    expect(feed.snapshot.spend!.reduce((n, x) => n + x.usd, 0)).toBe(3.2)
    expect(feed.snapshot.samples).toEqual([])
    await fire('session_shutdown', { reason: 'quit' })
  })

  test('before it knows what a window holds, the band shows the spend; the footer too', async () => {
    home()
    const { pi, fire, drawn } = fakePi()
    extension(pi)
    await fire('input', { text: 'fix the tests', source: 'interactive' })
    await fire('message_end', reply({ usd: 3.2 }))
    expect(drawn.widget!.join('\n')).toContain('$3.20 spent')
    expect(drawn.status).toContain('5h $3.20')
    await fire('session_shutdown', { reason: 'quit' })
    expect(drawn.widget).toBeUndefined()
  })

  test('a usage limit reached teaches it what the window holds, for every pi session after', async () => {
    const dir = home()
    const { pi, fire, drawn } = fakePi()
    extension(pi)
    await fire('input', { text: 'fix the tests', source: 'interactive' })
    await fire('message_end', reply({ usd: 8 }))
    await fire('message_end', reply({ error: LIMIT }))
    expect(JSON.parse(readFileSync(join(dir, '.local/state/pace/pi/codex.json'), 'utf8')).five_hour).toMatchObject({ usd: 8, source: 'limit' })
    expect(drawn.widget!.join('\n')).toContain('~100%')
    await fire('session_shutdown', { reason: 'quit' })
  })

  test('on ChatGPT, whose token names no email, joins the one account Codex is signed in with here', async () => {
    const dir = home()
    const now = Date.now()
    writeFileSync(join(dir, feedFile('codex', 'c1')), JSON.stringify({
      version: 1, host: 'codex', provider: 'codex', account: 'aaaa000011112222', session: 'c1', cwd: '/work/api', at: now,
      snapshot: { samples: [], prompts: [], cache: null, noCache: true },
    }))
    const { pi, fire } = fakePi()
    extension(pi)
    await fire('session_start', { reason: 'startup' })
    expect(feedIn(dir).account).toBe('aaaa000011112222')
    await fire('session_shutdown', { reason: 'quit' })
  })

  test('with two ChatGPT accounts here and none of its own, borrows neither one\'s readings', async () => {
    const dir = home()
    const now = Date.now()
    for (const [session, account, percent] of [['c1', 'aaaa000011112222', 40], ['h1', 'bbbb000011112222', 0]] as const) {
      writeFileSync(join(dir, feedFile('codex', session)), JSON.stringify({
        version: 1, host: 'codex', provider: 'codex', account, session, cwd: '/work/api', at: now,
        snapshot: { samples: [{ at: now - 60_000, quotas: { five_hour: { percent, resetsAt: now + 7200_000 } } }], prompts: [], cache: null, noCache: true },
      }))
    }
    const { pi, fire } = fakePi()
    extension(pi)
    await fire('session_start', { reason: 'startup' })
    expect(feedIn(dir).account).toBeUndefined()
    expect(feedIn(dir).snapshot.samples).toEqual([])
    await fire('session_shutdown', { reason: 'quit' })
  })

  test('takes a live Codex session\'s real reading over its own estimate', async () => {
    const dir = home(true)
    const { pi, fire, drawn } = fakePi()
    extension(pi)
    await fire('session_start', { reason: 'startup' })
    expect(feedIn(dir).snapshot.samples.map(x => x.quotas.five_hour!.percent)).toEqual([40])
    expect(drawn.status).toContain('40%')
    await fire('session_shutdown', { reason: 'quit' })
  })

  test('/pace hide hides the band for every pi session, and /pace show brings it back', async () => {
    const dir = home()
    const { pi, fire, drawn, pace } = fakePi()
    extension(pi)
    await fire('message_end', reply({ usd: 3.2 }))
    await pace('hide')
    expect(drawn.widget).toBeUndefined()
    expect(drawn.notes).toEqual(['Pace band hidden; /pace show brings it back'])
    expect(JSON.parse(readFileSync(join(dir, '.local/state/pace/pi/prefs.json'), 'utf8'))).toMatchObject({ band: false })
    await fire('agent_settled')
    expect(drawn.widget).toBeUndefined()
    await pace('show')
    expect(drawn.widget!.join('\n')).toContain('$3.20 spent')
    await fire('session_shutdown', { reason: 'quit' })
  })

  test('/pace outside Herdr opens the charts over pi; what it cannot read, it says in a notification', async () => {
    home(true)
    const { pi, fire, drawn, pace } = fakePi()
    extension(pi)
    await fire('session_start', { reason: 'startup' })
    await pace('')
    expect(drawn.overlay!.join('\n')).toContain('40%')
    await pace('faster')
    expect(drawn.notes.at(-1)).toContain('Unknown argument "faster"')
    await fire('session_shutdown', { reason: 'quit' })
  })

  test('in Herdr /pace opens there first, and over pi when Herdr cannot', async () => {
    home(true)
    const { pi, fire, drawn, pace } = fakePi()
    extension(pi)
    await fire('session_start', { reason: 'startup' })
    // A Herdr with no herdr-app on the PATH: the charts open over pi instead
    process.env.HC_TERMINAL_ID = 't9'
    process.env.PATH = '/nonexistent'
    try {
      await pace('pane')
    } finally {
      delete process.env.HC_TERMINAL_ID
      process.env.PATH = PATH
    }
    expect(drawn.overlay!.join('\n')).toContain('40%')
    expect(drawn.notes.at(-1)).toContain('Could not open pace in Herdr')
    await fire('session_shutdown', { reason: 'quit' })
  })

  test('a reply that read the cache starts its hour: the cache is in the feed', async () => {
    const dir = home()
    const { pi, fire } = fakePi()
    extension(pi)
    await fire('message_end', reply({ usd: 0.1, cacheRead: 11_500 }))
    expect(feedIn(dir).snapshot.cache).toMatchObject({ tokens: 12_000, window: 272_000, ttl: '1h' })
    await fire('session_shutdown', { reason: 'quit' })
  })

  test('on pace mode compacts a heavy context once its run settles, while its cache is warm', async () => {
    const dir = home()
    mkdirSync(join(dir, '.local/state/pace/pi'), { recursive: true })
    writeFileSync(join(dir, '.local/state/pace/pi/prefs.json'), JSON.stringify({ onPace: true }))
    const { pi, fire, drawn } = fakePi()
    extension(pi)
    // 200k of a 272k window: heavy
    await fire('message_end', reply({ usd: 0.5, cacheRead: 199_500 }))
    await fire('agent_settled')
    expect(drawn.compacted).toBe(1)
    expect(drawn.notes).toContain('pace: compacting a heavy context while its cache is warm')
    await fire('session_shutdown', { reason: 'quit' })
  })

  test('says a warning once per window, as Claude Code does', async () => {
    const dir = home(true)
    // The Codex session's 5-hour window at 85%
    const path = join(dir, feedFile('codex', 'c1'))
    writeFileSync(path, readFileSync(path, 'utf8').replace('"percent":40', '"percent":85'))
    const { pi, fire, drawn } = fakePi()
    extension(pi)
    await fire('session_start', { reason: 'startup' })
    await fire('agent_settled')
    expect(drawn.notes.filter(n => n.includes('85% used')).length).toBe(1)
    await fire('session_shutdown', { reason: 'quit' })
  })

  test('a prompt pi sends for an extension is not one of the user\'s', async () => {
    const dir = home()
    const { pi, fire } = fakePi()
    extension(pi)
    await fire('input', { text: 'continue', source: 'extension' })
    expect(feedIn(dir).snapshot.prompts.length).toBe(0)
    await fire('session_shutdown', { reason: 'quit' })
  })

  test('on an API key there is no quota to pace: no feed, and nothing drawn', async () => {
    const dir = home()
    const { pi, fire, drawn } = fakePi({ oauth: false })
    extension(pi)
    await fire('session_start', { reason: 'startup' })
    expect(existsSync(join(dir, feedFile('pi', 'p1')))).toBe(false)
    expect(drawn.widget).toBeUndefined()
    await fire('session_shutdown', { reason: 'quit' })
  })
})

describe('auto mode in pi', () => {
  test('/pace auto starts a run: its first prompt sent, auto mode\'s instructions in the system prompt', async () => {
    const dir = home()
    const { pi, fire, drawn, pace } = fakePi()
    extension(pi)
    await pace('auto PLAN.md')
    expect(drawn.sent).toEqual(['Work through the plan in PLAN.md, one step per turn, following pace\'s auto mode instructions. Start with its first unfinished step.'])
    expect(drawn.notes).toContain('Auto mode on: PLAN.md')
    expect(feedIn(dir).snapshot.auto).toEqual({ plan: 'PLAN.md', turns: 1, max: 40 })
    const r = (await fire('before_agent_start', { systemPrompt: 'You are pi.' })) as { systemPrompt: string }
    expect(r.systemPrompt).toContain('You are pi.')
    expect(r.systemPrompt).toContain('# Auto mode (pace)')
    await fire('session_shutdown', { reason: 'quit' })
  })

  test('after each run it sends the next prompt, until the plan is done', async () => {
    const dir = home()
    const { pi, fire, drawn, pace } = fakePi()
    extension(pi)
    await pace('auto PLAN.md')
    await fire('message_end', reply({ text: 'Ticked step 1.\nPACE: NEXT' }))
    await fire('agent_settled')
    expect(drawn.sent.at(-1)).toBe('Continue with the next unfinished step of PLAN.md.')
    expect(feedIn(dir).snapshot.auto).toMatchObject({ turns: 2 })
    await fire('message_end', reply({ text: 'PACE: DONE' }))
    await fire('agent_settled')
    expect(drawn.notes).toContain('pace: Auto mode off. Plan done: PLAN.md')
    expect(feedIn(dir).snapshot.auto ?? null).toBeNull()
    expect(drawn.sent.length).toBe(2)
    await fire('session_shutdown', { reason: 'quit' })
  })

  test('an interrupted run pauses until /pace auto resume', async () => {
    const dir = home()
    const { pi, fire, drawn, pace } = fakePi()
    extension(pi)
    await pace('auto PLAN.md')
    await fire('message_end', reply({ aborted: true }))
    await fire('agent_settled')
    expect(feedIn(dir).snapshot.auto).toMatchObject({ paused: true })
    await pace('auto resume')
    expect(feedIn(dir).snapshot.auto).toEqual({ plan: 'PLAN.md', turns: 2, max: 40 })
    expect(drawn.sent.at(-1)).toBe('Continue with the next unfinished step of PLAN.md.')
    await fire('session_shutdown', { reason: 'quit' })
  })

  test('/pace ultra works through the plan on pi\'s own ladder, and shifts down when a quota runs ahead', async () => {
    const dir = home(true)
    const path = join(dir, feedFile('codex', 'c1'))
    // The 5-hour window over pace and moving slowly: 60% an hour ago, 62% now, with three of its five hours left
    const now = Date.now()
    const codex = JSON.parse(readFileSync(path, 'utf8'))
    const reset = now + 3 * 3600_000
    codex.snapshot.samples = [{ at: now - 3600_000, quotas: { five_hour: { percent: 60, resetsAt: reset } } }, { at: now - 60_000, quotas: { five_hour: { percent: 62, resetsAt: reset } } }]
    codex.snapshot.prompts = []
    writeFileSync(path, JSON.stringify(codex))
    const { pi, fire, drawn, pace } = fakePi()
    extension(pi)
    await fire('session_start', { reason: 'startup' })
    await pace('ultra PLAN.md 10 mini..sol')
    expect(feedIn(dir).snapshot.auto).toMatchObject({ plan: 'PLAN.md', max: 10, gears: { floor: 'gpt-5.4-mini', ceiling: 'gpt-5.6-sol', model: 'gpt-5.6-sol', effort: 'medium' } })
    expect(drawn.sent.length).toBe(1)
    await fire('message_end', reply({ text: 'Step one done.' }))
    await fire('agent_settled')
    expect(drawn.thinking).toContain('low')
    expect(drawn.models).toEqual(['gpt-5.4-mini'])
    expect(feedIn(dir).snapshot.auto!.gears!.gear).toMatchObject({ model: 'gpt-5.4-mini', effort: 'low' })
    await fire('session_shutdown', { reason: 'quit' })
  })

  test('a quota gassed out holds the run, saying until when', async () => {
    const dir = home(true)
    const path = join(dir, feedFile('codex', 'c1'))
    writeFileSync(path, readFileSync(path, 'utf8').replace('"percent":40', '"percent":100'))
    const { pi, fire, drawn, pace } = fakePi()
    extension(pi)
    await pace('auto PLAN.md')
    await fire('message_end', reply({ text: 'PACE: NEXT' }))
    await fire('agent_settled')
    expect(drawn.sent.length).toBe(1)
    expect(drawn.notes.some(n => n.includes('Auto mode holding until'))).toBe(true)
    expect(feedIn(dir).snapshot.auto!.heldUntil).toBeGreaterThan(Date.now())
    await fire('session_shutdown', { reason: 'quit' })
  })

  test('/pace auto off ends the run', async () => {
    const dir = home()
    const { pi, fire, drawn, pace } = fakePi()
    extension(pi)
    await pace('auto PLAN.md')
    await pace('auto off')
    expect(feedIn(dir).snapshot.auto ?? null).toBeNull()
    expect(drawn.notes.at(-1)).toBe('Auto mode off')
    await fire('session_shutdown', { reason: 'quit' })
  })
})

describe('the plan\'s timeline in pi', () => {
  test('/pace plan draws the plan\'s steps over pi', async () => {
    const dir = home()
    writeFileSync(join(dir, 'PLAN.md'), '# Plan\n\n- [x] Read the feed\n- [ ] Draw the band\n')
    const { pi, fire, drawn, pace } = fakePi({ cwd: dir })
    extension(pi)
    await pace('plan PLAN.md')
    const text = drawn.overlay!.join('\n').replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
    expect(text).toContain('Read the feed')
    expect(text).toContain('Draw the band')
    await fire('session_shutdown', { reason: 'quit' })
  })
})
