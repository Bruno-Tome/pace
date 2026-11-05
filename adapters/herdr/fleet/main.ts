// The fleet in Herdr: every agent Herdr runs and every provider's quotas, by provider, by repo or by urgency, and a
// way to send the next piece of work where there is room for it. The model and its drawing are core/fleet.ts's;
// this file reads the feeds and Herdr, turns segments into elements and acts on clicks.
//
//   the panel    tabs for the three views, the recommendation, and each group: a provider's quotas as pace draws
//                them, or a repo, or an urgency, with its agents a line each; a click on an agent goes to it
//   the dialog   `{ view: 'send' }`, opened by "Send work": the host (the recommended one first), the folder and the
//                task; it asks once more before it starts the agent in a new tab, and never types into one running
//
// Reads ~/.local/state/pace/feeds/ and ~/.local/state/ql/feeds/ as they change, a timer as fallback, and Herdr's
// agents live. The model is worked out when either changes, never in render: Herdr interrupts a call past its budget.

import { View, div } from 'gpui-kit'
import { h_flex, Input, InputState, v_flex } from 'gpui-base'
import { agents, closeOverlay, exec, home, openOverlay, panes, props, readTextFile, run, settings, terminals, theme, watchFolder } from 'herdr'

import { barOf, colsFor, colWidth, PAD, PAD_Y, styleOf, type Bar } from '../draw.ts'
import { SEED } from './seed.ts'
import { byProvider, byRepo, byUrgency, fleetModel, groupLines, memberLine, PROVIDER_NAME, QL_FEEDS_DIR, qlFeedOf, recommendLine, type FleetGroup, type FleetModel, type HerdrAgent, type QlSession } from '../../../core/fleet.ts'
import { FEEDS_DIR, feedOf, type PaceFeed, type PaceProvider } from '../../../core/host.ts'
import type { Line } from '../../../core/view.ts'

const SIZE = 12
const LINE = 15
const REFRESH_MS = 30_000

type Tab = 'provider' | 'repo' | 'urgency'
const TABS: { tab: Tab; label: string; groups: (m: FleetModel) => FleetGroup[] }[] = [
  { tab: 'provider', label: 'By provider', groups: byProvider },
  { tab: 'repo', label: 'By repo', groups: byRepo },
  { tab: 'urgency', label: 'By urgency', groups: byUrgency },
]

/** How each host starts: Codex without its daemon, so its commands run in the terminal Herdr gave it */
const ARGV: Record<PaceProvider, string[]> = { claude: ['claude'], codex: ['codex', '--no-daemon'], antigravity: ['agy'] }

const paceDir = () => `${home()}/${FEEDS_DIR}`
const qlDir = () => `${home()}/${QL_FEEDS_DIR}`

/** Every .json in a folder, as text; none when the folder is not there */
async function readAll(dir: string): Promise<{ name: string; text: string }[]> {
  const listed = await exec('ls', [dir]).catch(() => null)
  const names = (listed?.code === 0 ? listed.stdout.split('\n') : []).filter((n: string) => n.endsWith('.json'))
  return Promise.all(names.map(async (name: string) => ({ name, text: (await readTextFile(`${dir}/${name}`).catch(() => null)) ?? '' })))
}

const parsed = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** Herdr's agents as the fleet reads them: each with its pane's folder and branch, and its ctx label */
function herdrAgents(): HerdrAgent[] {
  const byTerminal = new Map(panes().filter((p: any) => p.terminal).map((p: any) => [p.terminal, p]))
  const labels = new Map(terminals().map((k: any) => [k.address, k.labels ?? {}]))
  return agents().map((a: any) => {
    const pane: any = byTerminal.get(a.address)
    const ctx = Number((labels.get(a.address) as any)?.ctx)
    return { address: a.address, status: a.status, app: a.app, title: a.title, cwd: pane?.cwd ?? null, branch: pane?.branch ?? null, ctx: Number.isFinite(ctx) ? ctx : null }
  })
}

/** What render compares to tell Herdr's agents changed: who, doing what, where, how full */
const signature = (list: readonly HerdrAgent[]) => list.map(a => `${a.address}:${a.status}:${a.cwd}:${a.branch}:${a.ctx}`).join('|')

function barBlock(bar: Bar, color: string, key: string): any {
  const w = bar.cells * colWidth(SIZE)
  if (bar.kind === 'tick') return h_flex().id(key).w(w).h(LINE).justify_center().child(div().w(1).h(LINE - 4).bg(color))
  return div().id(key).w(w).h(LINE - 5).bg(color).opacity(bar.kind === 'empty' ? 0.35 : 1)
}

