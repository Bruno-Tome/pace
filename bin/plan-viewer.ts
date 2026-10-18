// The plan's timeline as a sidebar: drawn in a narrow tmux split beside Claude from the feed the mod writes and
// the plan file itself, animated with the pane's frames. Run by Node, which strips the types:
// `node bin/plan-viewer.ts ~/.claude/pace-plan-<session>.json`.
// Reads the feed and the plan every second, draws a frame every 80ms and on resize. q or Ctrl-C quits.

import { readFileSync } from 'node:fs'

import { stepsOf } from '../hooks/plan.ts'
import { FRAME_MS, planFrame, type PlanFeed } from '../hooks/timeline.ts'
import { planLines, toAnsi, type Seg } from '../hooks/view.ts'

const feedPath = process.argv[2]
if (!feedPath) {
  process.stderr.write('usage: plan-viewer.ts <feed file: ~/.claude/pace-plan-<session>.json>\n')
  process.exit(2)
}

let feed: PlanFeed | null = null
let text = ''
let f = 0
let done: number | null = null
let popAt: number | null = null

function load(): void {
  try { feed = JSON.parse(readFileSync(feedPath!, 'utf8')) as PlanFeed } catch {}
  if (!feed) return
  try { text = readFileSync(feed.path, 'utf8') } catch { text = '' }
}

/** A line cut to the terminal's width, so it never wraps */
function clip(segs: readonly Seg[], cols: number): Seg[] {
  const out: Seg[] = []
  let room = cols
  for (const s of segs) {
    if (room <= 0) break
    const chars = [...s.t]
    out.push({ ...s, t: chars.slice(0, room).join('') })
    room -= chars.length
  }
  return out
}

function draw(): void {
  const cols = process.stdout.columns || 46
  const rows = process.stdout.rows || 40
  let body = 'Waiting for pace to write the plan… (q quits)'
  if (feed) {
    const steps = stepsOf(text, feed.auto != null && !feed.auto.paused)
    const now = steps.filter(s => s.state === 'done').length
    if (done != null && now > done) popAt = f
    done = now
    const lines = planLines(steps, { plan: feed.plan, auto: feed.auto, cols: cols - 1, now: Date.now(), rows: rows - 1 })
    body = ['', ...planFrame(lines, f, popAt).map(l => toAnsi(clip(l, cols - 1)))].join('\n')
  }
  // Home, each line cleared to its end, then the rest of the screen cleared: no flicker between frames
  process.stdout.write('\x1b[H' + body.split('\n').map(l => `${l}\x1b[K`).join('\n') + '\x1b[J')
}

function quit(): void {
  process.stdout.write('\x1b[?25h\x1b[?1049l')
  process.exit(0)
}

process.stdout.write('\x1b[?1049h\x1b[?25l')
if (process.stdin.isTTY) {
  process.stdin.setRawMode(true)
  process.stdin.on('data', d => {
    const k = d.toString()
    if (k === 'q' || k === '\x03') quit()
  })
}
process.on('SIGINT', quit)
process.on('SIGTERM', quit)
process.stdout.on('resize', draw)
load()
setInterval(load, 1000)
setInterval(() => { f++; draw() }, FRAME_MS)
draw()
