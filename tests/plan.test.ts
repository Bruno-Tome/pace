import { describe, expect, test } from 'claude-code/testing'

import type { PaceAuto } from '../types'
import { stepsOf } from '../hooks/plan.ts'
import { planFrame } from '../hooks/timeline.ts'
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