function lineOf(line: Line, t: Record<string, string>, key: string): any {
  return h_flex().id(key).items_center().children(line.map((seg, i) => {
    const s = styleOf(seg, t)
    const bar = barOf(seg)
    if (bar) return barBlock(bar, s.color, `${key}-${i}`)
    let el = div().id(`${key}-${i}`).text_color(s.color).child(seg.t)
    if (s.bold) el = el.font_bold()
    if (s.pulse) el = el.loop('opacity', { from: 0.4, to: 1, period: 1200 })
    return el
  }))
}

function button(key: string, label: string, t: Record<string, string>, onClick: () => void, on = false): any {
  return div().id(key).px(8).py(2).rounded(4).cursor_pointer()
    .text_color(on ? t.foreground : t.muted).when(on, (el: any) => el.bg(t.hover).font_semibold())
    .hover((s: any) => s.bg(t.hover)).child(label).on_click((_e: any, cx: any) => { onClick(); cx.notify() })
}

/** A group as drawn: its head lines, and each agent's line with the terminal a click goes to */
type Drawn = { key: string; head: Line[]; members: { line: Line; address: string | null }[] }

export default class Fleet extends View {
  tab: Tab = 'provider'
  pace: PaceFeed[] = []
  ql: QlSession[] = []
  model: FleetModel = { agents: [], providers: [], recommended: null }
  drawn: Drawn[] = []
  cols = 60
  seen = ''
  /** The dialog's state, when this copy is the "Send work" dialog */
  send: { host: PaceProvider; folder: string; input: any; confirming: boolean } | null = null

  init(_props: unknown, cx: any): void {
    if (SEED) {
      // A check's build: the model and its drawing on the seed's feeds, at once, and no files
      this.pace = [...SEED.pace]
      this.work(Date.now(), [])
      return
    }
    const p = props() ?? {}
    if (p.view === 'send') {
      this.send = { host: p.host === 'codex' ? 'codex' : 'claude', folder: String(p.folders?.[0] ?? home()), input: InputState.new({ value: '' }), confirming: false }
      this.send.input.on('change', (_e: any, cx: any) => cx.notify())
      this.send.input.focus()
      cx.timer.after(600, () => this.send?.input.focus())
      return
    }
    this.reload(cx)
    cx.timer.every(REFRESH_MS, (cx: any) => this.reload(cx))
    for (const dir of [paceDir(), qlDir()]) {
      cx.spawn(async (cx: any) => {
        await exec('mkdir', ['-p', dir]).catch(() => null)
        for (;;) {
          try {
            await watchFolder(dir)
          } catch {
            return
          }
          this.reload(cx)
        }
      })
    }
  }

  /** Rereads both feed folders, a file mid-write keeping what was last read from it, and works the model out again */
  reload(cx: any): void {
    cx.spawn(async (cx: any) => {
      const [paceFiles, qlFiles] = await Promise.all([readAll(paceDir()), readAll(qlDir())])
      const pace = new Map(this.pace.map(f => [`${f.host}-${f.session}`, f]))
      for (const { text } of paceFiles) {
        const f = feedOf(text)
        if (f) pace.set(`${f.host}-${f.session}`, f)
      }
      const ql = new Map(this.ql.map(f => [`${f.host}-${f.session}`, f]))
      for (const { text } of qlFiles) {
        const f = qlFeedOf(parsed(text))
        if (f) ql.set(`${f.host}-${f.session}`, f)
      }
      this.pace = [...pace.values()]
      this.ql = [...ql.values()]
      this.work(Date.now(), herdrAgents())
      cx.notify()
    })
  }

  /** The model and what each group draws, from the feeds read and Herdr's agents now */
  work(now: number, live: readonly HerdrAgent[]): void {
    this.seen = signature(live)
    this.model = fleetModel({ pace: this.pace, ql: this.ql, agents: live, now })
    const groups = TABS.find(t => t.tab === this.tab)!.groups(this.model)
    this.drawn = groups.map((g, i) => {
      const lines = groupLines(g, now, this.cols)
      const head = g.agents.length ? lines.slice(0, lines.length - g.agents.length) : lines
      return { key: `${this.tab}-${i}`, head, members: g.agents.map(a => ({ line: [{ t: '  ' }, ...memberLine(a, now)], address: a.address })) }
    })
  }

