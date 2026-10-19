// The band above the prompt, animated on the surface's frame clock: each bar fills in from empty, then a sheen
// sweeps across it every few seconds, and a too-fast warning pulses. The hooks module hands over one row of
// segments per quota. While ultra pace runs, its gear powers the animation up: in cruise the sheen comes round
// twice as often; in push it goes super saiyan, a wide gold sheen three times as often, the filled cells crackling
// and a spark on ultra pace's own row.

import type { ClientModule, RenderElement } from 'claude-code'

type Seg = { t: string; color?: string; dim?: boolean; bold?: boolean; bar?: boolean; pulse?: boolean; aura?: boolean }
type Props = { lines: Seg[][]; ultra?: 'push' | 'cruise' | 'ease' }

const FRAME = 80
/** Frames the fill takes to reach its value */
const GROW = 12
const PULSE = 6

/**
 * How the animation looks at each of ultra pace's gears; calm without one. A sweep crosses the whole bar at `speed`
 * cells a frame, then rests `rest` frames.
 */
type Power = { speed: number; rest: number; sheen: number; gold: boolean; crackle: boolean; spark: boolean }
const CALM: Power = { speed: 1, rest: 28, sheen: 2, gold: false, crackle: false, spark: false }
export const POWERS = {
  calm: CALM,
  ease: CALM,
  cruise: { ...CALM, speed: 2, rest: 12 },
  push: { speed: 3, rest: 4, sheen: 3, gold: true, crackle: true, spark: true },
} satisfies Record<string, Power>
const POWER: Record<NonNullable<Props['ultra']>, Power> = POWERS

/** The cells the sheen lights at frame `f` on a bar `width` cells wide, first to last; off the bar while it rests */
export function sheenAt(f: number, width: number, power: Power): [number, number] {
  if (f < GROW) return [-99, -99]
  // Frames to carry the sheen's tail past the last cell, then the rest
  const crossing = Math.ceil((width + power.sheen) / power.speed)
  const t = (f - GROW) % (crossing + power.rest)
  if (t >= crossing) return [-99, -99]
  const head = t * power.speed
  return [head - power.sheen + 1, head]
}
/** In place of ultra pace's ▶, one cell wide each so the row keeps its width */
const SPARKS = ['▶', '✦', '✧', '✦']

/** Whether a filled cell crackles at frame `f`: about one in seven, a different few every two frames */
const crackles = (cell: number, f: number) => ((cell * 7919 + Math.floor(f / 2) * 104729) % 7) === 0

/** Every run of consecutive bar segments, as [first, last] indexes */
function barSpans(segs: readonly Seg[]): [number, number][] {
  const spans: [number, number][] = []
  segs.forEach((s, i) => {
    if (!s.bar) return
    const last = spans[spans.length - 1]
    if (last && last[1] === i - 1) last[1] = i
    else spans.push([i, i])
  })
  return spans
}

const Band: ClientModule<Props, { f: number }> = (props, surface) => {
  const { Box, Text } = surface.elements
  if (surface.state === undefined) {
    surface.setState({ f: 0 })
    surface.every(FRAME, () => surface.setState({ f: (surface.state?.f ?? 0) + 1 }))
  }
  const f = surface.state?.f ?? 0
  const power = props.ultra ? POWER[props.ultra] : CALM
  const lines = (props.lines ?? []).map((segs, i) => (
    <Text key={`pace-line-${i}`} wrap="truncate-end">{drawLine(Text, segs, f, power)}</Text>
  ))
  return <Box flexDirection="column">{lines}</Box>
}

/** One row's segments at frame `f`: bar cells hidden until the fill reaches them, the sheen's cells bright */
function drawLine(Text: any, segs: readonly Seg[], f: number, power: Power = CALM): RenderElement[] {
  const out: RenderElement[] = []
  const inBar = new Map<number, [number, number]>()
  for (const span of barSpans(segs)) for (let i = span[0]; i <= span[1]; i++) inBar.set(i, span)

  let k = 0
  const text = (t: string, s: { color?: string; dim?: boolean; bold?: boolean }) =>
    out.push(s.dim ? <Text key={`s${k++}`} dimColor bold={s.bold}>{t}</Text> : <Text key={`s${k++}`} color={s.color} bold={s.bold}>{t}</Text>)

  segs.forEach((s, i) => {
    const span = inBar.get(i)
    if (s.aura && power.spark) return text(s.t.replace('▶', SPARKS[Math.floor(f / 2) % SPARKS.length]!), { ...s, color: 'warning', bold: true })
    if (!span) {
      const dim = s.dim || (s.pulse && Math.floor(f / PULSE) % 2 === 1)
      return text(s.t, { ...s, dim })
    }
    // Cell index of this run's first cell within its bar, and the bar's width
    const lengths = segs.slice(span[0], span[1] + 1).map(x => x.t.length)
    const start = lengths.slice(0, i - span[0]).reduce((a, b) => a + b, 0)
    const width = lengths.reduce((a, b) => a + b, 0)
    const grown = Math.min(1, f / GROW) * width
    const lit = sheenAt(f, width, power)
    const chars = [...s.t]
    // Cells of one look go out together
    let run = ''
    let look: string | undefined
    const flush = () => {
      if (!run) return
      if (look === 'hidden') text('░'.repeat(run.length), { dim: true })
      else if (look === 'sheen') text(run, { color: power.gold ? 'warning' : 'text', bold: true })
      else if (look === 'crackle') text('▓'.repeat(run.length), { ...s, color: 'warning' })
      else text(run, s)
      run = ''
    }
    chars.forEach((ch, c) => {
      const cell = start + c
      const filled = ch === '█'
      const next =
        filled && cell >= grown ? 'hidden'
        : cell >= lit[0] && cell <= lit[1] ? 'sheen'
        : filled && power.crackle && crackles(cell, f) ? 'crackle'
        : 'plain'
      if (next !== look) flush()
      look = next
      run += ch
    })
    flush()
  })

  return out
}

export default Band
