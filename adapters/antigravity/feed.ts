// Antigravity's hooks, read into pace's feed: the hook's input, the history every Antigravity conversation shares,
// and a conversation's feed from it. Pure; times in ms.
//
// The readings are the account's, the same in every conversation, so the history is one for all of them: the
// readings, the prompts, and the runs already counted. Antigravity has no prompt hook: a prompt is the first
// PreInvocation of a run, the agent's loop the user's message started. A subagent's run is not the user prompting,
// and its hooks write its root conversation's feed.

import type { PaceSample } from '../../types'
import type { PaceFeed } from '../../core/host.ts'
import { appendSample, mergeSamples } from '../../core/quota.ts'
import { mergePrompts } from '../../core/rate.ts'

/** The hook events the adapter runs on; the payload does not name its event, so the hook's command line does */
export type HookEvent = 'PreInvocation' | 'Stop'

/** What the adapter needs of a hook's payload */
export type HookInput = {
  event: HookEvent
  /** The root conversation: a subagent's hooks are its root's */
  session: string
  cwd: string
  /** The run, the agent's loop one message started: its `executionId`, else the steps it started from */
  run: string
  /** What the user last sent; null when the payload does not say */
  lastInput: string | null
  subagent: boolean
}

/** What every Antigravity conversation shares: the readings, the prompts, the runs already counted */
export type History = { samples: PaceSample[]; prompts: number[]; runs: string[]; account?: string }
export const EMPTY: History = { samples: [], prompts: [], runs: [] }

const EVENTS: readonly HookEvent[] = ['PreInvocation', 'Stop']
/** Runs remembered: enough to tell the run going on in each conversation from a new one */
const RUNS_KEPT = 200

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v != null && !Array.isArray(v)
const text = (v: unknown) => (typeof v === 'string' && v ? v : null)

function parse(s: string): unknown {
  try {
    return JSON.parse(s)
  } catch {
    return undefined
  }
}

/** A hook's input from its payload and the event its command line names; null for one pace does not run on */
export function hookInputOf(payload: string, event: string): HookInput | null {
  const v = parse(payload)
  if (!isObject(v) || !EVENTS.includes(event as HookEvent)) return null
  const conversation = text(v.conversationId)
  if (!conversation) return null
  const steps = typeof v.initialNumSteps === 'number' ? v.initialNumSteps : 0
  return {
    event: event as HookEvent,
    session: text(v.rootConversationId) ?? conversation,
    cwd: Array.isArray(v.workspacePaths) ? text(v.workspacePaths[0]) ?? '' : '',
    run: text(v.executionId) ?? `steps-${steps}`,
    lastInput: text(v.lastUserInput),
    subagent: text(v.parentConversationId) != null,
  }
}

/** `/pace`'s arguments, '' for none, when the user's message is pace's own; null for any other */
export function paceArgOf(message: string | null): string | null {
  const m = /^\s*\/pace(?::pace)?(?:\s+(.*?))?\s*$/s.exec(message ?? '')
  return m ? (m[1] ?? '').replace(/\s+/g, ' ') : null
}

/** The history after a hook: a run's first PreInvocation counted as a prompt, unless it is a subagent's or /pace; the reading kept */
export function nextHistory(h: History, input: HookInput, sample: PaceSample | null, now: number): History {
  const key = `${input.session}:${input.run}`
  const counted = h.runs.includes(key)
  const isPrompt = input.event === 'PreInvocation' && !input.subagent && !counted && paceArgOf(input.lastInput) == null
  return {
    samples: sample ? appendSample(h.samples, sample) : h.samples,
    prompts: mergePrompts(h.prompts, isPrompt ? [now] : [], now),
    runs: input.event === 'PreInvocation' && !counted ? [...h.runs, key].slice(-RUNS_KEPT) : h.runs,
    ...(h.account ? { account: h.account } : {}),
  }
}

/** A stored history, what of it parses */
export function historyOf(stored: string): History {
  const v = parse(stored)
  if (!isObject(v)) return EMPTY
  return {
    samples: Array.isArray(v.samples) ? mergeSamples([], v.samples) : [],
    prompts: Array.isArray(v.prompts) ? v.prompts.filter((t): t is number => typeof t === 'number' && Number.isFinite(t)) : [],
    runs: Array.isArray(v.runs) ? v.runs.filter((r): r is string => typeof r === 'string') : [],
    ...(typeof v.account === 'string' && v.account ? { account: v.account } : {}),
  }
}

/** A conversation's feed: the shared history, with no cache and no dollars, since Antigravity reports neither */
export function feedOfHistory(h: History, input: HookInput, now: number, terminal?: string): PaceFeed {
  return {
    version: 1, host: 'antigravity', provider: 'antigravity', ...(h.account ? { account: h.account } : {}), session: input.session,
    ...(terminal ? { terminal } : {}),
    cwd: input.cwd, at: now,
    snapshot: { samples: h.samples, prompts: h.prompts, cache: null, noCache: true },
  }
}
