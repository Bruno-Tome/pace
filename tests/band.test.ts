import { expect, mock, test } from 'claude-code/testing'

const NOW = Date.UTC(2026, 9, 17, 12, 0, 0)
const H = 3600_000
const iso = (ms: number) => new Date(ms).toISOString()

// 5-hour: 60% used with 60% of the window gone; the Fable week comes from the usage endpoint
const LIMITS = [
  { kind: 'five_hour', percentUsed: 60, resetsAt: iso(NOW + 2 * H) },
  { kind: 'seven_day', percentUsed: 30, resetsAt: iso(NOW + 3 * 24 * H) },
]
const USAGE = {
  limits: [
    { kind: 'session', percent: 60, resets_at: iso(NOW + 2 * H) },
    { kind: 'weekly_scoped', percent: 68, resets_at: iso(NOW + 3 * 24 * H), scope: { model: { display_name: 'Fable' } } },
  ],
}

function world(on: any) {
  const clock = mock.clock(on, { now: NOW })
  const stored: Record<string, unknown> = {}
  const status: (string | undefined)[] = []
  const files: Record<string, string> = {}
  on('store.get', (_$: unknown, e: { key: string }) => ({ value: stored[e.key] }))
  on('store.set', (_$: unknown, e: { key: string; value: unknown }) => { stored[e.key] = e.value; return { value: undefined } })
  on('session.usage', () => ({ value: { startedAt: NOW, context: { window: 200000 }, rateLimits: LIMITS } }))
  on('session.start', (_$: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('prompt.submit', (_$: unknown, e: unknown) => e)
  on('session.measure', (_$: unknown, e: { changed: string[] }) => ({ changed: e.changed }))
  on('classic.PostModelSwitch', () => ({}) as any)
  on('session.authorize', () => ({ value: { kind: 'bearer', handle: 'h' } }))
  let fetches = 0
  on('http.fetch', () => (fetches++, { value: { ok: true, status: 200, text: JSON.stringify(USAGE), headers: {} } }))
  on('env.get', (_$: unknown, e: { name: string }) => ({ value: e.name === 'HOME' ? '/home/u' : undefined }))
  on('fs.write', (_$: unknown, e: { path: string; text: string }) => { files[e.path] = e.text; return { value: undefined } })
  on('fs.exists', (_$: unknown, e: { path: string }) => ({ value: e.path in files }))
  on('fs.read', (_$: unknown, e: { path: string }) => ({ value: files[e.path] ?? '' }))
  on('command.register', (_$: unknown, e: { name: string }) => ({ value: { command: e.name } }))
  const runs: string[][] = []
  on('process.run', (_$: unknown, e: { argv: string[] }) => {
    runs.push(e.argv)
    return { value: { exitCode: 0, stdout: e.argv[0] === '/usr/bin/which' ? '/opt/node/bin/node\n' : '', stderr: '' } }
  })
  const commands: string[] = []
  on('command.run', { command: 'compact' }, () => { commands.push('compact'); return { text: '' } as any })
  const forks: string[] = []
  on('model.fork', (_$: unknown, e: { prompt: string }) => {
    forks.push(e.prompt)
    return { value: { isAnswered: true, text: 'ok', usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 180_000, cache_creation_input_tokens: 0 } } } as any
  })
  on('ui.toast', () => ({ value: undefined }))
  on('ui.status', (_$: unknown, e: { text: string | undefined }) => { status.push(e.text); return { value: undefined } })
  const opens: any[] = []
  on('ui.open', (_$: unknown, e: unknown) => { opens.push(e); return { value: { isPlaced: true } } })
  on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'Box', props: { key: 'native' }, children: [] }) as any)
  return { stored, status, clock, files, opens, runs, commands, forks, fetches: () => fetches }
}

/** Every string in a drawn tree, joined: what the terminal shows, without the styling */
const textOf = (n: any): string => (typeof n === 'string' ? n : Array.isArray(n) ? n.map(textOf).join('') : n && typeof n === 'object' ? textOf(n.children ?? []) : '')

const BAND = { hasSurvey: false, isWorking: false, maxRows: 4, bodyColumns: 120, scroll: {} }

