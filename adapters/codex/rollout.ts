// Codex's rollout and hook input, read into pace's feed. The rollout is not a stable interface: any line this cannot
// read is dropped, and the tests pin the shapes Codex 0.161 writes. Pure; times in ms.
//
// A `token_count` event is a reading: `rate_limits.primary` is the 5-hour window, `secondary` the week, each
// `{ used_percent, resets_at }` with the reset in seconds; `info.last_token_usage` and `model_context_window` are the
// context. Prompts come from the UserPromptSubmit hook, not the rollout.

import type { PaceReading, PaceSample } from '../../types'
import type { PaceContext, PaceFeed } from '../../core/host.ts'
import { meter, type Metered } from '../../core/meter.ts'
import type { Tokens } from '../../core/log.ts'
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
export type RolloutRead = { samples: PaceSample[]; context: PaceContext | null; usage: { at: number; tokens: Tokens; model?: string }[]; last: RolloutLast }
/** Where a read of the rollout ended: the running token totals and the model, for the next read to go on from */
export type RolloutLast = { total: Totals | null; model?: string }
type Totals = { input: number; cached: number; cacheWrite: number; output: number; reasoning: number }

const n = (v: unknown) => (isNumber(v) && v >= 0 ? v : 0)

function totalsOf(info: unknown): Totals | null {
  if (!isObject(info) || !isObject(info.total_token_usage)) return null
  const u = info.total_token_usage
  return { input: n(u.input_tokens), cached: n(u.cached_input_tokens), cacheWrite: n(u.cache_write_input_tokens), output: n(u.output_tokens), reasoning: n(u.reasoning_output_tokens) }
}

/**
 * A reply's tokens: what the running totals grew by. Codex counts the cached input in the input and the reasoning
 * in the output; pace keeps the cache apart. Null when they did not grow (a count that only updates the limits)
 */
function grewBy(before: Totals | null, after: Totals): Tokens | null {
  const b = before ?? { input: 0, cached: 0, cacheWrite: 0, output: 0, reasoning: 0 }
  const d = { input: after.input - b.input, cached: after.cached - b.cached, cacheWrite: after.cacheWrite - b.cacheWrite, output: after.output - b.output, reasoning: after.reasoning - b.reasoning }
  // A total that went down started over (a new session's rollout): count it from nothing
  if (Object.values(d).some(x => x < 0)) return grewBy(null, after)
  if (!d.input && !d.output && !d.cacheWrite) return null
  return { input: Math.max(0, d.input - d.cached), output: d.output, cacheRead: d.cached, cacheWrite: d.cacheWrite, reasoning: d.reasoning }
}

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

/** The readings, the last context and each reply's tokens in a stretch of rollout lines, read on from `last` */
export function rolloutOf(text: string, last: RolloutLast = { total: null }): RolloutRead {
  const samples: PaceSample[] = []
  const usage: RolloutRead['usage'] = []
  let context: PaceContext | null = null
  let { total, model } = last
  for (const line of text.split('\n')) {
    const o = parse(line)
    if (isObject(o) && o.type === 'turn_context' && isObject(o.payload) && typeof o.payload.model === 'string') model = o.payload.model
    if (!isObject(o) || o.type !== 'event_msg' || !isObject(o.payload) || o.payload.type !== 'token_count') continue
    const at = typeof o.timestamp === 'string' ? Date.parse(o.timestamp) : NaN
    if (!Number.isFinite(at)) continue
    const sample = sampleOf(at, o.payload.rate_limits)
    if (sample) samples.push(sample)
    context = contextOf(o.payload.info) ?? context
    const now = totalsOf(o.payload.info)
    if (now) {
      const tokens = grewBy(total, now)
      if (tokens) usage.push({ at, tokens, ...(model ? { model } : {}) })
      total = now
    }
  }
  return { samples, context, usage, last: { total, ...(model ? { model } : {}) } }
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
  return meter(prev, codexMetered(input, read, now, terminal, account), siblings, { cache: false, estimate: false })
}

/** What a hook metered: a prompt submitted, and what the rollout added */
export function codexMetered(input: HookInput, read: RolloutRead, now: number, terminal?: string, account?: string): Metered {
  return {
    host: 'codex', provider: 'codex', ...(account ? { account } : {}), session: input.session, cwd: input.cwd, now,
    ...(terminal ? { terminal } : {}),
    prompted: input.event === 'UserPromptSubmit' && reachesModel(input.prompt ?? ''),
    samples: read.samples, context: read.context,
  }
}

/** Whether a prompt goes on to the model: any but a /pace that pace answers itself; auto mode's start and resume go on */
function reachesModel(prompt: string): boolean {
  const args = paceArgsOf(prompt)
  if (args == null) return true
  const kind = commandOf(args).kind
  return kind === 'auto' || kind === 'resume'
}
