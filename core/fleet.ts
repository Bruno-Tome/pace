// The fleet across hosts: every agent Herdr runs, joined by terminal to what pace and ql report of it, and every
// provider's quotas, so work goes where there is room for it. Pure; times in ms.
//
// Herdr says which agents are live and what each is doing; pace's feeds say each provider's quotas and an agent's
// context; ql's feeds say its repo, how long it has held its state and the files it touched. A feed from outside
// Herdr (no terminal) is an agent too. ql's feed is read here by its shape, not imported: pace and ql share no code.

import { repoOf } from './dims.ts'
import { FEED_STALE, fleetOf, type FleetRow, type PaceFeed, type PaceProvider, PROVIDER_NAME } from './host.ts'
import { FIVE_HOURS, formatDuration } from './quota.ts'
import { providerLines, STATUS_LOOK, type AgentStatus, type Line, type Seg } from './view.ts'

/** What the fleet reads of a Herdr agent: `agents()` joined with its pane's folder and branch and its ctx label */
export type HerdrAgent = { address: string; status: string; app: string | null; title: string; cwd: string | null; branch: string | null; ctx: number | null }

/** What the fleet reads of a ql feed (`~/.local/state/ql/feeds/<host>-<session>.json`) */
export type QlSession = {
  host: string
  session: string
  terminal?: string
  cwd: string
  at: number
  /** `working`, `blocked`, `done`, or '' before the first turn */
  state: string
  since: number
  repo: string
  tree: string
  edited: number
  read: number
}

/** ql's folder of feeds, relative to the home directory */
export const QL_FEEDS_DIR = '.local/state/ql/feeds'

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v != null && !Array.isArray(v)

/** A ql feed as read from its file's JSON; null when it is not one */
export function qlFeedOf(v: unknown): QlSession | null {
  if (!isObject(v) || v.version !== 1) return null
  const { host, session, terminal, cwd, at, state: s } = v
  if (typeof host !== 'string' || typeof session !== 'string' || typeof cwd !== 'string' || typeof at !== 'number') return null
  if (!isObject(s) || typeof s.state !== 'string' || typeof s.since !== 'number' || typeof s.repo !== 'string' || typeof s.tree !== 'string') return null
  const files = isObject(s.files) ? Object.values(s.files).filter(isObject) : []
  const edited = files.filter(f => typeof f.edits === 'number' && f.edits > 0).length
  return {
    host, session, ...(typeof terminal === 'string' ? { terminal } : {}), cwd, at,
    state: s.state, since: s.since, repo: s.repo, tree: s.tree, edited, read: files.length - edited,
  }
}

/** One agent: who runs it, on whose quotas, what it is doing since when, where, and how full its context is */
export type FleetMember = {
  /** Its terminal, or `<host>-<session>` for one outside Herdr */
  key: string
  /** Herdr's terminal; null outside Herdr */
  address: string | null
  host: string
  /** Whose quotas it draws on; null for a host pace does not read */
  provider: PaceProvider | null
  /** Its pace session, when it has a feed: which quota's row it is on */
  session?: string
  title: string
  state: AgentStatus
  /** Since when it has held its state, where ql says */
  since: number | null
  cwd: string
  repo: string
  branch: string | null
  /** Percent of its context window used; null where nothing says */
  context: number | null
  edited: number
  read: number
  /** Its provider's readings no longer hold */
  stale: boolean
}

/** A quota as the fleet compares it: percent used, its pace, its reset */
export type QuotaBrief = { percent: number; status: string | null; resetsAt: number | null }

/** One provider: its 5-hour and weekly use, the room the tighter leaves, its agents (by key) and how many work */
export type FleetProvider = {
  provider: PaceProvider
  fiveHour: QuotaBrief | null
  week: QuotaBrief | null
  /** Percent left in the tighter of the two */
  left: number
  tightest: '5 hours' | 'week'
  agents: string[]
  working: number
  /** Its readings no longer hold: shown, never recommended */
  stale: boolean
  /** What pace's drawing reads: its quotas with their pace and rates */
  row: FleetRow
}

export type FleetModel = {
  agents: FleetMember[]
  /** The one with the most room first; stale ones last */
  providers: FleetProvider[]
  /** Where the next piece of work goes, and why in one line; null with no provider live */
  recommended: { provider: PaceProvider; why: string } | null
}

export { PROVIDER_NAME }

const ROOM = ['push', 'cruise', 'ease', 'hold']
const STATUSES: readonly AgentStatus[] = ['working', 'blocked', 'done', 'idle']

