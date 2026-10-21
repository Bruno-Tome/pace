import { expect, test } from 'claude-code/testing'

import { BAND, H, iso, LIMITS, NOW, paceSnapshot, pricedReply, READER, reply, textOf, USAGE, world } from './world.ts'

/** The usage endpoint reporting the Fable week alone: the 5-hour window keeps only the reading the session starts with */
const FABLE_ONLY = { limits: USAGE.limits.filter(l => l.kind === 'weekly_scoped') }

test('the band shows the 5-hour and Fable bars and calls a burst on an on-pace window a burst', async ($, on) => {
  // The 5-hour window's one reading is the session's at start: too few to measure its movement, so prompts price the rate
  const { status, clock } = world(on, {}, FABLE_ONLY)
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
  // 3 points a prompt at 40 prompts an hour: the 40 points left last 20 minutes
  expect(drawn).toContain('▲ burst · out in 20m at this rate')
  expect(drawn).not.toContain('too fast')
  expect(drawn).not.toContain('%/h')
  expect(status[status.length - 1]).toBe('5h 60% ▲ burst · out in 20m at this rate │ Fable wk 68% ● → —')
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

/** An ultra run of this session's in `gear`, stored as `claude --resume` finds it */
const ultraRun = (gear: object) => ({
  at: NOW - H, onPace: true,
  auto: { plan: 'PLAN.md', turns: 4, max: 80, ultra: {
    goal: 'Ship it.', check: null, phase: 'work', sinceReview: 0, quietReviews: 0, checkFails: 0,
    models: { floor: 'sonnet', ceiling: 'opus' }, headroomStreak: 0, gear,
  } },
})
const PUSH = { model: 'opus', effort: 'xhigh', subagents: 3, subagentModel: 'sonnet', fanout: true }

/** 30 frames of the band: each frame's tree as JSON, and the mark after `ultra` on the modes row */
async function bandFrames($: any): Promise<{ trees: string[]; sparks: Set<string> }> {
  const ui = await $.ui.mount({ plugin: 'pace', surface: 'terminal', component: 'AbovePrompt', props: BAND as any })
  const trees: string[] = []
  const sparks = new Set<string>()
  for (let i = 0; i < 30; i++) {
    await ui.advance(80)
    const t: any = await ui.drawn({ in: 'pace-band' })
    trees.push(JSON.stringify(t))
    const row = textOf(t.children.at(-1))
    if (row.startsWith('ultra ')) sparks.add([...row][6]!)
  }
  return { trees, sparks }
}

test('ultra pace in push goes super saiyan: gold sheen, crackling bars, a spark on its row', async ($, on) => {
  const w = world(on)
  w.stored['session:session-a'] = ultraRun(PUSH)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true } as any)
  const { trees, sparks } = await bandFrames($)
  expect(trees.some(t => t.includes('▓'))).toBe(true)
  expect(trees.some(t => t.includes('"color":"warning"') && t.includes('█'))).toBe(true)
  // The ▶ flickers through sparks, the word itself untouched
  expect(sparks.size).toBeGreaterThanOrEqual(3)
  expect([...sparks].every(c => '▶✦✧'.includes(c))).toBe(true)
})

test('the band without ultra pace keeps its calm: no crackle, no spark', async ($, on) => {
  world(on)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true } as any)
  const { trees } = await bandFrames($)
  expect(trees.some(t => t.includes('▓') || t.includes('✦'))).toBe(false)
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
  // As above: the prompts price the 5-hour window's rate, its readings too few to measure it
  const { clock } = world(on, {}, FABLE_ONLY)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true } as any)
  for (let i = 0; i < 20; i++) {
    if (i) await clock.advance(60_000)
    await $.prompt.submit({ text: `p${i}` } as any)
  }
  const ui = await $.ui.mount({ plugin: 'pace', surface: 'terminal', component: 'AbovePrompt', props: BAND as any })
  const tree: any = await ui.drawn({ in: 'pace-band' })
  const [five, week] = tree.children.map(textOf)
  // The 5-hour window runs out before its reset at this rate; the week has no reading old enough to price a prompt
  expect(five).toContain('▲ burst · out in 20m at this rate')
  // Never the prompts an hour every quota shares: where the week lands comes once a prompt's cost is known
  expect(week).toContain('→ —')
  expect(week).not.toContain('40/h')
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

