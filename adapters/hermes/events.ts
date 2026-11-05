// What pace needs of Hermes Agent, read into pace's terms: the quota a Hermes provider spends, its account windows
// (Hermes's `fetch_account_usage`) as readings, and Hermes as a host in its two modes. Hermes runs pace's plugin in
// `hermes chat` (session mode) and in its messaging gateway (bot mode); the plugin hands its events to
// bin/pace-hermes.ts, which runs the core. Pure; times in ms.

import type { PaceCacheTtl, PaceReading, PaceSample } from '../../types'
import type { Host } from '../../core/api.ts'
import type { PaceProvider } from '../../core/host.ts'
import { readingOf } from '../../core/quota.ts'

/** Hermes's providers whose subscription sign-in spends a quota pace knows */
const QUOTA_OF: Record<string, PaceProvider> = { anthropic: 'claude', 'openai-codex': 'codex' }

/** The quota a Hermes provider spends; null for one pace does not pace */
export const quotaOf = (provider: string): PaceProvider | null => QUOTA_OF[provider.toLowerCase()] ?? null

/** How long a provider keeps a prompt cached by default: Anthropic five minutes, OpenAI an hour */
export const cacheTtlOf = (q: PaceProvider): PaceCacheTtl => (q === 'claude' ? '5m' : '1h')

/** One of Hermes's account windows, as its plugin sends it */
export type HermesWindow = { label: string; used_percent?: number | null; reset_at?: string | null; scope?: string }

/** A window's quota key by its label: Anthropic's `Current session`, `Current week`, `Opus week`; Codex's `Session`, `Weekly` */
function keyOf(label: string): { key: string; name?: string } | null {
  const l = label.trim().toLowerCase()
  if (l === 'session' || l === 'current session') return { key: 'five_hour' }
  if (l === 'weekly' || l === 'current week') return { key: 'seven_day' }
  const model = /^(\w+) week$/.exec(l)?.[1]
  return model ? { key: `seven_day_${model}`, name: model[0]!.toUpperCase() + model.slice(1) } : null
}

/** Hermes's account windows as one reading at `at`; null when none is a window pace paces */
export function readingsOf(windows: readonly HermesWindow[], at: number): PaceSample | null {
  if (!Array.isArray(windows)) return null
  const quotas: Record<string, PaceReading> = {}
  for (const w of windows) {
    const k = typeof w?.label === 'string' ? keyOf(w.label) : null
    if (!k || typeof w.used_percent !== 'number' || !Number.isFinite(w.used_percent)) continue
    const reset = w.reset_at ? Date.parse(w.reset_at) : NaN
    quotas[k.key] = readingOf(w.used_percent, Number.isFinite(reset) ? reset / 1000 : undefined, k.name)
  }
  return Object.keys(quotas).length ? { at, quotas } : null
}

/** Hermes as pace's host. A session has the answer to `/pace`, and Herdr, tmux or a window beside it; a bot has its chat */
export function hermesHost(mode: 'session' | 'bot', where: { herdr: boolean; tmux: boolean; mac: boolean }): Host {
  if (mode === 'bot') return { name: 'Hermes (bot)', input: 'message', surfaces: ['answer'], drives: ['prompt'], cache: true }
  const surfaces: Host['surfaces'] = [...(where.herdr ? ['herdr' as const] : []), ...(where.tmux ? ['split' as const] : []), 'answer', ...(where.mac ? ['window' as const] : [])]
  return { name: 'Hermes', input: 'prompt', surfaces, drives: ['prompt'], cache: true }
}
