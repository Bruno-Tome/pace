// The band in a terminal, end to end: feeds in a scratch home, one frame out. Run by Node:
// `node --test bin/band.node-test.ts`; not a *.test.ts, which Claude Code would load and cannot.

import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { describe, expect, test } from '../testing/node.ts'
import { feedFile, type PaceFeed } from '../core/host.ts'

const H = 3600_000
const band = join(import.meta.dirname, 'band.ts')
const plain = (s: string) => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')

function home(feeds: PaceFeed[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'pace-band-'))
  for (const f of feeds) {
    const path = join(dir, feedFile(f.host, f.session))
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(f))
  }
  return dir
}

const codex = (now: number): PaceFeed => ({
  version: 1, host: 'codex', provider: 'codex', session: 'c1', terminal: 't7', cwd: '/work/api', at: now,
  snapshot: { samples: [{ at: now, quotas: { five_hour: { percent: 30, resetsAt: now + 2.5 * H } } }], prompts: [], cache: null, noCache: true },
  context: { tokens: 50_000, window: 200_000 },
})

const run = (dir: string, args: string[]) =>
  spawnSync(process.execPath, [band, '--once', ...args], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', HOME: dir, COLUMNS: '100' } })

describe('bin/band.ts', () => {
  test('draws the newest feed\'s band under its agent\'s line', () => {
    const r = run(home([codex(Date.now())]), [])
    const out = plain(r.stdout)
    expect(r.status).toBe(0)
    expect(out).toContain('codex · api · t7 · ctx 25%')
    expect(out).toContain('5h')
    expect(out).toContain('30%')
    expect(out).not.toContain('cache')
  })

  test('--terminal draws that terminal\'s agent; one with no feed says so', () => {
    const dir = home([codex(Date.now())])
    expect(plain(run(dir, ['--terminal', 't7']).stdout)).toContain('codex · api')
    expect(plain(run(dir, ['--terminal', 't1']).stdout)).toContain('waiting for t1')
  })

  test('--fleet draws every provider with its agents', () => {
    const out = plain(run(home([codex(Date.now())]), ['--fleet']).stdout)
    expect(out).toContain('Codex · ')
    expect(out).toContain('  codex · api · t7')
  })
})