test('a burst stops being called once the prompting stops: the quiet minutes count in the rate', async ($, on) => {
  const { clock } = world(on, {}, FABLE_ONLY)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true } as any)
  // A fresh 5-hour window 20 minutes in: 3% to 9% in 8 minutes, a prompt before each reading
  const resetsAt = iso(NOW + 4 * H + 40 * 60_000)
  for (const [i, pct] of [3, 5, 6, 8, 9].entries()) {
    if (i) await clock.advance(2 * 60_000)
    await $.prompt.submit({ text: `p${i}` } as any)
    await $.session.measure({ context: { window: 1_000_000 }, rateLimits: [{ kind: 'five_hour', percentUsed: pct, resetsAt }], changed: ['rateLimits'] } as any)
  }
  const band = async () => {
    const ui = await $.ui.mount({ plugin: 'pace', surface: 'terminal', component: 'AbovePrompt', props: BAND as any })
    return textOf(((await ui.drawn({ in: 'pace-band' })) as any).children[0])
  }
  // 45 points an hour while it climbs: out in about 2 hours, a burst
  expect(await band()).toContain('burst')
  // 8 minutes with no prompt: 9% with 4h24m left is on pace, and nothing says it runs out
  await clock.advance(8 * 60_000)
  const five = await band()
  expect(five).toContain('9%')
  expect(five).not.toContain('burst')
  expect(five).not.toContain('out in')
})

test('a Fable session burning the 5-hour window is paced by the Fable week, not called too fast on the window', async ($, on) => {
  const { clock, status } = world(on, {}, FABLE_ONLY)
  on('session.model', () => ({ value: 'claude-fable-5-1' }))
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true } as any)
  // A fresh 5-hour window: 0% to 10% in 12 minutes, every prompt to Fable
  const resetsAt = iso(NOW + 4 * H + 48 * 60_000)
  for (const [i, pct] of [0, 2, 5, 7, 10].entries()) {
    if (i) await clock.advance(3 * 60_000)
    await $.prompt.submit({ text: `p${i}` } as any)
    await $.session.measure({ context: { window: 1_000_000 }, rateLimits: [{ kind: 'five_hour', percentUsed: pct, resetsAt }], changed: ['rateLimits'] } as any)
  }
  const ui = await $.ui.mount({ plugin: 'pace', surface: 'terminal', component: 'AbovePrompt', props: BAND as any })
  const tree: any = await ui.drawn({ in: 'pace-band' })
  const five = textOf(tree.children[0])
  const week = textOf(tree.children[1])
  // The window's own fill still shows; the burst is Fable's, paced by its week
  expect(five).toContain('10%')
  expect(five).not.toContain('too fast')
  expect(five).not.toContain('out in')
  expect(week).toContain('Fable wk')
  expect(week).toContain('↻')
  expect(status[status.length - 1]).not.toContain('out in')
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

test('/pace window opens the charts full-screen in a terminal window of their own, fed by a state file', async ($, on) => {
  const { files, runs } = world(on)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true } as any)
  const r: any = await $.command.run({ command: 'pace', args: 'window' } as any)
  const state = JSON.parse(files['/home/u/.claude/pace-state.json'] ?? 'null')
  expect(state.samples.length).toBeGreaterThan(0)
  const script = files['/home/u/.claude/pace-view.command'] ?? ''
  expect(script).toContain("'/opt/node/bin/node'")
  expect(script).toContain('/bin/viewer.ts')
  expect(script).toContain("'/home/u/.claude/pace-keys.json'")
  expect(runs).toContainEqual(['chmod', '+x', '/home/u/.claude/pace-view.command'])
  expect(runs).toContainEqual(['open', '-a', 'Terminal', '/home/u/.claude/pace-view.command'])
  expect(r.text).toBeUndefined()
})

