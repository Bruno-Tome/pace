import { expect, test } from 'claude-code/testing'

import type { Snapshot } from '../hooks/model.ts'
import { bandLines, click, lineText, paneLines, picked, press, screen, screenOf, sideBySide, splitParts, statusRow, type Line, type Feed, type UiState } from '../hooks/view.ts'

const NOW = Date.UTC(2026, 9, 17, 12, 0, 0)
const H = 3600_000
const plain = (s: string) => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')

const STATE: Feed = {
  samples: [
    { at: NOW - 2 * H, quotas: { five_hour: { percent: 20, resetsAt: NOW + 2 * H } } },
    { at: NOW, quotas: { five_hour: { percent: 60, resetsAt: NOW + 2 * H }, seven_day: { percent: 30, resetsAt: NOW + 72 * H } } },
  ],
  prompts: [NOW - 60_000],
  cache: { at: NOW - 10 * 60_000, tokens: 180_000, window: 1_000_000, ttl: '1h' },
  at: NOW,
}

test('the split names its own keys, not /pace commands, for what its buttons do', () => {
  const text = plain(screen({ ...STATE, warm: 'off' }, NOW, 100, 200))
  expect(text).not.toContain('/pace')
  expect(text).toContain('warm mode off  · [w] steps it')
  const on = plain(screen({ ...STATE, warm: 'ping' }, NOW, 100, 200))
  expect(on).toContain('acts under 10m left, while idle · [w] steps it')
  const empty = plain(screen({ ...STATE, samples: [] }, NOW, 100, 200))
  expect(empty).toContain('No usage yet: figures appear after the first reply, or press r.')
  const run = { plan: 'ROADMAP.md', turns: 3, max: 20 }
  expect(plain(screen({ ...STATE, auto: { ...run, paused: true } }, NOW, 100, 60)).split('\n')[1]).toContain('· [a] resume')
  expect(plain(screen({ ...STATE, auto: { ...run, heldUntil: NOW + H, why: 'the week is low' } }, NOW, 100, 60)).split('\n')[1]).toContain('· [a] off')
})

test('the pane still names the /pace commands it has no buttons for', () => {
  const text = paneLines({ ...STATE, warm: 'off' }, NOW, { cols: 100, chartWidth: 60, chartHeight: () => 5 }).map(l => l.map(x => x.t).join('')).join('\n')
  expect(text).toContain('warm mode off  · /pace warm compact | ping')
  const empty = paneLines({ ...STATE, samples: [] }, NOW, { cols: 100, chartWidth: 60, chartHeight: () => 5 }).map(l => l.map(x => x.t).join('')).join('\n')
  expect(empty).toContain('or run /pace refresh.')
})

test('the window fills the terminal: taller charts on a taller screen, no line wider than it', () => {
  const small = plain(screen(STATE, NOW, 100, 40)).split('\n')
  const big = plain(screen(STATE, NOW, 160, 70)).split('\n')
  expect(big.length).toBeLessThanOrEqual(70)
  expect(big.length).toBeGreaterThan(small.length)
  for (const l of big) expect([...l].length).toBeLessThanOrEqual(160)
  const text = big.join('\n')
  expect(text).toMatch(/[⠁-⣿]/)
  expect(text).toContain('5-hour window')
  expect(text).toContain('Cache & tokens')
  expect(text).toContain('[q] quit')
})

test('the window says how old its figures are', () => {
  expect(plain(screen(STATE, NOW + 3 * 60_000, 100, 40))).toContain('updated 3m ago')
})

test('a context whose window is not known says its size alone, never Infinity%', () => {
  const text = plain(screen({ ...STATE, cache: { ...STATE.cache!, window: 0 } }, NOW, 100, 60))
  expect(text).toContain('context 180k ·')
  expect(text).not.toMatch(/Infinity|NaN/)
})

const braille = (lines: string[]) => lines.filter(l => /[⠁-⣿]/.test(l)).length