test('the band shows the 5-hour and Fable bars and calls a burst on an on-pace window a burst', async ($, on) => {
  const { status, clock } = world(on)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true } as any)
  // 20 prompts in the last 20 minutes on a window already at 60%
  for (let i = 0; i < 20; i++) {
    if (i) await clock.advance(60_000)
    await $.prompt.submit({ text: `p${i}` } as any)
  }
  const ui = await $.ui.mount({ plugin: 'pace', surface: 'terminal', component: 'AbovePrompt', props: BAND as any })
  const drawn = textOf(await ui.drawn({ in: 'pace-band' }))
  expect(drawn).toContain('5h ')
  expect(drawn).toContain('Fable wk ')
  expect(drawn).toContain('68%')
  expect(drawn).toContain('│')
  expect(drawn).toContain('40/h')
  expect(drawn).toContain('burst')
  expect(drawn).not.toContain('too fast')
  expect(status[status.length - 1]).toBe('5h 60% · Fable wk 68% · 40/h burst')
})

test('the band animates: the bars fill in, then a sheen sweeps across them, its text unchanged', async ($, on) => {
  world(on)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true } as any)
  const ui = await $.ui.mount({ plugin: 'pace', surface: 'terminal', component: 'AbovePrompt', props: BAND as any })
  const frames = new Set([JSON.stringify(await ui.drawn({ in: 'pace-band' }))])
  for (let i = 0; i < 30; i++) {
    await ui.advance(80)
    const t = await ui.drawn({ in: 'pace-band' })
    frames.add(JSON.stringify(t))
    expect(textOf(t)).toContain('Fable wk ')
    expect(textOf(t)).toContain('68%')
  }
  expect(frames.size).toBeGreaterThan(5)
})

test('/pace hide removes the band and /pace pane opens the pane', async ($, on) => {
  world(on)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true } as any)
  await $.command.run({ command: 'pace', args: 'hide' } as any)
  const band = await $.ui.mount({ plugin: 'pace', surface: 'terminal', component: 'AbovePrompt', props: BAND as any })
  expect(textOf(await band.drawn())).not.toContain('5h ')
  await $.command.run({ command: 'pace', args: 'pane' } as any)
  const pane = await $.ui.mount({ plugin: 'pace', surface: 'terminal', component: 'Pane', requestId: 'pace', props: { bodyColumns: 70 } as any } as any)
  const drawn = textOf(await pane.drawn())
  expect(drawn).toContain('5-hour window')
  expect(drawn).toContain('Fable')
  expect(drawn).toContain('Prompting')
  expect(drawn).toContain('/pace show band')
})

const ROW = '/home/u/.claude/pace-row.txt'

test('placement status draws the band as a status-line row instead of above the prompt', { options: { placement: 'status' } }, async ($, on) => {
  const { files } = world(on)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true } as any)
  const row = files[ROW] ?? ''
  expect(row).toContain('\x1b[')
  expect(row.replace(/\x1b\[[0-9;]*m/g, '')).toContain('5h ')
  expect(row.replace(/\x1b\[[0-9;]*m/g, '')).toContain('Fable wk ')
  expect(row).toContain('│')
  const band = await $.ui.mount({ plugin: 'pace', surface: 'terminal', component: 'AbovePrompt', props: BAND as any })
  expect(textOf(await band.drawn())).not.toContain('5h ')
})

test('placement above leaves the status-line row empty', { options: { placement: 'above' } }, async ($, on) => {
  const { files } = world(on)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true } as any)
  expect(files[ROW]).toBe('')
})

test('the band is the pane in brief: one bar row per quota, the 5-hour first, the Fable week under it, the cache last', async ($, on) => {
  world(on)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true } as any)
  const ui = await $.ui.mount({ plugin: 'pace', surface: 'terminal', component: 'AbovePrompt', props: BAND as any })
  const tree: any = await ui.drawn({ in: 'pace-band' })
  // The quotas, then the cache
  expect(tree.children.length).toBe(3)
  const [five, week] = tree.children.map(textOf)
  expect(five).toContain('5h ')
  expect(five).toContain('│')
  expect(five).toContain('60%')
  expect(five).not.toContain('Fable')
  expect(week).toContain('Fable wk ')
  expect(week).toMatch(/[█░]{20}/)
  expect(week).toContain('68%')
  expect(week).toContain('On pace')
})

test('the pane draws each quota as a chart of usage against the pace line, with a projection', async ($, on) => {
  world(on)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true } as any)
  await $.command.run({ command: 'pace', args: 'pane' } as any)
  const pane = await $.ui.mount({ plugin: 'pace', surface: 'terminal', component: 'Pane', requestId: 'pace', props: { bodyColumns: 70 } as any } as any)
  const drawn = textOf(await pane.drawn())
  expect(drawn).toMatch(/[⠁-⣿]/)
  expect(drawn).toContain('100%')
  expect(drawn).toContain('projection')
  expect(drawn).toContain('pace')
  expect(drawn).not.toContain('░')
})

