// Chips: a view's choices as rows of things to click, shared by every view that filters or switches (activity, and
// the fleet's tabs). A row picks one, or any number with "All" first. Pure.

export type Chip = { group: string; value: string; label: string; on: boolean }
export type ChipRow = { group: string; title: string; chips: Chip[] }
export type Choice = { value: string; label: string }

/** A row that picks one: the one picked is on */
export function oneOf(group: string, title: string, choices: readonly Choice[], picked: string): ChipRow {
  return { group, title, chips: choices.map(c => ({ group, value: c.value, label: c.label, on: c.value === picked })) }
}

/** A row that picks any number: "All" first, on while none is picked */
export function anyOf(group: string, title: string, choices: readonly Choice[], picked: readonly string[]): ChipRow {
  return {
    group, title,
    chips: [{ group, value: '', label: 'All', on: !picked.length }, ...choices.map(c => ({ group, value: c.value, label: c.label, on: picked.includes(c.value) }))],
  }
}

/** What a click on `value` leaves picked: added, or taken away; "All" (no value) clears them */
export const toggled = (picked: readonly string[], value: string): string[] =>
  !value ? [] : picked.includes(value) ? picked.filter(v => v !== value) : [...picked, value]

/**
 * A key on chips, `focus` the chip in focus by its place across the rows: left and right along a row, down and up to
 * the next or last row at the same place (or its end), enter or space presses it, q quits
 */
export function chipKey(rows: readonly ChipRow[], focus: number, key: string): { focus: number; chip?: Chip; quit?: true } {
  if (key === 'q' || key === 'Q' || key === '\x03') return { focus, quit: true }
  const flat = rows.flatMap((r, ri) => r.chips.map((chip, ci) => ({ chip, ri, ci })))
  if (!flat.length) return { focus: 0 }
  const at = flat[Math.min(Math.max(0, focus), flat.length - 1)]!
  if (key === '\r' || key === '\n' || key === ' ') return { focus, chip: at.chip }
  const indexOf = (ri: number, ci: number) => flat.findIndex(f => f.ri === ri && f.ci === Math.min(ci, rows[ri]!.chips.length - 1))
  if (key === '\x1b[C') return { focus: at.ci < rows[at.ri]!.chips.length - 1 ? indexOf(at.ri, at.ci + 1) : flat.indexOf(at) }
  if (key === '\x1b[D') return { focus: at.ci > 0 ? indexOf(at.ri, at.ci - 1) : flat.indexOf(at) }
  if (key === '\x1b[B') return { focus: at.ri < rows.length - 1 ? indexOf(at.ri + 1, at.ci) : flat.indexOf(at) }
  if (key === '\x1b[A') return { focus: at.ri > 0 ? indexOf(at.ri - 1, at.ci) : flat.indexOf(at) }
  return { focus: flat.indexOf(at) }
}
