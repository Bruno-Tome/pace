import { describe, expect, test } from 'claude-code/testing'

import type { PaceAuto } from '../types'
import { goalOf, lockBroken, planChanges, revisionsOf, stepsOf } from '../hooks/plan.ts'
import { followOffset, planFrame, scrollBy } from '../hooks/timeline.ts'
import { planLines, type Line } from '../hooks/view.ts'
import { NOW } from './world.ts'

const PLAN = [
  '# Roadmap',
  'Some intro text, not a step.',
  '## Phase one',
  '- [x] Set up the repo',
  '- [X] Write the parser',
  '  - [ ] a sub-task, not a step of its own',
  '## Phase two',
  '- [ ] Draw the **timeline**',
  '* [ ] Animate the steps',
  '1. [ ] Ship it',
].join('\n')

const RUN: PaceAuto = { plan: 'ROADMAP.md', turns: 5, max: 40 }

const textOfLines = (lines: Line[]) => lines.map(l => l.map(s => s.t).join('')).join('\n')
const draw = (md: string, auto: PaceAuto | null, more: { rows?: number } = {}) =>
  textOfLines(planLines(stepsOf(md, auto != null && !auto.paused), { plan: 'ROADMAP.md', auto, cols: 80, now: NOW, ...more }))

describe('the plan timeline', () => {
  test('reads the plan\'s checklist as steps: ticked done, the first unticked under way while auto mode runs', () => {
    const steps = stepsOf(PLAN, true)
    expect(steps.map(s => s.text)).toEqual(['Set up the repo', 'Write the parser', 'Draw the timeline', 'Animate the steps', 'Ship it'])
    expect(steps.map(s => s.state)).toEqual(['done', 'done', 'now', 'next', 'next'])
    expect(steps.map(s => s.section)).toEqual(['Phase one', 'Phase one', 'Phase two', 'Phase two', 'Phase two'])
  })

  test('with auto mode not running no step is under way', () => {
    expect(stepsOf(PLAN, false).map(s => s.state)).toEqual(['done', 'done', 'next', 'next', 'next'])
  })

  test('the goal block reads as the goal, its criteria and its check, and none of it as steps', () => {
    const md = [
      '## Goal',
      'pace ships 1.0 with CI green.',
      'Done when:',
      '- CI runs tsc, validate and test on every push',
      '- CHANGELOG has a 1.0.0 section',
      'Check: `tsc -p . && claude plugin test .`',
      '## Steps',
      '- [x] Write the CI workflow',
      '- [ ] Bump plugin.json (parallel)',
      '## Revisions',
      '- [ ] not a step: the log is prose',
    ].join('\n')
    expect(goalOf(md)).toEqual({
      text: 'pace ships 1.0 with CI green.',
      criteria: ['CI runs tsc, validate and test on every push', 'CHANGELOG has a 1.0.0 section'],
      check: 'tsc -p . && claude plugin test .',
    })
    const steps = stepsOf(md, true)
    expect(steps.map(s => s.text)).toEqual(['Write the CI workflow', 'Bump plugin.json'])
    expect(steps.map(s => s.parallel === true)).toEqual([false, true])
  })

  test('a plan with no goal block has no goal, and a goal with no check has a null check', () => {
    expect(goalOf(PLAN)).toBeNull()
    expect(goalOf('## Goal\nShip it.\n## Steps\n- [ ] one')).toEqual({ text: 'Ship it.', criteria: [], check: null })
  })

  test('a plan with no checklist has no steps', () => {
    expect(stepsOf('# Ideas\nJust prose.', true)).toEqual([])
  })

  test('draws the steps done, the one under way and the one up next, with the count done and the turn', () => {
    const text = draw(PLAN, RUN)
    expect(text).toContain('ROADMAP.md')
    expect(text).toContain('2 of 5 steps done')
    expect(text).toContain('turn 5 of 40')
    expect(text).toMatch(/✔ +Set up the repo/)
    expect(text).toMatch(/◉ +Draw the timeline · under way/)
    expect(text).toMatch(/○ +Animate the steps · up next/)
    expect(text).toMatch(/○ +Ship it$/m)
  })

  test('a long plan folds the steps done long ago and the ones far ahead to fit its rows', () => {
    // 20 of 30 done: step 21 is under way
    const md = Array.from({ length: 30 }, (_, i) => `- [${i < 20 ? 'x' : ' '}] Step ${i + 1}`).join('\n')
    const lines = planLines(stepsOf(md, true), { plan: 'PLAN.md', auto: RUN, cols: 80, now: NOW, rows: 20 })
    const text = textOfLines(lines)
    expect(lines.length).toBeLessThanOrEqual(20)
    expect(text).toMatch(/◉ +Step 21 · under way/)
    expect(text).toMatch(/✔ +Step 20$/m)
    expect(text).not.toMatch(/Step 1$/m)
    expect(text).toMatch(/✔ +\d+ earlier steps done/)
    expect(text).toMatch(/○ +\d+ more steps/)
  })

  test('a long step wraps under its own text in a narrow sidebar, the line down the left unbroken', () => {
    const md = '- [x] Set up the repository with its tooling and its tests\n- [ ] Draw the plan as a timeline in a sidebar beside Claude\n- [ ] Ship it'
    const lines = planLines(stepsOf(md, true), { plan: 'PLAN.md', auto: RUN, cols: 30, now: NOW })
    const rows = lines.map(l => l.map(s => s.t).join(''))
    for (const r of rows) expect([...r].length).toBeLessThanOrEqual(30)
    // The text column, right of the 5-column gutter that holds the marks and the line
    const text = rows.slice(3).map(r => [...r].slice(5).join('')).join(' ')
    expect(text.replace(/\s+/g, ' ')).toContain('Draw the plan as a timeline in a sidebar beside Claude · under way')
    // The done step's second row sits on the line down to the next step; the step under way's on the dotted one ahead
    expect(rows.some(r => /^  │  +\S/.test(r))).toBe(true)
    expect(rows.some(r => /^  ┆  +\S/.test(r))).toBe(true)
    // A wrapped row starts at the text column, and a step's tag is never split across rows
    for (const r of rows.slice(3)) expect(r).not.toMatch(/^  \S   /)
    for (const width of [24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 40, 44, 46]) {
      const at = planLines(stepsOf(md, true), { plan: 'PLAN.md', auto: RUN, cols: width, now: NOW }).map(l => l.map(s => s.t).join(''))
      for (const r of at.slice(3)) expect(r).not.toMatch(/^  \S   /)
      expect(at.some(r => r.includes('· under way'))).toBe(true)
      expect(at.some(r => r.includes('· up next'))).toBe(true)
    }
  })

  test('says why auto mode is not moving: holding, waiting, paused or off', () => {
    expect(draw(PLAN, { ...RUN, heldUntil: NOW + 3600_000, why: 'Gassed out' })).toContain('holding until')
    expect(draw(PLAN, { ...RUN, waitingUntil: NOW + 900_000, why: 'Waiting on CI' })).toContain('Waiting on CI')
    expect(draw(PLAN, { ...RUN, paused: true, why: 'You interrupted' })).toContain('paused')
    expect(draw(PLAN, null)).toContain('auto mode off')
  })

  test('a plan with no checklist says how to write one', () => {
    expect(draw('# Notes', null)).toContain('- [ ]')
  })
})

