import { expect, test } from 'claude-code/testing'

import { world } from './world.ts'

const focus = ['herdr-app', 'do', 'pane.focus', '{"terminal":"t8"}']
const split = (props: string, direction = 'right') => ['herdr-app', 'do', 'pane.split', `{"direction":"${direction}","mod":"pace","props":${props}}`]

test('/pace in Herdr opens Claude\'s charts in a Herdr pane beside the session, ahead of tmux', async ($, on) => {
  const { runs, toasts } = world(on, { HC_TERMINAL_ID: 't8', TMUX: '/tmp/tmux-501/default,1,0', TMUX_PANE: '%3' })
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true } as any)
  await $.command.run({ command: 'pace', args: '' } as any)
  expect(runs).toContainEqual(focus)
  expect(runs).toContainEqual(split('{"view":"pane","provider":"claude"}'))
  expect(runs.some(r => r[1] === 'split-window')).toBe(false)
  expect(toasts).toContain('Pace opened in Herdr')
})

test('/pace pane and /pace window in Herdr open the charts in Herdr too: in Herdr every view goes through it first', async ($, on) => {
  const { runs, toasts } = world(on, { HC_TERMINAL_ID: 't8' })
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true } as any)
  await $.command.run({ command: 'pace', args: 'pane' } as any)
  await $.command.run({ command: 'pace', args: 'window' } as any)
  expect(runs.filter(r => r[2] === 'pane.split' && r[3]!.includes('"view":"pane"')).length).toBe(2)
  expect(toasts.filter(t => t === 'Pace opened in Herdr').length).toBe(2)
})

test('/pace pane falls back to Claude\'s own pane when Herdr cannot open it', async ($, on) => {
  const { toasts, failing } = world(on, { HC_TERMINAL_ID: 't8' })
  failing.add('herdr-app')
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true } as any)
  await $.command.run({ command: 'pace', args: 'pane' } as any)
  expect(toasts).toContain('Pace pane opened')
})

test('/pace band and /pace fleet open the session\'s band under it and the fleet beside it', async ($, on) => {
  const { runs } = world(on, { HC_TERMINAL_ID: 't8' })
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true } as any)
  await $.command.run({ command: 'pace', args: 'band' } as any)
  await $.command.run({ command: 'pace', args: 'fleet' } as any)
  expect(runs).toContainEqual(split('{"view":"band","terminal":"t8"}', 'down'))
  expect(runs).toContainEqual(split('{"view":"panel"}'))
})

test('/pace band outside Herdr says it opens in Herdr', async ($, on) => {
  const { runs, toasts } = world(on)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true } as any)
  await $.command.run({ command: 'pace', args: 'band' } as any)
  expect(runs.some(r => r[0] === 'herdr-app')).toBe(false)
  expect(toasts.some(t => t.includes('Herdr'))).toBe(true)
})

test('/pace focuses the Herdr pane already showing Claude\'s charts rather than open another', async ($, on) => {
  const { runs, toasts, files } = world(on, { HC_TERMINAL_ID: 't8' })
  files['/home/u/.config/herdr-app/shared.json'] = JSON.stringify({ layout: 'main', 'pace.panes': { p1: 'band:t8', p9: 'pane:claude' } })
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true } as any)
  await $.command.run({ command: 'pace', args: '' } as any)
  expect(runs).toContainEqual(['herdr-app', 'do', 'pane.focus', '{"pane":"p9"}'])
  expect(runs.some(r => r[2] === 'pane.split')).toBe(false)
  expect(toasts).toContain('Pace is already open in Herdr')
})