test('/pace inside tmux opens the viewer in a split beside Claude, once, and closes it with the session', async ($, on) => {
  const { files, runs, opens, toasts } = world(on, { TMUX: '/tmp/tmux-501/default,1,0', TMUX_PANE: '%3' })
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true } as any)
  await $.command.run({ command: 'pace', args: '' } as any)
  expect(JSON.parse(files['/home/u/.claude/pace-state.json'] ?? 'null').samples.length).toBeGreaterThan(0)
  expect(runs).toContainEqual(['tmux', 'split-window', '-h', '-d', '-l', '45%', '-t', '%3', '-P', '-F', '#{pane_id}', '/home/u/.claude/pace-view.command'])
  await $.command.run({ command: 'pace', args: '' } as any)
  expect(runs.filter(r => r[1] === 'split-window')).toHaveLength(1)
  expect(toasts).toContain('Pace is already open in a tmux split')
  expect(opens).toEqual([])
  await $.session.end({ reason: 'other' } as any)
  expect(runs).toContainEqual(['tmux', 'kill-pane', '-t', '%7'])
})

test('/pace split feeds the viewer the plan\'s steps, read from ROADMAP.md', async ($, on) => {
  const { files } = world(on, { TMUX: '/tmp/tmux-501/default,1,0', TMUX_PANE: '%3' })
  files['/tmp/ROADMAP.md'] = '# Roadmap\n\n- [x] Fix the reset\n- [ ] Write CI\n'
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true } as any)
  await $.command.run({ command: 'pace', args: 'split' } as any)
  const state = JSON.parse(files['/home/u/.claude/pace-state.json'] ?? 'null')
  expect(state.plan).toEqual({
    name: 'ROADMAP.md',
    steps: [
      { text: 'Fix the reset', state: 'done', section: 'Roadmap' },
      { text: 'Write CI', state: 'next', section: 'Roadmap' },
    ],
  })
})

test('/pace outside tmux opens a pane here, docked wide beside a fullscreen transcript', async ($, on) => {
  const { runs, opens } = world(on)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true } as any)
  await $.command.run({ command: 'pace', args: '' } as any)
  expect(runs.some(r => r[0] === 'tmux' || r[0] === 'open')).toBe(false)
  expect(opens).toMatchObject([{ id: 'pace', columns: 80 }])
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
  await $.command.run({ command: 'pace', args: 'window' } as any)
  let pressed = 0
  const key = async (cmd: string) => {
    files['/home/u/.claude/pace-keys.json'] = JSON.stringify({ id: NOW + ++pressed, cmd })
    await clock.advance(3000)
  }
  await key('warm')
  expect((stored['session:session-a'] as any).warm).toBe('ping')
  await key('warm')
  expect((stored['session:session-a'] as any).warm).toBe('compact')
  await key('warm')
  expect((stored['session:session-a'] as any).warm).toBe('off')
  expect(JSON.parse(files['/home/u/.claude/pace-state.json']!).warm).toBe('off')
  const before = fetches()
  await key('refresh')
  expect(fetches()).toBe(before + 1)
  // A key already handled is not handled again
  await clock.advance(3000)
  expect(fetches()).toBe(before + 1)
})


test('the split\'s buttons reach the session: any /pace argument runs, and its answer comes back in the feed', async ($, on) => {
  const { clock, files, stored, opens } = world(on, { TMUX: '/tmp/tmux-501/default,1,0', TMUX_PANE: '%3' })
  files['/tmp/ROADMAP.md'] = '# Roadmap\n\n- [ ] Write CI\n'
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true } as any)
  await $.command.run({ command: 'pace', args: 'split' } as any)
  const state = () => JSON.parse(files['/home/u/.claude/pace-state.json']!)
  expect(state().prefs).toEqual({ band: true, line: true })
  expect(state().known).toContain('ROADMAP.md')
  let pressed = 0
  const key = async (cmd: string) => {
    files['/home/u/.claude/pace-keys.json'] = JSON.stringify({ id: NOW + ++pressed, cmd })
    await clock.advance(3000)
  }
  await key('on')
  expect((stored['session:session-a'] as any).onPace).toBe(true)
  expect(state().onPace).toBe(true)
  expect(state().notice.text).toContain('On pace mode on')
  await key('hide')
  expect(state().prefs.band).toBe(false)
  // Starting a run from the split goes through the same onboarding as /pace auto
  await key('auto ROADMAP.md')
  expect(opens.map(o => o.id)).toContain('pace-auto')
  expect(state().notice.text).toContain('press Start')
})