describe('the plan\'s lock', () => {
  const BEFORE = '## Steps\n- [x] Write the CI workflow\n- [x] Pin Node\n- [ ] Bump plugin.json\n- [ ] Tag it\n## Revisions\n- turn 3 · added "Pin Node"'

  test('names the steps added, dropped, reopened, and done ones rewritten or removed', () => {
    // CI workflow unticked, Pin Node reworded, Tag it dropped, Push it added
    const after = '## Steps\n- [ ] Write the CI workflow\n- [x] Pin Node 22\n- [ ] Bump plugin.json\n- [ ] Push it\n## Revisions\n- turn 3 · added "Pin Node"'
    expect(planChanges(BEFORE, after)).toEqual({
      added: ['Pin Node 22', 'Push it'],
      dropped: ['Tag it'],
      reopened: ['Write the CI workflow'],
      rewrittenDone: ['Pin Node'],
    })
  })

  test('ticking a step and adding one keep the lock', () => {
    const after = BEFORE.replace('- [ ] Bump plugin.json', '- [x] Bump plugin.json\n- [ ] Push it')
    const changes = planChanges(BEFORE, after)
    expect(changes).toEqual({ added: ['Push it'], dropped: [], reopened: [], rewrittenDone: [] })
    expect(lockBroken(changes, false)).toEqual([])
  })

  test('a ticked step unticked, rewritten or removed breaks the lock unless a revision line logs it', () => {
    const after = BEFORE.replace('- [x] Write the CI workflow', '- [ ] Write the CI workflow').replace('- [x] Pin Node\n', '')
    const changes = planChanges(BEFORE, after)
    expect(lockBroken(changes, false)).toEqual(['Write the CI workflow', 'Pin Node'])
    expect(lockBroken(changes, true)).toEqual([])
  })

  test('counts the revision log\'s lines, so the shell can tell whether it grew', () => {
    expect(revisionsOf(BEFORE)).toBe(1)
    expect(revisionsOf(`${BEFORE}\n- turn 9 · reopened "Write the CI workflow": the check failed`)).toBe(2)
    expect(revisionsOf(PLAN)).toBe(0)
  })
})

