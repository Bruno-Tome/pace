import { expect, test } from 'claude-code/testing'

import { H, iso, NOW, reply, textOf, world } from './world.ts'

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

test('after the plan turn, ultra pace prompts the work toward the goal, with what the gear allows', async ($, on) => {
  const w = world(on)
  await ultra($, w)
  w.files['/tmp/PLAN.md'] = `${PLAN}\n- [ ] Write the CI workflow\n- [ ] Tag 1.0.0`
  await turnEnds($, 'Wrote the steps.\nPACE: NEXT')
  expect(w.submitted[1]).toContain('Work toward the goal in PLAN.md')
  expect(w.submitted[1]).toMatch(/Pace allows \d subagents? on/)
  expect(runOf(w).ultra.phase).toBe('work')
})

test('a claimed goal runs the check captured at the start; a pass stops the run and asks for the closing report', async ($, on) => {
  const w = world(on)
  await ultra($, w)
  await turnEnds($, 'Every line holds.\nPACE: GOAL')
  expect(w.runs.some(r => r[0] === 'sh' && r[2] === 'claude plugin test .')).toBe(true)
  expect(runOf(w)).toBeNull()
  expect(w.notices.some(n => n.includes('Goal reached'))).toBe(true)
  expect(w.submitted.at(-1)).toMatch(/closing report/)
})

test('a failed check is followed by a review carrying its output', async ($, on) => {
  const w = world(on)
  await ultra($, w)
  Object.assign(w.shell, { exitCode: 1, stdout: '(fail) the cache key\n1 fail\n' })
  await turnEnds($, 'Done, I think.\nPACE: GOAL')
  expect(runOf(w).ultra).toMatchObject({ phase: 'review', checkFails: 1 })
  expect(w.submitted.at(-1)).toContain('(fail) the cache key')
})

test('an edited Check: line changes nothing: pace runs the one captured at the start, and says so', async ($, on) => {
  const w = world(on)
  await ultra($, w)
  w.files['/tmp/PLAN.md'] = PLAN.replace('claude plugin test .', 'true')
  await turnEnds($, 'PACE: GOAL')
  expect(w.runs.filter(r => r[0] === 'sh').map(r => r[2])).toEqual(['claude plugin test .'])
  expect(w.toasts.some(t => t.includes('Check:') && t.includes('claude plugin test .'))).toBe(true)
})

const PUSH = { model: 'opus', effort: 'xhigh', subagents: 3, subagentModel: 'sonnet', fanout: true }
const STEPS = '- [ ] Pin Node\n- [ ] Bump plugin.json (parallel)\n- [ ] Move Unreleased (parallel)\n- [ ] Tag it'

/** A run of this session's, stored as `claude --resume` finds it */
const stored = (ultra: object) => ({
  at: NOW - H, onPace: true,
  auto: { plan: 'PLAN.md', turns: 3, max: 80, ultra: {
    goal: 'pace ships 1.0 with CI green.', check: 'claude plugin test .', phase: 'work', sinceReview: 0, quietReviews: 0,
    checkFails: 0, models: { floor: 'sonnet', ceiling: 'opus' }, gear: PUSH, headroomStreak: 0, ...ultra,
  } },
})

test('with room to push and a step just done, the parallel steps go to subagents on the gear\'s model', async ($, on) => {
  // No weekly reading from the endpoint: the 5-hour window and the week, both under pace
  const w = world(on, {}, { limits: [] })
  w.files['/tmp/PLAN.md'] = `${PLAN}\n${STEPS}`
  w.stored['session:session-a'] = stored({})
  await start($)
  // 10% used with 40% of the window gone: under pace
  await usage($, 10, NOW + 3 * H)
  await turnEnds($, 'Looked around.\nPACE: NEXT')
  const before = w.submitted.length
  w.files['/tmp/PLAN.md'] = `${PLAN}\n${STEPS.replace('- [ ] Pin Node', '- [x] Pin Node')}`
  await turnEnds($, 'Pinned Node.\nPACE: NEXT')
  expect(w.spawns.map(s => s.model)).toEqual(['sonnet', 'sonnet'])
  expect(w.spawns[0]!.prompt).toContain('Bump plugin.json')
  expect(w.spawns[1]!.prompt).toContain('.pace/fanout/2.md')
  // The main thread waits for their reports
  expect(w.submitted.length).toBe(before)
  expect(runOf(w).ultra).toMatchObject({ phase: 'fanout', fanout: { steps: ['Bump plugin.json', 'Move Unreleased'] } })
})

