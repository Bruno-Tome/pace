import { mock } from 'claude-code/testing'

export const NOW = Date.UTC(2026, 9, 17, 12, 0, 0)
export const H = 3600_000
export const iso = (ms: number) => new Date(ms).toISOString()

// 5-hour: 60% used with 60% of the window gone; the Fable week comes from the usage endpoint
export const LIMITS = [
  { kind: 'five_hour', percentUsed: 60, resetsAt: iso(NOW + 2 * H) },
  { kind: 'seven_day', percentUsed: 30, resetsAt: iso(NOW + 3 * 24 * H) },
]
export const USAGE = {
  limits: [
    { kind: 'session', percent: 60, resets_at: iso(NOW + 2 * H) },
    { kind: 'weekly_scoped', percent: 68, resets_at: iso(NOW + 3 * 24 * H), scope: { model: { display_name: 'Fable' } } },
  ],
}

export function world(on: any, env: Record<string, string> = {}) {
  const clock = mock.clock(on, { now: NOW })
  const stored: Record<string, unknown> = {}
  const status: (string | undefined)[] = []
  const files: Record<string, string> = {}
  on('store.get', (_$: unknown, e: { key: string }) => ({ value: stored[e.key] }))
  on('store.set', (_$: unknown, e: { key: string; value: unknown }) => { stored[e.key] = e.value; return { value: undefined } })
  on('session.usage', () => ({ value: { startedAt: NOW, context: { window: 200000 }, rateLimits: LIMITS } }))
  on('session.start', (_$: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('session.end', () => ({ sessionId: 's' }) as any)
  const submitted: string[] = []
  on('prompt.submit', (_$: unknown, e: { text: string }) => { submitted.push(e.text); return e })
  on('session.measure', (_$: unknown, e: { changed: string[] }) => ({ changed: e.changed }))
  on('classic.PostModelSwitch', () => ({}) as any)
  on('session.authorize', () => ({ value: { kind: 'bearer', handle: 'h' } }))
  let fetches = 0
  on('http.fetch', () => (fetches++, { value: { ok: true, status: 200, text: JSON.stringify(USAGE), headers: {} } }))
  on('env.get', (_$: unknown, e: { name: string }) => ({ value: e.name === 'HOME' ? '/home/u' : env[e.name] }))
  on('fs.write', (_$: unknown, e: { path: string; text: string }) => { files[e.path] = e.text; return { value: undefined } })
  on('fs.exists', (_$: unknown, e: { path: string }) => ({ value: e.path in files }))
  on('fs.read', (_$: unknown, e: { path: string }) => ({ value: files[e.path] ?? '' }))
  const registered: any[] = []
  on('command.register', (_$: unknown, e: { name: string }) => { registered.push(e); return { value: { command: e.name } } })
  const runs: string[][] = []
  on('process.run', (_$: unknown, e: { argv: string[] }) => {
    runs.push(e.argv)
    const stdout = e.argv[0] === '/usr/bin/which' ? '/opt/node/bin/node\n' : e.argv[1] === 'split-window' ? '%7\n' : ''
    return { value: { exitCode: 0, stdout, stderr: '' } }
  })
  const commands: string[] = []
  on('command.run', { command: 'compact' }, () => { commands.push('compact'); return { text: '' } as any })
  on('command.run', { command: 'clear' }, () => { commands.push('clear'); return { text: '' } as any })
  const notices: string[] = []
  on('ui.notify', (_$: unknown, e: { text: string }) => { notices.push(e.text); return { value: { isSent: true, channel: 'terminal_bell' } } })
  on('turn.complete', (_$: unknown, e: { answer: string }) => ({ text: e.answer }))
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'You are Claude.', scope: 'shared' }] }) as any)
  const forks: string[] = []
  on('model.fork', (_$: unknown, e: { prompt: string }) => {
    forks.push(e.prompt)
    return { value: { isAnswered: true, text: 'ok', usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 180_000, cache_creation_input_tokens: 0 } } } as any
  })
  const toasts: string[] = []
  on('ui.toast', (_$: unknown, e: { text: string }) => { toasts.push(e.text); return { value: undefined } })
  on('ui.status', (_$: unknown, e: { text: string | undefined }) => { status.push(e.text); return { value: undefined } })
  const opens: any[] = []
  on('ui.open', (_$: unknown, e: unknown) => { opens.push(e); return { value: { isPlaced: true } } })
  on('ui.close', () => ({ value: undefined }))
  on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'Box', props: { key: 'native' }, children: [] }) as any)
  return { stored, status, clock, files, opens, runs, commands, forks, toasts, registered, notices, submitted, fetches: () => fetches }
}

/** Every string in a drawn tree, joined: what the terminal shows, without the styling */
export const textOf = (n: any): string => (typeof n === 'string' ? n : Array.isArray(n) ? n.map(textOf).join('') : n && typeof n === 'object' ? textOf(n.children ?? []) : '')

/** Another plugin that reads `$.pace.snapshot()`, as a mod listing pace under `dependencies` does */
export const READER = {
  name: 'reader',
  register: (on: any) => {
    on('command.run', { command: 'probe' }, async ($: any) => ({ text: JSON.stringify(await $.pace.snapshot()) }))
  },
}
export const paceSnapshot = async (engine: any) => JSON.parse((await engine.command.run({ command: 'probe', args: '' })).text)

export const BAND = { hasSurvey: false, isWorking: false, maxRows: 4, bodyColumns: 120, scroll: {} }

/** A reply landing: the context it left and the session's rate limits */
export const reply = ($: any, tokens: number) =>
  $.session.measure({ context: { tokens, window: 1_000_000, percent: Math.round(tokens / 10_000) }, rateLimits: LIMITS, changed: ['context'] } as any)

/** A reply that also says what the session has cost so far */
export const pricedReply = ($: any, tokens: number, usd: number) =>
  $.session.measure({ context: { tokens, window: 1_000_000, percent: Math.round(tokens / 10_000) }, rateLimits: LIMITS, cost: { usd }, changed: ['context', 'cost'] } as any)
