// pace in Herdr. One mod, three views, by the props a copy is given (see `viewOf`):
//
//   the panel   the fleet (every harness's quotas and pace, the one with the most room first, the agents on each)
//               and each live agent's band; buttons open the other two views as panes
//   a band      `{ view: 'band', terminal }`: one agent's band, as Claude Code draws it above the prompt
//   a pace pane `{ view: 'pane', provider }`: a harness's charts and rates, as Claude Code's /pace pane draws them,
//               fed by every live session of that harness together
//
// Reads the feeds in ~/.local/state/pace/feeds/ as they change, a timer as fallback. Built to plain JS by
// scripts/herdr.ts; mods import only from their own folder. The drawing is view.ts's, segment by segment; this file
// only turns segments into elements and acts on clicks.
//
// Herdr interrupts any call into the mod that runs past its budget (under a second), and keeps showing what it
// last drew. So the drawing is worked out in steps (`steps`): the fleet, one agent's band, a harness's charts, each a
// call of its own, with a return to Herdr between them; never in render. `node scripts/herdr.ts check` runs every
// step on feeds the size real use makes, so a step that grows past the budget fails the check.

import { View, div } from 'gpui-kit'
import { h_flex, v_flex } from 'gpui-base'
import { agents, exec, home, panes, props, readTextFile, run, setShared, settings, shared, theme, watchFolder } from 'herdr'

import { colsFor, PAD, PAD_Y, rowsFor, styleOf, viewOf } from './draw.ts'
import { claimOf, PANES_KEY, viewKey, type HerdrView } from './open.ts'
import { SEED } from './seed.ts'
import { agentOf, FEED_STALE, FEEDS_DIR, feedFor, feedOf, fleetOf, type FleetRow, type PaceFeed, type PaceProvider } from '../../core/host.ts'
import { agentLine, bandLines, fittedLayout, fleetLines, paneLines, type Line } from '../../core/view.ts'

/** Text size, and a row's height: tight, as a terminal's, so a chart's braille rows meet; px */
const SIZE = 12
const LINE = 15
/** How often a copy rereads the feeds without a change seen, and moves its clocks */
const REFRESH_MS = 30_000

const PROVIDER_NAME: Record<PaceProvider, string> = { claude: 'Claude', codex: 'Codex' }

const feedsDir = () => `${home()}/${FEEDS_DIR}`

function lineOf(line: Line, t: Record<string, string>, key: string): any {
  return h_flex().id(key).children(line.map((seg, i) => {
    const s = styleOf(seg, t)
    let el = div().id(`${key}-${i}`).text_color(s.color).child(seg.t)
    if (s.bold) el = el.font_bold()
    if (s.pulse) el = el.loop('opacity', { from: 0.4, to: 1, period: 1200 })
    return el
  }))
}

function heading(text: string, t: Record<string, string>): any {
  return div().pt(8).pb(2).text_color(t.muted).font_semibold().child(text)
}

function button(key: string, label: string, t: Record<string, string>, onClick: () => void): any {
  return div().id(key).px(6).rounded(4).text_color(t.muted).hover((s: any) => s.bg(t.hover)).child(label).on_click(onClick)
}

/**
 * Opens a view of this mod as a pane, below `terminal`'s pane when given one, else beside the focused pane; a pane
 * already showing it is focused instead
 */
function openPane(view: HerdrView, terminal?: string): void {
  const open = Object.entries((shared(PANES_KEY) ?? {}) as Record<string, string>).find(([, k]) => k === viewKey(view))
  if (open && panes().some((p: { pane: string }) => p.pane === open[0])) {
    run('pane.focus', { pane: open[0] })
    return
  }
  const pane = terminal ? agents().find((a: { address: string }) => a.address === terminal)?.pane : undefined
  run('pane.split', { direction: terminal ? 'down' : 'right', ...(pane ? { pane } : {}), mod: 'pace', props: view })
}

/** One live agent as drawn: its feed, its line and its band */
type Drawn = { feed: PaceFeed; head: Line; band: Line[] }

