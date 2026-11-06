// Activity in a terminal, end to end: a log in a scratch home, one frame out. Run by Node:
// `node --test bin/activity.node-test.ts`; not a *.test.ts, which Claude Code would load and cannot.

import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { describe, expect, test } from '../testing/node.ts'
import { logFile, logText } from '../core/log.ts'

const activity = join(import.meta.dirname, 'activity.ts')
const plain = (s: string) => s.replace(/\x1b\[[0-9;?<]*[a-zA-Z]/g, '')
const tk = (input: number, output: number) => ({ input, output, cacheRead: 0, cacheWrite: 0, reasoning: 0 })

function home(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pace-activity-'))
  const now = Date.now()
  const put = (host: 'claude' | 'codex', provider: 'claude' | 'codex', session: string, at: number, model: string, input: number) => {
    const path = join(dir, logFile(host, session, at))
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, logText({ provider, session, host, cwd: '/work/pace' }, [{ at, prompt: true, model }, { at, tokens: tk(input, input / 10), model }, { at, usd: input / 1e5, model }], null).text, { flag: 'a' })
  }
  put('claude', 'claude', 'k1', now - 3600_000, 'claude-opus-4-6', 2_000_000)
  put('codex', 'codex', 'c1', now - 2 * 86_400_000, 'gpt-5.5', 500_000)
  return dir
}

const run = (dir: string, args: string[] = []) =>
  spawnSync(process.execPath, [activity, '--once', ...args], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', HOME: dir, COLUMNS: '100', LINES: '40' } })

describe('bin/activity.ts', () => {
  test('draws the chips, then the week\'s tokens by provider with every metric\'s total', () => {
    const r = run(home())
    const out = plain(r.stdout)
    expect(r.status).toBe(0)
    expect(out).toContain('Metric')
    expect(out).toContain('Tokens · Week · by Provider')
    expect(out).toContain('Claude')
    expect(out).toContain('Codex')
    expect(out).toContain('2 prompts')
  })

  test('starts on the question it is given', () => {
    const out = plain(run(home(), ['--metric', 'usd', '--range', 'day', '--by', 'model']).stdout)
    expect(out).toContain('Dollars · Day · by Model')
    expect(out).toContain('opus-4-6')
    // The day holds Claude's $20 alone: Codex's spend was two days ago
    expect(out).toContain('Dollars · Day · by Model  $20.00')
  })

  test('with no log yet it says so', () => {
    const out = plain(run(mkdtempSync(join(tmpdir(), 'pace-activity-'))).stdout)
    expect(out).toContain('No activity')
  })
})
