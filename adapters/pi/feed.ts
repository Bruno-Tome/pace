// pi's session, read into pace's feed. Pure; times in ms.
//
// pi tells an extension nothing of the quotas: on a ChatGPT sign-in neither the response headers nor the stream carry
// them. So a pi session estimates them from what it spends (core/estimate.ts), and its feed carries what pi knows:
// its prompts, its spend and its context, with the other pi sessions' on its provider, so the feed carries the
// harness's whole history, and its prompt cache, from the replies that touched it. Real readings of other feeds on its provider (Codex's, Claude's) are kept when there are
// any: they teach the estimate what a window holds, and a fresh one stands in its place.

import type { Capacities } from '../../core/estimate.ts'
import type { PaceFeed, PaceProvider } from '../../core/host.ts'
import { meter, type Metered } from '../../core/meter.ts'

/** What the extension tells the feed after an event: the session, the quota it spends, a prompt, the context */
export type PiEvent = {
  session: string
  provider: PaceProvider
  /** The account it spends (core/account.ts), when pi's sign-in names one */
  account?: string
  cwd: string
  now: number
  /** Herdr's terminal id when pi runs in Herdr */
  terminal?: string
  /** Whether the event was a prompt the user sent */
  prompted: boolean
  /** What a reply cost, in dollars at pi's prices; 0 for any other event */
  spent: number
  /** The tokens a reply's prompt held in the prompt cache, when it read or wrote it; absent for any other event */
  cached?: number
  /** pi's `getContextUsage()`; its tokens are null right after a compaction */
  context: { tokens: number | null; contextWindow: number } | null
}

/** pi's providers whose subscription sign-in spends a quota pace knows */
const QUOTA_OF: Record<string, PaceProvider> = { openai: 'codex', 'openai-codex': 'codex', anthropic: 'claude' }

/** The quota a pi session spends: its provider's on a subscription sign-in; null on an API key or another provider */
export function providerOf(provider: string | undefined, oauth: boolean): PaceProvider | null {
  return oauth && provider != null ? QUOTA_OF[provider] ?? null : null
}

/** How long pi's providers keep a prompt cached: an hour, as Claude's and OpenAI's caches do by default */
const CACHE_TTL = '1h'

/** The session's feed after an event (core/meter.ts): pi reports its cache and estimates its quotas from its spend */
export function nextFeed(prev: PaceFeed | null, e: PiEvent, others: readonly PaceFeed[], capacities: Capacities = {}): PaceFeed {
  return meter(prev, piMetered(e), others, { cache: true, estimate: true, capacities })
}

/** What pi's event metered */
export function piMetered(e: PiEvent): Metered {
  return {
    host: 'pi', provider: e.provider, ...(e.account ? { account: e.account } : {}), session: e.session, cwd: e.cwd, now: e.now,
    ...(e.terminal ? { terminal: e.terminal } : {}),
    prompted: e.prompted, spent: e.spent,
    ...(e.cached != null ? { cached: { tokens: e.cached, ttl: CACHE_TTL } } : {}),
    context: e.context ? { tokens: e.context.tokens, window: e.context.contextWindow } : null,
  }
}

/**
 * Whether a reply's error is a subscription's usage limit reached (`usage_limit_exceeded` on ChatGPT, "usage limit" in
 * words), not a rate limit of seconds or another error
 */
export function isLimit(error: string | undefined): boolean {
  return error != null && /usage[_ ]limit/i.test(error)
}