test('the split\'s timeline button opens the plan\'s timeline in a second split carved under the Pace split', async ($, on) => {
  const { clock, files, runs } = world(on, { TMUX: '/tmp/tmux-501/default,1,0', TMUX_PANE: '%3' })
  files['/tmp/ROADMAP.md'] = '# Roadmap\n\n- [ ] Write CI\n'
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true } as any)
  await $.command.run({ command: 'pace', args: 'split' } as any)
  files['/home/u/.claude/pace-keys.json'] = JSON.stringify({ id: NOW + 1, cmd: 'timeline' })
  await clock.advance(3000)
  // Below the viewer's pane (%7), half its height, not beside Claude's
  const split = runs.filter(r => r[1] === 'split-window')[1]!
  expect(split.slice(0, 8)).toEqual(['tmux', 'split-window', '-v', '-d', '-l', '50%', '-t', '%7'])
  expect(split[split.length - 1]).toContain('plan-viewer.ts')
  expect(files['/home/u/.claude/pace-plan-session-a.json']).toBeDefined()
  expect(JSON.parse(files['/home/u/.claude/pace-state.json']!).notice.text).toContain('under the Pace split')
  // Typed as /pace timeline with no Pace split open, it is the sidebar beside Claude
})

test('t again closes the timeline pane, and quitting the split closes it too', async ($, on) => {
  const { clock, files, runs } = world(on, { TMUX: '/tmp/tmux-501/default,1,0', TMUX_PANE: '%3' })
  files['/tmp/ROADMAP.md'] = '# Roadmap\n\n- [ ] Write CI\n'
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true } as any)
  await $.command.run({ command: 'pace', args: 'split' } as any)
  let pressed = 0
  const key = async (cmd: string) => {
    files['/home/u/.claude/pace-keys.json'] = JSON.stringify({ id: NOW + ++pressed, cmd })
    await clock.advance(3000)
  }
  const notice = () => JSON.parse(files['/home/u/.claude/pace-state.json']!).notice.text
  const kills = () => runs.filter(r => r[1] === 'kill-pane').length
  await key('timeline')
  expect(kills()).toBe(0)
  await key('timeline')
  expect(kills()).toBe(1)
  expect(notice()).toContain('Plan timeline closed')
  // Open again, then the viewer quits: its timeline pane goes with it, and /pace opens a fresh split
  await key('timeline')
  const splits = runs.filter(r => r[1] === 'split-window').length
  await key('close')
  expect(kills()).toBe(2)
  await $.command.run({ command: 'pace', args: 'split' } as any)
  expect(runs.filter(r => r[1] === 'split-window').length).toBe(splits + 1)
})

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
  // About $62/h at 0.5 points a dollar: the 40 points left last 1h18m
  expect(textOf(tree.children[0])).toContain('out in 1h18m')
  expect((stored.spend as any[]).some(s => s.id !== 'other')).toBe(true)
  await $.command.run({ command: 'pace', args: 'pane' } as any)
  const pane = await $.ui.mount({ plugin: 'pace', surface: 'terminal', component: 'Pane', requestId: 'pace', props: { bodyColumns: 100 } as any } as any)
  const drawn = textOf(await pane.drawn())
  expect(drawn).toContain('2 sessions')
  expect(drawn).toContain('$62/h')
  expect(drawn).toMatch(/~\d+(\.\d+)?% per prompt/)
})

test('a window over pace is not too fast once the prompting stops', async ($, on) => {
  // The 5-hour readings are this test's own: the endpoint reports the Fable week alone
  const { clock, status } = world(on, {}, FABLE_ONLY)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true } as any)
  for (let i = 0; i < 20; i++) {
    if (i) await clock.advance(60_000)
    await $.prompt.submit({ text: `p${i}` } as any)
  }
  // A window over pace, 90% used with about 70% of it gone, but the last prompt was 16 minutes ago: at 90% when
  // the prompting stopped, and at 90% still
  const at90 = () => $.session.measure({ context: { window: 1_000_000 }, rateLimits: [{ kind: 'five_hour', percentUsed: 90, resetsAt: iso(NOW + 2 * H) }], changed: ['rateLimits'] } as any)
  await at90()
  await clock.advance(16 * 60_000)
  await at90()
  const ui = await $.ui.mount({ plugin: 'pace', surface: 'terminal', component: 'AbovePrompt', props: BAND as any })
  const tree: any = await ui.drawn({ in: 'pace-band' })
  const five = textOf(tree.children[0])
  expect(five).toContain('Over pace')
  expect(five).not.toContain('too fast')
  expect(status[status.length - 1]).not.toContain('too fast')
})

