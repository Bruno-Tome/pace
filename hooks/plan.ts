// The plan auto mode works through, as steps on a timeline: its checklist read from the plan file. Pure.

/** Where a step stands: ticked off, the one auto mode is working on, or still ahead */
export type StepState = 'done' | 'now' | 'next'

/**
 * One step of the plan; `section` is the heading it sits under, null above the first. `parallel`: marked
 * `(parallel)`, so it may go to a subagent; left out on a step that is not, so the state file is unchanged.
 */
export type Step = { text: string; state: StepState; section: string | null; parallel?: true }

/** What ultra pace works toward: the goal, its *Done when* lines, and the command that checks it */
export type Goal = { text: string; criteria: string[]; check: string | null }

const ITEM = /^(\s*)(?:[-*+]|\d+[.)])\s+\[([ xX])\]\s+(.+?)\s*$/
const HEADING = /^#{1,6}\s+(.+?)\s*#*\s*$/
const BULLET = /^\s*(?:[-*+]|\d+[.)])\s+(.+?)\s*$/
const PARALLEL = /\s*\(parallel\)\s*$/i

/** Sections that hold no steps: the goal block and the revision log */
const NOT_STEPS = new Set(['goal', 'revisions'])

/** A step's text without the markdown that would show as marks: emphasis, code and strikethrough */
const plain = (t: string) => t.replace(/(\*\*|__|~~|`)/g, '')

/** The plan's goal from its `## Goal` section; null when it has none */
export function goalOf(markdown: string): Goal | null {
  let inGoal = false
  let found = false
  let inCriteria = false
  const text: string[] = []
  const criteria: string[] = []
  let check: string | null = null
  for (const line of markdown.split('\n')) {
    const h = HEADING.exec(line)
    if (h) {
      inGoal = plain(h[1]!).toLowerCase() === 'goal'
      found ||= inGoal
      continue
    }
    if (!inGoal || !line.trim()) continue
    const c = /^\s*check:\s*(.+?)\s*$/i.exec(line)
    const b = BULLET.exec(line)
    if (c) check = c[1]!.replace(/^`+|`+$/g, '').trim() || null
    else if (/^\s*done when:?\s*$/i.test(line)) inCriteria = true
    else if (inCriteria && b) criteria.push(plain(b[1]!))
    else text.push(line.trim())
  }
  return found ? { text: text.join(' '), criteria, check } : null
}

/**
 * The plan's steps: its outermost checklist items, ticked ones done, none from the goal block or the revision log.
 * `active`: whether auto mode is working on the plan, which puts the first unticked step under way.
 */
export function stepsOf(markdown: string, active: boolean): Step[] {
  const items: { indent: number; done: boolean; text: string; section: string | null; parallel: boolean }[] = []
  let section: string | null = null
  for (const line of markdown.split('\n')) {
    const h = HEADING.exec(line)
    if (h) section = plain(h[1]!)
    if (section && NOT_STEPS.has(section.toLowerCase())) continue
    const m = ITEM.exec(line)
    if (!m) continue
    const text = plain(m[3]!)
    const parallel = PARALLEL.test(text)
    items.push({ indent: m[1]!.replace(/\t/g, '  ').length, done: m[2] !== ' ', text: text.replace(PARALLEL, ''), section, parallel })
  }
  const top = Math.min(...items.map(i => i.indent))
  let first = active
  return items
    .filter(i => i.indent === top)
    .map(i => {
      const state: StepState = i.done ? 'done' : first ? 'now' : 'next'
      if (state === 'now') first = false
      return { text: i.text, state, section: i.section, ...(i.parallel ? { parallel: true as const } : {}) }
    })
}

/**
 * How the plan's steps moved over a turn, matched by their text. `dropped`: steps not yet done that are gone;
 * `reopened`: done steps now unticked; `rewrittenDone`: done steps whose text is gone, reworded or removed alike.
 */
export type PlanChanges = { added: string[]; dropped: string[]; reopened: string[]; rewrittenDone: string[] }

/** The steps' changes between the plan before a turn and after it */
export function planChanges(before: string, after: string): PlanChanges {
  const was = stepsOf(before, false)
  const now = new Map(stepsOf(after, false).map(s => [s.text, s.state === 'done']))
  const known = new Set(was.map(s => s.text))
  return {
    added: [...now.keys()].filter(t => !known.has(t)),
    dropped: was.filter(s => s.state !== 'done' && !now.has(s.text)).map(s => s.text),
    reopened: was.filter(s => s.state === 'done' && now.get(s.text) === false).map(s => s.text),
    rewrittenDone: was.filter(s => s.state === 'done' && !now.has(s.text)).map(s => s.text),
  }
}

/**
 * The ticked steps a turn unlocked: unticked, rewritten or removed with no new line under `## Revisions` to say why.
 * Empty while the lock holds.
 */
export function lockBroken(changes: PlanChanges, revisionsGrew: boolean): string[] {
  return revisionsGrew ? [] : [...changes.reopened, ...changes.rewrittenDone]
}

/** How many lines the plan's `## Revisions` log holds */
export function revisionsOf(markdown: string): number {
  let inLog = false
  let n = 0
  for (const line of markdown.split('\n')) {
    const h = HEADING.exec(line)
    if (h) inLog = plain(h[1]!).toLowerCase() === 'revisions'
    else if (inLog && BULLET.test(line)) n++
  }
  return n
}