test('a terminal over 180 columns puts the 5-hour and weekly charts side by side', () => {
  const wide = plain(screen(STATE, NOW, 200, 60)).split('\n')
  expect(wide.some(l => l.includes('5-hour window') && l.includes('Week · all models'))).toBe(true)
  for (const l of wide) expect([...l].length).toBeLessThanOrEqual(200)
  const narrow = plain(screen(STATE, NOW, 160, 60)).split('\n')
  expect(narrow.some(l => l.includes('5-hour window') && l.includes('Week · all models'))).toBe(false)
})

test('focusing a quota draws its chart alone, full-height, and the footer names the keys', () => {
  const all = plain(screen(STATE, NOW, 100, 40)).split('\n')
  const one = plain(screen(STATE, NOW, 100, 40, { focus: 2 })).split('\n')
  expect(one.length).toBeLessThanOrEqual(40)
  expect(one.join('\n')).toContain('Week · all models')
  expect(one.join('\n')).not.toContain('5-hour window')
  expect(braille(one)).toBeGreaterThan(20)
  expect(all.join('\n')).toContain('[1–2] focus')
  expect(one.join('\n')).toContain('[2] all')
})

test('focus on a quota that is not there draws the whole window', () => {
  expect(plain(screen(STATE, NOW, 100, 40, { focus: 3 }))).toContain('5-hour window')
})

test('the pane wraps its figures to its columns: nothing is cut off at a narrow split', () => {
  // 20 prompts in 20 minutes on a window at 60%: a burst with a run-out time, a long figures line
  const busy: Feed = { ...STATE, prompts: Array.from({ length: 20 }, (_, i) => NOW - i * 60_000) }
  const lines = paneLines(busy, NOW, { cols: 36, chartWidth: 30, chartHeight: () => 4 })
  for (const l of lines) expect([...l.map(x => x.t).join('')].length).toBeLessThanOrEqual(36)
  // The figures line and the context line, which a narrow split used to cut mid-word, now wrap between words
  const text = lines.map(l => l.map(x => x.t).join('')).join(' ')
  expect(text).toContain('per-prompt cost')
  expect(text).toContain('next prompt')
})

const ULTRA_RUN = {
  plan: 'PLAN.md', turns: 4, max: 80,
  ultra: {
    goal: 'pace ships 1.0 with CI green.', check: 'claude plugin test .', phase: 'work' as const, sinceReview: 1, quietReviews: 0, checkFails: 0,
    models: { floor: 'sonnet', ceiling: 'claude-opus-5-5' }, headroomStreak: 0,
    gear: { model: 'claude-opus-5-5', effort: 'xhigh' as const, subagents: 3, subagentModel: 'sonnet', fanout: true },
  },
}
const UI: UiState = {}
const FULL: Feed = { ...STATE, onPace: true, warm: 'compact', prefs: { band: true, line: false }, known: ['ROADMAP.md', 'PLAN.md'] }

test('the split\'s buttons sit under the title, each lit while what it flips is on, with no row of modes spelled out', () => {
  const { text, hits } = screenOf(FULL, NOW, 100, 60, UI)
  const t = plain(text)
  const rows = t.split('\n')
  // The bar comes before the first chart
  const bar = rows.findIndex(l => l.includes('[r] refresh'))
  expect(bar).toBeGreaterThan(0)
  expect(bar).toBeLessThan(rows.findIndex(l => l.includes('5-hour window')))
  for (const label of ['[r] refresh', '[a] auto…', '[u] ultra…', '[t] timeline', '[p] on pace', '[w] warm compact', '[b] band', '[l] status line', '[q] quit']) expect(t).toContain(label)
  // On pace mode, warm mode and the band are on: lit; the status line is off: not
  for (const lit of ['[p] on pace', '[w] warm compact', '[b] band']) expect(text).toContain(`\x1b[1;32m${lit}\x1b[0m`)
  expect(text).not.toContain('\x1b[1;32m[l] status line')
  expect(t).not.toContain('on pace mode  on')
  expect(t).not.toContain('auto mode  off')
  // Each button's hit covers its label on the screen
  expect(hits.length).toBeGreaterThanOrEqual(8)
  for (const h of hits as { x: number; y: number; w: number; label: string }[]) expect([...rows[h.y - 1]!].slice(h.x - 1, h.x - 1 + h.w).join('')).toBe(h.label)
  for (const l of rows) expect([...l].length).toBeLessThanOrEqual(100)
})

