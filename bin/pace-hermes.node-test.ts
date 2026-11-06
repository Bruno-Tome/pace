// The Hermes bridge end to end: the plugin's events in as JSON lines, the feed and the answers out, in a scratch home.
// Run by Node: `node --test bin/pace-hermes.node-test.ts`.

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from '../testing/node.ts'
import { feedOf } from '../core/host.ts'
import { logFile } from '../core/log.ts'
import { readFeeds } from '../adapters/log.ts'
import { accountId } from '../core/account.ts'

const KEY = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff'

const BIN = join(import.meta.dirname, 'pace-hermes.ts')

delete process.env.HC_TERMINAL_ID
delete process.env.TMUX

/** Runs the bridge, sends the plugin's events a line each, and collects what it answers */
async function bridge(dir: string, events: object[]): Promise<any[]> {
  const child = spawn(process.execPath, [BIN], { env: { ...process.env, HOME: dir } })
  const exited = new Promise(r => child.on('exit', r))
  setTimeout(() => child.kill(), 15_000).unref()
  let text = ''
  child.stdout.on('data', d => { text += d })
  for (const e of events as { id?: number }[]) {
    child.stdin.write(JSON.stringify(e) + '\n')
    for (let t = 0; t < 60 && e.id != null && !text.includes(`"id":${e.id},`); t++) await new Promise(r => setTimeout(r, 50))
  }
  await new Promise(r => setTimeout(r, 300))
  child.stdin.end()
  await exited
  return text.trim().split('\n').filter(Boolean).map(l => JSON.parse(l))
}

const NOW = Date.now()
const start = (mode = 'session') => ({ method: 'session/new', params: { session: 'h1', cwd: '/work/pace', mode, key: mode === 'bot' ? 'agent:main:telegram:dm:42' : undefined } })
const usage = { method: '_pace/usage', params: { session: 'h1', provider: 'openai-codex', model: 'gpt-5.6-sol', usage: { input_tokens: 2000, cache_read_tokens: 8000, cache_write_tokens: 0, output_tokens: 300 }, context_length: 272000 } }
/** The session's feed on a quota: one file per session and quota, so a move between providers keeps both */
/** The session's feed on a quota as a reader sees it: its history filled in from the log */
const feedIn = (dir: string, quota = 'codex') => readFeeds(dir, Date.now()).find(f => f.host === 'hermes' && f.session === 'h1' && f.provider === quota)!
const onDisk = (dir: string, quota = 'codex') => feedOf(readFileSync(join(dir, `.local/state/pace/feeds/hermes-h1-${quota}.json`), 'utf8'))!

