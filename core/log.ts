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
import { mergeCopies, mergeSpend } from './spend.ts'

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

type History = Pick<Snapshot, 'samples' | 'prompts' | 'modelPrompts' | 'spend'>

/** A quota's history: the log's events on it, and what the feeds on it still carry from before the log */
function historyFor(q: { provider: PaceProvider; account?: string }, feeds: readonly PaceFeed[], entries: readonly LogEntry[], now: number): History {
  const on = entries.filter(e => sameQuota(q, e))
  const carried = feeds.filter(f => sameQuota(q, f)).map(f => f.snapshot)
  const since = now - (DAYS - 1) * DAY
  // Readings are an account's own (core/account.ts): a quota that names none reads as its provider's one live account,
  // and with two or more here only what names none, since any other could be another account's
  const live = new Set(feeds.filter(f => f.provider === q.provider && f.account && f.at >= now - FEED_STALE).map(f => f.account!))
  const reads = (account?: string) => q.account || live.size === 0 ? true : live.size === 1 ? !account || live.has(account) : !account
  const samples = mergeSamples(
    feeds.filter(f => sameQuota(q, f) && reads(f.account)).flatMap(f => f.snapshot.samples),
    on.flatMap(e => ('quotas' in e.event && reads(e.account) ? [{ at: e.event.at, quotas: e.event.quotas }] : [])),
  )
  const prompted = on.flatMap(e => ('prompt' in e.event ? [e.event] : []))
  const byModel: Record<string, number[]> = {}
  for (const p of prompted) if (p.model) (byModel[p.model] ??= []).push(p.at)
  // Each cost is one event: summed by session and minute, never a copy of another
  const logged = mergeSpend(on.flatMap(e => ('usd' in e.event ? [{ t: e.event.at, id: e.session, usd: e.event.usd, ...(e.event.model ? { m: e.event.model } : {}) } as PaceSpend] : [])), [], now)
  const modelPrompts = carried.reduce((out, s) => mergeModelPrompts(out, s.modelPrompts ?? {}, now), mergeModelPrompts({}, byModel, now))
  return {
    samples: samples.filter(s => s.at >= since),
    prompts: mergePrompts(carried.flatMap(s => s.prompts), prompted.map(p => p.at), now),
    ...(Object.keys(modelPrompts).length ? { modelPrompts } : {}),
    spend: mergeCopies([logged, ...carried.map(s => s.spend ?? [])], now),
  }
}

/**
 * Feeds with their quota's history filled in from the log and from what older feeds still carry: what a feed
 * carried before the log, for every reader after it. Live state stays each feed's own
 */
export function hydrate(feeds: readonly PaceFeed[], entries: readonly LogEntry[], now: number): PaceFeed[] {
  const memo = new Map<string, History>()
  return feeds.map(f => {
    const key = `${f.provider}|${f.account ?? ''}`
    let h = memo.get(key)
    if (!h) memo.set(key, (h = historyFor(f, feeds, entries, now)))
    const { modelPrompts: _m, spend: _s, ...live } = f.snapshot
    const { spend, ...rest } = h
    // A feed with no spend anywhere stays without the list, as it was written
    return { ...f, snapshot: { ...live, ...rest, ...(spend!.length || f.snapshot.spend ? { spend } : {}) } }
  })
}

/** A snapshot as written: its live state, its history left to the log */
export function slimSnapshot(s: Snapshot): Snapshot {
  const { modelPrompts: _m, spend: _s, ...live } = s
  return { ...live, samples: [], prompts: [] }
}

/** A feed as written: its live state, its history left to the log */
export const slim = (f: PaceFeed): PaceFeed => ({ ...f, snapshot: slimSnapshot(f.snapshot) })
