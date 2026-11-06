import { describe, expect, test } from 'claude-code/testing'

import { afterStart, openSendPane, sendForm } from './send.ts'

const model = (provider: 'claude' | 'codex' | 'antigravity' | null, cwds: (string | null)[]) => ({
  recommended: provider ? { provider } : null,
  agents: cwds.map(cwd => ({ cwd })),
})

describe('Send work, in a popup or in a pane', () => {
  test('the popup keeps the host and folders it was opened with', () => {
    const props = { view: 'send', overlay: 'o1', host: 'codex', folders: ['/r/a'] }
    expect(sendForm(props, model('claude', ['/r/b']), '/h')).toEqual({ where: 'overlay', recommended: 'codex', folders: ['/r/a'] })
  })

  test('the pane follows the fleet live: the host recommended now, the folders the agents work in now', () => {
    expect(sendForm({ view: 'send' }, model('codex', ['/r/a', null, '/r/b', '/r/a']), '/h')).toEqual({ where: 'pane', recommended: 'codex', folders: ['/r/a', '/r/b'] })
  })

  test('with no agents the pane offers home, and a host it cannot start falls back to Claude', () => {
    expect(sendForm({ view: 'send' }, model('antigravity', []), '/h')).toEqual({ where: 'pane', recommended: 'claude', folders: ['/h'] })
    expect(sendForm({ view: 'send' }, model(null, []), '/h').recommended).toBe('claude')
  })

  test('once started, the popup closes and the pane clears for the next task', () => {
    expect(afterStart('overlay')).toBe('close')
    expect(afterStart('pane')).toBe('clear')
  })
})

describe('opening Send work as a pane', () => {
  test('splits the focused pane with the fleet mod\'s Send work, to stay open', () => {
    expect(openSendPane({}, [])).toEqual(['pane.split', { direction: 'right', mod: 'fleet', props: { view: 'send' } }])
  })

  test('focuses the one already open instead', () => {
    expect(openSendPane({ p5: 'send' }, ['p1', 'p5'])).toEqual(['pane.focus', { pane: 'p5' }])
  })

  test('opens another when the one recorded is gone', () => {
    expect(openSendPane({ p5: 'send' }, ['p1'])[0]).toBe('pane.split')
  })
})
