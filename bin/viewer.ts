// The Pace window: the pane drawn full-screen in a terminal of its own, from the state file the mod keeps while
// the window is open. Run by Node, which strips the types:
// `node bin/viewer.ts ~/.claude/pace-state.json ~/.claude/pace-keys.json`.
// Redraws when the file changes, every second for the clocks, and on resize. The command bar's keys, or a click on
// a button, send a /pace command to the session through the keys file; its answer comes back in the state file.
// 1–9 draws one quota alone (again: all of them); q or Ctrl-C quits.

import { readFileSync, watchFile, writeFileSync } from 'node:fs'

import { KEYS_FILE, STATE_FILE } from '../hooks/files.ts'
import { click, press, screenOf, type Feed, type Hit, type UiState } from '../hooks/view.ts'

const path = process.argv[2]
const keysPath = process.argv[3]
if (!path) {
  process.stderr.write(`usage: viewer.ts <state file: ~/${STATE_FILE}> [keys file: ~/${KEYS_FILE}]\n`)
  process.exit(2)
}

let feed: Feed | null = load()
let ui: UiState = {}
/** Where the buttons were last drawn, for a click */
let hits: Hit[] = []

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
  let body = 'Waiting for pace to write its figures… (q quits)'
  if (feed) {
    const s = screenOf(feed, Date.now(), cols, rows, ui)
    body = s.text
    hits = s.hits
  }
  // Home, each line cleared to its end, then the rest of the screen cleared: no flicker between frames
  process.stdout.write('\x1b[H' + body.split('\n').map(l => `${l}\x1b[K`).join('\n') + '\x1b[J')
}

/** A command for the session: it polls the file every 2 seconds and answers through the state file */
function send(cmd: string): void {
  if (!keysPath) return
  try { writeFileSync(keysPath, JSON.stringify({ id: Date.now(), cmd })) } catch {}
}

/** A key, pressed or clicked */
function key(k: string): void {
  if (!feed) {
    if (k === 'q' || k === '\x03') quit()
    return
  }
  const a = press(ui, k, feed)
  ui = a.ui
  if (a.quit || a.send === 'quit') quit()
  if (a.send && a.send !== 'quit') send(a.send)
  draw()
}

/** A mouse report (SGR: `\x1b[<button;x;yM`): a left press on a button is its key */
function mouse(data: string): boolean {
  const m = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/.exec(data)
  if (!m) return false
  if (m[1] === '0' && m[4] === 'M') {
    const k = click(hits, Number(m[2]), Number(m[3]))
    if (k) key(k)
  }
  return true
}

function quit(): void {
  // The session closes the timeline pane this one opened, and opens a fresh split next time
  send('close')
  process.stdout.write('\x1b[?1000l\x1b[?1006l\x1b[?25h\x1b[?1049l')
  process.exit(0)
}

process.stdout.write('\x1b[?1049h\x1b[?25l\x1b[?1000h\x1b[?1006h')
if (process.stdin.isTTY) {
  process.stdin.setRawMode(true)
  process.stdin.on('data', d => {
    const s = d.toString()
    if (mouse(s)) return
    key(s)
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