test('each band row judges the prompting rate against its own quota', async ($, on) => {
  const { clock } = world(on)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true } as any)
  for (let i = 0; i < 20; i++) {
    if (i) await clock.advance(60_000)
    await $.prompt.submit({ text: `p${i}` } as any)
  }
  const ui = await $.ui.mount({ plugin: 'pace', surface: 'terminal', component: 'AbovePrompt', props: BAND as any })
  const tree: any = await ui.drawn({ in: 'pace-band' })
  const [five, week] = tree.children.map(textOf)
  // The 5-hour window runs out before its reset at this rate; the week has no reading old enough to price a prompt
  expect(five).toContain('burst')
  expect(five).toContain('out in')
  expect(week).toContain('40/h')
  expect(week).not.toContain('too fast')
  for (const row of [five, week]) expect([...row].length).toBeLessThanOrEqual(BAND.bodyColumns)
})

test('/pace pane opens the pane tall enough for everything it shows, closed by Escape', async ($, on) => {
  const { opens } = world(on)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true } as any)
  await $.command.run({ command: 'pace', args: 'pane' } as any)
  const pane = await $.ui.mount({ plugin: 'pace', surface: 'terminal', component: 'Pane', requestId: 'pace', props: { bodyColumns: 70 } as any } as any)
  const tree: any = await pane.drawn()
  const count = (n: any): number => (n?.type === 'Text' ? 1 : (n?.children ?? []).reduce((a: number, c: any) => a + count(c), 0))
  const open = opens[opens.length - 1]
  expect(open.rows).toBeGreaterThanOrEqual(count(tree))
  expect(open.focus).toBe(true)
  expect(open.closeOnEscape).toBe(true)
})

/** A reply landing: the context it left and the session's rate limits */
const reply = ($: any, tokens: number) =>
  $.session.measure({ context: { tokens, window: 1_000_000, percent: Math.round(tokens / 10_000) }, rateLimits: LIMITS, changed: ['context'] } as any)

test('the band\'s third row counts the prompt cache down from the last reply, with what the next prompt costs', async ($, on) => {
  const { clock } = world(on)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true } as any)
  await reply($, 180_000)
  await clock.advance(17 * 60_000)
  const ui = await $.ui.mount({ plugin: 'pace', surface: 'terminal', component: 'AbovePrompt', props: BAND as any })
  let tree: any = await ui.drawn({ in: 'pace-band' })
  expect(tree.children.length).toBe(3)
  const row = textOf(tree.children[2])
  expect(row).toContain('cache')
  expect(row).toContain('43m')
  expect(row).toContain('180k')
  expect(row).toContain('18k')
  expect([...row].length).toBeLessThanOrEqual(BAND.bodyColumns)
  await clock.advance(60 * 60_000)
  tree = await ui.drawn({ in: 'pace-band' })
  expect(textOf(tree.children[2])).toContain('cold')
  expect(textOf(tree.children[2])).toContain('/compact')
})

test('a model switch that reports a 5-minute cache shortens the timer', async ($, on) => {
  const { clock } = world(on)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true } as any)
  await $.classic.PostModelSwitch({ from_model: 'a', to_model: 'b', requested_model: null, source: 'command', context_tokens: 180_000, prompt_cache_warm: true, cache_ttl: '5m', estimated_cache_write_usd: 1, pricing: 'catalog' } as any)
  await reply($, 180_000)
  await clock.advance(2 * 60_000)
  const ui = await $.ui.mount({ plugin: 'pace', surface: 'terminal', component: 'AbovePrompt', props: BAND as any })
  const tree: any = await ui.drawn({ in: 'pace-band' })
  expect(textOf(tree.children[2])).toContain('3m')
})

test('the pane shows the cache, the context and what to do about token usage', async ($, on) => {
  const { clock } = world(on)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true } as any)
  await reply($, 720_000)
  await clock.advance(5 * 60_000)
  await $.command.run({ command: 'pace', args: 'pane' } as any)
  const pane = await $.ui.mount({ plugin: 'pace', surface: 'terminal', component: 'Pane', requestId: 'pace', props: { bodyColumns: 70 } as any } as any)
  const drawn = textOf(await pane.drawn())
  expect(drawn).toContain('Cache & tokens')
  expect(drawn).toContain('55m')
  expect(drawn).toContain('720k')
  expect(drawn).toContain('Suggestions')
  expect(drawn).toContain('72%')
})

