import { expect, test } from 'claude-code/testing'

import { POWERS, sheenAt } from '../hooks/band-client.tsx'

/** The cells the sheen lights over one sweep's frames, for a bar `width` cells wide */
const swept = (width: number, power: (typeof POWERS)[keyof typeof POWERS]) => {
  const lit = new Set<number>()
  for (let f = 0; f < 400; f++) {
    const [from, to] = sheenAt(f, width, power)
    for (let c = Math.max(0, from); c <= Math.min(width - 1, to); c++) lit.add(c)
  }
  return lit
}

test('the sheen crosses the whole bar, to its last cell, however wide the bar and whatever the gear', () => {
  for (const width of [12, 48, 90]) {
    for (const [name, power] of Object.entries(POWERS)) {
      const lit = swept(width, power)
      expect(`${name} ${width}: ${lit.has(0)} ${lit.has(width - 1)} ${lit.size}`).toBe(`${name} ${width}: true true ${width}`)
    }
  }
})

test('push comes round more often than calm', () => {
  // Frames from one sweep's start to the next, on a 48-cell bar
  const starts = (power: (typeof POWERS)[keyof typeof POWERS]) => {
    const at: number[] = []
    for (let f = 13; f < 400; f++) if (sheenAt(f, 48, power)[1] === 0) at.push(f)
    return at[1]! - at[0]!
  }
  expect(starts(POWERS.push)).toBeLessThan(starts(POWERS.calm) / 2)
})