/** A failure to draw, said where the drawing would be */
const notDrawn = (error: unknown): Line[] => [[{ t: `not drawn: ${String(error)}`, color: 'error' }]]

export default class Pace extends View {
  view: HerdrView = { view: 'panel' }
  feeds: PaceFeed[] = []
  cols = 60
  rows = 40
  /** The pane this copy claimed in the registry of pace panes; null until it could tell which is its own */
  pane: string | null = null
  /** What render shows: the view's lines, worked out by `draw` */
  lines: Line[] = []
  agents: Drawn[] = []
  providers: PaceProvider[] = []

  init(_props: unknown, cx: any): void {
    if (SEED) {
      // A check's build: one step on the seed's feeds, at once, and no files
      Object.assign(this, { view: SEED.view, cols: SEED.cols, rows: SEED.rows, feeds: [...SEED.feeds] })
      const step = this.steps(Date.now())[SEED.step]
      if (!step) throw new Error(`pace load check: no step ${SEED.step} in this view`)
      step()
      return
    }
    this.view = viewOf(props())
    this.reload(cx)
    cx.timer.every(REFRESH_MS, (cx: any) => this.reload(cx))
    cx.spawn(async (cx: any) => {
      await exec('mkdir', ['-p', feedsDir()]).catch(() => null)
      for (;;) {
        try {
          await watchFolder(feedsDir())
        } catch {
          return
        }
        this.reload(cx)
      }
    })
  }

  /** Reads every feed that parses, a file mid-write or malformed keeping the feed last read from it, and draws them */
  reload(cx: any): void {
    cx.spawn(async (cx: any) => {
      const listed = await exec('ls', [feedsDir()]).catch(() => null)
      const names = (listed?.code === 0 ? listed.stdout.split('\n') : []).filter((n: string) => n.endsWith('.json'))
      const read = await Promise.all(names.map(async (name: string) => feedOf((await readTextFile(`${feedsDir()}/${name}`).catch(() => null)) ?? '')))
      const kept = new Map(this.feeds.map(f => [`${f.host}-${f.session}`, f]))
      for (const f of read) if (f) kept.set(`${f.host}-${f.session}`, f)
      this.feeds = [...kept.values()]
      this.claim()
      await this.draw(cx)
    })
  }

  /** Records this copy's pane under its view, once it can tell which pace pane is its own, so /pace reuses it */
  claim(): void {
    // Only a copy opened as a pane says its view in its props; one docked in a layout has no pane to claim
    if (this.pane || !(props() as { view?: unknown } | null)?.view) return
    const pacePanes = panes().filter((p: { mod?: string }) => p.mod === 'pace').map((p: { pane: string }) => p.pane)
    const known = (shared(PANES_KEY) ?? {}) as Record<string, string>
    const registry = claimOf(known, pacePanes, viewKey(this.view))
    if (!registry) return
    this.pane = pacePanes.find((p: string) => !(p in known)) ?? null
    setShared(PANES_KEY, registry)
  }

  /** Its pane gone, this copy leaves the registry */
  async close(_cx: any): Promise<void> {
    if (!this.pane) return
    const { [this.pane]: _gone, ...rest } = (shared(PANES_KEY) ?? {}) as Record<string, string>
    setShared(PANES_KEY, rest)
  }

  /** Works out what the view shows, a step a call, Herdr drawing what is done after each; a step that fails says so */
  async draw(cx: any): Promise<void> {
    const now = Date.now()
    for (const step of this.steps(now)) {
      step()
      cx.notify()
      await cx.sleep(0)
    }
  }

