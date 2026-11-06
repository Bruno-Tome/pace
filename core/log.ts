// The history of every quota, as an append-only log (.agents/decisions/0024-append-only-log.md): a file a day for each
// session, holding only the events that session saw itself, a JSON line each. Feeds carry live state only; a reader
// hydrates them from the log. Pure; the hosts read and append the files.
//
//   {"q":"codex","a":"1233abcd5678ef90","s":"<session>"}   the header: the quota and the session of the lines after it
//   {"at":1793990000000,"p":1,"m":"gpt-5"}                 a prompt, and its model when known
//   {"at":1793990000000,"r":{"five_hour":{...}}}            a reading the host was told
//   {"at":1793990000000,"usd":0.25,"m":"gpt-5"}            what a reply cost

import type { PaceSample, PaceSpend } from '../types'
import { FEED_STALE, type PaceFeed, type PaceHost, type PaceProvider } from './host.ts'
import type { Metered } from './meter.ts'
import type { Snapshot } from './model.ts'
import { mergeSamples } from './quota.ts'
import { mergeModelPrompts, mergePrompts } from './rate.ts'
import { mergeCopies, mergeSpend, unionMax } from './spend.ts'

export const LOG_DIR = '.local/state/pace/log'

const DAY = 24 * 3600_000
/** Days of folders read: the spend kept (eight days) back from any hour of today */
const DAYS = 9

/** The quota and session a log's lines are on */
export type LogHead = { provider: PaceProvider; account?: string; session: string }
/** One event a session saw: a prompt, a reading, or what a reply cost */
export type LogEvent =
  | { at: number; prompt: true; model?: string }
  | { at: number; quotas: PaceSample['quotas'] }
  | { at: number; usd: number; model?: string }
/** An event as read back, with the header it was under */
export type LogEntry = LogHead & { event: LogEvent }

/** A day's folder name, by UTC */
export const logDay = (now: number) => new Date(now).toISOString().slice(0, 10)

/** A session's log for the day of `now`, under the home */
export const logFile = (host: PaceHost, session: string, now: number) =>
  `${LOG_DIR}/${logDay(now)}/${host}-${session.replace(/[^A-Za-z0-9_-]/g, '_')}.jsonl`

/** The day folders a reader reads, oldest first, today's last */
export const logDays = (now: number): string[] => Array.from({ length: DAYS }, (_, i) => logDay(now - (DAYS - 1 - i) * DAY))

/** The day folders past keeping, of the names in the log folder */
export function expiredDays(names: readonly string[], now: number): string[] {
  const first = logDays(now)[0]!
  return names.filter(n => /^\d{4}-\d{2}-\d{2}$/.test(n) && n < first)
}

const estimated = (s: PaceSample) => Object.values(s.quotas).some(r => r.estimated)

/** The events a host metered: the prompt, the readings it was told (never an estimate), what the reply cost */
export function eventsOf(e: Metered): LogEvent[] {
  return [
    ...(e.prompted ? [{ at: e.now, prompt: true as const }] : []),
    ...(e.samples ?? []).filter(s => !estimated(s)).map(s => ({ at: s.at, quotas: s.quotas })),
    ...(e.spent && e.spent > 0 ? [{ at: e.now, usd: e.spent }] : []),
  ]
}

/** A header as written: the quota and the session of the lines after it */
export const headLine = (h: LogHead) => JSON.stringify({ q: h.provider, ...(h.account ? { a: h.account } : {}), s: h.session })

function lineOf(e: LogEvent): string {
  if ('prompt' in e) return JSON.stringify({ at: e.at, p: 1, ...(e.model ? { m: e.model } : {}) })
  if ('usd' in e) return JSON.stringify({ at: e.at, usd: e.usd, ...(e.model ? { m: e.model } : {}) })
  return JSON.stringify({ at: e.at, r: e.quotas })
}

/**
 * The text to append for `events` under `head`: the header first when the file has none yet or was on another
 * quota (`written`, the header last written to it), then a line an event. With the header now in force
 */
