#!/usr/bin/env node
// pace as an ACP proxy (.agents/decisions/0019-acp-adapter.md): `pace-acp [--host h] [--provider p] -- <agent command>`.
// An ACP client (Zed, Herdr, any) runs this in the agent's place; it runs the agent, passes every message through
// (adapters/acp/proxy.ts), and meters the sessions into their feeds (core/meter.ts). `/pace` is answered here and
// never reaches the agent; auto mode's next prompts go to the agent from here. Under `agy`, pace starts it with a
// CSRF token of its own (ANTIGRAVITY_CSRF_TOKEN), so it can ask its language server for each model's quota.

import { execFileSync, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { createInterface } from 'node:readline'

import type { PaceGears, PaceSample } from '../types'
import { ladderFor, type Ladder } from '../core/gears.ts'
import { headroomOf, shiftGears, startGears } from '../core/throttle.ts'
import { plainText, plansFor, route, stepOf, viewLines, type Host, type PaceAction } from '../core/api.ts'
import { continuePrompt, decide, protocol, resumed, startPrompt } from '../core/auto.ts'
import { commandOf } from '../core/command.ts'
import { feedFile, HOSTS, PROVIDERS, type PaceFeed, type PaceHost, type PaceProvider } from '../core/host.ts'
import { eventsOf } from '../core/log.ts'
import { meter, type Metered } from '../core/meter.ts'
import { snapshotOf } from '../core/model.ts'
import { accountFor } from '../adapters/account.ts'
import { answerPrompt, fromAgent, fromClient, PROXY_START, sendPrompt, setOption, type Rpc } from '../adapters/acp/proxy.ts'
import { readingNow } from '../adapters/antigravity/server.ts'
import { appendLog, pruneLog, sessionFeeds, writeFeed } from '../adapters/log.ts'
import { liveFeeds, openView } from '../adapters/views.ts'

const ASK_EVERY_MS = 60_000
const TEXT_COLS = 90

/** The arguments: the host and provider pace meters for (from the agent's name when not given), and the agent's command */
function argsOf(argv: readonly string[]): { host: PaceHost; provider: PaceProvider; command: string[] } {
  const at = argv.indexOf('--')
  const own = at < 0 ? [] : argv.slice(0, at)
  const command = at < 0 ? [...argv] : argv.slice(at + 1)
  const flag = (name: string) => { const i = own.indexOf(name); return i >= 0 ? own[i + 1] : undefined }
  const name = basename(command[0] ?? '')
  const guess: PaceProvider = name === 'agy' ? 'antigravity' : /codex/.test(name) ? 'codex' : 'claude'
  const provider = (flag('--provider') as PaceProvider | undefined) ?? guess
  return { host: (flag('--host') as PaceHost | undefined) ?? provider, provider, command }
}

const { host, provider, command } = argsOf(process.argv.slice(2))
// A feed no reader accepts would be metered and never shown: refuse it at the start
if (!PROVIDERS.includes(provider) || !HOSTS.includes(host) || !command.length) {
  process.stderr.write(`pace-acp [--host h] [--provider p] -- <agent command>\n--provider takes ${PROVIDERS.slice(0, -1).join(', ')} or ${PROVIDERS.at(-1)}; --host takes ${HOSTS.join(', ')}\n`)
  process.exit(2)
}
const home = homedir()
const token = provider === 'antigravity' ? process.env.ANTIGRAVITY_CSRF_TOKEN || randomBytes(16).toString('hex') : undefined
const agent = spawn(command[0]!, command.slice(1), { stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env, ...(token ? { ANTIGRAVITY_CSRF_TOKEN: token } : {}) } })
let state = PROXY_START
const sessions = new Map<string, { cwd: string; feed: PaceFeed | null }>()
let lastAsk = 0
let readings: PaceSample[] = []
let account: string | undefined

const toClient = (m: Rpc) => process.stdout.write(`${JSON.stringify(m)}\n`)
const toAgent = (m: Rpc) => agent.stdin.write(`${JSON.stringify(m)}\n`)

/** Every live feed but this session's */
const own = (session: string) => (f: PaceFeed) => f.host === host && f.session === session
const othersOf = (session: string, now: number): PaceFeed[] => liveFeeds(home, now, own(session))

/** Antigravity's readings, at most once a minute, from the agy pace started */
async function readNow(now: number): Promise<PaceSample[]> {
  if (!token || !agent.pid || now - lastAsk < ASK_EVERY_MS) return []
  lastAsk = now
  const read = await readingNow(readings, now, { pid: agent.pid, csrf: token }).catch(() => null)
  if (!read) return []
  account = accountFor(home, provider, read.email) ?? account
  readings = [...readings, read.sample].slice(-500)
  return [read.sample]
}

