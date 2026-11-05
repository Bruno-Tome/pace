// Rollout lines in the shapes Codex 0.161 writes, their numbers kept and their content left out, for the tests.

const NOW = Date.UTC(2026, 9, 17, 12, 0, 0)
const iso = (ms: number) => new Date(ms).toISOString()

/** The 5-hour window resets 2.5 hours from now, the week 3.5 days from now: in seconds, as Codex says */
export const FIVE_RESET_S = (NOW + 2.5 * 3600_000) / 1000
export const WEEK_RESET_S = (NOW + 3.5 * 86_400_000) / 1000

const usage = (total: number) => ({
  input_tokens: total - 68, cached_input_tokens: 7936, cache_write_input_tokens: 0, output_tokens: 68,
  reasoning_output_tokens: 0, total_tokens: total,
})

const limits = (five: number, week: number) => ({
  limit_id: 'codex', limit_name: null,
  primary: { used_percent: five, window_minutes: 300, resets_at: FIVE_RESET_S },
  secondary: { used_percent: week, window_minutes: 10080, resets_at: WEEK_RESET_S },
  credits: { has_credits: false, unlimited: false, balance: '0' },
  individual_limit: null, spend_control_reached: null, plan_type: 'plus', rate_limit_reached_type: null,
})

/** A token count: the session's usage, its last reply's and the context window, then the rate limits */
export const tokenCount = (at: number, five: number, week: number, total = 19_011) => JSON.stringify({
  timestamp: iso(at), ordinal: 13, type: 'event_msg',
  payload: { type: 'token_count', info: { total_token_usage: usage(total), last_token_usage: usage(total), model_context_window: 258_400 }, rate_limits: limits(five, week) },
})

/** A token count before any reply: no usage yet, the rate limits all the same */
export const tokenCountNoInfo = (at: number, five: number, week: number) => JSON.stringify({
  timestamp: iso(at), ordinal: 4, type: 'event_msg', payload: { type: 'token_count', info: null, rate_limits: limits(five, week) },
})

/** A token count from the `premium` limit, which Codex 0.153–0.155 wrote with no windows */
export const tokenCountPremium = (at: number) => JSON.stringify({
  timestamp: iso(at), ordinal: 9, type: 'event_msg',
  payload: { type: 'token_count', info: null, rate_limits: { ...limits(0, 0), limit_id: 'premium', primary: null, secondary: null } },
})

/** Lines a rollout holds around the token counts, which say nothing about the quotas */
export const sessionMeta = (at: number) => JSON.stringify({
  timestamp: iso(at), ordinal: 0, type: 'session_meta',
  payload: { session_id: '01a1aa40-0781-75c2-a5ae-6367b424026e', id: '01a1aa40-0781-75c2-a5ae-6367b424026e', cwd: '/work/pace', cli_version: '0.161.0', model_provider: 'openai', context_window: 258_400 },
})
export const taskStarted = (at: number) => JSON.stringify({ timestamp: iso(at), ordinal: 1, type: 'event_msg', payload: { type: 'task_started' } })
export const message = (at: number) => JSON.stringify({ timestamp: iso(at), ordinal: 2, type: 'response_item', payload: { type: 'message', role: 'user', content: [] } })

/** What Codex 0.161 sends a command hook on stdin, by event */
export const hookInput = (event: 'SessionStart' | 'UserPromptSubmit' | 'PostToolUse' | 'Stop', transcript: string | null) => JSON.stringify({
  session_id: '01a1aa40-0781-75c2-a5ae-6367b424026e', transcript_path: transcript, cwd: '/work/pace',
  hook_event_name: event, model: 'gpt-6-luna', permission_mode: 'default',
  ...(event === 'SessionStart' ? { source: 'startup' } : { turn_id: 'turn-1' }),
  ...(event === 'UserPromptSubmit' ? { prompt: 'p' } : {}),
  ...(event === 'Stop' ? { stop_hook_active: false, last_assistant_message: null } : {}),
  ...(event === 'PostToolUse' ? { tool_name: 'Bash', tool_use_id: 'call-1', tool_input: {}, tool_response: {} } : {}),
})
