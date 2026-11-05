// Claude Code's usage readings: the usage endpoint's answer and Claude Code's own copy of it in ~/.claude.json.
// Pure; times in ms.

import type { PaceReading, PaceSample } from '../types'
import { readingOf } from '../core/quota.ts'

/**
 * The usage endpoint's answer (what `/usage` reads): windows by key at the top (`five_hour`, `seven_day`,
 * `seven_day_<model>`, each `{ utilization, resets_at }`) and a `limits` list (`{ kind, percent, resets_at, scope }`),
 * whose entries win, a model's week keyed `seven_day_<model>` and named for it.
 */
export function parseUsage(root: unknown): Record<string, PaceReading> {
  const out: Record<string, PaceReading> = {}
  if (!root || typeof root !== 'object') return out
  for (const [k, v] of Object.entries(root as Record<string, unknown>)) {
    const o = v as { utilization?: unknown; resets_at?: unknown } | null
    if (o && typeof o === 'object' && typeof o.utilization === 'number') out[k] = readingOf(o.utilization, o.resets_at)
  }
  const limits = (root as { limits?: unknown }).limits
  for (const l of Array.isArray(limits) ? limits : []) {
    const o = l as { kind?: unknown; percent?: unknown; resets_at?: unknown; scope?: { model?: { display_name?: unknown } } } | null
    if (!o || typeof o.percent !== 'number') continue
    const name = typeof o.scope?.model?.display_name === 'string' ? o.scope.model.display_name : undefined
    const key = o.kind === 'session' ? 'five_hour'
      : o.kind === 'weekly_all' ? 'seven_day'
      : o.kind === 'weekly_scoped' && name ? `seven_day_${name.toLowerCase().replace(/\s+/g, '_')}`
      : null
    if (key) out[key] = readingOf(o.percent, o.resets_at, name)
  }
  return out
}

/** Claude Code's own copy of that answer in `~/.claude.json`, while it is under an hour old */
export function parseClaudeJson(text: string, now: number): PaceSample | null {
  let root: { cachedUsageUtilization?: { fetchedAtMs?: unknown; utilization?: unknown } }
  try { root = JSON.parse(text) } catch { return null }
  const c = root?.cachedUsageUtilization
  if (!c || typeof c.fetchedAtMs !== 'number' || now - c.fetchedAtMs < 0 || now - c.fetchedAtMs > 3600_000) return null
  const quotas = parseUsage(c.utilization)
  return Object.keys(quotas).length ? { at: c.fetchedAtMs, quotas } : null
}
