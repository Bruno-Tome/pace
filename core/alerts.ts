// Warnings about the quotas: nearly spent, gassed out, or a rate that gasses one out before it resets. Each has an
// id tied to its quota's window, so it is said once per window across every session. Pure; times in ms.

import type { PaceQuota, PaceSnapshot } from '../types'
import { clockAt, formatDuration, theName } from './quota.ts'

export type Alert = { id: string; level: 'warn' | 'urgent'; text: string }

const usd = (n: number) => `$${n >= 10 ? Math.round(n) : n.toFixed(1)}`

function quotaAlerts(q: PaceQuota, now: number): Alert[] {
  if (q.percent == null || q.resetsAt == null) return []
  const id = (what: string) => `${q.key}@${q.resetsAt}:${what}`
  const resetIn = formatDuration((q.resetsAt - now) / 1000)
  const out: Alert[] = []
  if (q.percent >= 80) out.push({ id: id('80'), level: 'warn', text: `${q.name} is ${Math.round(q.percent)}% used and resets in ${resetIn}: you risk getting gassed out.` })
  if (q.percent >= 95) out.push({ id: id('95'), level: 'urgent', text: `${q.name} is ${Math.round(q.percent)}% used: about to get gassed out, ${resetIn} before it resets.` })
  if (q.status === 'gassedOut') {
    out.push({ id: id('out'), level: 'urgent', text: `Gassed out: ${q.name} is spent until ${clockAt(q.resetsAt, q.resetsAt - now >= 86400_000)}. Prompts fail until then.` })
  } else if (q.rate.level === 'fast' && q.rate.emptyIn != null) {
    const rate = q.rate.usdPerHour != null ? usd(q.rate.usdPerHour) : `${q.rate.promptsPerHour} prompts`
    const before = formatDuration((q.resetsAt - now) / 1000 - q.rate.emptyIn)
    out.push({ id: id('fast'), level: 'urgent', text: `At ${rate}/h ${theName(q.name)} gasses out in ${formatDuration(q.rate.emptyIn)}, ${before} before it resets.` })
  }
  return out
}

/** Every warning that holds now; the caller says only the ones it has not said before */
export function alertsOf(s: PaceSnapshot): Alert[] {
  return s.quotas.flatMap(q => quotaAlerts(q, s.at))
}
