// The prompt cache and what the next prompt costs in tokens, plus what to do about token usage. Pure; times in ms.

import type { PaceCacheInfo, PaceCacheTtl, PaceWarmMode } from '../types'

export type CacheInfo = PaceCacheInfo
export type CacheTtl = PaceCacheTtl
export type WarmMode = PaceWarmMode

export const ttlSeconds = (ttl: CacheTtl) => (ttl === '5m' ? 300 : 3600)

/** Seconds the cache stays warm, counted from the last reply; 0 once it lapsed */
export function cacheLeft(c: CacheInfo, now: number): number {
  return Math.max(0, Math.round(ttlSeconds(c.ttl) - (now - c.at) / 1000))
}

/**
 * The next prompt's context in input-token equivalents: a warm cache reads it at a tenth of the input price; a
 * cold one writes it again at 1.25× for a 5-minute TTL, 2× for an hour.
 */
export function nextCost(tokens: number, ttl: CacheTtl): { warm: number; cold: number } {
  return { warm: Math.round(tokens * 0.1), cold: Math.round(tokens * (ttl === '5m' ? 1.25 : 2)) }
}

/**
 * A reply's context in input-token equivalents, from the cache it found: a warm one is read at a tenth and only
 * what the reply added is written; a cold or missing one is written whole.
 */
export function replyEquivalents(prev: CacheInfo | null, tokens: number, ttl: CacheTtl, now: number): number {
  const write = ttl === '5m' ? 1.25 : 2
  if (!prev || cacheLeft(prev, now) === 0) return tokens * write
  return prev.tokens * 0.1 + Math.max(0, tokens - prev.tokens) * write
}

/** Price samples kept: the last replies' dollars per input-token equivalent */
const PRICES = 20

/** A reply's price joined to the last ones; one that cost nothing or is not a number is left out */
export function addPrice(prices: readonly number[], usd: number, equivalents: number): number[] {
  const p = usd / equivalents
  if (!(usd > 0) || !(equivalents > 0) || !Number.isFinite(p)) return [...prices]
  return [...prices, p].slice(-PRICES)
}

/** Dollars per input-token equivalent: the median of the samples, so a reply that also wrote a long answer counts once */
export function priceOf(prices: readonly number[]): number | null {
  if (!prices.length) return null
  const sorted = [...prices].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}

/** `$0.03`, `$1.20`, `<$0.01` */
export function formatUsd(usd: number): string {
  if (usd < 0.005) return '<$0.01'
  return `$${usd.toFixed(2)}`
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${Number((n / 1_000_000).toFixed(1))}M`
  if (n >= 1000) return `${Math.round(n / 1000)}k`
  return String(n)
}

export type Suggestion = { level: 'urgent' | 'warn' | 'info'; short: string; text: string }

export type SuggestionInput = {
  cache: CacheInfo | null
  now: number
  /** The context window's fill, 0–100 */
  contextPercent?: number
  /** The quota the prompting rate empties before its reset, while its average would not */
  burst?: { name: string; emptyIn: number | null }
  /** The quota the prompting rate empties before its reset, already over pace */
  fast?: { name: string; emptyIn: number | null; slowTo: string | null }
  /** Warm mode, which keeps the cache warm itself */
  warm?: WarmMode
  /** A weekly quota's name when it is over pace */
  weeklyOverPace?: string
}

/** Below this, a context costs too little to act on */
const WORTH = 50_000

/** What would cut token usage now, most urgent first */
export function suggestions(i: SuggestionInput): Suggestion[] {
  const out: Suggestion[] = []
  const c = i.cache
  if (c && c.tokens >= WORTH) {
    const left = cacheLeft(c, i.now)
    const soon = c.ttl === '5m' ? 90 : 5 * 60
    const cost = nextCost(c.tokens, c.ttl)
    if (left > 0 && left <= soon && i.warm && i.warm !== 'off') {
      out.push({ level: 'info', short: `auto-${i.warm}`, text: `Warm mode will ${i.warm === 'compact' ? 'compact the conversation' : 'ping the cache'} before it lapses, while Claude is idle.` })
    } else if (left > 0 && left <= soon) {
      const m = `${Math.max(1, Math.ceil(left / 60))}m`
      out.push({
        level: 'urgent',
        short: `prompt within ${m}`,
        text: `The cache lapses in ${m}: a prompt before then reads ${formatTokens(c.tokens)} at ≈${formatTokens(cost.warm)}; after, it rewrites them at ≈${formatTokens(cost.cold)}.`,
      })
    } else if (left === 0) {
      out.push({
        level: 'warn',
        short: 'cold: /compact first',
        text: `The cache is cold: the next prompt rewrites ${formatTokens(c.tokens)} (≈${formatTokens(cost.cold)}). /compact first, or /clear if the old context is done with.`,
      })
    }
  }
  if (i.fast) {
    const budget = i.fast.slowTo != null ? ` Slow to ≤${i.fast.slowTo}.` : ''
    out.push({ level: 'urgent', short: 'batch prompts', text: `Batch asks into fewer, fuller prompts: ${i.fast.name} runs out before it resets at this rate.${budget}` })
  }
  if (i.burst) {
    const when = i.burst.emptyIn != null ? ` runs out in ${formatDuration(i.burst.emptyIn)}` : ' would run out before it resets'
    out.push({ level: 'info', short: 'burst', text: `Burst: if this pace keeps up, ${i.burst.name}${when}. Fine for a short run; ease off if it keeps going.` })
  }
  if (i.contextPercent != null && i.contextPercent >= 60) {
    out.push({ level: 'warn', short: `/compact (${i.contextPercent}%)`, text: `The context is ${i.contextPercent}% full and every prompt re-sends it: /compact, or /clear between unrelated tasks.` })
  }
  if (i.weeklyOverPace) {
    out.push({ level: 'info', short: '/model lighter', text: `${i.weeklyOverPace} weekly is over pace: a lighter model (/model) for routine edits, searches and subagents saves it.` })
  }
  return out
}

/** Compactions, or pings, warm mode makes between two prompts of the person's */
const WARM_CAP: Record<Exclude<WarmMode, 'off'>, number> = { compact: 1, ping: 3 }

export type WarmInput = {
  mode: WarmMode
  cache: CacheInfo | null
  now: number
  /** A turn is running */
  working: boolean
  /** Warm-mode actions since the person's last prompt */
  actions: number
  /** The reply (its `at`) warm mode last acted on */
  lastFor: number | null
}

/**
 * What warm mode does now, if anything: under 10 minutes left (half the TTL for 5 minutes), idle, on a context
 * worth keeping, once per reply and within its cap since the last prompt.
 */
export function warmAction(i: WarmInput): Exclude<WarmMode, 'off'> | null {
  const c = i.cache
  if (i.mode === 'off' || !c || i.working || c.tokens < WORTH || i.lastFor === c.at || i.actions >= WARM_CAP[i.mode]) return null
  const left = cacheLeft(c, i.now)
  return left > 0 && left <= Math.min(600, ttlSeconds(c.ttl) / 2) ? i.mode : null
}

/** `2h 5m`, `52m`, `40s`: a short duration */
function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds))
  if (s < 60) return `${s}s`
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  return h ? `${h}h ${m}m` : `${m}m`
}