test('the split\'s bar says what is on and what is off, each with its key, then the commands', () => {
  const rows = plain(screenOf(FULL, NOW, 100, 60, UI).text).split('\n')
  const row = (lead: string) => rows.find(l => l.startsWith(lead)) ?? ''
  // On pace mode, warm mode and the band are on; the status line and the runs are off
  expect(row('on  ')).toBe('on    [p] on pace  [w] warm compact  [b] band')
  expect(row('off ')).toBe('off   [l] status line  [a] auto…  [u] ultra…')
  for (const label of ['[r] refresh', '[t] timeline', '[f] plan…', '[v] preview', '[i] pane', '[m] window', '[1–2] focus', '[q] quit']) expect(row('do  ')).toContain(label)
  // Nothing on says so
  const none = plain(screenOf({ ...FULL, onPace: false, warm: 'off', prefs: { band: false, line: false } }, NOW, 100, 60, UI).text).split('\n')
  expect(none.find(l => l.startsWith('on  '))).toBe('on    nothing')
  expect(none.find(l => l.startsWith('off '))).toBe('off   [p] on pace  [w] warm  [b] band  [l] status line  [a] auto…  [u] ultra…')
  // A run under way is on with its burst; paused, it offers resume and stop
  const run = plain(screenOf({ ...FULL, auto: { plan: 'ROADMAP.md', turns: 3, max: 20 } }, NOW, 100, 60, UI).text).split('\n')
  expect(run.find(l => l.startsWith('on  '))).toContain('[a] auto')
  expect(run.find(l => l.startsWith('off '))).toContain('[s] burst')
  const paused = plain(screenOf({ ...FULL, auto: { plan: 'ROADMAP.md', turns: 3, max: 20, paused: true } }, NOW, 100, 60, UI).text).split('\n')
  expect(paused.find(l => l.startsWith('on  '))).toContain('[a] resume  [x] stop')
})

test('every /pace command has a key in the split: a plan\'s timeline, the pane, the window, stopping a paused run', () => {
  const f = press(UI, 'f', FULL)
  expect(f.ui.picking).toBe('plan')
  expect(plain(screenOf(FULL, NOW, 100, 60, f.ui).text)).toContain('Show the timeline of:')
  expect(press(f.ui, '2', FULL)).toEqual({ ui: {}, send: 'plan PLAN.md' })
  let typed = press(f.ui, 't', FULL).ui
  for (const c of 'x.md') typed = press(typed, c, FULL).ui
  expect(press(typed, '\r', FULL)).toEqual({ ui: {}, send: 'plan x.md' })
  expect(press(UI, 'i', FULL).send).toBe('pane')
  expect(press(UI, 'm', FULL).send).toBe('window')
  expect(press(UI, 'x', { ...FULL, auto: { plan: 'ROADMAP.md', turns: 3, max: 20, paused: true } }).send).toBe('auto off')
  expect(press(UI, 'x', { ...FULL, auto: { ...ULTRA_RUN, paused: true } }).send).toBe('ultra off')
})

