// The Codex hook end to end: Codex's stdin in, the session's feed out, in a scratch home. Run by Node:
// `node --test adapters/codex/hook.node-test.ts`; not a *.test.ts, which Claude Code would load and cannot.

import { spawnSync } from 'node:child_process'
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from '../../testing/node.ts'
import { feedFile, feedOf } from '../../core/host.ts'
import { hookInput, tokenCount, tokenCountNoInfo } from './fixtures.ts'

const SESSION = '01a1aa40-0781-75c2-a5ae-6367b424026e'
const hook = join(import.meta.dirname, 'hook.ts')

/** Runs the hook as Codex would: the event's input on stdin, in a home of the test's own */
function run(home: string, stdin: string, env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [hook], { input: stdin, encoding: 'utf8', env: { PATH: `${join(home, 'bin')}:${process.env.PATH ?? ''}`, HOME: home, ...env } })
}

/** A herdr-app that writes each call's arguments, a line each, to calls.txt in the home */
function fakeHerdr(home: string): string {
  const calls = join(home, 'calls.txt')
  mkdirSync(join(home, 'bin'), { recursive: true })
  writeFileSync(join(home, 'bin', 'herdr-app'), `#!/bin/sh\necho "$*" >> '${calls}'\necho '{"ok":true}'\n`)
  chmodSync(join(home, 'bin', 'herdr-app'), 0o755)
  return calls
}

const prompt = (text: string) => JSON.stringify({ ...JSON.parse(hookInput('UserPromptSubmit', null)), prompt: text })

const feedIn = (home: string) => feedOf(readFileSync(join(home, feedFile('codex', SESSION)), 'utf8'))!

describe('the Codex hook', () => {
  test('writes the session\'s feed from the rollout and the prompt, and says nothing to Codex', () => {
    const home = mkdtempSync(join(tmpdir(), 'pace-codex-'))
    const rollout = join(home, 'rollout.jsonl')
    writeFileSync(rollout, `${tokenCount(Date.now() - 60_000, 12, 40)}\n`)
    const r = run(home, hookInput('UserPromptSubmit', rollout), { HC_TERMINAL_ID: 't4' })
    expect(r.status).toBe(0)
    expect(r.stdout).toBe('')
    const feed = feedIn(home)
    expect(feed).toMatchObject({ host: 'codex', provider: 'codex', session: SESSION, cwd: '/work/pace', terminal: 't4' })
    expect(feed.snapshot.prompts.length).toBe(1)
    expect(feed.snapshot.samples.map(s => s.quotas.five_hour!.percent)).toEqual([12])
    expect(feed.context).toEqual({ tokens: 19_011, window: 258_400 })
  })

  test('reads on from where it left off, a line torn mid-write read once it is whole', () => {
    const home = mkdtempSync(join(tmpdir(), 'pace-codex-'))
    const rollout = join(home, 'rollout.jsonl')
    const later = tokenCountNoInfo(Date.now(), 20, 41)
    writeFileSync(rollout, `${tokenCount(Date.now() - 600_000, 12, 40)}\n${later.slice(0, 30)}`)
    run(home, hookInput('UserPromptSubmit', rollout))
    expect(feedIn(home).snapshot.samples.length).toBe(1)
    appendFileSync(rollout, `${later.slice(30)}\n`)
    run(home, hookInput('Stop', rollout))
    const feed = feedIn(home)
    expect(feed.snapshot.samples.map(s => s.quotas.five_hour!.percent)).toEqual([12, 20])
    expect(feed.snapshot.prompts.length).toBe(1)
  })

  test('input it cannot read leaves no feed and no error', () => {
    const home = mkdtempSync(join(tmpdir(), 'pace-codex-'))
    const r = run(home, 'not json')
    expect(r.status).toBe(0)
    expect(r.stderr).toBe('')
  })

  test('a session with no rollout yet still writes its feed', () => {
    const home = mkdtempSync(join(tmpdir(), 'pace-codex-'))
    run(home, hookInput('SessionStart', null))
    expect(feedIn(home).snapshot.samples).toEqual([])
  })

  test('/pace in Herdr opens the band beside the session and stops the prompt before the model', () => {
    const home = mkdtempSync(join(tmpdir(), 'pace-codex-'))
    const calls = fakeHerdr(home)
    const r = run(home, prompt('/pace band'), { HC_TERMINAL_ID: 't4' })
    expect(r.status).toBe(0)
    expect(JSON.parse(r.stdout)).toMatchObject({ decision: 'block' })
    expect(readFileSync(calls, 'utf8')).toBe(
      'do pane.focus {"terminal":"t4"}\ndo pane.split {"direction":"down","mod":"pace","props":{"view":"band","terminal":"t4"}}\n')
    expect(feedIn(home).snapshot.prompts).toEqual([])
  })

  test('/pace outside Herdr stops the prompt and says why, opening nothing', () => {
    const home = mkdtempSync(join(tmpdir(), 'pace-codex-'))
    const calls = fakeHerdr(home)
    const r = JSON.parse(run(home, prompt('/pace')).stdout)
    expect(r.decision).toBe('block')
    expect(r.reason).toContain('Herdr')
    expect(existsSync(calls)).toBe(false)
  })

  test('any other prompt goes on to the model, the hook silent', () => {
    const home = mkdtempSync(join(tmpdir(), 'pace-codex-'))
    fakeHerdr(home)
    expect(run(home, prompt('fix the tests'), { HC_TERMINAL_ID: 't4' }).stdout).toBe('')
  })

  test('/pace focuses the pace pane already open for that view', () => {
    const home = mkdtempSync(join(tmpdir(), 'pace-codex-'))
    const calls = fakeHerdr(home)
    mkdirSync(join(home, '.config', 'herdr-app'), { recursive: true })
    writeFileSync(join(home, '.config', 'herdr-app', 'shared.json'), JSON.stringify({ 'pace.panes': { p9: 'pane:codex' } }))
    const r = JSON.parse(run(home, prompt('/pace'), { HC_TERMINAL_ID: 't4' }).stdout)
    expect(readFileSync(calls, 'utf8')).toBe('do pane.focus {"pane":"p9"}\n')
    expect(r.reason).toBe('Pace is already open in Herdr')
  })

  test('the feed carries the other live Codex sessions\' readings and prompts, as Claude\'s shared store does', () => {
    const home = mkdtempSync(join(tmpdir(), 'pace-codex-'))
    const other = { ...feedOfSibling(Date.now()) }
    mkdirSync(join(home, '.local/state/pace/feeds'), { recursive: true })
    writeFileSync(join(home, feedFile('codex', 'other')), JSON.stringify(other))
    run(home, hookInput('Stop', null))
    expect(feedIn(home).snapshot.prompts).toEqual(other.snapshot.prompts)
  })
})

/** Another Codex session's feed, a prompt a minute ago */
function feedOfSibling(now: number) {
  return {
    version: 1, host: 'codex', provider: 'codex', session: 'other', cwd: '/work/api', at: now,
    snapshot: { samples: [], prompts: [now - 60_000], cache: null, noCache: true },
  }
}
