// The plan auto mode works through, as steps on a timeline: its checklist read from the plan file. Pure.

/** Where a step stands: ticked off, the one auto mode is working on, or still ahead */
export type StepState = 'done' | 'now' | 'next'

/** One step of the plan; `section` is the heading it sits under, null above the first */
export type Step = { text: string; state: StepState; section: string | null }

const ITEM = /^(\s*)(?:[-*+]|\d+[.)])\s+\[([ xX])\]\s+(.+?)\s*$/
const HEADING = /^#{1,6}\s+(.+?)\s*#*\s*$/

/** A step's text without the markdown that would show as marks: emphasis, code and strikethrough */
const plain = (t: string) => t.replace(/(\*\*|__|~~|`)/g, '')

/**
 * The plan's steps: its outermost checklist items, ticked ones done. `active`: whether auto mode is working on the
 * plan, which puts the first unticked step under way.
 */
export function stepsOf(markdown: string, active: boolean): Step[] {
  const items: { indent: number; done: boolean; text: string; section: string | null }[] = []
  let section: string | null = null
  for (const line of markdown.split('\n')) {
    const h = HEADING.exec(line)
    if (h) section = plain(h[1]!)
    const m = ITEM.exec(line)
    if (m) items.push({ indent: m[1]!.replace(/\t/g, '  ').length, done: m[2] !== ' ', text: plain(m[3]!), section })
  }
  const top = Math.min(...items.map(i => i.indent))
  let first = active
  return items
    .filter(i => i.indent === top)
    .map(i => {
      const state: StepState = i.done ? 'done' : first ? 'now' : 'next'
      if (state === 'now') first = false
      return { text: i.text, state, section: i.section }
    })
}
