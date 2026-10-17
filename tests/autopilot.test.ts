import { expect, test } from 'claude-code/testing'

import { BAND, H, iso, NOW, reply, textOf, USAGE, world } from './world.ts'

const start = ($: any) => $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true } as any)
const pace = ($: any, args: string) => $.command.run({ command: 'pace', args } as any)
const turnEnds = ($: any, answer: string, more: object = {}) =>
  $.turn.complete({ answer, durationMs: 1000, isAborted: false, turnId: `t${Math.random()}`, reason: 'answer', ...more } as any)
const usage = ($: any, percent: number, resetsAt = NOW + 2 * H) =>
  $.session.measure({ context: { window: 1_000_000 }, rateLimits: [{ kind: 'five_hour', percentUsed: percent, resetsAt: iso(resetsAt) }], changed: ['rateLimits'] } as any)

/** Accepts auto mode's onboarding, the first time, by its Start button, and lets its first prompt go out */
async function onboard($: any, clock: any): Promise<void> {
  const pane = await $.ui.mount({ plugin: 'pace', surface: 'terminal', component: 'Pane', requestId: 'pace-auto', props: { bodyColumns: 80 } as any } as any)
  await pane.press({ key: 'pace-auto-start' })
  await clock.advance(1)
}

test('warns once per window as a quota nears its end and when it is gassed out, in a toast and a notification', async ($, on) => {
  const { notices, toasts, clock } = world(on)
  await start($)
  await usage($, 82)
  await usage($, 83)
  expect(notices.filter(n => n.includes('risk getting gassed out')).length).toBe(1)
  await usage($, 100)
  expect(notices.some(n => n.startsWith('Gassed out: 5-hour window'))).toBe(true)
  expect(toasts.some(t => t.includes('Gassed out'))).toBe(true)
})

test('on pace mode compacts a heavy context after a turn while its cache is warm', async ($, on) => {
  const { commands, clock } = world(on)
  await start($)
  await pace($, 'on')
  await reply($, 300_000)
  await turnEnds($, 'done')
  expect(commands).toEqual([])
  await reply($, 650_000)
  await turnEnds($, 'done')
  expect(commands).toEqual(['compact'])
  // A subagent's turn is not the session's
  await reply($, 650_000)
  await turnEnds($, 'done', { agentId: 'a1' })
  expect(commands).toEqual(['compact'])
  await pace($, 'off')
  await turnEnds($, 'done')
  expect(commands).toEqual(['compact'])
})

test('on pace mode keeps an idle cache warm with no warm mode of your own', async ($, on) => {
  const { clock, forks } = world(on)
  await start($)
  await pace($, 'on')
  await reply($, 100_000)
  await clock.advance(51 * 60_000)
  expect(forks.length).toBe(1)
})

test('auto mode asks first: the onboarding pane says what it does and that it spends quota on its own', async ($, on) => {
  const { opens, submitted, clock } = world(on)
  await start($)
  await pace($, 'auto ROADMAP.md')
  expect(opens.map(o => o.id)).toContain('pace-auto')
  expect(submitted).toEqual([])
  const pane = await $.ui.mount({ plugin: 'pace', surface: 'terminal', component: 'Pane', requestId: 'pace-auto', props: { bodyColumns: 80 } as any } as any)
  const text = textOf(await pane.drawn())
  expect(text).toContain('ROADMAP.md')
  expect(text).toMatch(/spends? quota/)
  expect(text).toContain('gassed out')
  await pane.press({ key: 'pace-auto-start' })
  await clock.advance(1)
  expect(submitted[0]).toContain('ROADMAP.md')
  // Accepted once, it starts at once next time
  await pace($, 'auto off')
  await pace($, 'auto PLAN.md')
  await clock.advance(1)
  expect(submitted[1]).toContain('PLAN.md')
})

test('auto mode works through the plan turn by turn, its instructions in the system prompt, and stops when done', async ($, on) => {
  const { submitted, notices, clock } = world(on)
  await start($)
  await pace($, 'auto ROADMAP.md')
  await onboard($, clock)
  const composed: any = await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] } as any)
  expect(composed.sections.map((s: any) => s.id)).toEqual(['intro', 'pace:auto'])
  await turnEnds($, 'step one\nPACE: NEXT')
  expect(submitted.length).toBe(2)
  expect(submitted[1]).toContain('Continue with the next unfinished step of ROADMAP.md')
  await turnEnds($, 'all of it\nPACE: DONE')
  expect(submitted.length).toBe(2)
  expect(notices.some(n => n.includes('Plan done'))).toBe(true)
  const after: any = await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] } as any)
  expect(after.sections.map((s: any) => s.id)).toEqual(['intro'])
})

test('auto mode answers questions itself with the recommended option', async ($, on) => {
  const { clock } = world(on)
  await start($)
  await pace($, 'auto ROADMAP.md')
  await onboard($, clock)
  const r: any = await $.tool.call({ tool: 'AskUserQuestion', questions: [{ question: 'Which?', header: 'h', multiSelect: false, options: [{ label: 'A' }, { label: 'B (Recommended)' }] }] } as any)
  expect(r.result.answers).toEqual({ 'Which?': 'B (Recommended)' })
})

test('auto mode hands a heavy context off: /clear, then a prompt that resumes from the handoff file', async ($, on) => {
  const { submitted, commands, clock } = world(on)
  await start($)
  await pace($, 'auto ROADMAP.md')
  await onboard($, clock)
  await reply($, 650_000)
  await turnEnds($, 'PACE: NEXT')
  expect(commands).toEqual(['clear'])
  expect(submitted[1]).toContain('.pace/handoff.md')
})

