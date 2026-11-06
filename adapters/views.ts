// A view opened for a Node adapter where core/api.ts routed it: in Herdr (its fallback when Herdr fails), a tmux
// split or a terminal window running bin/band.ts, else drawn as text for the answer. Shared by the bridges that run
// the core for a host (bin/pace-acp.ts, bin/pace-hermes.ts); the live feeds the fleet reads, too.

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { plainText, plansFor, viewLines, type PaceAction } from '../core/api.ts'
import { FEED_STALE, type PaceFeed } from '../core/host.ts'
import { readFeeds } from './log.ts'
import { openInHerdr } from './codex/open.ts'

const TEXT_COLS = 90

export function writeAtomically(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(`${path}.tmp`, text)
  renameSync(`${path}.tmp`, path)
}

/** Every live feed but those `except` picks out, each with its quota's history from the log */
export function liveFeeds(home: string, now: number, except: (f: PaceFeed) => boolean = () => false): PaceFeed[] {
  return readFeeds(home, now).filter(f => f.at >= now - FEED_STALE && !except(f))
}

/** Where a view is opened from: the home, the session's feed and its file, the name Herdr says it for */
export type ViewContext = { home: string; feed: PaceFeed; feedPath: string; hostName: string; others: () => PaceFeed[] }

/** A view opened where the core routed it; what to say back */
export function openView(c: ViewContext, a: Extract<PaceAction, { kind: 'open' }>): string {
  const { feed } = c
  const note = a.note ? `${a.note}\n\n` : ''
  if (a.surface === 'herdr') {
    const r = openInHerdr(a.view === 'pane' ? '' : a.view, feed.provider, c.hostName, feed.account)
    return r.opened || a.fallback?.kind !== 'open' ? r.text : `${r.text}\n\n${openView(c, a.fallback)}`
  }
  const live = `'${process.execPath}' '${join(import.meta.dirname, '../bin/band.ts')}' ${a.view === 'pane' ? '--pane ' : a.view === 'fleet' ? '--fleet ' : ''}'${c.feedPath}'`
  try {
    if (a.surface === 'split' && a.view !== 'plan') {
      execFileSync('tmux', ['split-window', '-h', '-d', '-l', '64', live], { stdio: 'ignore', timeout: 5000 })
      return `${note}Pace opened in a tmux split; q there closes it`
    }
    if (a.surface === 'window' && a.view !== 'plan') {
      const script = join(c.home, `.local/state/pace/views/${feed.host}-${feed.session.replace(/[^A-Za-z0-9_-]/g, '_')}.command`)
      writeAtomically(script, `#!/bin/sh\nexec ${live}\n`)
      execFileSync('chmod', ['755', script])
      execFileSync('open', ['-a', 'Terminal', script], { stdio: 'ignore', timeout: 5000 })
      return `${note}Pace opened in a terminal window; q closes it`
    }
  } catch {}
  const now = Date.now()
  const plans = a.view === 'plan' ? plansFor(feed, a.files ?? []).map(plan => ({ plan, text: existsSync(join(feed.cwd, plan)) ? readFileSync(join(feed.cwd, plan), 'utf8') : '' })) : []
  return note + plainText(viewLines(a.view, { feed, others: a.view === 'fleet' ? c.others() : [], plans, now, cols: TEXT_COLS }))
}
