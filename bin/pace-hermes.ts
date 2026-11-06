#!/usr/bin/env node
// pace's bridge for Hermes Agent: pace's Hermes plugin (adapters/hermes/plugin) runs it once per Hermes process and
// hands it, a JSON line each, what Hermes does: a session starting, a prompt, each API call's usage, the account
// windows Hermes reads, a turn's end and `/pace`. The bridge runs the core on them (core/meter.ts, core/api.ts) and
// answers on stdout: a command's reply by its id, and `_pace/inject` for the plugin to send into the session or the
// bot's chat (auto mode's next prompt). Session mode is `hermes chat`; bot mode is Hermes's messaging gateway.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { createInterface } from 'node:readline'

import type { PaceSample } from '../types'
import { route, stepOf } from '../core/api.ts'
import { emailOfJwt, soleAccount } from '../core/account.ts'
import { accountFor, accountForIdentity } from '../adapters/account.ts'
import { continuePrompt, decide, protocol, resumed, startPrompt } from '../core/auto.ts'
import { commandOf } from '../core/command.ts'
import { feedFile, type PaceFeed, type PaceProvider } from '../core/host.ts'
import { eventsOf } from '../core/log.ts'
import { meter, type Metered } from '../core/meter.ts'
import { snapshotOf } from '../core/model.ts'
import { cacheTtlOf, hermesHost, quotaOf, readingsOf, type HermesWindow } from '../adapters/hermes/events.ts'
import { appendLog, pruneLog, readFeeds, writeFeed } from '../adapters/log.ts'
import { liveFeeds, openView } from '../adapters/views.ts'

type Mode = 'session' | 'bot'
/** A Hermes session: where it runs, the quota it spends now, and its feed on each quota it has spent, so a move between Claude and ChatGPT keeps both */
type Session = { cwd: string; mode: Mode; key?: string; provider?: PaceProvider; feed: PaceFeed | null; feeds: Map<PaceProvider, PaceFeed>; prompted: number }

const home = homedir()
const sessions = new Map<string, Session>()
/** The newest account reading of each quota, joined to the next feed written on it */
const readings = new Map<PaceProvider, PaceSample>()
/** The account each quota's last reading was for, where Hermes names it (its credential pool rotates them) */
const accounts = new Map<PaceProvider, string>()

/**
 * The account a reading's identity names. Hermes names a ChatGPT credential `codex:<account>:<user>`: when Codex is
 * signed in here on that account, it is Codex's own (its email's hash), so the two harnesses meet; otherwise the
 * identity is hashed as it is
 */
function accountOfIdentity(q: PaceProvider, identity: string): string | undefined {
  const acct = /^codex:([^:]+):/.exec(identity)?.[1]
  if (q === 'codex' && acct) {
    try {
      const auth = JSON.parse(readFileSync(join(home, '.codex/auth.json'), 'utf8')) as { tokens?: { account_id?: unknown; id_token?: unknown } }
      if (auth.tokens?.account_id === acct && typeof auth.tokens.id_token === 'string') {
        const email = accountFor(home, q, emailOfJwt(auth.tokens.id_token))
        if (email) return email
      }
    } catch {}
  }
  return accountForIdentity(home, q, identity)
}

const say = (m: object) => process.stdout.write(`${JSON.stringify(m)}\n`)
const where = () => ({ herdr: !!process.env.HC_TERMINAL_ID, tmux: !!process.env.TMUX, mac: process.platform === 'darwin' })
/** A session's feed on a quota: one file per session and quota, so a move between Claude and ChatGPT keeps both */
const fileOf = (session: string, q: PaceProvider) => feedFile('hermes', `${session}-${q}`)
/** The live feeds but this session's (core/meter.ts leaves its own out by host and session) */
const othersOf = (session: string) => liveFeeds(home, Date.now(), f => f.host === 'hermes' && f.session === session)

const sessionOf = (id: string): Session => {
  const known = sessions.get(id)
  if (known) return known
  const s: Session = { cwd: '', mode: 'session', feed: null, feeds: new Map(), prompted: 0 }
  sessions.set(id, s)
  return s
}

