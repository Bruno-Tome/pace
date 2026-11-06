// Activity, full screen in a terminal (.agents/decisions/0025-activity.md): what was spent over any range, sliced any
// way, from the log. Chips on top: click one, or move with the arrows and press enter or space; q quits. What
// `/pace activity` runs in a tmux split or a terminal window.
//
//   node bin/activity.ts [--metric tokens|input|output|cacheRead|cacheWrite|reasoning|usd|prompts|replies]
//                        [--range day|week|month|year|all] [--by provider|account|harness|repo|model] [--once]
//
// The log is read on as it grows (adapters/log.ts) and a frame is drawn again only when a key, a click, the size,
// the log or the minute changed it.

import { existsSync, watch } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { DEFAULT_QUERY, METRICS, pressed, RANGES, type ActivityQuery, type Metric, type Range } from '../core/activity.ts'
import { chipKey, type Chip, type ChipRow } from '../core/chips.ts'
import { DIMS, type Dim } from '../core/dims.ts'
import { LOG_DIR, logDay } from '../core/log.ts'
import { activityScreen, click, toAnsi, type Hit } from '../core/view.ts'
import { accountsIn } from '../adapters/account.ts'
import { LogReader } from '../adapters/log.ts'

const args = process.argv.slice(2)
const once = args.includes('--once')
const arg = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)
const pick = <T extends string>(v: string | undefined, all: readonly T[], or: T): T => (all.includes(v as T) ? (v as T) : or)

let query: ActivityQuery = {
  ...DEFAULT_QUERY,
  metric: pick<Metric>(arg('--metric'), METRICS, DEFAULT_QUERY.metric),
  range: pick<Range>(arg('--range'), RANGES, DEFAULT_QUERY.range),
  by: pick<Dim>(arg('--by'), DIMS, DEFAULT_QUERY.by),
}
let focus = 0
const home = homedir()
const reader = new LogReader()
/** Local time's lead on UTC, in ms */
const zone = () => -new Date().getTimezoneOffset() * 60_000

let hits: Hit[] = []
let chips: Chip[] = []
/** The chips as last drawn, by row: what the arrows move across */
let chipRows: ChipRow[] = []
let drawn = ''

function frame(): string[] {
  const now = Date.now()
  const cols = process.stdout.columns || Number(process.env.COLUMNS) || 100
  const rows = process.stdout.rows || Number(process.env.LINES) || 40
  const screen = activityScreen(reader.activity(home, now).rows(), query, { cols, rows, now, zone: zone(), focus: once ? undefined : focus, accounts: accountsIn(home) })
  hits = screen.hits
  chipRows = screen.chips
  chips = chipRows.flatMap(r => r.chips)
  return screen.lines.map(toAnsi)
}

function draw(): void {
  const body = frame()
  if (once) {
    process.stdout.write(`${body.join('\n')}\n`)
    return
  }
  const text = body.map(l => `${l}\x1b[K`).join('\n')
  // Nothing changed on screen: nothing written
  if (text === drawn) return
  drawn = text
  process.stdout.write(`\x1b[H${text}\x1b[J`)
}

/** A chip pressed: the next question, drawn */
function press(chip: Chip | undefined): void {
  if (!chip) return
  query = pressed(query, chip)
  draw()
}

function quit(): void {
  process.stdout.write('\x1b[?1000l\x1b[?1006l\x1b[?25h\x1b[?1049l')
  process.exit(0)
}

/** A key or a click: a mouse press reports `ESC [ < button ; x ; y M` (SGR) */
function input(data: string): void {
  const mouse = /^\x1b\[<(\d+);(\d+);(\d+)M$/.exec(data)
  if (mouse) {
    if (Number(mouse[1]) !== 0) return
    const key = click(hits, Number(mouse[2]), Number(mouse[3]))
    const at = chips.findIndex(c => `${c.group}:${c.value}` === key)
    if (at >= 0) focus = at
    return press(chips[at])
  }
  const next = chipKey(chipRows, focus, data)
  if (next.quit) return quit()
  focus = next.focus
  if (next.chip) return press(next.chip)
  draw()
}

if (once) {
  draw()
} else {
  process.stdout.write('\x1b[?1049h\x1b[?25l\x1b[?1000h\x1b[?1006h')
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true)
    process.stdin.on('data', (d: Buffer) => input(d.toString()))
  }
  process.on('SIGINT', quit)
  process.on('SIGTERM', quit)
  process.stdout.on('resize', draw)
  // Today's log as it grows; a minute's tick for the clock and a new day
  const root = join(home, LOG_DIR)
  let watching = ''
  const follow = () => {
    const dir = join(root, logDay(Date.now()))
    if (dir === watching || !existsSync(dir)) return
    watching = dir
    try {
      watch(dir, draw)
    } catch {}
  }
  follow()
  setInterval(() => { follow(); draw() }, 30_000)
  draw()
}