test('prompting one model never makes another model\'s week too fast', async ($, on) => {
  // The Fable week at 85% with 3 of its 7 days left: over pace
  const { clock } = world(on, {}, { limits: [USAGE.limits[0], { ...USAGE.limits[1], percent: 85 }] })
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true } as any)
  for (let i = 0; i < 20; i++) {
    if (i) await clock.advance(60_000)
    await $.prompt.submit({ text: `p${i}` } as any)
  }
  const ui = await $.ui.mount({ plugin: 'pace', surface: 'terminal', component: 'AbovePrompt', props: BAND as any })
  const tree: any = await ui.drawn({ in: 'pace-band' })
  const week = textOf(tree.children[1])
  // Every prompt went to Opus
  expect(week).toContain('Fable wk')
  expect(week).toContain('Over pace')
  expect(week).not.toContain('too fast')
})

test('/pace line off clears the status-line entry and keeps it off through ticks, replies and prompts', async ($, on) => {
  const { clock, status } = world(on)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true } as any)
  await $.prompt.submit({ text: 'p0' } as any)
  expect(status[status.length - 1]).toContain('5h ')
  await $.command.run({ command: 'pace', args: 'line off' } as any)
  expect(status[status.length - 1]).toBeUndefined()
  await clock.advance(60_000)
  await reply($, 100_000)
  await $.prompt.submit({ text: 'p1' } as any)
  await clock.advance(60_000)
  expect(status[status.length - 1]).toBeUndefined()
  await $.command.run({ command: 'pace', args: 'line on' } as any)
  expect(status[status.length - 1]).toContain('5h ')
})

test('a module loaded with the status-line entry off clears one a previous load left, and keeps it off', async ($, on) => {
  const { stored, status } = world(on)
  stored.prefs = { band: true, line: false, warm: 'off' }
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true } as any)
  await $.prompt.submit({ text: 'p0' } as any)
  await reply($, 100_000)
  // The engine keeps the entry across a hot reload; the module must say it is off, not assume it
  expect(status.length).toBeGreaterThan(0)
  expect(status.filter(t => t != null)).toEqual([])
})

test('/pace runs at once, mid-turn too, and answers in a toast: nothing lands in the transcript for the model to read', async ($, on) => {
  const { registered, toasts } = world(on)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true } as any)
  expect(registered.find(c => c.name === 'pace')?.immediate).toBe(true)
  for (const args of ['hide', 'show', 'refresh', 'warm ping', 'line off', 'nonsense']) {
    const r: any = await $.command.run({ command: 'pace', args } as any)
    expect(r.text).toBeUndefined()
    expect(r.context).toBeUndefined()
  }
  expect(toasts.some(t => t.includes('Warm mode ping'))).toBe(true)
  expect(toasts.some(t => t.includes('Unknown argument'))).toBe(true)
})

test('other plugins read pace through $.pace.snapshot(): quotas with their rate, the cache, the shared spend', { plugins: [READER] }, async ($, on) => {
  world(on)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true } as any)
  await pricedReply($, 100_000, 0.5)
  await pricedReply($, 120_000, 0.625)
  const snap = await paceSnapshot($)
  expect(snap.quotas.map((q: any) => q.key)).toEqual(['five_hour', 'seven_day', 'seven_day_fable'])
  const five = snap.quotas[0]
  expect(five).toMatchObject({ name: '5-hour window', percent: 60, status: 'onPace', resetsAt: NOW + 2 * H })
  expect(five.rate.level).toBe('idle')
  expect(snap.cache).toMatchObject({ tokens: 120_000, ttl: '1h', secondsLeft: 3600, nextWarm: 12_000 })
  expect(snap.cache.nextWarmUsd).toBeGreaterThan(0)
  expect(snap.gassedOut).toBe(false)
  expect(Array.isArray(snap.advice)).toBe(true)
})

