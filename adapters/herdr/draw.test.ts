import { describe, expect, test } from 'claude-code/testing'

import { colsFor, rowsFor, styleOf, viewOf } from './draw.ts'

/** The theme's colors by name, as Herdr's `theme()` gives them */
const THEME: Record<string, string> = {
  foreground: '#fff', muted: '#999', dim: '#666',
  ansi1: '#f00', ansi2: '#0f0', ansi3: '#ff0', ansi4: '#00f', ansi5: '#f0f', ansi6: '#0ff', ansi7: '#ccc', ansi8: '#888',
}

describe('a segment in Herdr', () => {
  test('its semantic color is the theme\'s ANSI color the terminal would show', () => {
    expect(styleOf({ t: 'x', color: 'success' }, THEME).color).toBe('#0f0')
    expect(styleOf({ t: 'x', color: 'warning' }, THEME).color).toBe('#ff0')
    expect(styleOf({ t: 'x', color: 'error' }, THEME).color).toBe('#f00')
    expect(styleOf({ t: 'x', color: 'suggestion' }, THEME).color).toBe('#00f')
    expect(styleOf({ t: 'x', color: 'subtle' }, THEME).color).toBe('#888')
  })

  test('plain text is the foreground, dim text the theme\'s dim, bold and pulse kept', () => {
    expect(styleOf({ t: 'x' }, THEME)).toEqual({ color: '#fff', bold: false, pulse: false })
    expect(styleOf({ t: 'x', dim: true }, THEME).color).toBe('#666')
    expect(styleOf({ t: 'x', bold: true, pulse: true, color: 'error' }, THEME)).toEqual({ color: '#f00', bold: true, pulse: true })
  })

  test('a color the theme lacks falls back to the foreground', () => {
    expect(styleOf({ t: 'x', color: 'ide' }, { foreground: '#fff' }).color).toBe('#fff')
  })
})

describe('the columns a panel holds', () => {
  test('a monospace character is six tenths of the text size wide, the padding taken off', () => {
    // 400px less 2 × 10px padding at 12px text: 380 / 7.2 = 52 columns
    expect(colsFor(400, 12)).toBe(52)
  })

  test('never fewer than the band needs to draw at all', () => {
    expect(colsFor(0, 12)).toBe(40)
  })
})

describe('which view a copy of the mod draws', () => {
  test('a band pane: one agent\'s band, by its terminal', () => {
    expect(viewOf({ view: 'band', terminal: 't7' })).toEqual({ view: 'band', terminal: 't7' })
  })

  test('a pace pane: a harness\'s charts, all its sessions together', () => {
    expect(viewOf({ view: 'pane', provider: 'codex' })).toEqual({ view: 'pane', provider: 'codex' })
  })

  test('the panel otherwise, or for props it cannot read', () => {
    expect(viewOf(undefined)).toEqual({ view: 'panel' })
    expect(viewOf({ view: 'band' })).toEqual({ view: 'panel' })
    expect(viewOf({ view: 'pane', provider: 'gemini' })).toEqual({ view: 'panel' })
  })
})

describe('the rows a pane holds', () => {
  test('its height at a row\'s line height, the padding taken off', () => {
    // 612px less 2 × 6px padding at 15px a row: 600 / 15 = 40 rows
    expect(rowsFor(612, 15)).toBe(40)
    expect(rowsFor(0, 15)).toBe(1)
  })
})
