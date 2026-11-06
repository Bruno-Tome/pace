import { expect, test } from 'claude-code/testing'

import { world } from './world.ts'

const SCRIPT = '/home/u/.claude/pace-activity.command'

test('/pace activity in Herdr opens it as a split of the pace mod beside the session', async ($, on) => {
  const { runs, toasts } = world(on, { HC_TERMINAL_ID: 't8' })
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true } as any)
  await $.command.run({ command: 'pace', args: 'activity' } as any)
  expect(runs).toContainEqual(['herdr-app', 'do', 'pane.split', '{"direction":"right","mod":"pace","props":{"view":"activity"}}'])
  expect(toasts).toContain('Pace opened in Herdr: activity')
})

test('/pace activity in tmux opens bin/activity.ts in a split beside Claude', async ($, on) => {
  const { runs, files, toasts } = world(on, { TMUX: '/tmp/tmux-501/default,1,0', TMUX_PANE: '%3' })
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true } as any)
  await $.command.run({ command: 'pace', args: 'activity' } as any)
  expect(files[SCRIPT]).toContain('bin/activity.ts')
  expect(runs.some(r => r[0] === 'tmux' && r[1] === 'split-window' && r.at(-1) === SCRIPT)).toBe(true)
  expect(toasts).toContain('Activity opened in a tmux split; q there closes it')
})

test('/pace activity outside Herdr and tmux opens it in a terminal window', async ($, on) => {
  const { runs, toasts } = world(on)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true } as any)
  await $.command.run({ command: 'pace', args: 'activity' } as any)
  expect(runs).toContainEqual(['open', '-a', 'Terminal', SCRIPT])
  expect(toasts).toContain('Activity opened in a terminal window; q closes it')
})