  /**
   * The view's drawing as steps, each small enough for one call: for a band, the band; for a harness's pane, its
   * charts; for the panel, the fleet and then each agent's band. A step that throws draws why in its place.
   */
  steps(now: number): (() => void)[] {
    const live = this.feeds.filter(f => f.at >= now - FEED_STALE)
    const v = this.view
    const guard = (draw: () => void, failed: (lines: Line[]) => void) => () => {
      try {
        draw()
      } catch (error) {
        failed(notDrawn(error))
      }
    }
    const toLines = (lines: Line[]) => { this.lines = lines }
    if (v.view === 'band') {
      return [guard(() => {
        const feed = feedFor(live, now, v.terminal)
        this.lines = feed
          ? [agentLine(agentOf(feed), now), ...bandLines(feed.snapshot, now, this.cols)]
          : [[{ t: `waiting for ${v.terminal}: no live feed from it yet`, dim: true }]]
      }, toLines)]
    }
    if (v.view === 'pane') return [guard(() => { this.lines = this.chartLines(fleetOf(live, now), v.provider, now) }, toLines)]
    const agents = [...live].sort((a, b) => b.at - a.at)
    this.agents = agents.map(feed => ({ feed, head: agentLine(agentOf(feed), now), band: [] }))
    return [
      guard(() => {
        const fleet = fleetOf(live, now)
        this.providers = fleet.map(r => r.provider)
        this.lines = fleetLines(fleet, now, this.cols)
      }, toLines),
      ...agents.map((feed, i) => guard(
        () => { this.agents[i]!.band = bandLines(feed.snapshot, now, this.cols) },
        lines => { this.agents[i]!.band = lines },
      )),
    ]
  }

  /** A harness's pane: its name and sessions, then its charts grown to fill the pane's rows */
  chartLines(fleet: readonly FleetRow[], provider: PaceProvider, now: number): Line[] {
    const row = fleet.find(r => r.provider === provider)
    const sessions = row?.agents.length ?? 0
    const title: Line = [
      { t: PROVIDER_NAME[provider], bold: true },
      { t: ` · ${sessions} session${sessions === 1 ? '' : 's'}${row ? '' : ': none live yet'}`, dim: true },
    ]
    if (!row) return [title]
    return [title, [], ...paneLines(row.snapshot, now, fittedLayout(row.snapshot, now, this.cols, this.rows - 2))]
  }

  agentBlock({ feed, head, band }: Drawn, t: Record<string, string>): any {
    const key = `agent-${feed.host}-${feed.session}`
    const terminal = feed.terminal
    const top = h_flex().id(`${key}-head`).justify_between()
      .child(lineOf(head, t, `${key}-line`))
      .when(!!terminal, (el: any) => el
        .child(button(`${key}-band`, 'band ⇥', t, () => openPane({ view: 'band', terminal: terminal! }, terminal)))
        .hover((s: any) => s.bg(t.hover))
        .on_click(() => run('agent.focus', { terminal })))
    return v_flex().id(key).pt(6).children([top, ...band.map((l, i) => lineOf(l, t, `${key}-${i}`))])
  }

  /** The panel's children: the charts' buttons, the fleet, then each agent */
  panel(t: Record<string, string>): any[] {
    const charts = this.providers.map(p => button(`charts-${p}`, `${PROVIDER_NAME[p]} charts ⇥`, t, () => openPane({ view: 'pane', provider: p })))
    return [
      h_flex().id('fleet-head').justify_between().children([heading('Fleet', t), h_flex().id('charts').gap(4).children(charts)]),
      ...this.lines.map((l, i) => lineOf(l, t, `fleet-${i}`)),
      ...(this.agents.length ? [heading('Agents', t)] : []),
      ...this.agents.map(a => this.agentBlock(a, t)),
    ]
  }

  render(_cx: any): any {
    const t = theme()
    const body = this.view.view === 'panel' ? this.panel(t) : this.lines.map((l, i) => lineOf(l, t, `line-${i}`))
    return v_flex().id('root').size_full().bg(t.surface).px(PAD).py(PAD_Y).text_size(SIZE).line_height(`${LINE}px`).text_color(t.foreground)
      .font_family(String(settings().font_family ?? 'JetBrains Mono'))
      .overflow_y_scrollbar()
      .on_size_change((size: { width: number; height: number }, cx: any) => {
        const cols = colsFor(size.width, SIZE)
        const rows = rowsFor(size.height, LINE)
        if (cols === this.cols && rows === this.rows) return
        this.cols = cols
        this.rows = rows
        cx.spawn((cx: any) => this.draw(cx))
      })
      .children(body)
  }
}