/** The session's feed after what was metered; none until its provider is one pace paces */
function record(id: string, e: Partial<Metered> = {}): PaceFeed | null {
  const s = sessionOf(id)
  if (!s.provider) return null
  const now = Date.now()
  const others = othersOf(id)
  const reading = readings.get(s.provider)
  const account = accounts.get(s.provider) ?? soleAccount(others, s.provider)
  const prompted = s.prompted > 0 || !!e.prompted
  s.prompted = 0
  const metered: Metered = {
    host: 'hermes', provider: s.provider, ...(account ? { account } : {}), session: id, cwd: s.cwd, now,
    ...(process.env.HC_TERMINAL_ID ? { terminal: process.env.HC_TERMINAL_ID } : {}),
    ...e, prompted, samples: reading ? [reading] : [],
  }
  // A bridge started again carries on from the session's own history on this quota
  const prev = s.feeds.get(s.provider) ?? (s.feed?.provider === s.provider ? s.feed : null)
    ?? readFeeds(home, now).find(f => f.host === 'hermes' && f.session === id && f.provider === s.provider) ?? null
  const feed = meter(prev, metered, others, { cache: true, estimate: false })
  // The events after the feed is worked out from the log, so none is counted twice
  appendLog(home, 'hermes', { provider: s.provider, ...(account ? { account } : {}), session: id, host: 'hermes', ...(s.cwd ? { cwd: s.cwd } : {}) }, eventsOf(metered), now)
  writeFeed(join(home, fileOf(id, s.provider)), feed)
  pruneLog(home, now)
  s.feed = feed
  s.feeds.set(s.provider, feed)
  return feed
}

function setAuto(id: string, auto: PaceFeed['snapshot']['auto'] | null): void {
  const s = sessionOf(id)
  if (!s.feed) return
  const { auto: _, ...rest } = s.feed.snapshot
  s.feed = { ...s.feed, snapshot: auto ? { ...rest, auto } : rest }
  s.feeds.set(s.feed.provider, s.feed)
  writeFeed(join(home, fileOf(id, s.feed.provider)), s.feed)
}

/** A prompt for the plugin to send into the session, or the bot's chat */
const inject = (id: string, text: string) => say({ method: '_pace/inject', params: { session: id, ...(sessionOf(id).key ? { key: sessionOf(id).key } : {}), text } })

/** `/pace <args>` in a session, carried out; what to say back */
function command(id: string, args: string): string {
  const s = sessionOf(id)
  const feed = s.feed ?? record(id)
  if (!feed) return 'pace paces a Claude or ChatGPT sign-in: this session has not used one yet'
  const a = route(commandOf(args), hermesHost(s.mode, where()))
  const auto = feed.snapshot.auto ?? null
  switch (a.kind) {
    case 'say': case 'refresh': case 'prefs': return a.text
    case 'open': return openView({ home, feed, feedPath: join(home, fileOf(id, feed.provider)), hostName: 'Hermes', others: () => othersOf(id) }, a)
    case 'auto':
      setAuto(id, { plan: a.plan, turns: 1, max: a.max })
      inject(id, `${protocol()}\n\n${startPrompt(a.plan)}`)
      return `Auto mode on: ${a.plan}`
    case 'resume':
      if (!auto) return 'Auto mode is not running: /pace auto <plan file> starts it'
      setAuto(id, resumed(auto))
      inject(id, `${protocol()}\n\n${continuePrompt(auto.plan, snapshotOf(feed.snapshot, Date.now()))}`)
      return `Auto mode resumed: ${auto.plan}`
    case 'stop':
      setAuto(id, null)
      return a.text
    case 'burst': {
      if (!auto) return 'Auto mode is not running: /pace auto <plan file> starts it'
      const { burst: _, ...rest } = auto
      setAuto(id, a.on ? { ...rest, burst: true } : rest)
      return a.on ? 'Burst on' : 'Burst off'
    }
    default: return 'Not in Hermes yet'
  }
}

