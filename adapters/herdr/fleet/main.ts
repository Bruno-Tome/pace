// The fleet in Herdr: every agent Herdr runs and every provider's quotas, by provider, by repo or by urgency, and a
// way to send the next piece of work where there is room for it. The model and its drawing are core/fleet.ts's;
// this file reads the feeds and Herdr, turns segments into elements and acts on clicks.
//
//   the panel    tabs for the three views, the recommendation, and each group: a provider's quotas as pace draws
//                them, or a repo, or an urgency, with its agents a line each; a click on an agent goes to it
//   Send work    `{ view: 'send' }`: the host (the recommended one first), the folder and the task; it asks once
//                more before it starts the agent in a new tab, and never types into one running. "Send work ⇥"
//                opens it as a popup, which closes once the agent starts; "in a pane" as a pane that stays open,
//                follows the fleet live and clears for the next task (adapters/herdr/send.ts)
//
// Reads ~/.local/state/pace/feeds/ and ~/.local/state/ql/feeds/ as they change, a timer as fallback, and Herdr's
// agents live. The model is worked out when either changes, never in render: Herdr interrupts a call past its budget.

import { View, div } from 'gpui-kit'
import { h_flex, Input, InputState, v_flex } from 'gpui-base'
import { agents, closeOverlay, exec, home, openOverlay, panes, props, readTextFile, run, setShared, settings, shared, terminals, theme, watchFolder } from 'herdr'

import { barOf, colsFor, colWidth, PAD, PAD_Y, styleOf, type Bar } from '../draw.ts'
import { HerdrLog, todaysLog } from '../log.ts'
import { claimOf } from '../open.ts'
import { afterStart, openSendPane, SEND_PANES_KEY, sendForm, type SendHost } from '../send.ts'
import { SEED } from './seed.ts'
import { byProvider, byRepo, byUrgency, fleetModel, groupLines, memberLine, PROVIDER_NAME, QL_FEEDS_DIR, qlFeedOf, recommendLine, type FleetGroup, type FleetModel, type HerdrAgent, type QlSession } from '../../../core/fleet.ts'
import { FEEDS_DIR, feedOf, type PaceFeed, type PaceProvider } from '../../../core/host.ts'
import type { Line } from '../../../core/view.ts'