test('a burst over a window already over pace is too fast', async ($, on) => {
  const { clock } = world(on)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true } as any)
  for (let i = 0; i < 20; i++) {
    if (i) await clock.advance(60_000)
    await $.prompt.submit({ text: `p${i}` } as any)
  }
  // Then a reply: 80% used with about 65% of the window gone, over pace, the average alone running it out before the reset
  await $.session.measure({ context: { window: 1_000_000 }, rateLimits: [{ kind: 'five_hour', percentUsed: 80, resetsAt: iso(NOW + 2 * H) }], changed: ['rateLimits'] } as any)
  const ui = await $.ui.mount({ plugin: 'pace', surface: 'terminal', component: 'AbovePrompt', props: BAND as any })
  const tree: any = await ui.drawn({ in: 'pace-band' })
  expect(textOf(tree.children[0])).toContain('too fast')
})

test('/pace opens the charts full-screen in a terminal window of their own, fed by a state file', async ($, on) => {
  const { files, runs } = world(on)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true } as any)
  const r: any = await $.command.run({ command: 'pace', args: '' } as any)
  const state = JSON.parse(files['/home/u/.claude/pace-state.json'] ?? 'null')
  expect(state.samples.length).toBeGreaterThan(0)
  const script = files['/home/u/.claude/pace-view.command'] ?? ''
  expect(script).toContain("'/opt/node/bin/node'")
  expect(script).toContain('/bin/viewer.ts')
  expect(script).toContain("'/home/u/.claude/pace-keys.json'")
  expect(runs).toContainEqual(['chmod', '+x', '/home/u/.claude/pace-view.command'])
  expect(runs).toContainEqual(['open', '-a', 'Terminal', '/home/u/.claude/pace-view.command'])
  expect(r.text).toContain('window')
})

test('warm mode compact compacts once when an idle cache nears its end, then waits for the next prompt', async ($, on) => {
  const { clock, commands } = world(on)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true } as any)
  await $.command.run({ command: 'pace', args: 'warm compact' } as any)
  await reply($, 180_000)
  await clock.advance(49 * 60_000)
  expect(commands).toEqual([])
  await clock.advance(2 * 60_000)
  expect(commands).toEqual(['compact'])
  await clock.advance(60 * 60_000)
  expect(commands).toEqual(['compact'])
})

test('warm mode ping reads the cache through a fork and restarts its timer, the conversation untouched', async ($, on) => {
  const { clock, forks, commands } = world(on)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true } as any)
  await $.command.run({ command: 'pace', args: 'warm ping' } as any)
  await reply($, 180_000)
  await clock.advance(51 * 60_000)
  expect(forks.length).toBe(1)
  expect(commands).toEqual([])
  const ui = await $.ui.mount({ plugin: 'pace', surface: 'terminal', component: 'AbovePrompt', props: BAND as any })
  const tree: any = await ui.drawn({ in: 'pace-band' })
  expect(textOf(tree.children[2])).toMatch(/ 5\dm /)
})

test('the band\'s rows split in one column: figures left of it, the rate or the suggestion right of it', async ($, on) => {
  const { clock } = world(on)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true } as any)
  for (let i = 0; i < 6; i++) {
    if (i) await clock.advance(60_000)
    await $.prompt.submit({ text: `p${i}` } as any)
  }
  await reply($, 180_000)
  for (const [mins, cols] of [[0, 120], [57, 120], [0, 90]] as const) {
    await clock.advance(mins * 60_000)
    const ui = await $.ui.mount({ plugin: 'pace', surface: 'terminal', component: 'AbovePrompt', props: { ...BAND, bodyColumns: cols } as any })
    const tree: any = await ui.drawn({ in: 'pace-band' })
    const at = tree.children.map((c: any) => [...textOf(c)].join('').indexOf('  │  '))
    expect(at.length).toBe(3)
    expect(at[0]).toBeGreaterThan(0)
    expect(new Set(at).size).toBe(1)
  }
})

