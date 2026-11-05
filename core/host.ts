// The seam between pace's core and the hosts it runs under. Each host session writes a feed, what its band draws
// from; the fleet sets the feeds side by side, one row per provider, so work goes where there is room for it.
// Pure; times in ms.

import type { PaceCacheInfo, PaceQuota, PaceSpend, PaceWarmMode } from '../types'
import { snapshotOf, type Snapshot } from './model.ts'
import { autoOf } from './prefs.ts'
import { mergeSamples } from './quota.ts'
import { headroomOf, type Headroom } from './throttle.ts'

/** The program a session runs in */
export type PaceHost = 'claude' | 'codex'
/** Whose quotas a session draws on: two providers' `five_hour` never mix */
export type PaceProvider = 'claude' | 'codex'
/** How much of the model's context window the session's last reply filled, in tokens */
export type PaceContext = { tokens: number; window: number }

/** What one host session writes for the band and the fleet: its snapshot, where it runs, how full its context is */
export type PaceFeed = {
  version: 1
  host: PaceHost
  provider: PaceProvider
  session: string
  /** Herdr's terminal id (`HC_TERMINAL_ID`) when the session runs in Herdr */
  terminal?: string
  cwd: string
  /** When the host last wrote it */
  at: number
  snapshot: Snapshot
  context?: PaceContext
}

/** A feed not written for this long is a session gone: the fleet drops it */
export const FEED_STALE = 6 * 3600_000

/** The folder of feeds, relative to the home directory */
export const FEEDS_DIR = '.local/state/pace/feeds'

const HOSTS: readonly PaceHost[] = ['claude', 'codex']
const PROVIDERS: readonly PaceProvider[] = ['claude', 'codex']
const WARM: readonly PaceWarmMode[] = ['off', 'ping', 'compact']

/** One host session's feed file, relative to the home directory; the session id kept to a safe file name */
export const feedFile = (host: PaceHost, session: string) => `${FEEDS_DIR}/${host}-${session.replace(/[^A-Za-z0-9_-]/g, '_')}.json`

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v != null && !Array.isArray(v)
const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const numbers = (v: unknown): number[] => (Array.isArray(v) ? v.filter(isNumber) : [])

function cacheOf(v: unknown): PaceCacheInfo | null {
  if (!isObject(v) || !isNumber(v.at) || !isNumber(v.tokens) || !isNumber(v.window)) return null
  return v.ttl === '5m' || v.ttl === '1h' ? { at: v.at, tokens: v.tokens, window: v.window, ttl: v.ttl } : null
}

function spendOf(v: unknown): PaceSpend[] {
  if (!Array.isArray(v)) return []
  return v.filter((s): s is PaceSpend => isObject(s) && isNumber(s.t) && typeof s.id === 'string' && isNumber(s.usd))
}

function modelPromptsOf(v: unknown): Record<string, number[]> {
  if (!isObject(v)) return {}
  const out: Record<string, number[]> = {}
  for (const [model, list] of Object.entries(v)) if (numbers(list).length) out[model] = numbers(list)
  return out
}

/** A stored snapshot, what of it parses; null when it is not one */
function snapshotOfStored(v: unknown): Snapshot | null {
  if (!isObject(v) || !Array.isArray(v.samples)) return null
  return {
    samples: mergeSamples([], v.samples),
    prompts: numbers(v.prompts),
    cache: cacheOf(v.cache),
    ...(v.noCache === true ? { noCache: true as const } : {}),
    ...(isObject(v.modelPrompts) ? { modelPrompts: modelPromptsOf(v.modelPrompts) } : {}),
    ...(WARM.includes(v.warm as PaceWarmMode) ? { warm: v.warm as PaceWarmMode } : {}),
    ...(isNumber(v.price) || v.price === null ? { price: v.price as number | null } : {}),
    ...(Array.isArray(v.spend) ? { spend: spendOf(v.spend) } : {}),
    ...(typeof v.onPace === 'boolean' ? { onPace: v.onPace } : {}),
    ...('auto' in v ? { auto: autoOf(v.auto) } : {}),
  }
}