const SIZE = 12
const LINE = 15
const REFRESH_MS = 30_000
/** How long a failed watch of today's log waits before it watches again */
const WATCH_RETRY_MS = 5_000

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
  /** Send work's state, when this copy is Send work: the host and folder picked (none: the form's first), the task */
  send: { host: SendHost | null; folder: string | null; input: any; confirming: boolean; started: string } | null = null
  /** The log, read on as it grows */
  log = new HerdrLog()
  /** The pane this copy of Send work claimed in the registry; null in a popup, or until it could tell which */
  pane: string | null = null

  init(_props: unknown, cx: any): void {
    if (SEED) {
      // A check's build: the model and its drawing on the seed's feeds, at once, and no files
      this.pace = [...SEED.pace]
      this.work(Date.now(), [])
      return
    }
    const p = props() ?? {}
    if (p.view === 'send') {
      this.send = { host: null, folder: null, input: InputState.new({ value: '' }), confirming: false, started: '' }
      this.send.input.on('change', (_e: any, cx: any) => { if (this.send) this.send.started = ''; cx.notify() })
      this.send.input.focus()
      cx.timer.after(600, () => this.send?.input.focus())
      // A popup keeps what it was opened with; a pane follows the fleet, as the panel does
      if (p.overlay) return
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
    // Today's log too: a slim feed may not change when a prompt or a reading is logged. The folder is worked out again
    // after each change, so a new day's is watched once it begins
    cx.spawn(async (cx: any) => {
      for (;;) {
        const dir = todaysLog(home(), Date.now())
        try {
          await exec('mkdir', ['-p', dir]).catch(() => null)
          await watchFolder(dir)
          this.reload(cx)
        } catch {
          await cx.sleep(WATCH_RETRY_MS)
        }
      }
    })
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
      // Feeds are written slim: their quotas' history is in the log (core/log.ts)
      this.pace = await this.log.hydrate([...pace.values()], home(), Date.now())
      this.ql = [...ql.values()]
      this.work(Date.now(), herdrAgents())
      // Claiming the pane is a nicety: it never stands between the feeds and their drawing
      try {
        this.claim()
      } catch {}
      cx.notify()
    })
  }

  /** Records this Send work pane, once it can tell which fleet pane is its own, so "in a pane" focuses it */
  claim(): void {
    if (this.pane || !this.send) return
    const fleetPanes = panes().filter((p: { mod?: string }) => p.mod === 'fleet').map((p: { pane: string }) => p.pane)
    const known = (shared(SEND_PANES_KEY) ?? {}) as Record<string, string>
    const registry = claimOf(known, fleetPanes, 'send')
    if (!registry) return
    this.pane = fleetPanes.find((p: string) => !(p in known)) ?? null
    setShared(SEND_PANES_KEY, registry)
  }

  /** Its pane gone, this copy leaves the registry */
  async close(_cx: any): Promise<void> {
    if (!this.pane) return
    const { [this.pane]: _gone, ...rest } = (shared(SEND_PANES_KEY) ?? {}) as Record<string, string>
    setShared(SEND_PANES_KEY, rest)
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

  /** Opens Send work as a popup: the recommended host first, the folders the agents work in to pick from */
  openSend(): void {
    const { folders, recommended } = sendForm({}, this.model, home())
    openOverlay({ mod: 'fleet', kind: 'dialog', width: 560, height: 380, props: { view: 'send', host: recommended, folders } })
  }

  /** Shows Send work as a pane that stays open: the one already open focused, else a new one beside */
  openSendPane(): void {
    const [command, args] = openSendPane(shared(SEND_PANES_KEY), panes().map((p: { pane: string }) => p.pane))
    run(command, args)
  }

  panel(t: Record<string, string>): any[] {
    return [
      h_flex().id('tabs').gap(4).pb(6).items_center().children([
        ...TABS.map(({ tab, label }) => button(`tab-${tab}`, label, t, () => { this.tab = tab; this.work(Date.now(), herdrAgents()) }, tab === this.tab)),
        div().flex_1(),
        button('send', 'Send work ⇥', t, () => this.openSend()),
        button('send-pane', 'in a pane', t, () => this.openSendPane()),
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

  /**
   * Send work: host, folder, task; Start asks once more, Confirm starts the agent in a new tab. A popup then closes;
   * a pane clears for the next task, and until a host or folder is picked follows the fleet's
   */
  dialog(t: Record<string, string>): any {
    const s = this.send!
    const p = props() ?? {}
    const form = sendForm(p, this.model, home())
    const host = s.host ?? form.recommended
    const folder = s.folder && form.folders.includes(s.folder) ? s.folder : form.folders[0]!
    const short = (f: string) => f.replace(home(), '~')
    const task = String(s.input.value() ?? '').trim()
    const label = (text: string) => div().pt(12).pb(5).text_size(11.5).text_color(t.dim).child(text)
    const pick = (key: string, text: string, on: boolean, act: () => void) => button(key, text, t, act, on)
    const start = () => {
      run('tab.new', { name: task.slice(0, 32), folder, argv: ARGV[host], task })
      if (afterStart(form.where) === 'close') return closeOverlay(p.overlay)
      Object.assign(s, { host: null, folder: null, confirming: false, started: `Started ${ARGV[host].join(' ')} in ${short(folder)}` })
      s.input.set_value('')
      s.input.focus()
    }
    const clear = () => form.where === 'overlay' ? closeOverlay(p.overlay) : (s.input.set_value(''), Object.assign(s, { host: null, folder: null, confirming: false }))
    const note = s.confirming ? `Start ${ARGV[host].join(' ')} in ${short(folder)} with this task?` : s.started
    return v_flex().id('send').size_full().p(18).bg(form.where === 'overlay' ? t.popover : t.surface).text_color(t.foreground).text_size(12.5)
      .child(h_flex().items_center().child(div().flex_1().text_size(15).font_semibold().child('Send work')).child(div().text_size(11).text_color(t.dim).child(form.where === 'overlay' ? 'Esc' : '')))
      .child(label('Host'))
      .child(h_flex().gap(4).children((['claude', 'codex'] as const).map(h =>
        pick(`host-${h}`, `${PROVIDER_NAME[h]}${h === form.recommended ? ' · recommended' : ''}`, host === h, () => { s.host = h; s.confirming = false }))))
      .child(label('Folder'))
      .child(h_flex().flex_wrap().gap(4).children(form.folders.map((f, i) => pick(`folder-${i}`, short(f), folder === f, () => { s.folder = f; s.confirming = false }))))
      .child(label('Task'))
      .child(Input.new(s.input).h(36).px(10).rounded(8).border_1().border_color(t.input).bg(t.background))
      .child(div().pt(10).text_color(t.dim).child(note))
      .child(h_flex().pt(10).gap(8).justify_end().children(s.confirming
        ? [pick('back', 'Back', false, () => { s.confirming = false }), pick('confirm', 'Confirm', true, start)]
        : [pick('cancel', form.where === 'overlay' ? 'Cancel' : 'Clear', false, clear), pick('start', 'Start…', !!task, () => { if (task) s.confirming = true })]))
  }

  render(cx: any): any {
    const t = theme()
    const live = herdrAgents()
    if (signature(live) !== this.seen) cx.spawn(async (cx: any) => { this.work(Date.now(), herdrAgents()); cx.notify() })
    if (this.send) return this.dialog(t)
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