/** The host an agent's report names: Herdr's `app` */
const hostOf = (app: string | null): string => (app === 'claude-code' || app === 'claude' ? 'claude' : app ?? 'agent')
const providerOf = (host: string): PaceProvider | null => (host === 'claude' || host === 'codex' || host === 'antigravity' ? host : null)
const stateOf = (s: string): AgentStatus => (STATUSES.includes(s as AgentStatus) ? (s as AgentStatus) : 'idle')
const newest = <T extends { at: number }>(list: readonly T[]): T | undefined => list.reduce<T | undefined>((a, b) => (a && a.at >= b.at ? a : b), undefined)

function memberOf(key: string, address: string | null, host: string, a: HerdrAgent | null, p: PaceFeed | undefined, q: QlSession | undefined): FleetMember {
  const cwd = a?.cwd ?? q?.cwd ?? p?.cwd ?? ''
  const context = p?.context ? Math.round((p.context.tokens / p.context.window) * 100) : a?.ctx ?? null
  return {
    // A feed names the quota its session spends: pi's is Codex's or Claude's, by its sign-in
    key, address, host, provider: p?.provider ?? providerOf(host), ...(p ? { session: p.session } : {}), title: a?.title ?? host,
    state: stateOf(a?.status ?? q?.state ?? ''), since: q?.since ?? null,
    cwd, repo: q?.repo || repoOf(cwd), branch: a?.branch ?? null, context,
    edited: q?.edited ?? 0, read: q?.read ?? 0, stale: false,
  }
}

function brief(row: FleetRow, key: string): QuotaBrief | null {
  const q = row.quotas.find(q => q.key === key)
  return q && q.percent != null ? { percent: q.percent, status: q.status, resetsAt: q.resetsAt } : null
}

/** A provider whose newest reading is older than the 5-hour window can't say what that window holds now: stale */
function providerRow(row: FleetRow, members: readonly FleetMember[], now: number, first: boolean): FleetProvider {
  const fiveHour = brief(row, 'five_hour')
  const week = brief(row, 'seven_day')
  const fiveLeft = fiveHour ? 100 - fiveHour.percent : 100
  const weekLeft = week ? 100 - week.percent : 100
  // On the row of the quota its feed spends; an agent with no feed on its provider's first row
  const on = members.filter(m => m.provider === row.provider && (m.session ? row.agents.some(a => a.session === m.session) : first))
  return {
    provider: row.provider, fiveHour, week,
    left: Math.max(0, Math.round(Math.min(fiveLeft, weekLeft))), tightest: weekLeft < fiveLeft ? 'week' : '5 hours',
    agents: on.map(m => m.key), working: on.filter(m => m.state === 'working').length,
    stale: now - (row.snapshot.samples[row.snapshot.samples.length - 1]?.at ?? 0) > FIVE_HOURS * 1000,
    row,
  }
}

/** Better first: live before stale, more room, more left, fewer agents working */
const rank = (a: FleetProvider, b: FleetProvider) =>
  Number(a.stale) - Number(b.stale) || ROOM.indexOf(a.row.headroom) - ROOM.indexOf(b.row.headroom) || b.left - a.left || a.working - b.working

/** The fleet: every agent, every provider, and where the next piece of work goes */
export function fleetModel(input: { pace: readonly PaceFeed[]; ql: readonly QlSession[]; agents: readonly HerdrAgent[]; now: number }): FleetModel {
  const { now } = input
  const pace = input.pace.filter(f => f.at >= now - FEED_STALE)
  const ql = input.ql.filter(f => f.at >= now - FEED_STALE)
  const inHerdr = input.agents.map(a => memberOf(
    a.address, a.address, hostOf(a.app), a, newest(pace.filter(f => f.terminal === a.address)), newest(ql.filter(f => f.terminal === a.address)),
  ))
  // Outside Herdr: a live feed with no terminal, pace's and ql's of one session together
  const outside = new Map<string, { host: string; p?: PaceFeed; q?: QlSession; at: number }>()
  for (const p of pace.filter(f => f.terminal == null)) outside.set(`${p.host}-${p.session}`, { host: p.host, p, at: p.at })
  for (const q of ql.filter(f => f.terminal == null)) {
    const key = `${q.host}-${q.session}`
    const was = outside.get(key)
    outside.set(key, { host: q.host, ...was, q, at: Math.max(was?.at ?? 0, q.at) })
  }
  const elsewhere = [...outside].sort(([, a], [, b]) => b.at - a.at).map(([key, o]) => memberOf(key, null, o.host, null, o.p, o.q))
  const members = [...inHerdr, ...elsewhere]
  const rows = fleetOf(pace, now)
  const providers = rows.map(row => providerRow(row, members, now, rows.find(r => r.provider === row.provider) === row)).sort(rank)
  const stale = new Set(providers.filter(p => p.stale).map(p => p.provider))
  const best = providers.find(p => !p.stale)
  return {
    agents: members.map(m => (m.provider && stale.has(m.provider) ? { ...m, stale: true } : m)),
    providers,
    recommended: best ? { provider: best.provider, why: whyOf(best) } : null,
  }
}

