// pace between an ACP client and an ACP agent (.agents/decisions/0019-acp-adapter.md): every message passes through,
// and what pace needs of it comes out as metered events for core/meter.ts. A `/pace` prompt never reaches the agent:
// pace answers it as the turn's message. Auto mode's prompts and ultra pace's gears go to the agent on ids of pace's
// own, whose answers reach no client. JSON-RPC 2.0, ACP v1. Pure; the shell (bin/pace-acp.ts) does the I/O.

import { paceArgsOf } from '../../core/command.ts'

/** A JSON-RPC message, as much of it as pace reads */
export type Rpc = { jsonrpc: '2.0'; id?: number | string; method?: string; params?: any; result?: any; error?: any }

/** A select option the agent offers: its id, its value now, the values it takes */
export type Option = { id: string; current: string; values: string[] }

/** What pace meters from the traffic */
export type Metered =
  | { kind: 'session'; session: string; cwd: string }
  | { kind: 'prompt'; session: string }
  | { kind: 'usage'; session: string; context: { tokens: number; window: number }; spent: number }

export type ProxyState = {
  /** Prompts on their way, by request id: the session each is for */
  pending: Record<string, string>
  /** `session/new` requests on their way, by id: the folder each named */
  newAt: Record<string, string>
  /** Each session's cumulative cost in dollars, as last told */
  cost: Record<string, number>
  /** What the agent said in each session's turn so far */
  said: Record<string, string>
  /** Each session's model and thinking options */
  options: Record<string, { model?: Option; thought?: Option }>
  /** The last id pace used of its own */
  ours: number
}

export const PROXY_START: ProxyState = { pending: {}, newAt: {}, cost: {}, said: {}, options: {}, ours: 0 }

export type ProxyOut = {
  toAgent: Rpc[]
  toClient: Rpc[]
  meter: Metered[]
  /** A `/pace` prompt for pace to carry out and answer (answerPrompt) */
  command?: { id: number | string; session: string; args: string }
  /** A turn ended: how, and what the agent said in it */
  turnEnd?: { session: string; stopReason: string; answer: string }
}

const out = (o: Partial<ProxyOut> = {}): ProxyOut => ({ toAgent: [], toClient: [], meter: [], ...o })
const isOurs = (id: unknown) => typeof id === 'string' && id.startsWith('pace-')
const without = <T>(r: Record<string, T>, k: string) => Object.fromEntries(Object.entries(r).filter(([x]) => x !== k)) as Record<string, T>

