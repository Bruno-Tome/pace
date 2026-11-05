// The Codex opener end to end: `node adapters/codex/open.ts [band|fleet]`, as the pace skill runs it, against a
// herdr-app of the test's own. Run by Node: `node --test adapters/codex/open.node-test.ts`.

import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from '../../testing/node.ts'

const open = join(import.meta.dirname, 'open.ts')

/** A home with a herdr-app that writes each call's arguments to calls.txt */
function home(): { dir: string; calls: string } {
  const dir = mkdtempSync(join(tmpdir(), 'pace-open-'))
  mkdirSync(join(dir, 'bin'))
  const calls = join(dir, 'calls.txt')
  writeFileSync(join(dir, 'bin', 'herdr-app'), `#!/bin/sh\necho "$*" >> '${calls}'\necho '{"ok":true}'\n`)
  chmodSync(join(dir, 'bin', 'herdr-app'), 0o755)
  return { dir, calls }
}

const run = (dir: string, args: string[], env: Record<string, string> = {}) =>
  spawnSync(process.execPath, [open, ...args], { encoding: 'utf8', env: { PATH: `${join(dir, 'bin')}:${process.env.PATH ?? ''}`, HOME: dir, ...env } })

describe('node adapters/codex/open.ts', () => {
  test('opens the session\'s band in Herdr and says so in one line', () => {
    const { dir, calls } = home()
    const r = run(dir, ['band'], { HC_TERMINAL_ID: 't4' })
    expect(r.status).toBe(0)
    expect(r.stdout).toBe('Pace opened in Herdr: band\n')
    expect(readFileSync(calls, 'utf8')).toContain('pane.split {"direction":"down","mod":"pace","props":{"view":"band","terminal":"t4"}}')
  })

  test('outside Herdr it opens nothing, says why and fails', () => {
    const { dir, calls } = home()
    const r = run(dir, [])
    expect(r.status).toBe(1)
    expect(r.stdout).toContain('not running in Herdr')
    expect(existsSync(calls)).toBe(false)
  })
})
