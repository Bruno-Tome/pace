// Installing pace's pi extension, in a scratch home. Run by Node: `node --test scripts/pi.node-test.ts`.

import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from '../testing/node.ts'

const root = join(import.meta.dirname, '..')

describe('node scripts/pi.ts install', () => {
  test('puts an extension in ~/.pi/agent/extensions that loads this repo\'s, so a pull updates it', () => {
    const home = mkdtempSync(join(tmpdir(), 'pace-pi-install-'))
    const r = spawnSync(process.execPath, [join(root, 'scripts/pi.ts'), 'install'], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', HOME: home } })
    expect(r.status).toBe(0)
    expect(readFileSync(join(home, '.pi/agent/extensions/pace.ts'), 'utf8')).toContain(`export { default } from '${join(root, 'adapters/pi/extension.ts')}'`)
  })
})
