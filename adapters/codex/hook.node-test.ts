// The Codex hook end to end: Codex's stdin in, the session's feed out, in a scratch home. Run by Node:
// `node --test adapters/codex/hook.node-test.ts`; not a *.test.ts, which Claude Code would load and cannot.

import { spawnSync } from 'node:child_process'
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from '../../testing/node.ts'
import { feedFile, feedOf } from '../../core/host.ts'
import { logFile } from '../../core/log.ts'
import { readFeeds } from '../log.ts'
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

/** The session's feed as a reader sees it: its quota's history filled in from the log */
const feedIn = (home: string) => readFeeds(home, Date.now()).find(f => f.host === 'codex' && f.session === SESSION)!
/** The feed as written on disk */
const onDisk = (home: string) => feedOf(readFileSync(join(home, feedFile('codex', SESSION)), 'utf8'))!

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

  test('writes the history to the session\'s log, a line an event, and its feed slim', () => {
    const home = mkdtempSync(join(tmpdir(), 'pace-codex-'))
    const rollout = join(home, 'rollout.jsonl')
    writeFileSync(rollout, `${tokenCount(Date.now() - 60_000, 12, 40)}\n`)
    run(home, hookInput('UserPromptSubmit', rollout))
    run(home, hookInput('Stop', rollout))
    expect(onDisk(home).snapshot.prompts).toEqual([])
    expect(onDisk(home).snapshot.samples).toEqual([])
    const lines = readFileSync(join(home, logFile('codex', SESSION, Date.now())), 'utf8').trim().split('\n').map(l => JSON.parse(l))
    // The header, the prompt, the reading: the reading read once, though the hook ran twice
    expect(lines.map(l => Object.keys(l).find(k => ['q', 'p', 'r'].includes(k)))).toEqual(['q', 'p', 'r'])
  })

  test('names the account Codex is signed in with, as a keyed hash of its email, and none signed out', () => {
    const home = mkdtempSync(join(tmpdir(), 'pace-codex-'))
    run(home, hookInput('SessionStart', null))
    expect(feedIn(home).account).toBeUndefined()
    // An id_token whose payload is {"email":"a@b.co"}
    mkdirSync(join(home, '.codex'), { recursive: true })
    writeFileSync(join(home, '.codex/auth.json'), JSON.stringify({ tokens: { id_token: 'x.eyJlbWFpbCI6ImFAYi5jbyJ9.y' } }))
    run(home, hookInput('SessionStart', null))
    const account = feedIn(home).account!
    expect(account).toMatch(/^[0-9a-f]{16}$/)
    expect(readFileSync(join(home, feedFile('codex', SESSION)), 'utf8')).not.toContain('a@b.co')
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

  test('/pace outside Herdr and tmux stops the prompt and draws the charts into the answer, opening nothing', () => {
    const home = mkdtempSync(join(tmpdir(), 'pace-codex-'))
    const calls = fakeHerdr(home)
    const r = JSON.parse(run(home, prompt('/pace')).stdout)
    expect(r.decision).toBe('block')
    expect(r.reason).toContain('codex · pace')
    expect(existsSync(calls)).toBe(false)
  })

  test('/pace in Herdr with no herdr-app falls back to the charts drawn into the answer, saying why', () => {
    const home = mkdtempSync(join(tmpdir(), 'pace-codex-'))
    const r = JSON.parse(spawnSync(process.execPath, [hook], { input: prompt('/pace'), encoding: 'utf8', env: { PATH: '/nonexistent', HOME: home, HC_TERMINAL_ID: 't4' } }).stdout)
    expect(r.reason).toContain('Could not open pace in Herdr')
    expect(r.reason).toContain('codex · pace')
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

  test('the feed carries the prompts of a pi session spending Codex\'s quota, and not those of one spending Claude\'s', () => {
    const home = mkdtempSync(join(tmpdir(), 'pace-codex-'))
    const now = Date.now()
    const pi = { ...feedOfSibling(now), host: 'pi', session: 'p1', snapshot: { samples: [], prompts: [now - 120_000], cache: null, noCache: true } }
    const claude = { ...feedOfSibling(now), host: 'pi', provider: 'claude', session: 'p2', snapshot: { samples: [], prompts: [now - 30_000], cache: null, noCache: true } }
    mkdirSync(join(home, '.local/state/pace/feeds'), { recursive: true })
    writeFileSync(join(home, feedFile('pi', 'p1')), JSON.stringify(pi))
    writeFileSync(join(home, feedFile('pi', 'p2')), JSON.stringify(claude))
    run(home, hookInput('Stop', null))
    expect(feedIn(home).snapshot.prompts).toEqual([now - 120_000])
  })
})

/** Another Codex session's feed, a prompt a minute ago */
function feedOfSibling(now: number) {
  return {
    version: 1, host: 'codex', provider: 'codex', session: 'other', cwd: '/work/api', at: now,
    snapshot: { samples: [], prompts: [now - 60_000], cache: null, noCache: true },
  }
}

/** A Codex hook's input: the event, with what it carries */
const input = (event: string, extra: object = {}) => JSON.stringify({ ...JSON.parse(hookInput('Stop', null)), hook_event_name: event, ...extra })

/** A scratch home where this session's feed reads 85% of the 5-hour window, resetting in two hours, with `auto` running */
function homeWith(o: { percent?: number; auto?: object } = {}): string {
  const home = mkdtempSync(join(tmpdir(), 'pace-codex-'))
  const now = Date.now()
  mkdirSync(join(home, '.local/state/pace/feeds'), { recursive: true })
  writeFileSync(join(home, feedFile('codex', SESSION)), JSON.stringify({
    version: 1, host: 'codex', provider: 'codex', session: SESSION, cwd: '/work/pace', at: now,
    snapshot: { samples: [{ at: now - 60_000, quotas: { five_hour: { percent: o.percent ?? 20, resetsAt: now + 2 * 3600_000 } } }], prompts: [], cache: null, noCache: true, ...(o.auto ? { auto: o.auto } : {}) },
  }))
  return home
}

const out = (r: { stdout: string }) => (r.stdout ? JSON.parse(r.stdout) : {})

describe('/pace\'s commands in Codex', () => {
  test('a view outside Herdr and tmux is drawn into the answer: the fleet', () => {
    const r = run(homeWith(), prompt('/pace fleet'))
    expect(out(r).decision).toBe('block')
    expect(out(r).reason).toContain('Codex · ')
  })

  test('/pace pane draws the charts into the answer', () => {
    expect(out(run(homeWith(), prompt('$pace pane'))).reason).toContain('resets in')
  })

  test('/pace ultra says plainly that Codex cannot run it', () => {
    expect(out(run(homeWith(), prompt('/pace ultra PLAN.md'))).reason).toContain('Ultra pace is not in Codex')
  })

  test('/pace auto starts a run: the prompt goes on to Codex with auto mode\'s instructions', () => {
    const home = homeWith()
    const r = out(run(home, prompt('/pace auto PLAN.md')))
    expect(r.decision).toBeUndefined()
    expect(r.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit')
    expect(r.hookSpecificOutput.additionalContext).toContain('# Auto mode (pace)')
    expect(r.hookSpecificOutput.additionalContext).toContain('Work through the plan in PLAN.md')
    expect(feedIn(home).snapshot.auto).toEqual({ plan: 'PLAN.md', turns: 1, max: 40 })
  })
})

describe('auto mode in Codex', () => {
  const running = { plan: 'PLAN.md', turns: 1, max: 40 }

  test('a turn that ends with the next step to do keeps Codex going with the next prompt', () => {
    const home = homeWith({ auto: running })
    const r = out(run(home, input('Stop', { last_assistant_message: 'Ticked step 1.\nPACE: NEXT' })))
    expect(r).toEqual({ decision: 'block', reason: 'Continue with the next unfinished step of PLAN.md.' })
    expect(feedIn(home).snapshot.auto).toMatchObject({ plan: 'PLAN.md', turns: 2 })
  })

  test('a plan done ends the run, said in Codex\'s UI', () => {
    const home = homeWith({ auto: running })
    expect(out(run(home, input('Stop', { last_assistant_message: 'PACE: DONE' })))).toEqual({ systemMessage: 'Auto mode off. Plan done: PLAN.md' })
    expect(feedIn(home).snapshot.auto ?? null).toBeNull()
  })

  test('a quota gassed out for longer than the hook may wait pauses the run until /pace auto resume', () => {
    const home = homeWith({ percent: 100, auto: running })
    const r = out(run(home, input('Stop', { last_assistant_message: 'PACE: NEXT' })))
    expect(r.decision).toBeUndefined()
    expect(r.systemMessage).toContain('/pace auto resume')
    expect(feedIn(home).snapshot.auto).toMatchObject({ paused: true })
  })

  test('/pace auto resume picks it back up with the next prompt', () => {
    const home = homeWith({ auto: { ...running, paused: true, why: 'x' } })
    const r = out(run(home, prompt('/pace auto resume')))
    expect(r.hookSpecificOutput.additionalContext).toContain('Continue with the next unfinished step of PLAN.md.')
    expect(feedIn(home).snapshot.auto).toEqual({ plan: 'PLAN.md', turns: 2, max: 40 })
  })

  test('an interrupt pauses the run', () => {
    const home = homeWith({ auto: running })
    run(home, input('Interrupt'))
    expect(feedIn(home).snapshot.auto).toMatchObject({ paused: true })
  })

  test('/pace auto off ends it', () => {
    const home = homeWith({ auto: running })
    expect(out(run(home, prompt('/pace auto off'))).reason).toBe('Auto mode off')
    expect(feedIn(home).snapshot.auto ?? null).toBeNull()
  })
})

describe('warnings in Codex', () => {
  test('are said in Codex\'s UI once per window', () => {
    const home = homeWith({ percent: 85 })
    expect(out(run(home, input('Stop'))).systemMessage).toContain('85% used')
    expect(out(run(home, input('Stop'))).systemMessage).toBeUndefined()
  })
})
