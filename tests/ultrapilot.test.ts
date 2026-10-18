import { expect, test } from 'claude-code/testing'

import { H, iso, NOW, textOf, world } from './world.ts'

const start = ($: any) => $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true } as any)
const pace = ($: any, args: string) => $.command.run({ command: 'pace', args } as any)
const turnEnds = ($: any, answer: string) =>
  $.turn.complete({ answer, durationMs: 1000, isAborted: false, turnId: `t${Math.random()}`, reason: 'answer' } as any)
const usage = ($: any, percent: number, resetsAt = NOW + 2 * H) =>
  $.session.measure({ context: { window: 1_000_000 }, rateLimits: [{ kind: 'five_hour', percentUsed: percent, resetsAt: iso(resetsAt) }], changed: ['rateLimits'] } as any)
const compose = ($: any) => $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] } as any)
const mountOnboarding = ($: any) => $.ui.mount({ plugin: 'pace', surface: 'terminal', component: 'Pane', requestId: 'pace-auto', props: { bodyColumns: 80 } as any } as any)

const PLAN = [
  '## Goal',
  'pace ships 1.0 with CI green.',
  'Done when:',
  '- CI runs on every push',
  'Check: `claude plugin test .`',
  '## Steps',
].join('\n')

/** Ultra pace started on /tmp/PLAN.md, its onboarding accepted and its first prompt sent */
async function ultra($: any, w: ReturnType<typeof world>, args = 'ultra PLAN.md'): Promise<void> {
  w.files['/tmp/PLAN.md'] = PLAN
  await start($)
  await pace($, args)
  await (await mountOnboarding($)).press({ key: 'pace-auto-start' })
  await w.clock.advance(1)
}

const runOf = (w: ReturnType<typeof world>) => (w.stored['session:session-a'] as any)?.auto

test('ultra pace needs a goal: a plan without one does not start', async ($, on) => {
  const { files, submitted, toasts, opens, clock } = world(on)
  files['/tmp/PLAN.md'] = '- [ ] a step'
  await start($)
  await pace($, 'ultra PLAN.md')
  await clock.advance(1)
  expect(submitted).toEqual([])
  expect(opens.map(o => o.id)).not.toContain('pace-auto')
  expect(toasts.some(t => t.includes('## Goal'))).toBe(true)
})

test('ultra pace asks first, says it works toward the goal and spends faster while there is room, then plans', async ($, on) => {
  const w = world(on)
  w.files['/tmp/PLAN.md'] = PLAN
  await start($)
  await pace($, 'ultra PLAN.md')
  const pane = await mountOnboarding($)
  const text = textOf(await pane.drawn())
  expect(text).toContain('pace ships 1.0 with CI green.')
  expect(text).toContain('claude plugin test .')
  expect(text).toMatch(/spends? quota/)
  await pane.press({ key: 'pace-auto-start' })
  await w.clock.advance(1)
  expect(w.submitted[0]).toContain('Read the goal in PLAN.md')
  expect(runOf(w)).toMatchObject({
    plan: 'PLAN.md', turns: 1, max: 80,
    ultra: { goal: 'pace ships 1.0 with CI green.', check: 'claude plugin test .', phase: 'plan', models: { floor: 'sonnet' } },
  })
})

test('ultra pace takes a turn cap and model bounds', async ($, on) => {
  const w = world(on)
  await ultra($, w, 'ultra PLAN.md 30 haiku..opus')
  expect(runOf(w)).toMatchObject({ max: 30, ultra: { models: { floor: 'haiku', ceiling: 'opus' } } })
})

test('ultra pace\'s instructions replace auto mode\'s in the system prompt', async ($, on) => {
  const w = world(on)
  await ultra($, w)
  const composed: any = await compose($)
  expect(composed.sections.map((s: any) => s.id)).toEqual(['intro', 'pace:ultra'])
  expect(composed.sections[1].text).toContain('PACE: GOAL')
})

test('ultra pace keeps its state through a hold', async ($, on) => {
  const w = world(on)
  await ultra($, w)
  await usage($, 100, NOW + H)
  await turnEnds($, 'Planned.\nPACE: NEXT')
  expect(runOf(w).heldUntil).toBeGreaterThan(NOW)
  expect(runOf(w).ultra).toMatchObject({ goal: 'pace ships 1.0 with CI green.' })
})

test('/pace ultra off stops it; /pace ultra resume picks it back up toward the goal', async ($, on) => {
  const w = world(on)
  await ultra($, w)
  const run = runOf(w)
  await pace($, 'ultra off')
  expect(runOf(w)).toBeNull()
  w.stored['session:session-a'] = { ...(w.stored['session:session-a'] as any), auto: { ...run, turns: 80, max: 80 } }
  await start($)
  await pace($, 'ultra resume')
  await w.clock.advance(1)
  expect(w.submitted.at(-1)).toContain('goal in PLAN.md')
  expect(runOf(w).max).toBeGreaterThan(80)
  expect(runOf(w).ultra).toBeTruthy()
})
