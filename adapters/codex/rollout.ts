// Codex's rollout and hook input, read into pace's feed. The rollout is not a stable interface: any line this cannot
// read is dropped, and the tests pin the shapes Codex 0.161 writes. Pure; times in ms.
//
// A `token_count` event is a reading: `rate_limits.primary` is the 5-hour window, `secondary` the week, each
// `{ used_percent, resets_at }` with the reset in seconds; `info.last_token_usage` and `model_context_window` are the
// context. Prompts come from the UserPromptSubmit hook, not the rollout.

import type { PaceReading, PaceSample } from '../../types'
import type { PaceContext, PaceFeed } from '../../core/host.ts'
import { meter } from '../../core/meter.ts'
import { readingOf } from '../../core/quota.ts'
import { commandOf, paceArgsOf } from '../../core/command.ts'

/** The hook events the adapter runs on */
export type HookEvent = 'SessionStart' | 'UserPromptSubmit' | 'PostToolUse' | 'Stop' | 'Interrupt'

/**
 * What a hook needs of Codex's stdin: the event, the session, its rollout (null when Codex has none), folder, prompt,
 * and at a turn's end its last message, `answer`, which says how auto mode's turn ended
 */
export type HookInput = { event: HookEvent; session: string; transcript: string | null; cwd: string; prompt?: string; answer?: string }

/** What a stretch of rollout says: its readings, and the context as of its last reply (null when it has none) */
export type RolloutRead = { samples: PaceSample[]; context: PaceContext | null }

const EVENTS: readonly HookEvent[] = ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop', 'Interrupt']

/** The rate limit pace reads; Codex has written others (`premium`) with no windows */
const LIMIT = 'codex'

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v != null && !Array.isArray(v)
const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

function parse(line: string): unknown {
  try {
    return JSON.parse(line)
  } catch {
    return undefined
  }
}

/** One window of the rate limits, `{ used_percent, resets_at }`; null when it is not there */
function windowOf(v: unknown): PaceReading | null {
  return isObject(v) && isNumber(v.used_percent) ? readingOf(v.used_percent, v.resets_at) : null
}

/** A token count's readings; null for a line that is not one, or whose limit pace does not read */
function sampleOf(at: number, limits: unknown): PaceSample | null {
  if (!isObject(limits) || (limits.limit_id != null && limits.limit_id !== LIMIT)) return null
  const quotas: Record<string, PaceReading> = {}
  const five = windowOf(limits.primary)
  const week = windowOf(limits.secondary)
  if (five) quotas.five_hour = five
  if (week) quotas.seven_day = week
  return Object.keys(quotas).length ? { at, quotas } : null
}

function contextOf(info: unknown): PaceContext | null {
  if (!isObject(info) || !isObject(info.last_token_usage)) return null
  const tokens = info.last_token_usage.total_tokens
  const window = info.model_context_window
  return isNumber(tokens) && isNumber(window) && window > 0 ? { tokens, window } : null
}

/** The readings and the last context in a stretch of rollout lines */
export function rolloutOf(text: string): RolloutRead {
  const samples: PaceSample[] = []
  let context: PaceContext | null = null
  for (const line of text.split('\n')) {
    const o = parse(line)
    if (!isObject(o) || o.type !== 'event_msg' || !isObject(o.payload) || o.payload.type !== 'token_count') continue
    const at = typeof o.timestamp === 'string' ? Date.parse(o.timestamp) : NaN
    if (!Number.isFinite(at)) continue
    const sample = sampleOf(at, o.payload.rate_limits)
    if (sample) samples.push(sample)
    context = contextOf(o.payload.info) ?? context
  }
  return { samples, context }
}

/** A hook's stdin as Codex sends it; null when it is not a hook input pace runs on */
export function hookInputOf(text: string): HookInput | null {
  const o = parse(text)
  if (!isObject(o) || !EVENTS.includes(o.hook_event_name as HookEvent)) return null
  if (typeof o.session_id !== 'string' || !o.session_id || typeof o.cwd !== 'string') return null
  const transcript = typeof o.transcript_path === 'string' && o.transcript_path ? o.transcript_path : null
  return {
    event: o.hook_event_name as HookEvent, session: o.session_id, transcript, cwd: o.cwd,
    ...(typeof o.prompt === 'string' ? { prompt: o.prompt } : {}),
    ...(typeof o.last_assistant_message === 'string' ? { answer: o.last_assistant_message } : {}),
  }
}

/**
 * The session's feed after a hook (core/meter.ts): what the rollout added, a prompt submitted, and the history of the
 * other live sessions on Codex's quota (`siblings`, any harness). Codex reports no cache and no dollars
 */
export function nextFeed(prev: PaceFeed | null, input: HookInput, read: RolloutRead, now: number, terminal?: string, siblings: readonly PaceFeed[] = [], account?: string): PaceFeed {
  return meter(prev, {
    host: 'codex', provider: 'codex', ...(account ? { account } : {}), session: input.session, cwd: input.cwd, now,
    ...(terminal ? { terminal } : {}),
    prompted: input.event === 'UserPromptSubmit' && reachesModel(input.prompt ?? ''),
    samples: read.samples, context: read.context,
  }, siblings, { cache: false, estimate: false })
}

/** Whether a prompt goes on to the model: any but a /pace that pace answers itself; auto mode's start and resume go on */
function reachesModel(prompt: string): boolean {
  const args = paceArgsOf(prompt)
  if (args == null) return true
  const kind = commandOf(args).kind
  return kind === 'auto' || kind === 'resume'
}
