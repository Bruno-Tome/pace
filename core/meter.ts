// What a host meters, read into its session's feed: one rule for every host, so a session metered by hooks, by an
// extension or over ACP comes out the same. The feed carries the history of its whole quota, the provider and the
// account (.agents/decisions/0017-quota-is-provider-and-account.md): the readings, prompts and spend of every
// harness's live sessions on it, real readings only. A host told no readings estimates them from its spend
// (core/estimate.ts). Pure; times in ms.

import type { PaceCacheInfo, PaceCacheTtl, PaceSample } from '../types'
import { learnsFrom } from './account.ts'
import { estimateOf, type Capacities } from './estimate.ts'
import type { PaceContext, PaceFeed, PaceHost, PaceProvider } from './host.ts'
import type { Snapshot } from './model.ts'
import { mergeSamples } from './quota.ts'
import { mergePrompts } from './rate.ts'
import { addSpend, mergeSpend } from './spend.ts'

/** A quota: a provider, and the account when known */
export type QuotaOf = { provider: PaceProvider; account?: string }

/** What a host meters at one event of a session */
export type Metered = {
  host: PaceHost
  provider: PaceProvider
  account?: string
  session: string
  cwd: string
  now: number
  /** Herdr's terminal id when the session runs in Herdr */
  terminal?: string
  /** The user sent a prompt that goes on to the model */
  prompted?: boolean
  /** Readings the host was told */
  samples?: readonly PaceSample[]
  /** What a reply cost, in dollars */
  spent?: number
  /** The tokens a reply held in the prompt cache, when it read or wrote it, and how long the cache keeps them */
  cached?: { tokens: number; ttl: PaceCacheTtl }
  /** The context as of the last reply; null tokens (right after a compaction) keep the last one known */
  context?: { tokens: number | null; window: number } | null
}

/** What the host can tell: its prompt cache, and whether it estimates its quotas from spend with the capacities known */
export type MeterOptions = { cache: boolean; estimate: boolean; capacities?: Capacities }

/** A real reading this recent stands: no estimate in its place */
const FRESH = 10 * 60_000

/** Whether a feed spends `q`: the same provider, and the same account unless either names none */
export function sameQuota(f: Pick<PaceFeed, 'provider' | 'account'>, q: QuotaOf): boolean {
  return f.provider === q.provider && (f.account == null || q.account == null || f.account === q.account)
}

/** Readings as history: the ones a host was told, never an estimate */
const real = (samples: readonly PaceSample[]) => samples.filter(x => !Object.values(x.quotas).some(r => r.estimated))

function cacheOf(own: PaceFeed | null, e: Metered, o: MeterOptions): PaceCacheInfo | null {
  if (!o.cache) return null
  const window = e.context?.window ?? own?.snapshot.cache?.window ?? 0
  if (e.cached && e.cached.tokens > 0 && window > 0) return { at: e.now, tokens: e.cached.tokens, window, ttl: e.cached.ttl }
  return own?.snapshot.cache ?? null
}

/** The session's feed after an event: what it carried, the other live sessions on its quota, and what the event told */
export function meter(prev: PaceFeed | null, e: Metered, others: readonly PaceFeed[], o: MeterOptions): PaceFeed {
  const q: QuotaOf = { provider: e.provider, ...(e.account ? { account: e.account } : {}) }
  const own = prev && sameQuota(prev, q) ? prev : null
  const theirs = others.filter(f => sameQuota(f, q) && !(f.host === e.host && f.session === e.session))
  const all = [own?.snapshot, ...theirs.map(f => f.snapshot)].filter(s => s != null)
  // Readings are an account's own: from feeds that name it, or, for a session that cannot tell, only while its
  // provider has one account here (core/account.ts). Prompts and spend pool across the quota as before
  const teachers = e.account ? theirs.filter(f => f.account === e.account) : learnsFrom(theirs, e.provider, undefined)
  const read = [own?.snapshot, ...teachers.map(f => f.snapshot)].filter(s => s != null)
  const history = mergeSamples(real(read.flatMap(s => s.samples)), e.samples ?? [])
  const prompts = mergePrompts(all.flatMap(s => s.prompts), e.prompted ? [e.now] : [], e.now)
  const before = mergeSpend([], all.flatMap(s => s.spend ?? []), e.now)
  const spend = e.spent && e.spent > 0 ? addSpend(before, e.session, e.now, e.spent, e.now) : before
  const fresh = (history.at(-1)?.at ?? -Infinity) >= e.now - FRESH
  const estimate = o.estimate && !fresh ? estimateOf(spend, prompts, o.capacities ?? {}, e.now) : null
  const cache = cacheOf(own, e, o)
  const told: PaceContext | null = e.context && e.context.tokens != null && e.context.window > 0 ? { tokens: e.context.tokens, window: e.context.window } : null
  const context = told ?? own?.context
  return {
    version: 1, host: e.host, provider: e.provider, ...(e.account ? { account: e.account } : {}), session: e.session,
    ...(e.terminal ? { terminal: e.terminal } : {}),
    cwd: e.cwd, at: e.now,
    snapshot: {
      samples: estimate ? [...history, estimate] : history, prompts,
      ...(spend.length || o.estimate ? { spend } : {}),
      cache, ...(cache ? {} : { noCache: true as const }),
      ...(o.estimate ? { estimated: true as const } : {}),
      ...(own?.snapshot.auto ? { auto: own.snapshot.auto } : {}),
    },
    ...(context ? { context } : {}),
  }
}

/**
 * A snapshot a harness keeps in a store of its own (Claude Code's), with the prompts and spend of the other
 * harnesses' live sessions on its quota pooled in, so its rate is the whole quota's. Its own feed is left out; another
 * account's feeds never join
 */
export function pooled(s: Snapshot, others: readonly PaceFeed[], q: QuotaOf, self: { host: PaceHost; session: string }, now: number): Snapshot {
  const theirs = others.filter(f => sameQuota(f, q) && (!q.account || f.account === q.account || !f.account) && !(f.host === self.host && f.session === self.session))
  if (!theirs.length) return s
  return {
    ...s,
    prompts: mergePrompts(s.prompts, theirs.flatMap(f => f.snapshot.prompts), now),
    spend: mergeSpend(s.spend ?? [], theirs.flatMap(f => f.snapshot.spend ?? []), now),
  }
}