/** Auto mode at a turn's end: core/auto.ts decides; the next prompt goes into the session or the chat */
function afterTurn(id: string, answer: string): void {
  const s = sessionOf(id)
  const auto = s.feed?.snapshot.auto
  if (!s.feed || !auto || auto.paused) return
  const host = hermesHost(s.mode, where())
  const step = stepOf(decide({ auto, snap: snapshotOf(s.feed.snapshot, Date.now()), answer, aborted: false }), host, Date.now())
  if (step.kind === 'send') {
    setAuto(id, { ...auto, turns: auto.turns + 1 })
    return inject(id, step.prompt)
  }
  if (step.kind === 'hold') {
    setAuto(id, { ...auto, heldUntil: step.until })
    setTimeout(() => {
      const a = sessionOf(id).feed?.snapshot.auto
      if (!a) return
      const { heldUntil: _, ...rest } = a
      setAuto(id, rest)
      afterTurn(id, '')
    }, Math.max(0, step.until - Date.now())).unref()
    return
  }
  setAuto(id, step.kind === 'pause' ? { ...auto, paused: true, why: step.message } : null)
}

createInterface({ input: process.stdin }).on('line', line => {
  let m: { id?: number; method?: string; params?: any }
  try { m = JSON.parse(line) } catch { return }
  const p = m.params ?? {}
  const id = typeof p.session === 'string' ? p.session : ''
  try {
    switch (m.method) {
      case 'session/new': {
        const s = sessionOf(id)
        s.cwd = String(p.cwd ?? s.cwd)
        s.mode = p.mode === 'bot' ? 'bot' : 'session'
        if (typeof p.key === 'string' && p.key) s.key = p.key
        break
      }
      case 'session/prompt': {
        const s = sessionOf(id)
        s.prompted += 1
        if (s.provider) record(id)
        break
      }
      case '_pace/usage': {
        const q = quotaOf(String(p.provider ?? ''))
        if (!q) break
        const s = sessionOf(id)
        // A background call (compression, titling, Mixture of Agents) or a subagent's: its quota's figures refreshed,
        // the session's own context and cache left as they are
        const u = p.usage ?? {}
        const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
        // Every call's tokens spend the account, a background one's and a subagent's too (core/log.ts)
        const tokens = { input: n(u.input_tokens), output: n(u.output_tokens), cacheRead: n(u.cache_read_tokens), cacheWrite: n(u.cache_write_tokens), reasoning: n(u.reasoning_tokens) }
        const spent = tokens.input || tokens.output || tokens.cacheRead || tokens.cacheWrite ? { tokens, ...(p.model ? { model: String(p.model) } : {}) } : {}
        if (p.aux || p.sub) {
          if (!s.provider) s.provider = q
          if (s.provider === q) record(id, spent)
          break
        }
        s.provider = q
        const held = n(u.input_tokens) + n(u.cache_read_tokens) + n(u.cache_write_tokens)
        const window = n(p.context_length)
        record(id, {
          ...spent,
          ...(n(u.cache_read_tokens) + n(u.cache_write_tokens) > 0 ? { cached: { tokens: held, ttl: cacheTtlOf(q) } } : {}),
          ...(window > 0 ? { context: { tokens: held, window } } : {}),
        })
        break
      }
      case '_pace/reading': {
        const q = quotaOf(String(p.provider ?? ''))
        const sample = q ? readingsOf(p.windows as HermesWindow[], Date.now()) : null
        if (!q || !sample) break
        readings.set(q, sample)
        const account = typeof p.identity === 'string' && p.identity ? accountOfIdentity(q, p.identity) : undefined
        if (account) accounts.set(q, account)
        for (const [sid, s] of sessions) if (s.provider === q) record(sid)
        break
      }
      case 'turn_end': afterTurn(id, String(p.answer ?? '')); break
      case '_pace/command': say({ id: m.id, result: { text: command(id, String(p.args ?? '')) } }); break
    }
  } catch (e) {
    if (m.id != null) say({ id: m.id, result: { text: `pace: ${(e as Error).message}` } })
  }
}).on('close', () => process.exit(0))
