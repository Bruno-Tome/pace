// The feeds and the log as the Herdr mods read them (.agents/decisions/0024-append-only-log.md), through Herdr's own
// calls, doing no work twice: a feed is parsed again only when its text changed; a finished day is read from its
// checkpoint, or from its files once; today's files are read on from where they were left; and the history is a
// History, which works out only what changed and gives back the same feeds when nothing did.

import { exec, readTextFile } from 'herdr'

import { FEEDS_DIR, feedOf, type PaceFeed } from '../../core/host.ts'
import { checkpointFrom, History, LOG_DIR, logDay, logDays, parseLog, type LogHead } from '../../core/log.ts'

/** The .json or .jsonl names in a folder; none when it is not there */
async function namesIn(dir: string, ext: string): Promise<string[]> {
  const listed = await exec('ls', [dir]).catch(() => null)
  return (listed?.code === 0 ? listed.stdout.split('\n') : []).filter((n: string) => n.endsWith(ext))
}

const read = async (path: string) => (await readTextFile(path).catch(() => null)) ?? ''

export class HerdrLog {
  readonly history = new History()
  /** Each file of an open day: how much of it was read, up to its last whole line, and the header in force there */
  private files = new Map<string, { length: number; head: LogHead | null }>()
  /** Each feed file's text as last read, and the feed it parsed to: the same feed while the text is the same */
  private feeds = new Map<string, { text: string; feed: PaceFeed | null }>()
  /** The finished days read whole, from their checkpoint or their files */
  private done = new Set<string>()

  /** Reads what the log added since the last call into the history */
  async readOn(home: string, now: number): Promise<void> {
    const today = logDay(now)
    const yesterday = logDay(now - 24 * 3600_000)
    this.history.forget(now)
    for (const day of logDays(now)) {
      if (this.done.has(day)) continue
      const dir = `${home}/${LOG_DIR}/${day}`
      const cp = day < yesterday ? checkpointFrom(await read(`${dir}/checkpoint.json`)) : null
      if (cp) {
        this.history.setCheckpoint(cp)
        this.done.add(day)
        continue
      }
      for (const name of await namesIn(dir, '.jsonl')) {
        const path = `${dir}/${name}`
        const text = await read(path)
        const f = this.files.get(path) ?? { length: 0, head: null }
        // A file only grows; one read shorter is being written over, and is read on next time
        const whole = text.lastIndexOf('\n') + 1
        if (whole <= f.length) continue
        const got = parseLog(text.slice(f.length, whole), f.head)
        this.files.set(path, { length: whole, head: got.head })
        this.history.append(got.entries)
      }
      // A day before yesterday is not written again: read once
      if (day < yesterday && day !== today) this.done.add(day)
    }
  }

  /**
   * Every feed in the feeds folder with its quota's history; a feed being written keeps the one last read. The same
   * objects as last time for every feed whose text and history did not change
   */
  async feedsWithHistory(home: string, now: number): Promise<PaceFeed[]> {
    const dir = `${home}/${FEEDS_DIR}`
    const names = await namesIn(dir, '.json')
    for (const name of names) {
      const text = await read(`${dir}/${name}`)
      const known = this.feeds.get(name)
      if (known?.text === text) continue
      const feed = feedOf(text)
      // One that does not parse (written as it was read) keeps the feed last read from it
      if (feed || !known) this.feeds.set(name, { text, feed })
    }
    for (const name of [...this.feeds.keys()]) if (!names.includes(name)) this.feeds.delete(name)
    await this.readOn(home, now)
    return this.history.hydrate([...this.feeds.values()].flatMap(f => (f.feed ? [f.feed] : [])), now)
  }
}

/** Today's log folder, which a mod watches beside the feeds: a prompt or a reading lands there first */
export const todaysLog = (home: string, now: number) => `${home}/${LOG_DIR}/${logDay(now)}`