test('the split scrolls instead of squashing: a long plan leaves the charts their height, and the arrows move what is under the bar', () => {
  const long: Feed = { ...FULL, plan: { name: 'ROADMAP.md', steps: Array.from({ length: 30 }, (_, i) => ({ text: `Step ${i + 1}`, state: i ? 'next' as const : 'now' as const, section: null })) } }
  // The charts' rows: the braille above the legend that closes them
  const chartRows = (f: Feed) => {
    const lines = plain(screenOf(f, NOW, 100, 60, UI).text).split('\n')
    return lines.slice(0, lines.findIndex(l => l.includes('even pace'))).filter(l => /[⠁-⣿]/.test(l)).length
  }
  expect(chartRows(long)).toBeGreaterThan(0)
  expect(chartRows(long)).toBe(chartRows(FULL))
  const first = screenOf(long, NOW, 100, 40, UI)
  expect(plain(first.text)).toContain('↓')
  const down = press(UI, '\x1b[B', long)
  expect(down).toEqual({ ui: { scroll: 1 } })
  const moved = screenOf(long, NOW, 100, 40, press(down.ui, '\x1b[6~', long).ui)
  const a = plain(first.text).split('\n')
  const b = plain(moved.text).split('\n')
  // The title and the bar stay; the body under them moved
  expect(b[0]).toBe(a[0])
  expect(b.find(l => l.includes('[r] refresh'))).toBe(a.find(l => l.includes('[r] refresh')))
  expect(b.slice(4)).not.toEqual(a.slice(4))
  expect(b.length).toBeLessThanOrEqual(40)
  // Scrolled past the end, it stops at the end; up goes back
  const end = screenOf(long, NOW, 100, 40, { scroll: 9999 })
  expect(end.scroll).toBeLessThan(9999)
  expect(press({ scroll: 3 }, '\x1b[A', long)).toEqual({ ui: { scroll: 2 } })
  expect(press(UI, '\x1b[A', long)).toEqual({ ui: { scroll: 0 } })
})

test('the command bar follows the run: auto lit and burst while one runs, resume while it is paused, ultra lit under ultra pace', () => {
  const lit = (t: string) => `\x1b[1;32m${t}\x1b[0m`
  const raw = screenOf({ ...FULL, auto: { plan: 'ROADMAP.md', turns: 3, max: 20 } }, NOW, 100, 60, UI).text
  const running = plain(raw)
  expect(raw).toContain(lit('[a] auto'))
  expect(running).toContain('[s] burst')
  expect(raw).not.toContain(lit('[s] burst'))
  expect(screenOf({ ...FULL, auto: { plan: 'ROADMAP.md', turns: 3, max: 20, burst: true } }, NOW, 100, 60, UI).text).toContain(lit('[s] burst'))
  expect(running).toContain('auto mode  ▶ ROADMAP.md · turn 3/20')
  const paused = plain(screenOf({ ...FULL, auto: { plan: 'ROADMAP.md', turns: 3, max: 20, paused: true } }, NOW, 100, 60, UI).text)
  expect(paused).toContain('[a] resume')
  const ultra = plain(screenOf({ ...FULL, auto: ULTRA_RUN }, NOW, 100, 60, UI).text)
  expect(screenOf({ ...FULL, auto: ULTRA_RUN }, NOW, 100, 60, UI).text).toContain(lit('[u] ultra'))
  expect(ultra).toContain('goal  pace ships 1.0 with CI green.')
  expect(ultra).toContain('gear  push · opus xhigh · 3 agents')
  expect(ultra).toContain('check  claude plugin test .')
})

