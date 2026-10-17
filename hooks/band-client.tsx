// The band above the prompt, animated on the surface's frame clock: each bar fills in from empty, then a sheen
// sweeps across it every few seconds, and a too-fast warning pulses. The hooks module hands over one row of
// segments per quota.

import type { ClientModule, RenderElement } from 'claude-code'

type Seg = { t: string; color?: string; dim?: boolean; bold?: boolean; bar?: boolean; pulse?: boolean }
type Props = { lines: Seg[][] }

const FRAME = 80
/** Frames the fill takes to reach its value */
const GROW = 12
/** Frames between the starts of two sweeps: the sheen's crossing, then a rest */
const PERIOD = 40
const PULSE = 6

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
  const lines = (props.lines ?? []).map((segs, i) => (
    <Text key={`pace-line-${i}`} wrap="truncate-end">{drawLine(Text, segs, f)}</Text>
  ))
  return <Box flexDirection="column">{lines}</Box>
}

/** One row's segments at frame `f`: bar cells hidden until the fill reaches them, the sheen's two cells bright */
function drawLine(Text: any, segs: readonly Seg[], f: number): RenderElement[] {
  const sweep = f < GROW ? -99 : (f - GROW) % PERIOD
  const out: RenderElement[] = []
  const inBar = new Map<number, [number, number]>()
  for (const span of barSpans(segs)) for (let i = span[0]; i <= span[1]; i++) inBar.set(i, span)

  let k = 0
  const text = (t: string, s: { color?: string; dim?: boolean; bold?: boolean }) =>
    out.push(s.dim ? <Text key={`s${k++}`} dimColor bold={s.bold}>{t}</Text> : <Text key={`s${k++}`} color={s.color} bold={s.bold}>{t}</Text>)

  segs.forEach((s, i) => {
    const span = inBar.get(i)
    if (!span) {
      const dim = s.dim || (s.pulse && Math.floor(f / PULSE) % 2 === 1)
      return text(s.t, { ...s, dim })
    }
    // Cell index of this run's first cell within its bar, and the bar's width
    const lengths = segs.slice(span[0], span[1] + 1).map(x => x.t.length)
    const start = lengths.slice(0, i - span[0]).reduce((a, b) => a + b, 0)
    const width = lengths.reduce((a, b) => a + b, 0)
    const grown = Math.min(1, f / GROW) * width
    const chars = [...s.t]
    // Cells of one look go out together
    let run = ''
    let look: string | undefined
    const flush = () => {
      if (!run) return
      if (look === 'hidden') text('░'.repeat(run.length), { dim: true })
      else if (look === 'sheen') text(run, { color: 'text', bold: true })
      else text(run, s)
      run = ''
    }
    chars.forEach((ch, c) => {
      const cell = start + c
      const filled = ch === '█'
      const next = filled && cell >= grown ? 'hidden' : cell === sweep || cell === sweep - 1 ? 'sheen' : 'plain'
      if (next !== look) flush()
      look = next
      run += ch
    })
    flush()
  })

  return out
}

export default Band