const whyOf = (p: FleetProvider) =>
  `${p.row.name}: ${p.left}% of the ${p.tightest} left, ${p.working} agent${p.working === 1 ? '' : 's'} working`

/** A view's group of agents: its title, its agents, the provider it stands for, and whether two share one tree */
export type FleetGroup = { title: string; agents: FleetMember[]; provider?: FleetProvider; clash?: boolean }

/** By provider: each provider, the most room first, with its agents; then the agents on no provider pace reads */
export function byProvider(m: FleetModel): FleetGroup[] {
  const known = new Set(m.providers.map(p => p.provider))
  const rest = m.agents.filter(a => !a.provider || !known.has(a.provider))
  return [
    ...m.providers.map(p => ({ title: p.row.name, agents: m.agents.filter(a => p.agents.includes(a.key)), provider: p })),
    ...(rest.length ? [{ title: 'No quotas', agents: rest }] : []),
  ]
}

/** By repo: the agents on each repo and branch, in the order first seen; two on one tree is a clash */
export function byRepo(m: FleetModel): FleetGroup[] {
  const groups = new Map<string, FleetMember[]>()
  for (const a of m.agents) {
    const title = a.branch ? `${a.repo} · ${a.branch}` : a.repo
    groups.set(title, [...(groups.get(title) ?? []), a])
  }
  return [...groups].map(([title, agents]) => ({ title, agents, clash: agents.length > 1 }))
}

/** A context this full is close to a compaction */
export const CONTEXT_FULL = 80

/** By urgency: blocked, then a context nearly full, then done, then working, then idle; empty groups left out */
export function byUrgency(m: FleetModel): FleetGroup[] {
  const full = (a: FleetMember) => a.state !== 'blocked' && (a.context ?? 0) >= CONTEXT_FULL
  const groups: FleetGroup[] = [
    { title: 'Blocked', agents: m.agents.filter(a => a.state === 'blocked') },
    { title: `Context ≥ ${CONTEXT_FULL}%`, agents: m.agents.filter(full) },
    ...(['done', 'working', 'idle'] as const).map(s => ({
      title: s[0]!.toUpperCase() + s.slice(1), agents: m.agents.filter(a => a.state === s && !full(a)),
    })),
  ]
  return groups.filter(g => g.agents.length)
}

// ----------------------------------------------------------------------
// The drawing: view.ts's segments, as pace's band and fleet draw them
// ----------------------------------------------------------------------

const DOT: Seg = { t: ' · ', dim: true }

/** An agent in one line: its state in its color and how long it has held it, its host, repo, branch, context, files */
export function memberLine(a: FleetMember, now: number): Line {
  const look = STATUS_LOOK[a.state]
  const held = a.since != null && now - a.since >= 1000 ? formatDuration((now - a.since) / 1000).split(' ')[0] : ''
  const out: Line = [{ t: '● ', ...look }, { t: a.state, ...look }, ...(held ? [{ t: ` ${held}`, dim: true }] : []), { t: '  ' }, { t: a.host, bold: true }, DOT, { t: a.repo }]
  if (a.branch) out.push(DOT, { t: a.branch, dim: true })
  if (a.context != null) out.push(DOT, { t: `ctx ${a.context}%`, ...(a.context >= CONTEXT_FULL ? { color: 'warning' } : { dim: true }) })
  if (a.edited || a.read) out.push(DOT, { t: `${a.edited} edited, ${a.read} read`, dim: true })
  if (a.stale) out.push(DOT, { t: 'stale', dim: true })
  return out
}

/** Where the next piece of work goes, or why nothing is recommended */
export function recommendLine(m: FleetModel): Line {
  if (!m.recommended) return [{ t: 'No provider has a live reading yet', dim: true }]
  return [{ t: 'Send work to ', dim: true }, { t: m.recommended.why, color: 'success' }]
}

/** A group as drawn: a provider's quotas as pace draws them, else the group's title; then its agents, a line each */
export function groupLines(g: FleetGroup, now: number, cols: number): Line[] {
  const n = g.agents.length
  const head: Line[] = g.provider
    ? providerLines(g.provider.row, now, cols)
    : [[{ t: g.title, bold: true }, ...(g.clash ? [DOT, { t: `${n} agents on one tree`, color: 'warning' }] : [])]]
  if (g.provider?.stale) head[0] = [...head[0]!, DOT, { t: 'stale: no reading in 5 hours', dim: true }]
  return [...head, ...(n ? g.agents.map(a => [{ t: '  ' }, ...memberLine(a, now)]) : [[{ t: '  no agents', dim: true }]])]
}