test('picking a plan: a lists the plans the session knows, a digit starts the run on one, t takes a typed path, esc cancels', () => {
  const a = press(UI, 'a', FULL)
  expect(a.ui.picking).toBe('auto')
  expect(a.send).toBeUndefined()
  const menu = plain(screenOf(FULL, NOW, 100, 60, a.ui).text)
  expect(menu).toContain('Start auto mode on')
  expect(menu).toContain('[1] ROADMAP.md')
  expect(menu).toContain('[2] PLAN.md')
  expect(menu).toContain('[t] a path')
  expect(menu).toContain('[esc] cancel')
  expect(press(a.ui, '2', FULL)).toEqual({ ui: {}, send: 'auto PLAN.md' })
  const typing = press(a.ui, 't', FULL).ui
  expect(typing.typing).toBe('')
  let ui = typing
  for (const c of 'x.md') ui = press(ui, c, FULL).ui
  expect(plain(screenOf(FULL, NOW, 100, 60, ui).text)).toContain('plan file: x.md')
  expect(press(ui, '\x7f', FULL).ui.typing).toBe('x.m')
  expect(press(ui, '\r', FULL)).toEqual({ ui: {}, send: 'auto x.md' })
  expect(press(ui, '\x1b', FULL)).toEqual({ ui: {} })
  expect(press(press(UI, 'u', FULL).ui, '1', FULL)).toEqual({ ui: {}, send: 'ultra ROADMAP.md' })
})

test('the keys send the /pace command that flips each mode, focus a quota, or quit', () => {
  expect(press(UI, 'p', FULL).send).toBe('off')
  expect(press(UI, 'p', { ...FULL, onPace: false }).send).toBe('on')
  expect(press(UI, 'w', { ...FULL, warm: 'off' }).send).toBe('warm compact')
  expect(press(UI, 'w', FULL).send).toBe('warm ping')
  expect(press(UI, 'w', { ...FULL, warm: 'ping' }).send).toBe('warm off')
  expect(press(UI, 'b', FULL).send).toBe('hide')
  expect(press(UI, 'b', { ...FULL, prefs: { band: false, line: true } }).send).toBe('show')
  expect(press(UI, 'l', FULL).send).toBe('line on')
  expect(press(UI, 'r', FULL).send).toBe('refresh')
  expect(press(UI, 't', FULL).send).toBe('timeline')
  expect(press(UI, 'v', FULL).send).toBe('ultra preview')
  const run = { ...FULL, auto: { plan: 'ROADMAP.md', turns: 3, max: 20 } }
  expect(press(UI, 'a', run).send).toBe('auto off')
  expect(press(UI, 's', run).send).toBe('auto burst')
  expect(press(UI, 's', { ...run, auto: { ...run.auto, burst: true as const } }).send).toBe('auto burst off')
  expect(press(UI, 'a', { ...run, auto: { ...run.auto, paused: true } }).send).toBe('auto resume')
  expect(press(UI, 'u', { ...FULL, auto: ULTRA_RUN }).send).toBe('ultra off')
  expect(press(UI, '2', FULL)).toEqual({ ui: { focus: 2 } })
  expect(press({ focus: 2 }, '2', FULL)).toEqual({ ui: { focus: undefined } })
  expect(press(UI, 'q', FULL)).toEqual({ ui: {}, quit: true })
  expect(press(UI, '\x03', FULL)).toEqual({ ui: {}, quit: true })
  expect(press(UI, 'z', FULL)).toEqual({ ui: {} })
})

test('a click on a button is its key', () => {
  const { hits } = screenOf(FULL, NOW, 100, 60, UI)
  const refresh = hits.find(h => h.label === '[r] refresh')!
  expect(click(hits, refresh.x + 2, refresh.y)).toBe('r')
  expect(click(hits, refresh.x + refresh.w, refresh.y)).toBeUndefined()
  expect(click(hits, 1, 1)).toBeUndefined()
})

test('the split draws two plans side by side when wide, one under the other when narrow', () => {
  const also = { name: 'PLAN.md', steps: [{ text: 'Ship it', state: 'now' as const, section: null }] }
  const wide = plain(screenOf({ ...FULL, plan: PLAN, also }, NOW, 180, 70, UI).text).split('\n')
  expect(wide.some(l => l.includes('ROADMAP.md') && l.includes('PLAN.md'))).toBe(true)
  const narrow = plain(screenOf({ ...FULL, plan: PLAN, also }, NOW, 80, 70, UI).text)
  expect(narrow).toContain('ROADMAP.md')
  expect(narrow).toContain('Ship it')
})