test('a spent quota is gassed out, in the snapshot and on the band', { plugins: [READER] }, async ($, on) => {
  world(on)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true } as any)
  await $.session.measure({ context: { window: 1_000_000 }, rateLimits: [{ kind: 'five_hour', percentUsed: 100, resetsAt: iso(NOW + H) }], changed: ['rateLimits'] } as any)
  const snap = await paceSnapshot($)
  expect(snap.gassedOut).toBe(true)
  expect(snap.quotas[0].status).toBe('gassedOut')
  const ui = await $.ui.mount({ plugin: 'pace', surface: 'terminal', component: 'AbovePrompt', props: BAND as any })
  expect(textOf((await ui.drawn({ in: 'pace-band' }) as any).children[0])).toContain('Gassed out')
})

test('once the 5-hour window resets with no new reading, the band and the status line show the new window at 0%', async ($, on) => {
  const { status, clock } = world(on)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true } as any)
  await $.prompt.submit({ text: 'p' } as any)
  // The 5-hour window, at 60%, resets in 2h; five minutes past it no reading of the new window has arrived
  await clock.advance(2 * H + 5 * 60_000)
  await $.prompt.submit({ text: 'q' } as any)
  const ui = await $.ui.mount({ plugin: 'pace', surface: 'terminal', component: 'AbovePrompt', props: BAND as any })
  const drawn = textOf(await ui.drawn({ in: 'pace-band' }))
  expect(drawn).not.toContain('60%')
  expect(drawn).not.toContain('Window ended')
  expect(drawn).toContain('0%')
  expect(status[status.length - 1]).toMatch(/^5h 0%/)
})

test('a week over pace with no per-prompt cost yet says so calmly, not too fast', async ($, on) => {
  // The Fable week at 80% with 3 of its 7 days left: over pace, and its first reading is too new to cost a prompt
  const usage = { limits: [USAGE.limits[0], { ...USAGE.limits[1], percent: 80 }] }
  const { status, clock } = world(on, {}, usage)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true } as any)
  for (let i = 0; i < 3; i++) {
    if (i) await clock.advance(60_000)
    await $.prompt.submit({ text: `p${i}` } as any)
  }
  const ui = await $.ui.mount({ plugin: 'pace', surface: 'terminal', component: 'AbovePrompt', props: BAND as any })
  const week = textOf((await ui.drawn({ in: 'pace-band' }) as any).children[1])
  expect(week).toContain('over pace · no cost yet')
  expect(week).not.toContain('too fast')
  expect(week).not.toContain('→ —')
  expect(status[status.length - 1]).toContain('Fable wk 80% ▲ over pace · no cost yet')
})

test('on pace mode asks for one effort level lighter while a burst lasts', async ($, on) => {
  const { clock } = world(on)
  const asked: unknown[] = []
  on('turn.step', async function* (_$: unknown, e: { turnId: string; index: number; effort?: unknown }) {
    asked.push(e.effort)
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null } as any
  })
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true } as any)
  await $.command.run({ command: 'pace', args: 'on' } as any)
  const step = async () => {
    for await (const _ of $.turn.step({ turnId: 't', index: 0, model: 'claude-opus-5-5', effort: 'high', messageCount: 1 } as any) as any) { /* drain the stream */ }
  }
  await step()
  // 20 prompts in the last 20 minutes on a window at 60%: a burst, out in 20m
  for (let i = 0; i < 20; i++) {
    if (i) await clock.advance(60_000)
    await $.prompt.submit({ text: `p${i}` } as any)
  }
  await clock.advance(60_000)
  await step()
  expect(asked).toEqual(['high', 'medium'])
})

test('another session\'s spend with no prompt of its own (its subagents at work) brings the figures again; a quiet hour does not', async ($, on) => {
  const { clock, stored, fetches } = world(on)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true } as any)
  const before = fetches()
  await clock.advance(30 * 60_000)
  expect(fetches()).toBe(before)
  stored['spend'] = [{ t: NOW + 31 * 60_000, id: 'session-b', usd: 2, m: 'claude-fable-5-1' }]
  // Within 3 minutes of the spend
  await clock.advance(3 * 60_000)
  expect(fetches()).toBe(before + 1)
  await clock.advance(30 * 60_000)
  expect(fetches()).toBe(before + 1)
})
