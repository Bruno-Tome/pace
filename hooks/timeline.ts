// The plan's timeline as frames: the steps come in from the top, a dot runs down the line into the step under way
// while its node spins, and the step ticked off last pops into a check. The pane's client and the tmux sidebar
// draw the same frames. Pure; times in frames.

import type { PaceAuto } from '../types'
import type { Line, Seg } from './view.ts'

/** What the tmux sidebar draws from: the plan as named and its full path, auto mode's run on it, when written */
export type PlanFeed = { plan: string; path: string; auto: PaceAuto | null; at: number }

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
