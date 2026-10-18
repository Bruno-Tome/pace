// Auto mode and on pace mode, as decisions. Pure; times in ms.
//
// Auto mode works through a plan with no one at the keyboard: after each turn it continues with the next step,
// hands off to a fresh context when this one is heavy, holds while a quota is gassed out or the rate would gas one
// out, waits without prompting while Claude waits on background work or its turns stop making progress, and stops
// when the plan is done or blocked. On pace mode keeps a long-running session's context and cache
// in shape: it compacts a heavy context while the cache is warm, keeps an idle cache from lapsing, and thinks one
// effort level lighter while the rate would run a quota out.

import type { PaceAuto, PaceSnapshot, PaceWarmMode } from '../types'
import { clockAt, drawsOn, formatDuration } from './quota.ts'

export const HANDOFF_FILE = '.pace/handoff.md'

const MIN = 60_000

/** A context this full is worth compacting or handing off: every prompt re-sends it */
const HEAVY = 0.6
/** A cold context this large costs more to read again than a handoff costs to start over */
const COLD_LARGE = 100_000
/** How long auto mode holds before looking again at a rate that would gas a quota out */
const PACING_HOLD = 15 * MIN
/** How long auto mode waits on background work before checking in, in case it hung without reporting */
const WAIT_CHECK = 15 * MIN
/** Turns in a row without progress before auto mode stops prompting */
const STALL_LIMIT = 2
/** The first wait after turns stop making progress, doubled each time after, up to the cap */
const STALL_WAIT = 5 * MIN
const STALL_WAIT_MAX = 30 * MIN

/** `goal` and `replan` are ultra pace's: the goal claimed, a review asked for; auto mode reads them as `next` */
export type Marker = { kind: 'next' | 'done' | 'blocked' | 'waiting' | 'goal' | 'replan'; reason?: string }

/**
 * How the turn says it ended: its last `PACE:` line. With none, a turn that ends on a question is waiting on the
 * user, who is away: blocked, the question its reason. Any other is `next`.
 */
export function markerOf(answer: string): Marker {
  const lines = [...answer.matchAll(/^PACE: (NEXT|DONE|BLOCKED|WAITING|GOAL|REPLAN)\b[ \t]*(.*)$/gm)]
  const m = lines[lines.length - 1]
  if (!m) {
    const last = answer.trim().split('\n').pop()!.trim()
    return last.endsWith('?') ? { kind: 'blocked', reason: `Claude is waiting on you: ${last}` } : { kind: 'next' }
  }
  const kind = m[1]!.toLowerCase() as Marker['kind']
  return (kind === 'blocked' || kind === 'waiting' || kind === 'replan') && m[2] ? { kind, reason: m[2].trim() } : { kind }
}

/** How long to wait after `stalls` turns in a row without progress: 5 minutes, doubling, at most half an hour */
const stallWait = (stalls: number) => Math.min(STALL_WAIT_MAX, STALL_WAIT * 2 ** (stalls - STALL_LIMIT))

/** How full the context is, 0–1; 0 when its window is not known, which would read as full */
const fill = (s: PaceSnapshot) => (s.cache && s.cache.window > 0 ? s.cache.tokens / s.cache.window : 0)

/** `stalls`: turns in a row without progress, carried to the next decision */
export type Decision =
  | { kind: 'continue'; prompt: string; stalls: number }
  /** `/clear`, then the prompt, which resumes from the handoff file */
  | { kind: 'handoff'; prompt: string; stalls: number }
  /** Look again at `until`, turns ending meanwhile ignored */
  | { kind: 'hold'; until: number; why: string }
  /** Send nothing: the next turn's end decides again, as background work reporting starts one; check in at `until` */
  | { kind: 'wait'; until: number; why: string; stalls: number }
  /** Off until `/pace auto resume` */
  | { kind: 'pause'; why: string }
  | { kind: 'stop'; why: string }

/**
 * `model`: the session's, by id; undefined before its first request. `progressed`: whether the turn moved the plan
 * or the handoff file; undefined with no turn to judge (a hold or a wait ending), which keeps the stall count.
 */