test('the window\'s keys reach the session: w steps warm mode off → ping → compact → off, r refreshes the figures', async ($, on) => {
  const { clock, files, stored, fetches } = world(on)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true } as any)
  await $.command.run({ command: 'pace', args: '' } as any)
  let pressed = 0
  const key = async (cmd: string) => {
    files['/home/u/.claude/pace-keys.json'] = JSON.stringify({ id: NOW + ++pressed, cmd })
    await clock.advance(3000)
  }
  await key('warm')
  expect((stored.prefs as any).warm).toBe('ping')
  await key('warm')
  expect((stored.prefs as any).warm).toBe('compact')
  await key('warm')
  expect((stored.prefs as any).warm).toBe('off')
  expect(JSON.parse(files['/home/u/.claude/pace-state.json']!).warm).toBe('off')
  const before = fetches()
  await key('refresh')
  expect(fetches()).toBe(before + 1)
  // A key already handled is not handled again
  await clock.advance(3000)
  expect(fetches()).toBe(before + 1)
})

const pricedReply = ($: any, tokens: number, usd: number) =>
  $.session.measure({ context: { tokens, window: 1_000_000, percent: Math.round(tokens / 10_000) }, rateLimits: LIMITS, cost: { usd }, changed: ['context', 'cost'] } as any)

test('the next prompt\'s cost shows in dollars, priced from what the session\'s own replies cost', async ($, on) => {
  const { clock, stored } = world(on)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true } as any)
  // A cold write of 100k at 2× (200k equivalents) for $0.50, then a warm read of it plus 20k written (50k) for $0.125
  await pricedReply($, 100_000, 0.5)
  await clock.advance(60_000)
  await pricedReply($, 120_000, 0.625)
  const ui = await $.ui.mount({ plugin: 'pace', surface: 'terminal', component: 'AbovePrompt', props: BAND as any })
  const tree: any = await ui.drawn({ in: 'pace-band' })
  // Warm: 12k equivalents at $2.50 a million
  expect(textOf(tree.children[2])).toContain('$0.03')
  await $.command.run({ command: 'pace', args: 'pane' } as any)
  const pane = await $.ui.mount({ plugin: 'pace', surface: 'terminal', component: 'Pane', requestId: 'pace', props: { bodyColumns: 100 } as any } as any)
  const drawn = textOf(await pane.drawn())
  expect(drawn).toContain('$0.03')
  expect(drawn).toContain('$0.60')
  // The price carries to the next session
  expect(Array.isArray(stored.prices)).toBe(true)
})

test('without priced replies the cost stays in tokens', async ($, on) => {
  const { clock } = world(on)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true } as any)
  await reply($, 180_000)
  await clock.advance(60_000)
  const ui = await $.ui.mount({ plugin: 'pace', surface: 'terminal', component: 'AbovePrompt', props: BAND as any })
  expect(textOf((await ui.drawn({ in: 'pace-band' }) as any).children[2])).not.toContain('$')
})

test('parallel sessions pace together: the rate is every session\'s dollars an hour against what the quota has left', async ($, on) => {
  const { stored } = world(on)
  // The 5-hour window moved 10 points per half hour while another session spent $20, then $30
  stored.samples = Array.from({ length: 5 }, (_, i) => ({ at: NOW - 150 * 60_000 + i * 30 * 60_000, quotas: { five_hour: { percent: 10 + 10 * i, resetsAt: NOW + 2 * H } } }))
  stored.spend = Array.from({ length: 5 }, (_, i) => ({ t: NOW - 120 * 60_000 + i * 30 * 60_000 - 60_000, id: 'other', usd: i === 4 ? 30 : 20 }))
  stored.prompts = Array.from({ length: 10 }, (_, i) => NOW - i * 10 * 60_000)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true } as any)
  // This session spends $1 too
  await pricedReply($, 100_000, 0.5)
  await pricedReply($, 110_000, 1.5)
  const ui = await $.ui.mount({ plugin: 'pace', surface: 'terminal', component: 'AbovePrompt', props: BAND as any })
  const tree: any = await ui.drawn({ in: 'pace-band' })
  expect(textOf(tree.children[0])).toContain('$62/h')
  expect((stored.spend as any[]).some(s => s.id !== 'other')).toBe(true)
  await $.command.run({ command: 'pace', args: 'pane' } as any)
  const pane = await $.ui.mount({ plugin: 'pace', surface: 'terminal', component: 'Pane', requestId: 'pace', props: { bodyColumns: 100 } as any } as any)
  const drawn = textOf(await pane.drawn())
  expect(drawn).toContain('2 sessions')
  expect(drawn).toMatch(/~\d+(\.\d+)?% per prompt/)
})
