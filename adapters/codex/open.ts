// Opens pace in Herdr beside this Codex session: its charts, or with `band` its band, or with `fleet` the fleet.
// The hook runs it for a `/pace` or `$pace` prompt; the pace skill runs it as a command when the hook did not:
// `node adapters/codex/open.ts [band|fleet]`, which prints one line and exits 1 when nothing opened.

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { ALREADY_OPEN, herdrOpen, herdrReuse, paceViewOf, registryIn, sharedFile } from '../herdr/open.ts'

const run = (argv: readonly string[]) => execFileSync(argv[0]!, argv.slice(1), { stdio: 'ignore', timeout: 5000 })

/** Opens what `/pace <arg>` asks for, or focuses the pane already showing it: whether it did, and what to say */
export function openInHerdr(arg: string): { opened: boolean; text: string } {
  const terminal = process.env.HC_TERMINAL_ID
  if (!terminal) return { opened: false, text: '/pace opens pace in Herdr, and this Codex is not running in Herdr' }
  const view = paceViewOf(arg, 'codex', terminal)
  if (!view) return { opened: false, text: `/pace ${arg}: use /pace, /pace band or /pace fleet` }
  const shared = sharedFile(process.env.HERDR_APP_HOME || join(homedir(), '.config', 'herdr-app'))
  const reuse = herdrReuse(existsSync(shared) ? registryIn(readFileSync(shared, 'utf8')) : {}, view)
  if (reuse) {
    try {
      run(reuse)
      return { opened: true, text: ALREADY_OPEN }
    } catch {
      // The pane recorded is gone: open another
    }
  }
  try {
    for (const argv of herdrOpen(terminal, view)) run(argv)
  } catch {
    return { opened: false, text: 'Could not open pace in Herdr: is herdr-app on the PATH?' }
  }
  return { opened: true, text: `Pace opened in Herdr${arg ? `: ${arg}` : ''}` }
}

if (import.meta.main) {
  const { opened, text } = openInHerdr(process.argv.slice(2).join(' '))
  process.stdout.write(`${text}\n`)
  process.exitCode = opened ? 0 : 1
}
