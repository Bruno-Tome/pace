// Feeds the size real use makes, for the load check: a week and a day of history, half again what a busy
// machine keeps, 11 Claude sessions sharing one history (as Claude's shared store makes them) and 2 Codex sessions.
// Pure; times in ms.

import type { ActivityRow } from '../core/activity.ts'
import type { PaceSample, PaceSpend } from '../types'
import type { PaceFeed } from '../core/host.ts'

const MIN = 60_000
const H = 60 * MIN
const DAY = 24 * H

/** Readings every `every` ms over 8 days: each quota climbing through its window, resetting on time */
function history(now: number, every: number, keys: readonly string[]): PaceSample[] {
  const out: PaceSample[] = []
  for (let at = now - 8 * DAY; at <= now; at += every) {
    const quotas: PaceSample['quotas'] = {}
    for (const key of keys) {
      const window = key === 'five_hour' ? 5 * H : 7 * DAY
      const start = Math.floor(at / window) * window
      quotas[key] = { percent: Math.round(((at - start) / window) * 80), resetsAt: start + window }
    }
    out.push({ at, quotas })
  }
  return out
}

/** Spend as Claude keeps it: minute buckets for the last 2 hours, hours folded before that, over a week */
function spend(now: number): PaceSpend[] {
  const minutes = Array.from({ length: 120 }, (_, i): PaceSpend => ({ t: now - (120 - i) * MIN, id: `s${i % 11}`, usd: 0.05, m: 'claude-fable-5-1' }))
  const hours = Array.from({ length: 7 * 24 }, (_, i): PaceSpend => ({ t: now - 2 * H - (i + 1) * H, id: `s${i % 11}`, usd: 2, h: true, m: 'claude-fable-5-1' }))
  return [...hours.reverse(), ...minutes]
}

/** Prompts every 6 minutes over the last day */
const prompts = (now: number) => Array.from({ length: 240 }, (_, i) => now - DAY + (i + 1) * 6 * MIN)

/** The feeds a busy machine holds at `now`: every session live */
export function loadFeeds(now: number): PaceFeed[] {
  const shared = {
    samples: history(now, 5 * MIN, ['five_hour', 'seven_day', 'seven_day_fable']),
    prompts: prompts(now),
    modelPrompts: { 'claude-fable-5-1': prompts(now) },
    spend: spend(now),
  }
  const claude = Array.from({ length: 11 }, (_, i): PaceFeed => ({
    version: 1, host: 'claude', provider: 'claude', session: `claude-${i}`, terminal: `t${i + 1}`, cwd: `/work/project-${i}`,
    at: now - i * MIN,
    snapshot: { ...shared, cache: { at: now - i * MIN, tokens: 150_000, window: 1_000_000, ttl: '1h' }, price: 0.000003 },
    context: { tokens: 150_000, window: 1_000_000 },
  }))
  const codexHistory = history(now, 5 * MIN, ['five_hour', 'seven_day'])
  const codex = Array.from({ length: 2 }, (_, i): PaceFeed => ({
    version: 1, host: 'codex', provider: 'codex', session: `codex-${i}`, terminal: `t${20 + i}`, cwd: `/work/api-${i}`,
    at: now - i * MIN,
    snapshot: { samples: codexHistory, prompts: prompts(now), cache: null, noCache: true },
    context: { tokens: 60_000, window: 258_400 },
  }))
  return [...claude, ...codex]
}

/**
 * A year of activity as heavy use makes it, for the Herdr load check: every hour, three providers, three harnesses,
 * three repos and two models each, about 44,000 rows
 */
export function loadActivity(now: number): ActivityRow[] {
  const rows: ActivityRow[] = []
  const hour = 3600_000
  const first = Math.floor(now / hour) * hour - 365 * 24 * hour
  const combos = [
    { provider: 'claude', harness: 'claude', model: 'claude-opus-4-6' }, { provider: 'claude', harness: 'pi', model: 'claude-sonnet-4-6' },
    { provider: 'codex', harness: 'codex', model: 'gpt-5.5' }, { provider: 'codex', harness: 'hermes', model: 'gpt-5.6-sol' },
    { provider: 'antigravity', harness: 'antigravity', model: 'gemini-3.1-pro' },
  ]
  for (let t = first, i = 0; t <= now; t += hour, i++) {
    const c = combos[i % combos.length]!
    rows.push({ hour: t, ...c, repo: ['pace', 'ql', 'maestro'][i % 3]!, input: 40_000 + (i % 97) * 100, output: 3_000 + (i % 31) * 50, cacheRead: 400_000, cacheWrite: 9_000, reasoning: 500, usd: 1.2, prompts: 3, replies: 9 })
    rows.push({ hour: t, ...combos[(i + 1) % combos.length]!, repo: 'pace', input: 1_000, output: 100, cacheRead: 0, cacheWrite: 0, reasoning: 0, usd: 0.05, prompts: 1, replies: 1 })
    rows.push({ hour: t, ...combos[(i + 2) % combos.length]!, repo: 'ql', input: 2_000, output: 200, cacheRead: 10_000, cacheWrite: 0, reasoning: 0, usd: 0.1, prompts: 0, replies: 2 })
    rows.push({ hour: t, ...combos[(i + 3) % combos.length]!, repo: 'maestro', input: 500, output: 50, cacheRead: 0, cacheWrite: 0, reasoning: 0, usd: 0.01, prompts: 1, replies: 1 })
    rows.push({ hour: t, ...combos[(i + 4) % combos.length]!, repo: 'pace', input: 100, output: 10, cacheRead: 0, cacheWrite: 0, reasoning: 0, usd: 0, prompts: 0, replies: 1 })
  }
  return rows
}
