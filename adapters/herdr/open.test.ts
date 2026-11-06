import { describe, expect, test } from 'claude-code/testing'

import { claimOf, herdrOpen, herdrReuse, paceViewOf, viewKey } from './open.ts'

describe('opening pace in Herdr beside a terminal', () => {
  test('focuses the terminal, then splits its pane with the view asked for', () => {
    expect(herdrOpen('t8', { view: 'pane', provider: 'claude' })).toEqual([
      ['herdr-app', 'do', 'pane.focus', '{"terminal":"t8"}'],
      ['herdr-app', 'do', 'pane.split', '{"direction":"right","mod":"pace","props":{"view":"pane","provider":"claude"}}'],
    ])
  })

  test('activity opens as a split beside the session', () => {
    expect(herdrOpen('t8', { view: 'activity' })[1]).toEqual(['herdr-app', 'do', 'pane.split', '{"direction":"right","mod":"pace","props":{"view":"activity"}}'])
  })

  test('a band goes under its agent, the fleet beside it', () => {
    expect(herdrOpen('t8', { view: 'band', terminal: 't8' })[1]).toEqual(
      ['herdr-app', 'do', 'pane.split', '{"direction":"down","mod":"pace","props":{"view":"band","terminal":"t8"}}'])
    // The fleet's pane says so in its props: the panel docked in a layout has none, and claims no pane
    expect(herdrOpen('t8', { view: 'panel' })[1]).toEqual(['herdr-app', 'do', 'pane.split', '{"direction":"right","mod":"pace","props":{"view":"panel"}}'])
  })
})

describe('what /pace opens in Herdr', () => {
  test('the harness\'s charts alone; its band, or the fleet, by name', () => {
    expect(paceViewOf('', 'codex', 't4')).toEqual({ view: 'pane', provider: 'codex' })
    expect(paceViewOf('band', 'codex', 't4')).toEqual({ view: 'band', terminal: 't4' })
    expect(paceViewOf('fleet', 'claude', 't4')).toEqual({ view: 'panel' })
    expect(paceViewOf('activity', 'claude', 't4')).toEqual({ view: 'activity' })
  })

  test('pane and window open the charts in Herdr too: in Herdr every view goes through it first', () => {
    expect(paceViewOf('pane', 'claude', 't4')).toEqual({ view: 'pane', provider: 'claude' })
    expect(paceViewOf('window', 'codex', 't4')).toEqual({ view: 'pane', provider: 'codex' })
  })

  test('nothing for an argument that is not a view', () => {
    expect(paceViewOf('auto plan.md', 'claude', 't4')).toBeNull()
  })
})

describe('a pace pane already open', () => {
  test('each view has one key: a harness\'s charts, an agent\'s band, the fleet', () => {
    expect(viewKey({ view: 'pane', provider: 'codex' })).toBe('pane:codex')
    // Two accounts on one provider are two panes
    expect(viewKey({ view: 'pane', provider: 'codex', account: '1233abcd5678ef90' })).toBe('pane:codex:1233abcd5678ef90')
    expect(paceViewOf('', 'codex', 't4', '1233abcd5678ef90')).toEqual({ view: 'pane', provider: 'codex', account: '1233abcd5678ef90' })
    expect(viewKey({ view: 'band', terminal: 't8' })).toBe('band:t8')
    expect(viewKey({ view: 'panel' })).toBe('panel')
    expect(viewKey({ view: 'activity' })).toBe('activity')
  })

  test('is focused rather than opened again', () => {
    const registry = { p1: 'band:t8', p2: 'pane:claude' }
    expect(herdrReuse(registry, { view: 'pane', provider: 'claude' })).toEqual(['herdr-app', 'do', 'pane.focus', '{"pane":"p2"}'])
  })

  test('none for a view not open, or a registry that does not parse', () => {
    expect(herdrReuse({ p1: 'band:t8' }, { view: 'pane', provider: 'claude' })).toBeNull()
    expect(herdrReuse('junk', { view: 'panel' })).toBeNull()
    expect(herdrReuse({ p1: 7 }, { view: 'panel' })).toBeNull()
  })
})

describe('a new pace pane claiming its place', () => {
  test('takes the one pace pane not yet known, and forgets the panes that are gone', () => {
    expect(claimOf({ p1: 'band:t8', gone: 'panel' }, ['p1', 'p3'], 'pane:codex')).toEqual({ p1: 'band:t8', p3: 'pane:codex' })
  })

  test('claims nothing when it cannot tell which pane is its own', () => {
    expect(claimOf({}, ['p3', 'p4'], 'panel')).toBeNull()
    expect(claimOf({ p3: 'panel' }, ['p3'], 'panel')).toBeNull()
  })
})
