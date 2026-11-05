// The plan's timeline as frames: the steps come in from the top, a dot runs down the line into the step under way
// while its node spins, and the step ticked off last pops into a check. The pane's client and the tmux sidebar
// draw the same frames. Pure; times in frames.

import type { PaceAuto } from '../types'
import type { Line, Seg } from './view.ts'

/** What the tmux sidebar draws from: the plan as named and its full path, auto mode's run on it, when written */
/** What the sidebar draws from; `also`: a second plan drawn beside the first (the roadmap beside an ultra run's plan) */
export type PlanFeed = { plan: string; path: string; auto: PaceAuto | null; at: number; also?: { plan: string; path: string; auto: PaceAuto | null } }

/** Frames between two lines coming in */
const REVEAL = 1
/** Frames each spin, flow and pop look holds */
const STEP = 3
const SPIN = ['◐', '◓', '◑', '◒']
const POP = ['◉', '◎', '✱', '✔']

/** The milliseconds a frame lasts */
export const FRAME_MS = 80

/**
 * The timeline at frame `f`: lines not yet come in are empty, the marked segments animated. `popAt`: the frame the
 * last step was ticked off on; null when none was since the timeline was first drawn.
 */
export function planFrame(lines: readonly Line[], f: number, popAt: number | null): Line[] {
  const flows = lines.flat().filter(s => s.flow).length
  const dot = Math.floor(f / STEP) % (flows + 2)
  const popping = popAt != null && f >= popAt && f - popAt < POP.length * STEP
  let flow = 0
  const frame = (s: Seg): Seg => {
    if (s.spin) return { ...s, t: SPIN[Math.floor(f / STEP) % SPIN.length]! }
    if (s.flow && flow++ === dot) return { t: '●', color: 'suggestion', bold: true }
    if (s.pop && popping) return { t: POP[Math.floor((f - popAt!) / STEP)]!, color: 'success', bold: true }
    return s
  }
  return lines.map((segs, i) => (f >= i * REVEAL ? segs.map(frame) : []))
}

/**
 * Where the sidebar's window over `total` lines starts after `key`: arrows and j/k a line, page keys and space a
 * window less a line, Home/End and g/G either end; any other key leaves it. Kept so the window never runs past
 * the plan.
 */
export function scrollBy(offset: number, key: string, total: number, rows: number): number {
  const max = Math.max(0, total - rows)
  const page = Math.max(1, rows - 1)
  const to =
    key === 'down' || key === 'j' ? offset + 1
    : key === 'up' || key === 'k' ? offset - 1
    : key === 'pagedown' || key === ' ' ? offset + page
    : key === 'pageup' ? offset - page
    : key === 'home' || key === 'g' ? 0
    : key === 'end' || key === 'G' ? max
    : offset
  return Math.min(max, Math.max(0, to))
}

/** The row of the step under way (its spinning mark), else the first step ahead, else the last row */
export function nowRow(lines: readonly Line[]): number {
  const under = lines.findIndex(l => l.some(s => s.t === '◉'))
  if (under >= 0) return under
  const ahead = lines.findIndex(l => l.some(s => s.t === '○'))
  return ahead >= 0 ? ahead : Math.max(0, lines.length - 1)
}

/** Where a window of `rows` starts to show the step under way, with a few rows of what is done above it */
export function followOffset(lines: readonly Line[], rows: number): number {
  const lead = Math.min(4, Math.floor(rows / 3))
  return Math.min(Math.max(0, lines.length - rows), Math.max(0, nowRow(lines) - lead))
}

const NAMED: Record<string, string> = {
  '\x1b[A': 'up', '\x1b[B': 'down', '\x1b[5~': 'pageup', '\x1b[6~': 'pagedown',
  '\x1b[H': 'home', '\x1b[1~': 'home', '\x1b[F': 'end', '\x1b[4~': 'end',
}

/** What the sidebar reads as a scroll: a key's name for `scrollBy`, the mouse wheel as up or down; null for anything else */
export function keyOf(k: string): string | null {
  if (NAMED[k]) return NAMED[k]!
  // SGR mouse: button 64 is the wheel up, 65 down
  const wheel = /^\x1b\[<(64|65);\d+;\d+M/.exec(k)
  if (wheel) return wheel[1] === '64' ? 'up' : 'down'
  return ['j', 'k', 'g', 'G', ' '].includes(k) ? k : null
}
