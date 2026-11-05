import { expect, test } from 'claude-code/testing'

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