test('once every subagent out on the fan-out has reported, a turn integrates their work', async ($, on) => {
  const w = world(on)
  w.files['/tmp/PLAN.md'] = `${PLAN}\n${STEPS}`
  w.stored['session:session-a'] = stored({ phase: 'fanout', fanout: { agentIds: ['agent-1', 'agent-2'], steps: ['Bump plugin.json', 'Move Unreleased'] } })
  await start($)
  // Each subagent's answer is its own turn's end
  await $.turn.complete({ answer: 'Bumped.', durationMs: 1, isAborted: false, turnId: 's1', reason: 'answer', agentId: 'agent-1' } as any)
  expect(w.submitted).toEqual([])
  await $.turn.complete({ answer: 'Moved.', durationMs: 1, isAborted: false, turnId: 's2', reason: 'answer', agentId: 'agent-2' } as any)
  expect(w.submitted.at(-1)).toMatch(/Integrate the subagents' work on "Bump plugin.json", "Move Unreleased"/)
  expect(runOf(w).ultra.phase).toBe('integrate')
})

const EASE = { model: 'sonnet', effort: 'medium', subagents: 1, subagentModel: 'haiku', fanout: false }

test('the main thread runs at the gear\'s effort, and on the gear\'s model once the cache is cold, as after a handoff', async ($, on) => {
  const w = world(on)
  const asked: { model: string; effort?: unknown }[] = []
  on('turn.step', async function* (_$: unknown, e: { turnId: string; index: number; model: string; effort?: unknown }) {
    asked.push({ model: e.model, effort: e.effort })
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null } as any
  })
  w.files['/tmp/PLAN.md'] = PLAN
  w.stored['session:session-a'] = stored({ gear: EASE })
  await start($)
  const step = async () => {
    for await (const _ of $.turn.step({ turnId: 't', index: 0, model: 'claude-opus-5-5', effort: 'high', messageCount: 1 } as any) as any) { /* drain the stream */ }
  }
  await reply($, 100_000)
  await step()
  // On pace mode keeps the idle cache warm: the model holds
  await w.clock.advance(61 * 60_000)
  await step()
  // A handoff clears the context, and the cache with it
  await $.session.measure({ context: { window: 1_000_000 }, changed: ['context'] } as any)
  await step()
  // A reply on the new model warms the cache again
  await reply($, 30_000)
  await step()
  const opus = { model: 'claude-opus-5-5', effort: 'medium' }
  const sonnet = { model: 'sonnet', effort: 'medium' }
  // Once switched, it stays switched
  expect(asked).toEqual([opus, opus, sonnet, sonnet])
})

test('the Agent tool\'s subagents run on the gear\'s model, and no more of them at once than it allows', async ($, on) => {
  const w = world(on)
  w.files['/tmp/PLAN.md'] = PLAN
  w.stored['session:session-a'] = stored({ gear: EASE })
  await start($)
  const first: any = await $.agent.spawn({ prompt: 'Search the repo for the parser.', model: 'opus' } as any)
  expect(w.spawns.at(-1)!.model).toBe('haiku')
  const second: any = await $.agent.spawn({ prompt: 'Read the tests.' } as any)
  expect(second.deny).toMatch(/1 subagent/)
  expect(w.spawns.length).toBe(1)
  // The first one's turn ends: room for another
  await $.turn.complete({ answer: 'Found it.', durationMs: 1, isAborted: false, turnId: 's1', reason: 'answer', agentId: first.agentId } as any)
  await $.agent.spawn({ prompt: 'Read the tests.' } as any)
  expect(w.spawns.length).toBe(2)
})

test('/pace ultra preview plays push on the band for 20 seconds, whatever the quota says, then calms down', async ($, on) => {
  const w = world(on)
  await start($)
  await pace($, 'ultra preview')
  const band = await $.ui.mount({ plugin: 'pace', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 6, bodyColumns: 120, scroll: {} } as any })
  const frames: string[] = []
  for (let i = 0; i < 20; i++) { await band.advance(80); frames.push(JSON.stringify(await band.drawn({ in: 'pace-band' }))) }
  expect(frames.some(f => f.includes('▓'))).toBe(true)
  expect(frames.some(f => f.includes('ultra') && f.includes('push'))).toBe(true)
  await w.clock.advance(21_000)
  await band.advance(80)
  const after = JSON.stringify(await band.drawn({ in: 'pace-band' }))
  expect(after.includes('▓') || after.includes('push')).toBe(false)
})

test('/pace plan shows the roadmap and the ultra run\'s plan side by side, each counting its own steps', async ($, on) => {
  const w = world(on)
  w.files['/tmp/ROADMAP.md'] = '- [x] one\n- [x] two\n- [ ] three'
  w.files['/tmp/PLAN.md'] = `${PLAN}\n- [x] a\n- [ ] b\n- [ ] c\n- [ ] d`
  w.stored['session:session-a'] = stored({})
  await start($)
  await pace($, 'plan')
  const pane: any = await $.ui.mount({ plugin: 'pace', surface: 'terminal', component: 'Pane', requestId: 'pace-plan', props: { bodyColumns: 120 } as any } as any)
  await pane.advance(3000)
  const tree: any = await pane.drawn({ in: 'pace-plan' })
  const rows: string[] = (tree.children ?? []).map((r: any) => textOf(r))
  const head = rows.find(r => r.includes('ROADMAP.md'))!
  expect(head).toContain('2 of 3 steps done')
  expect(head).toContain('PLAN.md')
  expect(head).toContain('1 of 4 steps done')
})

test('/pace plan takes two files, drawn side by side', async ($, on) => {
  const w = world(on)
  w.files['/tmp/A.md'] = '- [x] one\n- [ ] two'
  w.files['/tmp/B.md'] = '- [ ] x\n- [ ] y\n- [ ] z'
  await start($)
  await pace($, 'plan A.md B.md')
  const pane: any = await $.ui.mount({ plugin: 'pace', surface: 'terminal', component: 'Pane', requestId: 'pace-plan', props: { bodyColumns: 120 } as any } as any)
  await pane.advance(3000)
  const text = textOf(await pane.drawn({ in: 'pace-plan' }))
  expect(text).toContain('1 of 2 steps done')
  expect(text).toContain('0 of 3 steps done')
})