test('a command\'s answer shows under the title for 10 seconds', () => {
  const f: Feed = { ...FULL, notice: { id: 1, text: 'On pace mode off', at: NOW } }
  expect(plain(screenOf(f, NOW + 5_000, 100, 60, UI).text)).toContain('› On pace mode off')
  expect(plain(screenOf(f, NOW + 11_000, 100, 60, UI).text)).not.toContain('On pace mode off')
})

const textOfLine = (l: Line) => l.map(x => x.t).join('')

test('the band, the status-line row and the status-line entry say the same rate for each quota', () => {
  const week = { percent: 80, resetsAt: NOW + 72 * H, name: 'Fable' }
  const cases: Snapshot[] = [
    // 20 prompts in 20 minutes on a window at 60%: a burst; the Fable week over pace with no cost yet
    { samples: [{ at: NOW, quotas: { five_hour: { percent: 60, resetsAt: NOW + 2 * H }, seven_day_fable: week } }], prompts: Array.from({ length: 20 }, (_, i) => NOW - i * 60_000), cache: null },
    // No prompt in the last 15 minutes: idle
    { samples: [{ at: NOW, quotas: { five_hour: { percent: 30, resetsAt: NOW + 2 * H } } }], prompts: [NOW - 40 * 60_000], cache: null },
  ]
  for (const s of cases) {
    const entry = lineText(s, NOW)
    const row = textOfLine(statusRow(s, NOW, 120))
    for (const l of bandLines(s, NOW, 60).slice(0, -1)) {
      const rate = textOfLine(l).split('│').pop()!.trim()
      expect(entry).toContain(rate)
      expect(row).toContain(rate)
    }
  }
})

const PLAN: Feed['plan'] = {
  name: 'ROADMAP.md',
  steps: [
    { text: 'Platform table', state: 'done', section: 'Docs' },
    { text: 'CI', state: 'now', section: 'Release' },
    { text: '1.0.0', state: 'next', section: 'Release' },
  ],
}

test('the split shows auto mode\'s run under its title and the plan\'s timeline under the charts', () => {
  const auto = { plan: 'ROADMAP.md', turns: 3, max: 20 }
  // Tall enough that nothing scrolls under the bar: the order of the blocks is what is checked
  const lines = plain(screen({ ...STATE, onPace: true, auto, plan: PLAN }, NOW, 100, 80)).split('\n')
  expect(lines.length).toBeLessThanOrEqual(80)
  const text = lines.join('\n')
  expect(lines[1]).toContain('auto  ▶ ROADMAP.md · turn 3/20')
  expect(text).toContain('1 of 3 steps done')
  expect(text).toContain('CI · under way')
  expect(text).toContain('1.0.0 · up next')
  const at = (s: string) => lines.findIndex(l => l.includes(s))
  expect(at('Plan')).toBeGreaterThan(at('5-hour window'))
  expect(at('Plan')).toBeLessThan(at('Prompting'))
})

test('the split without a plan or a mode draws no plan and no modes row', () => {
  const text = plain(screen(STATE, NOW, 100, 60))
  expect(text).not.toContain('steps done')
  expect(text).not.toContain('auto  ')
  expect(text).not.toContain('on pace ●')
})

test('on pace mode in the split says the effort is a level lighter while the rate runs a quota out', () => {
  // 20 prompts in 20 minutes on a window at 60%: a burst that runs it out before its reset
  const burst: Feed = { ...STATE, onPace: true, prompts: Array.from({ length: 20 }, (_, i) => NOW - i * 60_000) }
  expect(plain(screen(burst, NOW, 100, 60))).toContain('effort a level lighter')
  // One prompt in the last hour: steady, the effort as set
  expect(plain(screen({ ...STATE, onPace: true }, NOW, 100, 60))).not.toContain('effort a level lighter')
})