export function logText(head: LogHead, events: readonly LogEvent[], written: string | null): { text: string; head: string } {
  const line = headLine(head)
  const lines = [...(line === written ? [] : [line]), ...events.map(lineOf)]
  return { text: events.length ? lines.map(l => `${l}\n`).join('') : '', head: events.length ? line : (written ?? '') }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v != null && !Array.isArray(v)
const isTime = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0
const PROVIDERS: readonly string[] = ['claude', 'codex', 'antigravity']

/** A line's event; null for a header, a line cut short, or anything else */
function eventOf(v: Record<string, unknown>): LogEvent | null {
  if (!isTime(v.at)) return null
  const model = typeof v.m === 'string' && v.m ? { model: v.m } : {}
  if (v.p === 1) return { at: v.at, prompt: true, ...model }
  if (typeof v.usd === 'number' && Number.isFinite(v.usd) && v.usd >= 0) return { at: v.at, usd: v.usd, ...model }
  if (isObject(v.r)) return { at: v.at, quotas: v.r as PaceSample['quotas'] }
  return null
}

/** A log's events as read back, each under its header; a line that does not parse, or comes before any header, dropped */
export const entriesOf = (text: string): LogEntry[] => parseLog(text, null).entries

/**
 * Lines of a log read on from where a reader left it, under `head`, the header in force there: their events, and
 * the header in force after them, to read on from next
 */
export function parseLog(text: string, from: LogHead | null): { entries: LogEntry[]; head: LogHead | null } {
  const out: LogEntry[] = []
  let head = from
  for (const line of text.split('\n')) {
    if (!line) continue
    let v: unknown
    try {
      v = JSON.parse(line)
    } catch {
      continue
    }
    if (!isObject(v)) continue
    if (typeof v.q === 'string' && typeof v.s === 'string') {
      head = PROVIDERS.includes(v.q) ? { provider: v.q as PaceProvider, ...(typeof v.a === 'string' ? { account: v.a } : {}), session: v.s } : null
      continue
    }
    const event = eventOf(v)
    if (head && event) out.push({ ...head, event })
  }
  return { entries: out, head }
}

/** Whether history on `b`'s quota counts for `a`: one provider, and one account unless either names none */
const sameQuota = (a: { provider: PaceProvider; account?: string }, b: { provider: PaceProvider; account?: string }) =>
  a.provider === b.provider && (a.account == null || b.account == null || a.account === b.account)

/** A quota's history from one source, folded: a day of the log, or what a feed from before the log carries */
export type Part = {
  provider: PaceProvider
  account?: string
  samples: PaceSample[]
  prompts: number[]
  modelPrompts?: Record<string, number[]>
  spend: PaceSpend[]
}
/** A finished day of the log, folded once: a part for each quota that day */
export type Checkpoint = { version: 1; day: string; parts: Part[] }

const DAY_END = (day: string) => Date.parse(`${day}T00:00:00Z`) + DAY

/** The log's events as parts, one for each quota: each cost summed by session and minute, never a copy of another */
export function partsOf(entries: readonly LogEntry[], now: number): Part[] {
  const groups = new Map<string, LogEntry[]>()
  for (const e of entries) {
    const key = `${e.provider}|${e.account ?? ''}`
    const list = groups.get(key)
    if (list) list.push(e)
    else groups.set(key, [e])
  }
  return [...groups.values()].map(on => {
    const samples: PaceSample[] = []
    const prompts: number[] = []
    const byModel: Record<string, number[]> = {}
    const spent: PaceSpend[] = []
    for (const { event: e, session } of on) {
      if ('quotas' in e) samples.push({ at: e.at, quotas: e.quotas })
      else if ('prompt' in e) {
        prompts.push(e.at)
        if (e.model) (byModel[e.model] ??= []).push(e.at)
      } else spent.push({ t: e.at, id: session, usd: e.usd, ...(e.model ? { m: e.model } : {}) })
    }
    return {
      provider: on[0]!.provider, ...(on[0]!.account ? { account: on[0]!.account } : {}),
      samples: mergeSamples([], samples), prompts: [...new Set(prompts)].sort((a, b) => a - b),
      ...(Object.keys(byModel).length ? { modelPrompts: byModel } : {}),
      spend: mergeSpend(spent, [], now),
    }
  })
}

/** A finished day's checkpoint: its events folded as of the day's end */
export const checkpointOf = (day: string, entries: readonly LogEntry[]): Checkpoint => ({ version: 1, day, parts: partsOf(entries, DAY_END(day)) })

const isPart = (v: unknown): v is Part =>
  isObject(v) && PROVIDERS.includes(v.provider as string) && Array.isArray(v.samples) && Array.isArray(v.prompts) && Array.isArray(v.spend)

/** A checkpoint as read back; null for one cut short or of another shape, which is folded again from its day */
export function checkpointFrom(text: string): Checkpoint | null {
  try {
    const v: unknown = JSON.parse(text)
    if (!isObject(v) || v.version !== 1 || typeof v.day !== 'string' || !Array.isArray(v.parts) || !v.parts.every(isPart)) return null
    return v as Checkpoint
  } catch {
    return null
  }
}

/** The days a checkpoint is made for: before yesterday, when no session writes them again; yesterday may still get a late line */
export function checkpointDays(names: readonly string[], now: number): string[] {
  const yesterday = logDay(now - DAY)
  return names.filter(n => /^\d{4}-\d{2}-\d{2}$/.test(n) && n < yesterday)
}

type Merged = Pick<Snapshot, 'samples' | 'prompts' | 'modelPrompts' | 'spend'>

/** Folded by the minute only, never by the clock: a part of an open day stays the same until a line arrives */
const UNFOLDED = -Infinity

/** Parts as one, the clock left out: readings by `reads`, every prompt, the spend merged as of `now` */
function joined(parts: readonly Part[], reads: (account?: string) => boolean, now: number): Part {
  const modelPrompts: Record<string, number[]> = {}
  for (const p of parts) for (const [m, at] of Object.entries(p.modelPrompts ?? {})) modelPrompts[m] = [...(modelPrompts[m] ?? []), ...at]
  return {
    provider: parts[0]?.provider ?? 'claude',
    samples: mergeSamples([], parts.filter(p => reads(p.account)).flatMap(p => p.samples)),
    prompts: [...new Set(parts.flatMap(p => p.prompts))].sort((a, b) => a - b),
    ...(Object.keys(modelPrompts).length ? { modelPrompts } : {}),
    // A day's buckets are its own (an hour never spans two days), and a feed's copy is a copy: the larger wins
    spend: mergeCopies(parts.map(p => p.spend), now),
  }
}

/**
 * Today's parts on top of a quota's past, joined already: today's readings and prompts added, today's spend folded
 * and set beside the past's, which is not folded again
 */
function atop(past: Part, todays: readonly Part[], reads: (account?: string) => boolean, now: number): Part {
  if (!todays.length) return past
  const modelPrompts: Record<string, number[]> = { ...past.modelPrompts }
  for (const p of todays) for (const [m, at] of Object.entries(p.modelPrompts ?? {})) modelPrompts[m] = [...(modelPrompts[m] ?? []), ...at]
  return {
    provider: past.provider,
    samples: mergeSamples(past.samples, todays.filter(p => reads(p.account)).flatMap(p => p.samples)),
    prompts: [...new Set([...past.prompts, ...todays.flatMap(p => p.prompts)])].sort((a, b) => a - b),
    ...(Object.keys(modelPrompts).length ? { modelPrompts } : {}),
    spend: unionMax(past.spend, mergeCopies(todays.map(p => p.spend), now)),
  }
}

/** A part as a snapshot's history, as of `now`: the readings, prompts and spend still kept */
function asOf(p: Part, now: number): Merged {
  const since = now - (DAYS - 1) * DAY
  const modelPrompts = mergeModelPrompts({}, p.modelPrompts ?? {}, now)
  return {
    samples: p.samples.filter(s => s.at >= since),
    prompts: mergePrompts([], p.prompts, now),
    ...(Object.keys(modelPrompts).length ? { modelPrompts } : {}),
    spend: p.spend.filter(s => s.t >= since),
  }
}

const HOUR = 60 * 60_000
const MINUTE = 60_000

/**
 * The history of every quota, kept as parts and worked out only when what it is made of changes. A finished day's
 * checkpoint is set once; the open days are appended to as their lines arrive, a part for each day and quota; a
 * feed's own history is folded once for as long as the feed is the same. A quota's history is its past (every part
 * but today's), joined at most once an hour, and today's parts on top. It and the feeds hydrated with it come back as
 * the same objects until one of their parts changes, so a reader can tell there is nothing to draw again.
 */
export class History {
  private days = new Map<string, Part[]>()
  private open = new Map<string, Map<string, { entries: LogEntry[]; part: Part | null }>>()
  private carried = new WeakMap<Snapshot, Part | null>()
  private ids = new WeakMap<object, number>()
  private nextId = 1
  private pasts = new Map<string, { key: string; part: Part }>()
  private combined = new Map<string, { key: string; part: Part }>()
  private quotas = new Map<string, { key: string; h: Merged }>()
  private fed = new WeakMap<PaceFeed, { h: Merged; out: PaceFeed }>()

  /** A finished day, folded: its raw lines are no longer needed */
  setCheckpoint(cp: Checkpoint): void {
    this.days.set(cp.day, cp.parts)
    this.open.delete(cp.day)
  }

  /** Whether a day is held as a checkpoint */
  hasCheckpoint(day: string): boolean {
    return this.days.has(day)
  }

  /** Lines just read from the log, of days not yet folded: only their day's and quota's part is folded again */
  append(entries: readonly LogEntry[]): void {
    for (const e of entries) {
      const day = logDay(e.event.at)
      if (this.days.has(day)) continue
      let groups = this.open.get(day)
      if (!groups) this.open.set(day, (groups = new Map()))
      const key = `${e.provider}|${e.account ?? ''}`
      const g = groups.get(key)
      if (g) {
        g.entries.push(e)
        g.part = null
      } else groups.set(key, { entries: [e], part: null })
    }
  }

  /** Drops the days past keeping */
  forget(now: number): void {
    const first = logDays(now)[0]!
    for (const map of [this.days, this.open] as Map<string, unknown>[]) for (const day of [...map.keys()]) if (day < first) map.delete(day)
  }

  private id(o: object): number {
    let n = this.ids.get(o)
    if (n == null) this.ids.set(o, (n = this.nextId++))
    return n
  }

  /** The open days' parts, by day: a part folded again only once a line arrived for it */
  private openParts(): Map<string, Part[]> {
    const out = new Map<string, Part[]>()
    for (const [day, groups] of this.open) {
      out.set(day, [...groups.values()].map(g => (g.part ??= partsOf(g.entries, UNFOLDED)[0]!)))
    }
    return out
  }

  /** What a feed from before the log still carries, folded once for as long as it is the same */
  private carriedOf(f: PaceFeed): Part | null {
    const s = f.snapshot
    if (this.carried.has(s)) return this.carried.get(s)!
    const has = s.samples.length || s.prompts.length || s.spend?.length
    const part: Part | null = has
      ? { provider: f.provider, ...(f.account ? { account: f.account } : {}), samples: [...s.samples], prompts: [...s.prompts], ...(s.modelPrompts ? { modelPrompts: s.modelPrompts as Record<string, number[]> } : {}), spend: [...(s.spend ?? [])] }
      : null
    this.carried.set(s, part)
    return part
  }

  /** Feeds with their quota's history filled in; the same objects back as long as nothing they are made of changed */
  hydrate(feeds: readonly PaceFeed[], now: number): PaceFeed[] {
    const today = logDay(now)
    const open = this.openParts()
    const past = [...this.days.values(), ...[...open].filter(([d]) => d !== today).map(([, p]) => p)].flat()
    const recent = open.get(today) ?? []
    const carried = feeds.flatMap(f => this.carriedOf(f) ?? [])
    const live = (provider: PaceProvider) => new Set(feeds.filter(f => f.provider === provider && f.account && f.at >= now - FEED_STALE).map(f => f.account!))
    const ids = (ps: readonly Part[]) => ps.map(p => this.id(p)).join()
    return feeds.map(f => {
      const q = { provider: f.provider, ...(f.account ? { account: f.account } : {}) }
      const accounts = [...live(f.provider)].sort()
      // Readings are an account's own (core/account.ts): a quota that names none reads as its provider's one live
      // account, and with two or more here only what names none, since any other could be another account's
      const reads = (account?: string) => q.account || accounts.length === 0 ? true : accounts.length === 1 ? !account || accounts.includes(account) : !account
      const name = `${q.provider}|${q.account ?? ''}`
      const before = [...past, ...carried].filter(p => sameQuota(q, p))
      const pastKey = `${Math.floor(now / HOUR)}|${accounts.join()}|${ids(before)}`
      let p = this.pasts.get(name)
      if (p?.key !== pastKey) this.pasts.set(name, (p = { key: pastKey, part: joined(before, reads, now) }))
      const todays = recent.filter(x => sameQuota(q, x))
      // Today's parts on the past: joined again only when one of them changed
      const both = `${this.id(p.part)}|${ids(todays)}`
      let c = this.combined.get(name)
      if (c?.key !== both) this.combined.set(name, (c = { key: both, part: atop(p.part, todays, reads, now) }))
      // As of the minute: what is past keeping trimmed off
      const key = `${Math.floor(now / MINUTE)}|${this.id(c.part)}`
      let known = this.quotas.get(name)
      if (known?.key !== key) this.quotas.set(name, (known = { key, h: asOf(c.part, now) }))
      const seen = this.fed.get(f)
      if (seen?.h === known.h) return seen.out
      const { modelPrompts: _m, spend: _s, ...liveState } = f.snapshot
      const { spend, ...rest } = known.h
      // A feed with no spend anywhere stays without the list, as it was written
      const out = { ...f, snapshot: { ...liveState, ...rest, ...(spend!.length || f.snapshot.spend ? { spend } : {}) } }
      this.fed.set(f, { h: known.h, out })
      return out
    })
  }
}

/**
 * Feeds with their quota's history filled in from the log and from what older feeds still carry: what a feed
 * carried before the log, for every reader after it. Live state stays each feed's own. A reader that hydrates again
 * keeps a History instead, so only what changed is worked out
 */
export function hydrate(feeds: readonly PaceFeed[], entries: readonly LogEntry[], now: number): PaceFeed[] {
  const h = new History()
  h.append(entries)
  return h.hydrate(feeds, now)
}

/** A snapshot as written: its live state, its history left to the log */
export function slimSnapshot(s: Snapshot): Snapshot {
  const { modelPrompts: _m, spend: _s, ...live } = s
  return { ...live, samples: [], prompts: [] }
}

/** A feed as written: its live state, its history left to the log */
export const slim = (f: PaceFeed): PaceFeed => ({ ...f, snapshot: slimSnapshot(f.snapshot) })