describe('pace for Hermes', () => {
  test('meters a session: its prompts, its cache and context, and the account windows Hermes reads', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pace-hermes-'))
    await bridge(dir, [
      start(),
      { method: 'session/prompt', params: { session: 'h1' } },
      usage,
      { method: '_pace/reading', params: { provider: 'openai-codex', windows: [{ label: 'Session', used_percent: 40, reset_at: new Date(NOW + 7200_000).toISOString() }] } },
    ])
    const feed = feedIn(dir)
    expect(feed).toMatchObject({ host: 'hermes', provider: 'codex', session: 'h1', cwd: '/work/pace', context: { tokens: 10_000, window: 272_000 } })
    expect(feed.snapshot.prompts.length).toBe(1)
    expect(feed.snapshot.cache).toMatchObject({ tokens: 10_000, ttl: '1h' })
    expect(feed.snapshot.samples.at(-1)!.quotas.five_hour!.percent).toBe(40)
    // Written slim, the prompt and the reading in the session's log
    expect(onDisk(dir).snapshot.samples).toEqual([])
    const lines = readFileSync(join(dir, logFile('hermes', 'h1', Date.now())), 'utf8').trim().split('\n').map(l => JSON.parse(l))
    expect(lines.filter(l => l.p === 1).length).toBe(1)
    expect(lines.filter(l => l.r).at(-1).r.five_hour.percent).toBe(40)
    // The call's tokens, with its model, under a header naming Hermes and the folder
    expect(lines.find(l => l.q)).toMatchObject({ h: 'hermes', c: '/work/pace' })
    expect(lines.filter(l => l.tk).map(l => [l.m, l.tk])).toEqual([['gpt-5.6-sol', [2000, 300, 8000, 0, 0]]])
  })

  test('answers /pace in a session, and in a bot\'s chat, where only the chat shows anything', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pace-hermes-'))
    const got = await bridge(dir, [start(), usage, { id: 1, method: '_pace/command', params: { session: 'h1', args: 'hide' } }])
    expect(got.find(m => m.id === 1).result.text).toBe('Hermes has no band of its own: /pace band opens one beside it')
    const bot = mkdtempSync(join(tmpdir(), 'pace-hermes-'))
    const said = await bridge(bot, [start('bot'), usage, { id: 2, method: '_pace/command', params: { session: 'h1', args: 'window' } }])
    // A bot has no window: the charts are drawn into the chat
    expect(said.find(m => m.id === 2).result.text).toContain('Hermes (bot) has no window of its own; the charts open here')
  })

  test('auto mode sends the next prompt into the session, or the bot\'s chat, after each turn', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pace-hermes-'))
    writeFileSync(join(dir, 'PLAN.md'), '- [ ] one\n- [ ] two\n')
    const got = await bridge(dir, [
      { method: 'session/new', params: { session: 'h1', cwd: dir, mode: 'bot', key: 'agent:main:telegram:dm:42' } },
      usage,
      { id: 1, method: '_pace/command', params: { session: 'h1', args: 'auto PLAN.md' } },
      { method: 'turn_end', params: { session: 'h1', answer: 'Step one done.\nPACE: NEXT' } },
    ])
    const sent = got.filter(m => m.method === '_pace/inject').map(m => m.params)
    expect(sent[0]).toMatchObject({ session: 'h1', key: 'agent:main:telegram:dm:42' })
    expect(sent[0].text).toContain('Work through the plan in PLAN.md')
    expect(sent.at(-1).text).toBe('Continue with the next unfinished step of PLAN.md.')
  })

  test('a background call (compression, Mixture of Agents) refreshes the figures, and leaves the session\'s context alone', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pace-hermes-'))
    await bridge(dir, [start(), usage, { method: '_pace/usage', params: { ...usage.params, aux: true, usage: { input_tokens: 90_000, cache_read_tokens: 0 }, context_length: 128_000 } }])
    expect(feedIn(dir).context).toEqual({ tokens: 10_000, window: 272_000 })
  })

  test('a subagent\'s calls are its parent session\'s: no context or cache of its own', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pace-hermes-'))
    await bridge(dir, [start(), usage, { method: '_pace/usage', params: { ...usage.params, sub: true, usage: { input_tokens: 50_000, cache_read_tokens: 1000 } } }])
    expect(feedIn(dir).context).toEqual({ tokens: 10_000, window: 272_000 })
    expect(feedIn(dir).snapshot.cache).toMatchObject({ tokens: 10_000 })
  })

  test('a session that moves between Claude and ChatGPT keeps each one\'s history', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pace-hermes-'))
    const claude = { method: '_pace/usage', params: { ...usage.params, provider: 'anthropic', model: 'claude-sonnet-4-6' } }
    await bridge(dir, [start(), { method: 'session/prompt', params: { session: 'h1' } }, usage, claude, usage])
    const feed = feedIn(dir)
    expect(feed.provider).toBe('codex')
    expect(feed.snapshot.prompts.length).toBe(1)
    // Claude's feed is still there for the fleet and the other harnesses to read
    expect(feedIn(dir, 'claude').provider).toBe('claude')
  })

  test('the pooled account Hermes read is the account: the same as Codex\'s own sign-in when it is that account', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pace-hermes-'))
    mkdirSync(join(dir, '.codex'), { recursive: true })
    // Codex signed in as a@b.co on account acct-1: an id_token whose payload is {"email":"a@b.co"}
    writeFileSync(join(dir, '.codex/auth.json'), JSON.stringify({ tokens: { account_id: 'acct-1', id_token: 'x.eyJlbWFpbCI6ImFAYi5jbyJ9.y' } }))
    mkdirSync(join(dir, '.local/state/pace'), { recursive: true })
    writeFileSync(join(dir, '.local/state/pace/key'), KEY)
    const window = { label: 'Session', used_percent: 10, reset_at: new Date(NOW + 7200_000).toISOString() }
    await bridge(dir, [start(), usage, { method: '_pace/reading', params: { provider: 'openai-codex', identity: 'codex:acct-1:user-1', windows: [window] } }])
    expect(feedIn(dir).account).toBe(accountId('a@b.co', KEY))
    const other = mkdtempSync(join(tmpdir(), 'pace-hermes-'))
    await bridge(other, [start(), usage, { method: '_pace/reading', params: { provider: 'openai-codex', identity: 'codex:acct-2:user-9', windows: [window] } }])
    expect(feedIn(other).account).toMatch(/^[0-9a-f]{16}$/)
    expect(readFileSync(join(other, '.local/state/pace/feeds/hermes-h1-codex.json'), 'utf8')).not.toContain('acct-2')
  })

  test('a provider pace does not pace writes no feed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pace-hermes-'))
    await bridge(dir, [start(), { ...usage, params: { ...usage.params, provider: 'openrouter' } }])
    expect(existsSync(join(dir, '.local/state/pace/feeds/hermes-h1-codex.json'))).toBe(false)
  })
})
