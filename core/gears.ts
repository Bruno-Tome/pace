// Ultra pace's gears on any provider (.agents/decisions/0021-ultra-gears-per-provider.md): a ladder of the models and
// thinking levels a host offers, lightest first, ranked by the provider's families in one table here, since neither
// ACP nor a harness ranks its models. core/throttle.ts picks the notch; this says what each notch is on a ladder.
// Pure.

import type { PaceGear } from '../types'
import type { PaceProvider } from './host.ts'

/** A ladder: models and thinking levels, lightest first; Claude's also names its subagents' models and its push effort */
export type Ladder = { models: readonly string[]; efforts: readonly string[]; sub?: { light: string; mid: string }; push?: string }

/** Each provider's model families, lightest first: a model is ranked by the first family its name holds */
const FAMILIES: Record<PaceProvider, readonly string[]> = {
  claude: ['haiku', 'sonnet', 'opus', 'fable'],
  codex: ['nano', 'mini'],
  antigravity: ['flash', 'gpt-oss', 'sonnet', 'pro', 'opus'],
}

/** Each provider's thinking levels, lightest first, when its host names none */
const EFFORTS: Record<PaceProvider, readonly string[]> = {
  claude: ['low', 'medium', 'high', 'xhigh', 'max'],
  codex: ['minimal', 'low', 'medium', 'high', 'xhigh'],
  antigravity: ['low', 'medium', 'high'],
}

/** Claude's ladder, by family: the one ultra pace has always climbed */
export const CLAUDE_LADDER: Ladder = { models: FAMILIES.claude, efforts: EFFORTS.claude, sub: { light: 'haiku', mid: 'sonnet' }, push: 'xhigh' }

/** A provider's ladder from what its host offers: models ranked by family (one of none last, as offered), its levels */
export function ladderFor(provider: PaceProvider, models: readonly string[], efforts: readonly string[]): Ladder {
  const families = FAMILIES[provider]
  const rank = (m: string) => { const i = families.findIndex(f => m.toLowerCase().includes(f)); return i < 0 ? families.length : i }
  const ranked = models.map((m, i) => ({ m, i })).sort((a, b) => rank(a.m) - rank(b.m) || a.i - b.i).map(x => x.m)
  return { models: ranked, efforts: efforts.length ? efforts : EFFORTS[provider], ...(provider === 'claude' ? { sub: CLAUDE_LADDER.sub!, push: 'xhigh' } : {}) }
}

/** The user's bounds: the models a run ranges over, and the model and thinking it runs at */
export type Bounds = { floor: string; ceiling: string; model: string; effort: string }

/**
 * A notch on a ladder: push the ceiling with the most thinking short of the top (when there is more than one step
 * above the user's), cruise the user's own, ease the floor with one step less
 */
export function gearOf(notch: 'push' | 'cruise' | 'ease', l: Ladder, b: Bounds): PaceGear {
  const at = Math.max(0, l.efforts.indexOf(b.effort))
  const above = l.efforts.slice(at + 1)
  const sub = l.sub
  const effort = (e: string) => e as PaceGear['effort']
  if (notch === 'push') {
    const top = l.push ?? (above.length > 1 ? above[above.length - 2]! : above[0] ?? b.effort)
    return { model: b.ceiling, effort: effort(top), subagents: sub ? 3 : 1, subagentModel: sub?.mid ?? '', fanout: !!sub }
  }
  if (notch === 'cruise') return { model: b.model, effort: effort(b.effort), subagents: sub ? 2 : 1, subagentModel: sub?.mid ?? '', fanout: false }
  return { model: b.floor, effort: effort(l.efforts[Math.max(0, at - 1)] ?? b.effort), subagents: 1, subagentModel: sub?.light ?? '', fanout: false }
}