test('the split\'s status row puts the lighter effort with the mode\'s figures, the key that turns it off last', () => {
  const prompts = Array.from({ length: 20 }, (_, i) => NOW - i * 60_000)
  const auto = plain(screen({ ...STATE, prompts, onPace: true, auto: { plan: 'ROADMAP.md', turns: 3, max: 20 } }, NOW, 100, 60)).split('\n')[1]
  expect(auto).toBe('auto  ▶ ROADMAP.md · turn 3/20 · effort a level lighter · [a] off')
  const onPace = plain(screen({ ...STATE, prompts, onPace: true }, NOW, 100, 60)).split('\n')[1]
  expect(onPace).toBe('on pace ● compacts heavy contexts, keeps the cache warm · effort a level lighter · [p] off')
})

const plainLine = (l: Line | undefined) => (l ?? []).map(s => s.t).join('')

test('an ultra run shows under the band and in the status-line entry: its gear and its turn', () => {
  const s = { ...STATE, auto: ULTRA_RUN }
  const modes = plainLine(bandLines(s, NOW, 120).at(-1))
  expect(modes).toContain('ultra ▶ push · opus xhigh · 3 agents · turn 4/80')
  expect(lineText(s, NOW)).toContain('│ ultra · push · opus xhigh · 3 agents')
})

test('an ultra run easing, or after failed checks, says so in the warning color', () => {
  const ease = { ...ULTRA_RUN, ultra: { ...ULTRA_RUN.ultra, checkFails: 2, gear: { model: 'sonnet', effort: 'medium' as const, subagents: 1, subagentModel: 'haiku', fanout: false } } }
  const modes = bandLines({ ...STATE, auto: ease }, NOW, 120).at(-1)!
  expect(plainLine(modes)).toContain('ultra ▶ ease · sonnet medium · 1 agent')
  expect(plainLine(modes)).toContain('check failed 2×')
  expect(modes.some(s => s.color === 'warning')).toBe(true)
})

test('two plans side by side: the left padded to its width, a gap, the right; the longer one runs on alone', () => {
  const left: Line[] = [[{ t: 'abc' }], [{ t: 'de' }]]
  const right: Line[] = [[{ t: 'X' }], [{ t: 'Y' }], [{ t: 'Z' }]]
  const rows = sideBySide(left, right, 5).map(l => l.map(s => s.t).join(''))
  expect(rows).toEqual(['abc     X', 'de      Y', '        Z'])
})

test('the split in a pane: the bar as rows of buttons, a digit for each quota, no quit or pane of its own', () => {
  const p = splitParts(FULL, NOW, 100, 60, UI)
  const keys = (lead: string) => p.bar.find(r => r.lead === lead)!.buttons.map(b => b.key)
  // On pace and warm compact are on, the band too; the status line is off
  expect(keys('on')).toEqual(['p', 'w', 'b'])
  expect(keys('off')).toContain('l')
  expect(keys('do')).toContain('1')
  expect(keys('do')).not.toContain('i')
  expect(keys('do')).not.toContain('q')
  expect(p.body.length).toBeGreaterThan(0)
})

test('the split in a pane while a plan is picked: no bar, what it is picked for, the plans known', () => {
  const p = splitParts(FULL, NOW, 100, 60, { picking: 'ultra' })
  expect(p.bar).toEqual([])
  expect(p.picking).toBe('Start ultra pace on:')
  expect(p.known).toEqual(['ROADMAP.md', 'PLAN.md'])
})

test('a plan picked starts the run it was picked for; a blank path cancels', () => {
  expect(picked({ picking: 'ultra' }, ' PLAN.md ')).toEqual({ ui: {}, send: 'ultra PLAN.md' })
  expect(picked({ picking: 'plan' }, 'ROADMAP.md').send).toBe('plan ROADMAP.md')
  expect(picked({ picking: 'auto' }, '  ')).toEqual({ ui: {} })
})