/** Metering in order: each event's feed builds on the last one's, so two events never race */
let queue: Promise<unknown> = Promise.resolve()
function record(session: string, e: Parameters<typeof recordNow>[1]): Promise<PaceFeed | null> {
  const next = queue.then(() => recordNow(session, e))
  queue = next.catch(() => null)
  return next
}

/** A session's feed after what was metered */
async function recordNow(session: string, e: { prompted?: boolean; spent?: number; context?: { tokens: number; window: number } }): Promise<PaceFeed | null> {
  const s = sessions.get(session)
  if (!s) return null
  const now = Date.now()
  const samples = await readNow(now)
  const metered: Metered = {
    host, provider, ...(account ? { account } : {}), session, cwd: s.cwd, now,
    ...(process.env.HC_TERMINAL_ID ? { terminal: process.env.HC_TERMINAL_ID } : {}),
    samples, ...e,
  }
  // A proxy started again carries on from the session's own history
  const feeds = sessionFeeds(home, now, own(session))
  const feed = meter(s.feed ?? feeds.own, metered, feeds.others, { cache: false, estimate: !token })
  // The events after the feed is worked out from the log, so none is counted twice
  appendLog(home, host, { provider, ...(account ? { account } : {}), session }, eventsOf(metered), now)
  writeFeed(join(home, feedFile(host, session)), feed)
  pruneLog(home, now)
  s.feed = feed
  return feed
}

/** The agent's ladder in a session: the models and thinking levels it offers (core/gears.ts); null when it offers neither */
function acpLadder(session: string): Ladder | null {
  const o = state.options[session]
  if (!o?.model && !o?.thought) return null
  return ladderFor(provider, o.model?.values ?? [], o.thought?.values ?? [])
}

/** Ultra pace's next gear in a session, set on the agent: the thinking level at once, the model once the turn is over */
function shift(session: string, g: PaceGears, feed: PaceFeed): PaceGears {
  const ladder = acpLadder(session)
  const o = state.options[session]
  if (!ladder || !o) return g
  const snap = snapshotOf(feed.snapshot, Date.now())
  // No cache is reported over ACP: a model changes between turns, where a new one starts cold all the same
  const { gears, set } = shiftGears(g, headroomOf(snap, g.gear.model), ladder, true)
  for (const [option, value] of [[o.model, set.model], [o.thought, set.effort]] as const) {
    if (!option || !value) continue
    const [next, m] = setOption(state, session, option.id, value)
    state = next
    toAgent(m)
  }
  return gears
}

/** The host this agent is, over ACP: an answer, Herdr, tmux, a window; pace sends its prompts, and sets its gear where it offers one */
function acpHost(session?: string): Host {
  const o = session ? state.options[session] : undefined
  const surfaces: Host['surfaces'] = [...(process.env.HC_TERMINAL_ID ? ['herdr' as const] : []), ...(process.env.TMUX ? ['split' as const] : []), 'answer', ...(process.platform === 'darwin' ? ['window' as const] : [])]
  const drives: Host['drives'] = ['prompt', ...(o?.model ? ['model' as const] : []), ...(o?.thought ? ['effort' as const] : [])]
  // The proxy keeps no modes of its own: auto mode and ultra pace live in the feed, on pace and warm mode nowhere yet
  return { name: host === 'antigravity' ? 'Antigravity' : `this ${host} agent`, input: 'prompt', surfaces, drives, cache: false, keeps: [] }
}

/** A view opened where the core routed it (adapters/views.ts); what to say back */
const show = (feed: PaceFeed, a: Extract<PaceAction, { kind: 'open' }>) =>
  openView({ home, feed, feedPath: join(home, feedFile(host, feed.session)), hostName: host, others: () => othersOf(feed.session, Date.now()) }, a)

function setAuto(session: string, auto: PaceFeed['snapshot']['auto'] | null): void {
  const s = sessions.get(session)
  if (!s?.feed) return
  const { auto: _, ...rest } = s.feed.snapshot
  s.feed = { ...s.feed, snapshot: auto ? { ...rest, auto } : rest }
  writeFeed(join(home, feedFile(host, session)), s.feed)
}

/** Sends a prompt of pace's own to the agent */
function prompt(session: string, text: string): void {
  const [next, m] = sendPrompt(state, session, text)
  state = next
  toAgent(m)
  void record(session, { prompted: true })
}

