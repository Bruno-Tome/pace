// The log as the Herdr mods read it (.agents/decisions/0024-append-only-log.md), through Herdr's own calls: a day
// before today is read once, since no session writes it again; today's is read again at each reload.

import { exec, readTextFile } from 'herdr'

import type { PaceFeed } from '../../core/host.ts'
import { hydrate, LOG_DIR, logDay, logDays, parseLog, type LogEntry } from '../../core/log.ts'

/** The text of every .jsonl file in a folder; none when the folder is not there */
async function readDay(dir: string): Promise<string[]> {
  const listed = await exec('ls', [dir]).catch(() => null)
  const names = (listed?.code === 0 ? listed.stdout.split('\n') : []).filter((n: string) => n.endsWith('.jsonl'))
  return Promise.all(names.map(async (n: string) => (await readTextFile(`${dir}/${n}`).catch(() => null)) ?? ''))
}

export class HerdrLog {
  /** The events of each day before today, by its folder name */
  private past = new Map<string, LogEntry[]>()

  /** The log of the days kept */
  async entries(home: string, now: number): Promise<LogEntry[]> {
    const today = logDay(now)
    const days = logDays(now)
    for (const day of this.past.keys()) if (!days.includes(day)) this.past.delete(day)
    const out: LogEntry[] = []
    for (const day of days) {
      const known = this.past.get(day)
      if (known) {
        out.push(...known)
        continue
      }
      const entries = (await readDay(`${home}/${LOG_DIR}/${day}`)).flatMap(text => parseLog(text, null).entries)
      if (day !== today) this.past.set(day, entries)
      out.push(...entries)
    }
    return out
  }

  /** Feeds with their quotas' history filled in from the log */
  async hydrate(feeds: readonly PaceFeed[], home: string, now: number): Promise<PaceFeed[]> {
    return hydrate(feeds, await this.entries(home, now), now)
  }
}

/** Today's log folder, which a mod watches beside the feeds: a prompt or a reading lands there first */
export const todaysLog = (home: string, now: number) => `${home}/${LOG_DIR}/${logDay(now)}`
