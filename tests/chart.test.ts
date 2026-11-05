import { describe, expect, test } from 'claude-code/testing'

import { chart, chartSvg } from '../core/chart.ts'

/** The chart's rows as plain text, and as the layer of each cell */
const text = (rows: ReturnType<typeof chart>) => rows.map(r => r.map(x => x.t).join(''))
const layerAt = (rows: ReturnType<typeof chart>, row: number, col: number) => {
  let c = 0
  for (const run of rows[row] ?? []) {
    if (col < c + run.t.length) return run.layer
    c += run.t.length
  }
}

describe('chart', () => {
  test('is width cells by height rows of braille', () => {
    const rows = chart({ segments: [], projection: null }, { used: 0.3, elapsed: 0.5 }, 20, 5)
    expect(rows.length).toBe(5)
    for (const r of text(rows)) {
      expect([...r].length).toBe(20)
      expect(r).toMatch(/^[⠀-⣿]+$/)
    }
  })

  test('the pace line runs from the bottom-left to the top-right', () => {
    const rows = chart({ segments: [], projection: null }, { used: 0, elapsed: 0 }, 20, 5)
    expect(layerAt(rows, 4, 0)).toBe('ideal')
    expect(layerAt(rows, 0, 19)).toBe('ideal')
    expect(layerAt(rows, 0, 0)).toBe('empty')
  })

  test('usage over pace draws above the pace line, and the projection carries it to 100%', () => {
    const seg = [{ elapsed: 0, used: 0 }, { elapsed: 0.25, used: 0.5 }, { elapsed: 0.5, used: 0.8 }]
    const rows = chart({ segments: [seg], projection: { from: seg[2]!, to: { elapsed: 0.75, used: 1 } } }, { used: 0.8, elapsed: 0.5 }, 20, 5)
    // At a quarter of the way across, usage is at half height: row 2 of 5
    expect(layerAt(rows, 2, 5)).toBe('actual')
    expect(layerAt(rows, 0, 14)).toBe('projection')
    // Past where the projection ends, only the pace line is drawn
    expect(layerAt(rows, 1, 18)).not.toBe('projection')
  })

  test('without a trajectory the projection runs from the origin through the latest reading', () => {
    const rows = chart(null, { used: 0.2, elapsed: 0.5 }, 20, 5)
    expect(rows.flat().some(r => r.layer === 'actual')).toBe(true)
    expect(rows.flat().some(r => r.layer === 'projection')).toBe(true)
  })

  test('usage fills the area under its line from the window start to now, and nothing past now', () => {
    const rows = chart(null, { used: 0.8, elapsed: 0.5 }, 20, 5)
    // Half-way across, the bottom row is solid usage; three quarters across, it is not
    expect(text(rows)[4]![9]).toBe('⣿')
    expect(layerAt(rows, 4, 9)).toBe('actual')
    expect(layerAt(rows, 4, 15)).not.toBe('actual')
  })
})

describe('chartSvg', () => {
  const COLORS = { actual: '#5b8def', projection: '#d4a72c', ideal: '#888888', axis: '#888888' }

  test('is an SVG of the size asked for, every point of usage on it', () => {
    // Two readings, 20% then 40% used, halfway through the window
    const svg = chartSvg({ segments: [[{ elapsed: 0.2, used: 0.2 }, { elapsed: 0.5, used: 0.4 }]], projection: null }, { used: 0.4, elapsed: 0.5 }, { width: 400, height: 120, colors: COLORS })
    expect(svg.startsWith('<svg')).toBe(true)
    expect(svg).toContain('viewBox="0 0 400 120"')
    // The usage area in the quota's colour, its readings as points
    expect(svg).toContain(`fill="${COLORS.actual}"`)
    expect((svg.match(/<circle /g) ?? []).length).toBe(3)
  })

  test('draws even pace and the projection as dashed lines, and where now is', () => {
    const svg = chartSvg({ segments: [], projection: { from: { elapsed: 0.5, used: 0.4 }, to: { elapsed: 1, used: 0.8 } } }, { used: 0.4, elapsed: 0.5 }, { width: 400, height: 120, colors: COLORS })
    expect(svg).toMatch(new RegExp(`stroke="${COLORS.ideal}"[^>]*stroke-dasharray`))
    expect(svg).toMatch(new RegExp(`stroke="${COLORS.projection}"[^>]*stroke-dasharray`))
    expect(svg).toContain('100%')
    expect(svg).toContain('0%')
  })
})
