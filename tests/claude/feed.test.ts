import { expect, test } from 'claude-code/testing'

import { accountId } from '../../core/account.ts'
import { feedOf } from '../../core/host.ts'
import { logFile, logText } from '../../core/log.ts'
import { NOW, paceSnapshot, pricedReply, READER, reply, world } from './world.ts'

const FEED = '/home/u/.local/state/pace/feeds/claude-session-a.json'
const LOG = `/home/u/${logFile('claude', 'session-a', NOW)}`

test('the session writes its feed for the band beside other hosts and the fleet: written aside, then moved into place', async ($, on) => {
  const { files, runs } = world(on)
  await $.session.start({ cwd: '/work/pace', surface: 'terminal', isInteractive: true } as any)
  await $.prompt.submit({ text: 'p' } as any)
  // A reply that left 250k tokens in a 1M window
  await reply($, 250_000)
  const feed = feedOf(files[`${FEED}.tmp`] ?? '')!
  expect(feed).toMatchObject({ version: 1, host: 'claude', provider: 'claude', session: 'session-a', cwd: '/work/pace', at: NOW })
  // Written slim: its history is in its log
  expect(feed.snapshot.samples).toEqual([])
  expect(feed.snapshot.prompts).toEqual([])
  expect(feed.context).toEqual({ tokens: 250_000, window: 1_000_000 })
  expect(feed.terminal).toBeUndefined()
  expect(runs.some(r => r[0] === '/bin/mv' && r[1] === `${FEED}.tmp` && r[2] === FEED)).toBe(true)
})

test('the session\'s prompts, readings and costs go to its log, a line an event, each once', async ($, on) => {
  const { files } = world(on)
  await $.session.start({ cwd: '/work/pace', surface: 'terminal', isInteractive: true } as any)
  await $.prompt.submit({ text: 'p' } as any)
  await pricedReply($, 100_000, 0.5)
  await pricedReply($, 120_000, 0.625)
  const lines = (files[LOG] ?? '').trim().split('\n').map(l => JSON.parse(l))
  expect(lines[0]).toMatchObject({ q: 'claude', s: 'session-a' })
  expect(lines.filter(l => l.p === 1).map(l => l.at)).toEqual([NOW])
  expect(lines.filter(l => l.r).length).toBeGreaterThan(0)
  // Each cost once, as the shared spend records it: the first reply sets where the session's cost starts, the
  // second adds what it cost
  expect(lines.filter(l => l.usd != null).map(l => l.usd)).toEqual([0.125])
})

test('under Herdr the feed names the terminal the session runs in', async ($, on) => {
  const { files } = world(on, { HC_TERMINAL_ID: 't5' })
  await $.session.start({ cwd: '/work/pace', surface: 'terminal', isInteractive: true } as any)
  await $.prompt.submit({ text: 'p' } as any)
  expect(feedOf(files[`${FEED}.tmp`] ?? '')!.terminal).toBe('t5')
})

test('the feed names the account Claude Code is signed in with, as a keyed hash of its email, and none signed out', async ($, on) => {
  const { files } = world(on)
  files['/home/u/.claude.json'] = JSON.stringify({ oauthAccount: { emailAddress: 'A@b.co' } })
  files['/home/u/.local/state/pace/key'] = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff'
  await $.session.start({ cwd: '/work/pace', surface: 'terminal', isInteractive: true } as any)
  await $.prompt.submit({ text: 'p' } as any)
  const text = files[`${FEED}.tmp`] ?? ''
  // The id core/account.ts gives a@b.co under that key: the same in every harness
  expect(feedOf(text)!.account).toBe(accountId('a@b.co', '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff'))
  expect(text).not.toContain('a@b.co')
  expect(files['/home/u/.local/state/pace/accounts.json']).toContain(feedOf(text)!.account!)
})

test('pace makes its key on first use when there is none', async ($, on) => {
  const { files } = world(on)
  files['/home/u/.claude.json'] = JSON.stringify({ oauthAccount: { emailAddress: 'a@b.co' } })
  await $.session.start({ cwd: '/work/pace', surface: 'terminal', isInteractive: true } as any)
  await $.prompt.submit({ text: 'p' } as any)
  expect(files['/home/u/.local/state/pace/key']).toMatch(/^[0-9a-f]{64}$/)
  expect(feedOf(files[`${FEED}.tmp`] ?? '')!.account).toMatch(/^[0-9a-f]{16}$/)
})

test('the band counts the prompts other harnesses send on the same Claude account: the quota is shared', { plugins: [READER] }, async ($, on) => {
  const { files } = world(on)
  const KEY = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff'
  files['/home/u/.claude.json'] = JSON.stringify({ oauthAccount: { emailAddress: 'a@b.co' } })
  files['/home/u/.local/state/pace/key'] = KEY
  // A pi session on the same Claude account prompted a minute ago; one on another account two minutes ago. Their
  // feeds are slim, their prompts in their logs
  const pi = (session: string, account: string) => JSON.stringify({ version: 1, host: 'pi', provider: 'claude', account, session, cwd: '/w', at: NOW, snapshot: { samples: [], prompts: [], cache: null } })
  const log = (session: string, account: string, at: number) => logText({ provider: 'claude', account, session }, [{ at, prompt: true }], null).text
  files['/home/u/.local/state/pace/feeds/pi-p1.json'] = pi('p1', accountId('a@b.co', KEY))
  files['/home/u/.local/state/pace/feeds/pi-p2.json'] = pi('p2', accountId('c@d.co', KEY))
  files[`/home/u/${logFile('pi', 'p1', NOW)}`] = log('p1', accountId('a@b.co', KEY), NOW - 60_000)
  files[`/home/u/${logFile('pi', 'p2', NOW)}`] = log('p2', accountId('c@d.co', KEY), NOW - 120_000)
  await $.session.start({ cwd: '/work/pace', surface: 'terminal', isInteractive: true } as any)
  await $.prompt.submit({ text: 'p' } as any)
  // Its own prompt and pi's on the same account, in the last half hour: four an hour
  expect((await paceSnapshot($)).quotas[0].rate.promptsPerHour).toBe(4)
})
