import { describe, expect, test } from 'claude-code/testing'

import type { PaceAuto } from '../types'
import { stepsOf } from '../hooks/plan.ts'
import { followOffset, nowRow } from '../hooks/timeline.ts'
import { planLines, type Line } from '../hooks/view.ts'

const NOW = Date.UTC(2026, 9, 17, 12, 0, 0)
const RUN: PaceAuto = { plan: 'PLAN.md', turns: 5, max: 40 }
const plan = (n: number, done: number) => Array.from({ length: n }, (_, i) => `- [${i < done ? 'x' : ' '}] Step ${i + 1}`).join('\n')
const linesOf = (md: string): Line[] => planLines(stepsOf(md, true), { plan: 'PLAN.md', auto: RUN, cols: 80, now: NOW, rows: Infinity })
const textOf = (lines: Line[]) => lines.map(l => l.map(s => s.t).join('')).join('\n')
const window = (lines: Line[], rows: number) => textOf(lines.slice(followOffset(lines, rows), followOffset(lines, rows) + rows))

describe('following the plan', () => {
  test('with every step done, the window shows the end of the plan: the last step done', () => {
    const lines = linesOf(plan(30, 30))
    expect(nowRow(lines)).toBe(lines.length - 1)
    expect(window(lines, 12)).toContain('Step 30')
    expect(followOffset(lines, 12)).toBe(lines.length - 12)
  })

  test('with none done, the window starts at the top: the title and the first step under way', () => {
    const lines = linesOf(plan(30, 0))
    expect(textOf([lines[nowRow(lines)]!])).toContain('Step 1 · under way')
    expect(followOffset(lines, 12)).toBe(0)
    expect(window(lines, 12)).toContain('PLAN.md')
  })

  test('a plan shorter than the window never scrolls, whichever step is under way', () => {
    for (const done of [0, 2, 4]) {
      const lines = linesOf(plan(4, done))
      expect(followOffset(lines, 40)).toBe(0)
    }
  })

  test('a plan with no checklist has a row to follow and nothing to scroll', () => {
    const lines = linesOf('# Ideas\nJust prose.')
    expect(nowRow(lines)).toBeGreaterThanOrEqual(0)
    expect(followOffset(lines, 12)).toBe(0)
  })
})
