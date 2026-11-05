// How Herdr shows view.ts's segments: each semantic color as the theme's ANSI color, the one a terminal would show,
// so the band looks the same in a panel as beside the prompt. Pure.

import type { PaceProvider } from '../../core/host.ts'
import type { HerdrView } from './open.ts'
import type { Seg } from '../../core/view.ts'

/** A segment's look in a panel */
export type Style = { color: string; bold: boolean; pulse: boolean }

/** The theme's ANSI color for each of view.ts's semantic colors, as `toAnsi` picks them (subtle is bright black) */
const THEME_COLOR: Record<string, string> = {
  success: 'ansi2', warning: 'ansi3', error: 'ansi1', text: 'ansi7', subtle: 'ansi8', suggestion: 'ansi4', merged: 'ansi5', ide: 'ansi6',
}

/** Padding either side of the panel's text, and above and below it, in px */
export const PAD = 10
export const PAD_Y = 6

/** The narrowest band that still draws its words */
const MIN_COLS = 40

/** A segment's color in the theme, its weight and whether it pulses; the foreground where the theme lacks a color */
export function styleOf(s: Seg, theme: Readonly<Record<string, string>>): Style {
  const named = s.dim ? 'dim' : s.color ? THEME_COLOR[s.color] : 'foreground'
  return { color: (named && theme[named]) ?? theme.foreground ?? '', bold: !!s.bold, pulse: !!s.pulse }
}

/** The columns a panel `width` px wide holds at text `size` px: a monospace character is 0.6 of the size */
export function colsFor(width: number, size: number): number {
  return Math.max(MIN_COLS, Math.floor((width - 2 * PAD) / (size * 0.6)))
}

const PROVIDERS: readonly PaceProvider[] = ['claude', 'codex']

/** The view a copy's props ask for (a `HerdrView`, as /pace opens it); the fleet panel for none, or for props it cannot read */
export function viewOf(props: unknown): HerdrView {
  const p = typeof props === 'object' && props != null ? (props as Record<string, unknown>) : {}
  if (p.view === 'band' && typeof p.terminal === 'string' && p.terminal) return { view: 'band', terminal: p.terminal }
  if (p.view === 'pane' && PROVIDERS.includes(p.provider as PaceProvider)) return { view: 'pane', provider: p.provider as PaceProvider }
  return { view: 'panel' }
}

/** The rows a pane `height` px tall holds at `line` px a row, the padding taken off */
export function rowsFor(height: number, line: number): number {
  return Math.max(1, Math.floor((height - 2 * PAD_Y) / line))
}