export type DecideInput = { auto: PaceAuto; snap: PaceSnapshot; answer: string; aborted: boolean; model?: string; progressed?: boolean }

/** The snapshot as a session on `model` sees it: only the quotas it draws on */
export const forModel = (s: PaceSnapshot, model: string | undefined): PaceSnapshot =>
  model ? { ...s, quotas: s.quotas.filter(q => drawsOn(q.key, model)) } : s

/** What auto mode does after a turn, or after a hold */
export function decide(i: DecideInput): Decision {
  const { auto } = i
  const snap = forModel(i.snap, i.model)
  if (i.aborted) return { kind: 'pause', why: 'You interrupted: /pace auto resume picks the plan back up' }
  const marker = markerOf(i.answer)
  if (marker.kind === 'done') return { kind: 'stop', why: `Plan done: ${auto.plan}` }
  if (marker.kind === 'blocked') return { kind: 'stop', why: `Blocked: ${marker.reason ?? 'no reason given'}` }
  if (auto.turns >= auto.max) return { kind: 'stop', why: `Reached ${auto.max} turns: /pace auto resume for more` }
  const out = snap.quotas.find(q => q.status === 'gassedOut' && q.resetsAt != null)
  if (out) return { kind: 'hold', until: out.resetsAt! + MIN, why: `Gassed out: ${out.name} resets at ${clockAt(out.resetsAt!, out.resetsAt! - snap.at >= 86400_000)}` }
  // In burst the rate is the person's call: only a quota already gassed out holds
  const fast = auto.burst ? undefined : snap.quotas.find(q => q.rate.level === 'fast')
  if (fast) {
    const when = fast.rate.emptyIn != null ? ` gasses out in ${formatDuration(fast.rate.emptyIn)}` : ' runs out before it resets'
    return { kind: 'hold', until: snap.at + PACING_HOLD, why: `Pacing: at this rate ${fast.name}${when}` }
  }
  // Background work reports by starting a turn of its own: prompting meanwhile only spends turns
  const stalls = i.progressed == null ? (auto.stalls ?? 0) : i.progressed ? 0 : (auto.stalls ?? 0) + 1
  if (marker.kind === 'waiting') return { kind: 'wait', until: snap.at + WAIT_CHECK, why: `Waiting on ${marker.reason ?? 'background work'}`, stalls }
  if (i.progressed === false && stalls >= STALL_LIMIT) return { kind: 'wait', until: snap.at + stallWait(stalls), why: `No progress in ${stalls} turns: waiting for background work to report`, stalls }
  const c = snap.cache
  if (c && (fill(snap) >= HEAVY || (c.secondsLeft === 0 && c.tokens >= COLD_LARGE))) return { kind: 'handoff', prompt: handoffPrompt(auto.plan, snap), stalls }
  return { kind: 'continue', prompt: continuePrompt(auto.plan, snap), stalls }
}

/** What the next turn should know about pacing: said in the prompt, never in the system prompt, which stays cached */
export function pacingNote(s: PaceSnapshot): string {
  const notes: string[] = []
  const over = s.quotas.find(q => q.key !== 'five_hour' && (q.status === 'over' || q.rate.level === 'burst'))
  if (over) notes.push(`${over.name} is over pace: hand searches, reads and routine edits to subagents on a lighter model (haiku, sonnet).`)
  if (s.quotas.some(q => q.rate.level === 'brisk' || q.rate.level === 'burst')) notes.push('Spending is brisk: do fewer, fuller steps.')
  return notes.length ? ` Pace: ${notes.join(' ')}` : ''
}

export const startPrompt = (plan: string) =>
  `Work through the plan in ${plan}, one step per turn, following pace's auto mode instructions. Start with its first unfinished step.`

export const continuePrompt = (plan: string, s: PaceSnapshot) => `Continue with the next unfinished step of ${plan}.${pacingNote(s)}`

export const handoffPrompt = (plan: string, s: PaceSnapshot) =>
  `Resume the plan in ${plan} from ${HANDOFF_FILE}: it says what is done, what is next and what you need to know. Then continue with the next unfinished step.${pacingNote(s)}`

