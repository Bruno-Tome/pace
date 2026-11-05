import { expect, test } from 'claude-code/testing'

import { textOf, world } from './world.ts'

const start = ($: any) => $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true } as any)
const pace = ($: any, args: string) => $.command.run({ command: 'pace', args } as any)
const paneOn = ($: any) => $.ui.mount({ plugin: 'pace', surface: 'desktop', component: 'Pane', requestId: 'pace', props: { bodyColumns: 100, scroll: { offset: 0, bodyRows: 40 } } as any } as any)

/** Every element of a type in a drawn tree, with its props */
const elements = (n: any, type: string): any[] =>
  !n || typeof n !== 'object' ? [] : Array.isArray(n) ? n.flatMap(c => elements(c, type)) : [...(n.type === type ? [n.props ?? {}] : []), ...elements(n.children ?? n.props?.children ?? [], type)]

test('the Pace pane on the desktop is the split: its command bar as buttons over the charts', async ($, on) => {
  world(on)
  await start($)
  await pace($, '')
  const tree = await (await paneOn($)).drawn()
  const labels = elements(tree, 'Button').map(b => b.label)
  for (const l of ['on pace', 'warm', 'band', 'status line', 'auto…', 'ultra…', 'refresh', 'timeline', 'plan…']) expect(labels).toContain(l)
  // The split's keys are the buttons' hotkeys, and the pane closes itself: no quit and no pane button
  expect(elements(tree, 'Button').find(b => b.label === 'on pace')?.hotkey).toBe('p')
  expect(labels).not.toContain('quit')
  expect(labels).not.toContain('pane')
  expect(textOf(tree)).toContain('5-hour')
})

test('a button in the desktop split runs its command, answers in a toast and lights up while on', async ($, on) => {
  const { toasts } = world(on)
  await start($)
  await pace($, '')
  const pane: any = await paneOn($)
  await pane.press({ key: 'pace-p' })
  expect(toasts.some(t => t.startsWith('On pace mode on'))).toBe(true)
  const lit = elements(await pane.drawn(), 'Button').find(b => b.label === 'on pace')
  expect(lit?.variant).toBe('primary')
})

test('auto… in the desktop split picks a plan from a list, or a typed path, to start the run on', async ($, on) => {
  const { files, opens } = world(on)
  files['/tmp/ROADMAP.md'] = '- [ ] One\n'
  await start($)
  await pace($, '')
  const pane: any = await paneOn($)
  await pane.press({ key: 'pace-a' })
  const tree = await pane.drawn()
  expect(textOf(tree)).toContain('Start auto mode on')
  expect(elements(tree, 'Select')[0]?.options.map((o: any) => o.value)).toContain('ROADMAP.md')
  expect(elements(tree, 'Input').length).toBe(1)
  await pane.select({ key: 'pace-pick', value: 'ROADMAP.md' })
  // The run's onboarding opens, and the bar is back to its buttons
  expect(opens.map(o => o.id)).toContain('pace-auto')
  expect(elements(await pane.drawn(), 'Select').length).toBe(0)
})

test('a path typed in the desktop split starts the run on that file', async ($, on) => {
  const { files, opens } = world(on)
  // Ultra pace works toward the plan's goal, checked by its command
  files['/tmp/PLAN.md'] = '## Goal\nShip it.\nDone when:\n- it ships\nCheck: `true`\n## Steps\n- [ ] One\n'
  await start($)
  await pace($, '')
  const pane: any = await paneOn($)
  await pane.press({ key: 'pace-u' })
  expect(textOf(await pane.drawn())).toContain('Start ultra pace on')
  await pane.input({ key: 'pace-path', text: 'PLAN.md' })
  expect(opens.map(o => o.id)).toContain('pace-auto')
})

test('a digit in the desktop split draws one quota alone, and again all of them', async ($, on) => {
  world(on)
  await start($)
  await pace($, '')
  const pane: any = await paneOn($)
  await pane.press({ key: 'pace-1' })
  const one = elements(await pane.drawn(), 'Button').map(b => b.label)
  expect(one).toContain('all')
  await pane.press({ key: 'pace-1' })
  expect(elements(await pane.drawn(), 'Button').map(b => b.label)).not.toContain('all')
})

test('/pace split on the desktop opens the split in a pane, without a word about tmux', async ($, on) => {
  const { toasts, opens } = world(on)
  await start($)
  await pace($, 'split')
  expect(opens.map(o => o.id)).toContain('pace')
  expect(toasts.at(-1)).not.toContain('tmux')
})

test('the Pace pane in the terminal is drawn as before: no buttons', async ($, on) => {
  world(on)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true } as any)
  await pace($, 'pane')
  const tree = await (await $.ui.mount({ plugin: 'pace', surface: 'terminal', component: 'Pane', requestId: 'pace', props: { bodyColumns: 100 } as any } as any)).drawn()
  expect(elements(tree, 'Button').length).toBe(0)
})

test('the desktop split draws its lines in the monospace face, so the figures keep their columns', async ($, on) => {
  world(on)
  await start($)
  await pace($, '')
  const tree: any = await (await paneOn($)).drawn()
  const lines = tree.children.filter((n: any) => n.type === 'Text' && textOf(n).includes('% used'))
  expect(lines.length).toBeGreaterThan(0)
  expect(lines.filter((n: any) => !n.props.mono).length).toBe(0)
})

test('the desktop split draws each chart as an SVG with its points, not braille rows', async ($, on) => {
  world(on)
  await start($)
  await pace($, '')
  const tree: any = await (await paneOn($)).drawn()
  const svgs = elements(tree, 'Svg')
  // The 5-hour window, the week and the Fable week
  expect(svgs.length).toBe(3)
  expect(svgs[0].source).toContain('<circle')
  expect(svgs[0].alt).toContain('5-hour')
  const braille = tree.children.filter((n: any) => n.type === 'Text' && /[⠀-⣿]{4}/.test(textOf(n)))
  expect(braille.length).toBe(0)
})
