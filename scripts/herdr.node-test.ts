// The Herdr build's rule: a module as plain JS that imports only from the mod's own folder. Run by Node:
// `node --test scripts/herdr.node-test.ts`.

import { describe, expect, test } from '../testing/node.ts'
import { jsOf, MODS } from './herdr.ts'

describe('jsOf', () => {
  test('strips the types and points relative imports at the built .js files', () => {
    const js = jsOf("import { cacheLeft, type Suggestion } from './cache.ts'\nexport const n: number = 1\n", 'core/model.js')
    expect(js).toContain("from './cache.js'")
    expect(js).not.toContain('Suggestion')
    expect(js).not.toContain(': number')
  })

  test('drops type-only imports, so nothing reaches outside the folder', () => {
    const js = jsOf("import type { PaceSample } from '../types'\nexport const a = 1\n", 'core/quota.js')
    expect(js).not.toContain('import')
    expect(js).not.toContain('../types')
  })

  test("maps claude-code/testing to the mod's own runner, relative to the file", () => {
    expect(jsOf("import { expect, test } from 'claude-code/testing'\n", 'tests/rate.test.js'))
      .toContain("from '../testing/herdr.js'")
    expect(jsOf("import { expect, test } from 'claude-code/testing'\n", 'adapters/codex/rollout.test.js'))
      .toContain("from '../../testing/herdr.js'")
  })

  test('leaves a .ts inside a string that is not an import alone', () => {
    expect(jsOf("export const file = './plan.ts'\n", 'core/plan.js')).toContain("'./plan.ts'")
  })
})

describe('the mods it builds', () => {
  test('pace, and the fleet beside it: each from its own adapter, docked right until a layout places it', () => {
    expect(MODS.map(m => [m.name, m.entry, m.json.place, m.json.title])).toEqual([
      ['pace', 'adapters/herdr/main.ts', 'right', 'Pace'],
      ['fleet', 'adapters/herdr/fleet/main.ts', 'right', 'Fleet'],
    ])
  })
})