/** Auto mode's instructions, a system-prompt section while it runs: fixed text, so the prompt cache keeps it */
export function protocol(): string {
  return [
    '# Auto mode (pace)',
    'You are working through a plan with no one at the keyboard. pace sends the next prompt after each turn.',
    '- Do one step of the plan per turn, then stop. Tick it off in the plan file when it is done.',
    '- Never wait for the user. Where you would ask, take the recommended option and say which you took.',
    '- When you hand the user a task or need their feedback (a decision only they can make, a credential, an action on their machine or an account), end the turn with `PACE: BLOCKED <what you need>`: pace stops and tells them. Never end a turn on a question.',
    `- Before ending each turn, update ${HANDOFF_FILE}: what is done, what is next, and the facts a fresh session needs (files, commands, decisions). pace may clear the context and resume from it.`,
    '- Use subagents for work that does not need the main thread: searches, reading many files, mechanical edits, test runs. Give them a lighter model (haiku for search and reads, sonnet for routine edits) and keep the main thread for decisions.',
    '- Never poll background work (a shell, a subagent, CI). When the next step waits on it, end the turn with `PACE: WAITING <what>`: pace sends nothing, and Claude Code starts your next turn when it reports.',
    '- Before ending a turn with `PACE: DONE` or `PACE: BLOCKED`, write a closing report for the user, who was away, under these headings: **What got done** (each step finished this run, one line each); **Why it stopped** (the plan is finished, or what blocks it); **What needs you** (each thing only the user can do, with its reason and its urgency: blocking, soon or whenever, most urgent first; "Nothing" when there is none); **How to do it** (the exact steps or commands for each); **The plan now** (the plan file\'s checklist as it stands after this run, ticked and unticked).',
    '- End every turn with exactly one line: `PACE: NEXT` when steps remain, `PACE: WAITING <what>` while background work runs, `PACE: DONE` when the plan is finished, or `PACE: BLOCKED <reason>` when you cannot go on without the user.',
  ].join('\n')
}

type Question = { question: string; header?: string; kind?: string; multiSelect?: boolean; options: readonly { label: string }[]; min?: number; max?: number; defaultValue?: number }

/** Answers to `AskUserQuestion` for auto mode: the option marked `(Recommended)`, else the first */
export function answerQuestions(questions: readonly Question[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const q of questions) {
    if (q.kind === 'number') out[q.question] = String(q.defaultValue ?? q.min ?? 0)
    else if (q.kind === 'text' || !q.options.length) out[q.question] = 'Use your judgment and take the recommended approach.'
    else out[q.question] = (q.options.find(o => /\(recommended\)/i.test(o.label)) ?? q.options[0]!).label
  }
  return out
}

/** Effort levels, lightest first */
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const

/** A rate known to run a quota out before its reset: a burst, or too fast with a run-out behind it */
export const runsOut = (s: PaceSnapshot) => s.quotas.some(q => (q.rate.level === 'burst' || q.rate.level === 'fast') && q.rate.emptyIn != null)

/**
 * On pace mode's effort for a request: one level lighter than asked while the rate would run a quota out before
 * its reset, the effort asked otherwise. A lighter effort, not a lighter model: a model switch rewrites the cache.
 */
export function effortFor<T extends string | number | undefined>(s: PaceSnapshot, effort: T): T {
  const i = EFFORTS.indexOf(effort as (typeof EFFORTS)[number])
  if (i <= 0 || !runsOut(s)) return effort
  return EFFORTS[i - 1] as T
}

/** On pace mode after a turn: compact a heavy context while the cache is warm, when reading it is cheapest */
export function upkeep(s: PaceSnapshot): 'compact' | null {
  return s.cache && s.cache.secondsLeft > 0 && fill(s) >= HEAVY ? 'compact' : null
}

/** The warm mode in force: yours when set, else on pace mode's own, compacting a large context and pinging a small one */
export function warmModeFor(o: { onPace: boolean; warm: PaceWarmMode }, s: PaceSnapshot): PaceWarmMode {
  if (o.warm !== 'off' || !o.onPace) return o.warm
  return fill(s) >= 0.3 ? 'compact' : 'ping'
}