/** A feed as read from its file; null when it does not parse as one. What parses of a partial one is kept. */
export function feedOf(text: string): PaceFeed | null {
  let v: unknown
  try {
    v = JSON.parse(text)
  } catch {
    return null
  }
  if (!isObject(v) || v.version !== 1) return null
  if (!HOSTS.includes(v.host as PaceHost) || !PROVIDERS.includes(v.provider as PaceProvider)) return null
  if (typeof v.session !== 'string' || typeof v.cwd !== 'string' || !isNumber(v.at)) return null
  const snapshot = snapshotOfStored(v.snapshot)
  if (!snapshot) return null
  const context = isObject(v.context) && isNumber(v.context.tokens) && isNumber(v.context.window) && v.context.window > 0
    ? { tokens: v.context.tokens, window: v.context.window }
    : undefined
  return {
    version: 1, host: v.host as PaceHost, provider: v.provider as PaceProvider, session: v.session, cwd: v.cwd, at: v.at,
    snapshot,
    ...(typeof v.terminal === 'string' ? { terminal: v.terminal } : {}),
    ...(context ? { context } : {}),
  }
}

/** One agent on a provider: where it runs and how full its context is, in percent of its window too */
export type FleetAgent = {
  host: PaceHost
  session: string
  /** Herdr's terminal id; null outside Herdr */
  terminal: string | null
  cwd: string
  at: number
  /** Null where the host has not said */
  context: (PaceContext & { percent: number }) | null
}

/**
 * One provider: its quotas with their pace and rate, the room they leave, the agents drawing on them, and the
 * snapshot all its feeds make together, which the fleet's drawing reads
 */
export type FleetRow = { provider: PaceProvider; quotas: PaceQuota[]; headroom: Headroom; agents: FleetAgent[]; snapshot: Snapshot }

const ROOM: readonly Headroom[] = ['push', 'cruise', 'ease', 'hold']

/** When a feed's newest reading was taken; 0 for none */
const readAt = (f: PaceFeed) => f.snapshot.samples[f.snapshot.samples.length - 1]?.at ?? 0

/**
 * A provider's history: the snapshot of its session with the newest reading, the one written last among equals.
 * Each feed carries its harness's whole history (Claude's shared store; the Codex hook merges its sessions'), so
 * one speaks for all, and the fleet never merges copies of it. It has no prompt cache: each session keeps its own.
 */
function harnessOf(feeds: readonly PaceFeed[]): Snapshot {
  const newest = feeds.reduce((a, b) => (readAt(b) > readAt(a) || (readAt(b) === readAt(a) && b.at > a.at) ? b : a))
  const { cache: _cache, ...rest } = newest.snapshot
  return { ...rest, cache: null, noCache: true }
}

/** A feed's agent: where it runs and its context, in percent of its window too */
export const agentOf = (f: PaceFeed): FleetAgent => ({
  host: f.host, session: f.session, terminal: f.terminal ?? null, cwd: f.cwd, at: f.at,
  context: f.context ? { ...f.context, percent: (f.context.tokens / f.context.window) * 100 } : null,
})

/** The fleet: one row per provider with a live feed, the one with the most room first */
export function fleetOf(feeds: readonly PaceFeed[], now: number): FleetRow[] {
  const live = feeds.filter(f => f.at >= now - FEED_STALE)
  const rows = PROVIDERS.flatMap((provider): FleetRow[] => {
    const own = live.filter(f => f.provider === provider)
    if (!own.length) return []
    const snapshot = harnessOf(own)
    const snap = snapshotOf(snapshot, now)
    const agents = [...own].sort((a, b) => b.at - a.at).map(agentOf)
    return [{ provider, quotas: snap.quotas, headroom: headroomOf(snap, undefined), agents, snapshot }]
  })
  return rows.sort((a, b) => ROOM.indexOf(a.headroom) - ROOM.indexOf(b.headroom))
}

/** The feed a band draws: the live one of `terminal` when asked for one, else the newest live one; null for none */
export function feedFor(feeds: readonly PaceFeed[], now: number, terminal?: string): PaceFeed | null {
  const live = feeds.filter(f => f.at >= now - FEED_STALE && (terminal == null || f.terminal === terminal))
  return live.reduce<PaceFeed | null>((best, f) => (best == null || f.at > best.at ? f : best), null)
}