describe('the timeline\'s animation', () => {
  const lines = planLines(stepsOf(PLAN, true), { plan: 'ROADMAP.md', auto: RUN, cols: 80, now: NOW })
  const glyphs = (ls: Line[]) => textOfLines(ls)

  test('the lines come in from the top, one a frame', () => {
    expect(planFrame(lines, 0, null).filter(l => l.length).length).toBe(1)
    expect(planFrame(lines, 3, null).filter(l => l.length).length).toBe(lines.slice(0, 4).filter(l => l.length).length)
    expect(glyphs(planFrame(lines, 100, null))).toContain('Draw the timeline')
  })

  test('the step under way spins and a dot runs down the line into it', () => {
    const frames = new Set(Array.from({ length: 24 }, (_, f) => glyphs(planFrame(lines, 100 + f, null))))
    expect(frames.size).toBeGreaterThan(3)
    expect([...frames].some(t => t.includes('●'))).toBe(true)
    expect([...frames].some(t => /[◐◓◑◒] +Draw the timeline/.test(t))).toBe(true)
  })

  test('the step ticked off last pops into its check, then stays one', () => {
    const at = (f: number) => glyphs(planFrame(lines, 100 + f, 100))
    expect(Array.from({ length: 12 }, (_, f) => at(f)).some(t => /✱ +Write the parser/.test(t))).toBe(true)
    expect(at(40)).toMatch(/✔ +Write the parser/)
  })
})

describe('the timeline of an ultra run', () => {
  const RUN_U: PaceAuto = {
    plan: 'PLAN.md', turns: 4, max: 80,
    ultra: {
      goal: 'pace ships 1.0 with CI green.', check: null, phase: 'review', sinceReview: 0, quietReviews: 0, checkFails: 0,
      models: { floor: 'sonnet', ceiling: 'opus' }, headroomStreak: 0,
      gear: { model: 'opus', effort: 'xhigh', subagents: 3, subagentModel: 'sonnet', fanout: true },
      fanout: { agentIds: ['a1'], steps: ['Move Unreleased'] },
    },
  }
  const md = '## Steps\n- [x] Write CI\n- [ ] Bump plugin.json\n- [ ] Move Unreleased (parallel)\n- [ ] Tag it'

  test('says the goal under the title, the phase on the step under way, and marks the steps out on subagents', () => {
    const text = textOfLines(planLines(stepsOf(md, true), { plan: 'PLAN.md', auto: RUN_U, cols: 80, now: NOW }))
    expect(text).toContain('goal  pace ships 1.0 with CI green.')
    expect(text).toMatch(/◉ +Bump plugin.json · review/)
    expect(text).toMatch(/Move Unreleased · with a subagent/)
  })
})

describe('scrolling the sidebar', () => {
  test('arrows and j/k move a row, page keys a screen less a row, Home and End to either end, kept within the plan', () => {
    // 50 lines in 20 rows: the window can start anywhere from 0 to 30
    expect(scrollBy(10, 'down', 50, 20)).toBe(11)
    expect(scrollBy(10, 'k', 50, 20)).toBe(9)
    expect(scrollBy(10, 'pagedown', 50, 20)).toBe(29)
    expect(scrollBy(25, 'pagedown', 50, 20)).toBe(30)
    expect(scrollBy(3, 'pageup', 50, 20)).toBe(0)
    expect(scrollBy(10, 'end', 50, 20)).toBe(30)
    expect(scrollBy(10, 'home', 50, 20)).toBe(0)
    // A plan that fits never moves
    expect(scrollBy(0, 'down', 10, 20)).toBe(0)
  })

  test('the window starts where the step under way shows, a few rows of what is done above it', () => {
    const md = Array.from({ length: 30 }, (_, i) => `- [${i < 20 ? 'x' : ' '}] Step ${i + 1}`).join('\n')
    const lines = planLines(stepsOf(md, true), { plan: 'PLAN.md', auto: RUN, cols: 80, now: NOW, rows: Infinity })
    const at = followOffset(lines, 12)
    const shown = textOfLines(lines.slice(at, at + 12))
    expect(shown).toContain('Step 21 · under way')
    expect(shown).toContain('Step 20')
  })
})
