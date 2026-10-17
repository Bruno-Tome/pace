// The Pace window: the pane drawn full-screen in a terminal of its own, from the state file the mod keeps while
// the window is open. Run by Node, which strips the types:
// `node bin/viewer.ts ~/.claude/pace-state.json ~/.claude/pace-keys.json`.
// Redraws when the file changes, every second for the clocks, and on resize. Keys: q or Ctrl-C quits, 1–9 draws
// one quota alone (again: all of them); w (warm mode) and r (refresh) go to the session through the keys file.

import { readFileSync, watchFile, writeFileSync } from 'node:fs'

import { keyAction, screen, type Feed } from '../hooks/view.ts'

const path = process.argv[2]
const keysPath = process.argv[3]
if (!path) {
  process.stderr.write('usage: viewer.ts <state file> [keys file]\n')
  process.exit(2)
}

let feed: Feed | null = load()
let focus: number | undefined

function load(): Feed | null {
  try {
    return JSON.parse(readFileSync(path!, 'utf8')) as Feed
  } catch {
    return null
  }
}

function draw(): void {
  const cols = process.stdout.columns || 100
  const rows = process.stdout.rows || 40
  const body = feed ? screen(feed, Date.now(), cols, rows, { focus }) : 'Waiting for pace to write its figures… (q quits)'
  // Home, each line cleared to its end, then the rest of the screen cleared: no flicker between frames
  process.stdout.write('\x1b[H' + body.split('\n').map(l => `${l}\x1b[K`).join('\n') + '\x1b[J')
}

/** A key for the session: it polls the file every 2 seconds and answers through the state file */
function send(cmd: string): void {
  if (!keysPath) return
  try { writeFileSync(keysPath, JSON.stringify({ id: Date.now(), cmd })) } catch {}
}

function quit(): void {
  process.stdout.write('\x1b[?25h\x1b[?1049l')
  process.exit(0)
}

process.stdout.write('\x1b[?1049h\x1b[?25l')
if (process.stdin.isTTY) {
  process.stdin.setRawMode(true)
  process.stdin.on('data', d => {
    const a = keyAction(d.toString(), focus)
    if (a.quit) quit()
    if ('focus' in a) {
      focus = a.focus
      draw()
    }
    if (a.send) send(a.send)
  })
}
process.on('SIGINT', quit)
process.on('SIGTERM', quit)
process.stdout.on('resize', draw)
watchFile(path, { interval: 1000 }, () => {
  feed = load() ?? feed
  draw()
})
setInterval(draw, 1000)
draw()
