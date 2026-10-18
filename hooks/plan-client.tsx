// The plan's timeline in a pane, animated on the surface's frame clock: the frames come from timeline.ts. The hooks
// module hands over the lines and how many steps are done; a step ticked off since the last drawing pops.

import type { ClientModule } from 'claude-code'

import { FRAME_MS, planFrame } from './timeline.ts'
import type { Line } from './view.ts'

type Props = { lines: Line[]; done: number }
/** `f`: the frame; `done`: the steps done as last drawn; `popAt`: the frame the last step was ticked off on */
type State = { f: number; done: number; popAt: number | null }

const Timeline: ClientModule<Props, State> = (props, surface) => {
  const { Box, Text } = surface.elements
  const done = props.done ?? 0
  if (surface.state === undefined) {
    surface.setState({ f: 0, done, popAt: null })
    surface.every(FRAME_MS, () => { const s = surface.state; if (s) surface.setState({ ...s, f: s.f + 1 }) })
  }
  const st = surface.state ?? { f: 0, done, popAt: null }
  if (surface.state && st.done !== done) surface.setState({ ...st, done, popAt: done > st.done ? st.f : st.popAt })
  let k = 0
  const lines = planFrame(props.lines ?? [], st.f, st.popAt).map((segs, i) => (
    <Text key={`pace-plan-${i}`} wrap="truncate-end">
      {segs.length
        ? segs.map(s => (s.dim ? <Text key={`s${k++}`} dimColor bold={s.bold}>{s.t}</Text> : <Text key={`s${k++}`} color={s.color} bold={s.bold}>{s.t}</Text>))
        : ' '}
    </Text>
  ))
  return <Box flexDirection="column">{lines}</Box>
}

export default Timeline