test('auto mode holds while a quota is gassed out and picks the plan back up after the reset', async ($, on) => {
  const { submitted, clock, notices } = world(on)
  await start($)
  await pace($, 'auto ROADMAP.md')
  await onboard($, clock)
  await usage($, 100, NOW + H)
  await turnEnds($, 'PACE: NEXT')
  expect(submitted.length).toBe(1)
  expect(notices.some(n => n.includes('holding'))).toBe(true)
  const ui = await $.ui.mount({ plugin: 'pace', surface: 'terminal', component: 'AbovePrompt', props: BAND as any })
  expect(textOf(await ui.drawn({ in: 'pace-band' }))).toMatch(/auto.*held/)
  await clock.advance(30 * 60_000)
  expect(submitted.length).toBe(1)
  await usage($, 0, NOW + 6 * H)
  await clock.advance(32 * 60_000)
  expect(submitted.length).toBe(2)
})

test('an interrupt pauses auto mode until /pace auto resume', async ($, on) => {
  const { submitted, clock } = world(on)
  await start($)
  await pace($, 'auto ROADMAP.md')
  await onboard($, clock)
  await turnEnds($, '', { isAborted: true, reason: 'aborted' })
  expect(submitted.length).toBe(1)
  await pace($, 'auto resume')
  await clock.advance(1)
  expect(submitted.length).toBe(2)
})

test('auto mode sends nothing while Claude waits on background work, and picks up when it reports', async ($, on) => {
  const { submitted, clock, files } = world(on)
  files['/tmp/ROADMAP.md'] = '- [ ] step one'
  await start($)
  await pace($, 'auto ROADMAP.md')
  await onboard($, clock)
  await turnEnds($, 'Started the suite.\nPACE: WAITING the test run')
  expect(submitted.length).toBe(1)
  // The run reports: Claude Code starts a turn of its own, which moves the plan
  files['/tmp/ROADMAP.md'] = '- [x] step one'
  await turnEnds($, 'Suite green, step one done.\nPACE: NEXT')
  expect(submitted.length).toBe(2)
  expect(submitted[1]).toContain('Continue with the next unfinished step')
})

test('auto mode checks in on background work that has not reported in 15 minutes', async ($, on) => {
  const { submitted, clock } = world(on)
  await start($)
  await pace($, 'auto ROADMAP.md')
  await onboard($, clock)
  await turnEnds($, 'PACE: WAITING the test run')
  await clock.advance(14 * 60_000)
  expect(submitted.length).toBe(1)
  await clock.advance(60_000)
  expect(submitted.length).toBe(2)
})

test('auto mode stops prompting turns that make no progress, and backs off', async ($, on) => {
  const { submitted, clock, files } = world(on)
  files['/tmp/ROADMAP.md'] = '- [ ] step one'
  await start($)
  await pace($, 'auto ROADMAP.md')
  await onboard($, clock)
  await turnEnds($, 'Still waiting on the test run.')
  expect(submitted.length).toBe(2)
  // A second turn in a row with the plan and the handoff file unchanged: no third prompt
  await turnEnds($, 'Still waiting.')
  expect(submitted.length).toBe(2)
  await clock.advance(5 * 60_000)
  expect(submitted.length).toBe(3)
  // Still nothing: twice as long this time
  await turnEnds($, 'Still waiting.')
  await clock.advance(5 * 60_000)
  expect(submitted.length).toBe(3)
  await clock.advance(5 * 60_000)
  expect(submitted.length).toBe(4)
})

const compose = ($: any) => $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] } as any)

test('auto mode stays in the session that started it: a run stored where every session reads it drives none', async ($, on) => {
  const { submitted, stored } = world(on, {}, USAGE, 'session-b')
  // Another session's run, kept the old way in the prefs every session shares
  stored.prefs = { band: true, line: true, warm: 'off', onPace: true, auto: { plan: 'Roadmap.md', turns: 25, max: 40 } }
  await start($)
  await turnEnds($, 'done')
  expect(submitted).toEqual([])
  expect(((await compose($)) as any).sections.map((s: any) => s.id)).toEqual(['intro'])
})

test('starting auto mode stores the run under the session alone', async ($, on) => {
  const { stored, clock } = world(on)
  await start($)
  await pace($, 'auto ROADMAP.md')
  await onboard($, clock)
  expect((stored['session:session-a'] as any).auto).toMatchObject({ plan: 'ROADMAP.md' })
  expect((stored.prefs as any).auto).toBeUndefined()
  expect((stored.prefs as any).onPace).toBeUndefined()
})

test('a resumed session picks its own run back up', async ($, on) => {
  const { submitted, stored } = world(on)
  stored['session:session-a'] = { at: NOW - H, onPace: true, auto: { plan: 'ROADMAP.md', turns: 5, max: 40 } }
  await start($)
  await turnEnds($, 'step five\nPACE: NEXT')
  expect(submitted.length).toBe(1)
  expect(submitted[0]).toContain('ROADMAP.md')
})

test('a session\'s own modes are forgotten a month after it was last used', async ($, on) => {
  const { stored } = world(on)
  stored['session:old'] = { at: NOW - 31 * 24 * H, onPace: true }
  stored['session:recent'] = { at: NOW - 24 * H, onPace: true }
  await start($)
  expect(stored['session:old']).toBeUndefined()
  expect(stored['session:recent']).toBeDefined()
})
