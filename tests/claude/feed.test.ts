import { expect, test } from 'claude-code/testing'

import { accountId } from '../../core/account.ts'
import { feedOf } from '../../core/host.ts'
import { NOW, reply, world } from './world.ts'

const FEED = '/home/u/.local/state/pace/feeds/claude-session-a.json'

test('the session writes its feed for the band beside other hosts and the fleet: written aside, then moved into place', async ($, on) => {
  const { files, runs } = world(on)
  await $.session.start({ cwd: '/work/pace', surface: 'terminal', isInteractive: true } as any)
  await $.prompt.submit({ text: 'p' } as any)
  // A reply that left 250k tokens in a 1M window
  await reply($, 250_000)
  const feed = feedOf(files[`${FEED}.tmp`] ?? '')!
  expect(feed).toMatchObject({ version: 1, host: 'claude', provider: 'claude', session: 'session-a', cwd: '/work/pace', at: NOW })
  expect(feed.snapshot.samples.length).toBeGreaterThan(0)
  expect(feed.snapshot.prompts).toContain(NOW)
  expect(feed.context).toEqual({ tokens: 250_000, window: 1_000_000 })
  expect(feed.terminal).toBeUndefined()
  expect(runs.some(r => r[0] === '/bin/mv' && r[1] === `${FEED}.tmp` && r[2] === FEED)).toBe(true)
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

test('the band counts the prompts other harnesses send on the same Claude account: the quota is shared', async ($, on) => {
  const { files } = world(on)
  const KEY = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff'
  files['/home/u/.claude.json'] = JSON.stringify({ oauthAccount: { emailAddress: 'a@b.co' } })
  files['/home/u/.local/state/pace/key'] = KEY
  // A pi session on the same Claude account prompted a minute ago; one on another account two minutes ago
  const pi = (session: string, account: string, at: number) => JSON.stringify({ version: 1, host: 'pi', provider: 'claude', account, session, cwd: '/w', at: NOW, snapshot: { samples: [], prompts: [at], cache: null } })
  files['/home/u/.local/state/pace/feeds/pi-p1.json'] = pi('p1', accountId('a@b.co', KEY), NOW - 60_000)
  files['/home/u/.local/state/pace/feeds/pi-p2.json'] = pi('p2', accountId('c@d.co', KEY), NOW - 120_000)
  await $.session.start({ cwd: '/work/pace', surface: 'terminal', isInteractive: true } as any)
  await $.prompt.submit({ text: 'p' } as any)
  const prompts = feedOf(files[`${FEED}.tmp`] ?? '')!.snapshot.prompts
  expect(prompts).toContain(NOW - 60_000)
  expect(prompts).not.toContain(NOW - 120_000)
})