/** `/pace <args>` for a session: carried out, and what to say back */
async function paceCommand(session: string, args: string): Promise<string> {
  const feed = sessions.get(session)?.feed ?? (await record(session, {}))
  if (!feed) return 'pace has not seen this session start'
  const a = route(commandOf(args), acpHost(session))
  const auto = feed.snapshot.auto ?? null
  switch (a.kind) {
    case 'say': case 'refresh': case 'prefs': return a.text
    case 'open': return show(feed, a)
    case 'auto':
      setAuto(session, { plan: a.plan, turns: 1, max: a.max })
      setTimeout(() => prompt(session, `${protocol()}\n\n${startPrompt(a.plan)}`), 0)
      return `Auto mode on: ${a.plan}`
    case 'resume':
      if (!auto) return 'Auto mode is not running: /pace auto <plan file> starts it'
      setAuto(session, resumed(auto))
      setTimeout(() => prompt(session, `${protocol()}\n\n${continuePrompt(auto.plan, snapshotOf(feed.snapshot, Date.now()))}`), 0)
      return `Auto mode resumed: ${auto.plan}`
    case 'ultra': {
      const ladder = acpLadder(session)
      const o = state.options[session]
      if (!ladder || !o) return 'Ultra pace needs an agent that offers a model or a thinking level'
      const gears = startGears(ladder, o.model?.current ?? '', o.thought?.current ?? '', a.floor, a.ceiling)
      setAuto(session, { plan: a.plan, turns: 1, max: a.max, gears })
      setTimeout(() => prompt(session, `${protocol()}\n\n${startPrompt(a.plan)}`), 0)
      return `Ultra pace on: ${a.plan}, from ${gears.floor} to ${gears.ceiling}`
    }
    case 'stop':
      setAuto(session, null)
      return a.text
    case 'burst': {
      if (!auto) return 'Auto mode is not running: /pace auto <plan file> starts it'
      const { burst: _, ...rest } = auto
      setAuto(session, a.on ? { ...rest, burst: true } : rest)
      return a.on ? 'Burst on' : 'Burst off'
    }
    default: return 'Not over ACP yet'
  }
}

/** Auto mode at a turn's end: core/auto.ts decides, the proxy carries it out */
function afterTurn(session: string, answer: string, stopReason: string): void {
  const feed = sessions.get(session)?.feed
  const was = feed?.snapshot.auto
  if (!feed || !was || was.paused) return
  // Ultra pace's gear shifts at every turn's end, whatever auto mode decides next
  const auto = was.gears ? { ...was, gears: shift(session, was.gears, feed) } : was
  const step = stepOf(decide({ auto, snap: snapshotOf(feed.snapshot, Date.now()), answer, aborted: stopReason === 'cancelled' }), acpHost(session), Date.now())
  if (step.kind === 'send') {
    setAuto(session, { ...auto, turns: auto.turns + 1 })
    return prompt(session, step.prompt)
  }
  if (step.kind === 'hold') {
    setAuto(session, { ...auto, heldUntil: step.until })
    setTimeout(() => { const a = sessions.get(session)?.feed?.snapshot.auto; if (a) { const { heldUntil: _, ...rest } = a; setAuto(session, rest); afterTurn(session, '', 'end_turn') } }, Math.max(0, step.until - Date.now())).unref()
    return
  }
  setAuto(session, step.kind === 'pause' ? { ...auto, paused: true, why: step.message } : null)
}

createInterface({ input: process.stdin }).on('line', line => {
  let m: Rpc
  try { m = JSON.parse(line) } catch { return }
  const [next, out] = fromClient(state, m)
  state = next
  out.toAgent.forEach(toAgent)
  for (const e of out.meter) if (e.kind === 'prompt') void record(e.session, { prompted: true })
  if (out.command) {
    const c = out.command
    void paceCommand(c.session, c.args).then(text => answerPrompt(c.session, c.id, text).forEach(toClient))
  }
}).on('close', () => agent.stdin.end())

createInterface({ input: agent.stdout }).on('line', line => {
  let m: Rpc
  try { m = JSON.parse(line) } catch { return }
  const [next, out] = fromAgent(state, m)
  state = next
  out.toClient.forEach(toClient)
  for (const e of out.meter) {
    if (e.kind === 'session') {
      sessions.set(e.session, { cwd: e.cwd, feed: null })
      void record(e.session, {})
    }
    if (e.kind === 'usage') void record(e.session, { spent: e.spent, context: e.context })
  }
  if (out.turnEnd) afterTurn(out.turnEnd.session, out.turnEnd.answer, out.turnEnd.stopReason)
})

agent.on('exit', code => process.exit(code ?? 0))
