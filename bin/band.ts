// The band, live, in any terminal: in a pane beside Codex, or any agent pace has a feed for. Run by Node, which
// strips the types:
//
//   node bin/band.ts [feed file]       that feed's band; without one, the newest live feed's
//   node bin/band.ts --terminal <id>   the band of the agent in that Herdr terminal (HC_TERMINAL_ID)
//   node bin/band.ts --fleet           every provider's quotas, the one with the most room first, with its agents
//   --once                             draws once and exits, for a script or a test
//
// Reads the feeds in ~/.local/state/pace/feeds/, redraws when they change, every second for the clocks, and on
// resize. q or Ctrl-C quits.

import { existsSync, readdirSync, readFileSync, watch } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { agentOf, FEEDS_DIR, feedFor, feedOf, fleetOf, type PaceFeed } from '../core/host.ts'
import { agentLine, bandLines, fleetLines, toAnsi, type Line } from '../core/view.ts'

const args = process.argv.slice(2)
const once = args.includes('--once')
const fleet = args.includes('--fleet')
const terminal = args.includes('--terminal') ? args[args.indexOf('--terminal') + 1] : undefined
const file = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--terminal')
const dir = join(homedir(), FEEDS_DIR)

/** Every feed that parses: one file's alone when given one */
function feeds(): PaceFeed[] {
  const paths = file ? [file] : existsSync(dir) ? readdirSync(dir).filter(n => n.endsWith('.json')).map(n => join(dir, n)) : []
  return paths.flatMap(path => {
    try {
      const feed = feedOf(readFileSync(path, 'utf8'))
      return feed ? [feed] : []
    } catch {
      return []
    }
  })
}

function frame(now: number, cols: number): Line[] {
  const all = feeds()
  if (fleet) return fleetLines(fleetOf(all, now), now, cols)
  // A file given is drawn however old it is: it was asked for by name
  const feed = file ? (all[0] ?? null) : feedFor(all, now, terminal)
  if (!feed) return [[{ t: terminal ? `waiting for ${terminal}: no live feed from it yet` : 'waiting for an agent: no live feed yet', dim: true }]]
  return [agentLine(agentOf(feed), now), ...bandLines(feed.snapshot, now, cols)]
}

function draw(): void {
  const cols = process.stdout.columns || Number(process.env.COLUMNS) || 100
  const body = frame(Date.now(), cols).map(toAnsi)
  if (once) {
    process.stdout.write(`${body.join('\n')}\n`)
    return
  }
  process.stdout.write('\x1b[H' + body.map(l => `${l}\x1b[K`).join('\n') + '\x1b[J')
}

function quit(): void {
  process.stdout.write('\x1b[?25h\x1b[?1049l')
  process.exit(0)
}

if (once) {
  draw()
} else {
  process.stdout.write('\x1b[?1049h\x1b[?25l')
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true)
    process.stdin.on('data', (data: Buffer) => {
      const key = data.toString()
      if (key === 'q' || key === '\x03') quit()
    })
  }
  process.on('SIGINT', quit)
  process.on('SIGTERM', quit)
  process.stdout.on('resize', draw)
  if (existsSync(dir)) watch(dir, draw)
  setInterval(draw, 1000)
  draw()
}