/** A prompt's text: its text blocks joined */
const textOf = (prompt: unknown) => (Array.isArray(prompt) ? prompt.filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n') : '')

/** A message from the client */
export function fromClient(s: ProxyState, m: Rpc): [ProxyState, ProxyOut] {
  if (m.method === 'session/new' && m.id != null) {
    return [{ ...s, newAt: { ...s.newAt, [String(m.id)]: String(m.params?.cwd ?? '') } }, out({ toAgent: [m] })]
  }
  if (m.method === 'session/prompt' && m.id != null) {
    const session = String(m.params?.sessionId ?? '')
    const args = paceArgsOf(textOf(m.params?.prompt))
    if (args != null) return [s, out({ command: { id: m.id, session, args } })]
    return [{ ...s, pending: { ...s.pending, [String(m.id)]: session }, said: { ...s.said, [session]: '' } }, out({ toAgent: [m], meter: [{ kind: 'prompt', session }] })]
  }
  return [s, out({ toAgent: [m] })]
}

function optionOf(o: any): Option | undefined {
  if (o?.type !== 'select' || typeof o.id !== 'string' || !Array.isArray(o.options)) return undefined
  const values = o.options.flatMap((x: any) => (Array.isArray(x?.options) ? x.options : [x])).map((x: any) => x?.value).filter((v: unknown): v is string => typeof v === 'string')
  return { id: o.id, current: String(o.currentValue ?? ''), values }
}

function optionsOf(list: unknown): { model?: Option; thought?: Option } {
  const all = Array.isArray(list) ? list : []
  const model = optionOf(all.find((o: any) => o?.category === 'model'))
  const thought = optionOf(all.find((o: any) => o?.category === 'thought_level'))
  return { ...(model ? { model } : {}), ...(thought ? { thought } : {}) }
}

/** A message from the agent */
export function fromAgent(s: ProxyState, m: Rpc): [ProxyState, ProxyOut] {
  const id = m.id != null ? String(m.id) : null
  // A response to a request
  if (id != null && m.method == null) {
    const toClient = isOurs(m.id) ? [] : [m]
    if (id in s.newAt && typeof m.result?.sessionId === 'string') {
      const session = m.result.sessionId as string
      return [{ ...s, newAt: without(s.newAt, id), options: { ...s.options, [session]: optionsOf(m.result.configOptions) } }, out({ toClient, meter: [{ kind: 'session', session, cwd: s.newAt[id]! }] })]
    }
    if (id in s.pending) {
      const session = s.pending[id]!
      const turnEnd = { session, stopReason: String(m.result?.stopReason ?? (m.error ? 'error' : 'end_turn')), answer: s.said[session] ?? '' }
      return [{ ...s, pending: without(s.pending, id) }, out({ toClient, turnEnd })]
    }
    return [s, out({ toClient })]
  }
  if (m.method !== 'session/update') return [s, out({ toClient: [m] })]
  const session = String(m.params?.sessionId ?? '')
  const u = m.params?.update
  switch (u?.sessionUpdate) {
    case 'usage_update': {
      if (typeof u.used !== 'number' || typeof u.size !== 'number') return [s, out({ toClient: [m] })]
      const usd = u.cost?.currency === 'USD' && typeof u.cost.amount === 'number' ? u.cost.amount : null
      const spent = usd != null ? Math.max(0, usd - (s.cost[session] ?? 0)) : 0
      const next = usd != null ? { ...s, cost: { ...s.cost, [session]: usd } } : s
      return [next, out({ toClient: [m], meter: [{ kind: 'usage', session, context: { tokens: u.used, window: u.size }, spent: Math.round(spent * 1e6) / 1e6 }] })]
    }
    case 'agent_message_chunk': {
      const text = u.content?.type === 'text' && typeof u.content.text === 'string' ? u.content.text : ''
      return [{ ...s, said: { ...s.said, [session]: (s.said[session] ?? '') + text } }, out({ toClient: [m] })]
    }
    case 'available_commands_update': {
      const commands = Array.isArray(u.availableCommands) ? u.availableCommands.filter((c: any) => c?.name !== 'pace') : []
      const pace = { name: 'pace', description: 'pace: quotas, the fleet, auto mode', input: { hint: 'pane | band | fleet | auto [plan] | …' } }
      return [s, out({ toClient: [{ ...m, params: { ...m.params, update: { ...u, availableCommands: [...commands, pace] } } }] })]
    }
    case 'config_option_update': {
      return [{ ...s, options: { ...s.options, [session]: optionsOf(u.configOptions) } }, out({ toClient: [m] })]
    }
  }
  return [s, out({ toClient: [m] })]
}

/** `/pace`'s answer to the client: shown as the turn's message, and the turn ended. The agent never sees either */
export function answerPrompt(session: string, id: number | string, text: string): Rpc[] {
  return [
    { jsonrpc: '2.0', method: 'session/update', params: { sessionId: session, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } },
    { jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } },
  ]
}

/** A prompt of pace's own (auto mode's next) to the agent */
export function sendPrompt(s: ProxyState, session: string, text: string): [ProxyState, Rpc] {
  const id = `pace-${s.ours + 1}`
  return [{ ...s, ours: s.ours + 1, pending: { ...s.pending, [id]: session }, said: { ...s.said, [session]: '' } }, { jsonrpc: '2.0', id, method: 'session/prompt', params: { sessionId: session, prompt: [{ type: 'text', text }] } }]
}

/** A config option pace sets (a gear: the model, the thinking level) */
export function setOption(s: ProxyState, session: string, configId: string, value: string): [ProxyState, Rpc] {
  const id = `pace-${s.ours + 1}`
  return [{ ...s, ours: s.ours + 1 }, { jsonrpc: '2.0', id, method: 'session/set_config_option', params: { sessionId: session, configId, value } }]
}