  /** Opens the "Send work" dialog: the recommended host first, the folders the agents work in to pick from */
  openSend(): void {
    const folders = [...new Set(this.model.agents.map(a => a.cwd).filter(Boolean))]
    openOverlay({ mod: 'fleet', kind: 'dialog', width: 560, height: 380, props: { view: 'send', host: this.model.recommended?.provider ?? 'claude', folders } })
  }

  panel(t: Record<string, string>): any[] {
    return [
      h_flex().id('tabs').gap(4).pb(6).items_center().children([
        ...TABS.map(({ tab, label }) => button(`tab-${tab}`, label, t, () => { this.tab = tab; this.work(Date.now(), herdrAgents()) }, tab === this.tab)),
        div().flex_1(),
        button('send', 'Send work ⇥', t, () => this.openSend()),
      ]),
      lineOf(recommendLine(this.model), t, 'recommend'),
      ...this.drawn.flatMap(g => [
        div().id(`gap-${g.key}`).h(LINE / 2),
        ...g.head.map((l, i) => lineOf(l, t, `${g.key}-head-${i}`)),
        ...g.members.map((m, i) => (m.address
          ? lineOf(m.line, t, `${g.key}-m-${i}`).cursor_pointer().hover((s: any) => s.bg(t.hover)).on_click(() => run('agent.focus', { terminal: m.address }))
          : lineOf(m.line, t, `${g.key}-m-${i}`))),
      ]),
    ]
  }

  /** The dialog: host, folder, task; Start asks once more, Confirm starts the agent in a new tab */
  dialog(t: Record<string, string>): any {
    const s = this.send!
    const p = props() ?? {}
    const folders: string[] = p.folders?.length ? p.folders : [home()]
    const short = (f: string) => f.replace(home(), '~')
    const task = String(s.input.value() ?? '').trim()
    const label = (text: string) => div().pt(12).pb(5).text_size(11.5).text_color(t.dim).child(text)
    const pick = (key: string, text: string, on: boolean, act: () => void) => button(key, text, t, act, on)
    const start = () => {
      closeOverlay(p.overlay)
      run('tab.new', { name: task.slice(0, 32), folder: s.folder, argv: ARGV[s.host], task })
    }
    return v_flex().id('send').size_full().p(18).bg(t.popover).text_color(t.foreground).text_size(12.5)
      .child(h_flex().items_center().child(div().flex_1().text_size(15).font_semibold().child('Send work')).child(div().text_size(11).text_color(t.dim).child('Esc')))
      .child(label('Host'))
      .child(h_flex().gap(4).children((['claude', 'codex'] as const).map(h =>
        pick(`host-${h}`, `${PROVIDER_NAME[h]}${h === p.host ? ' · recommended' : ''}`, s.host === h, () => { s.host = h; s.confirming = false }))))
      .child(label('Folder'))
      .child(h_flex().flex_wrap().gap(4).children(folders.map((f, i) => pick(`folder-${i}`, short(f), s.folder === f, () => { s.folder = f; s.confirming = false }))))
      .child(label('Task'))
      .child(Input.new(s.input).h(36).px(10).rounded(8).border_1().border_color(t.input).bg(t.background))
      .child(div().pt(10).text_color(t.dim).child(s.confirming ? `Start ${ARGV[s.host].join(' ')} in ${short(s.folder)} with this task?` : ''))
      .child(h_flex().pt(10).gap(8).justify_end().children(s.confirming
        ? [pick('back', 'Back', false, () => { s.confirming = false }), pick('confirm', 'Confirm', true, start)]
        : [pick('cancel', 'Cancel', false, () => closeOverlay(p.overlay)), pick('start', 'Start…', !!task, () => { if (task) s.confirming = true })]))
  }

  render(cx: any): any {
    const t = theme()
    if (this.send) return this.dialog(t)
    const live = herdrAgents()
    if (signature(live) !== this.seen) cx.spawn(async (cx: any) => { this.work(Date.now(), herdrAgents()); cx.notify() })
    return v_flex().id('root').size_full().bg(t.surface).px(PAD).py(PAD_Y).text_size(SIZE).line_height(`${LINE}px`).text_color(t.foreground)
      .font_family(String(settings().font_family ?? 'JetBrains Mono'))
      .overflow_y_scrollbar()
      .on_size_change((size: { width: number }, cx: any) => {
        const cols = colsFor(size.width, SIZE)
        if (cols === this.cols) return
        this.cols = cols
        cx.spawn(async (cx: any) => { this.work(Date.now(), herdrAgents()); cx.notify() })
      })
      .children(this.panel(t))
  }
}
