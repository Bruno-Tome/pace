// Installing pace's Codex commands, in a scratch home. Run by Node: `node --test scripts/codex.node-test.ts`.

import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from '../testing/node.ts'

const root = join(import.meta.dirname, '..')

describe('node scripts/codex.ts install', () => {
  test('writes the custom prompt and the pace skill into ~/.codex, the skill running this repo\'s opener', () => {
    const home = mkdtempSync(join(tmpdir(), 'pace-codex-install-'))
    const r = spawnSync(process.execPath, [join(root, 'scripts/codex.ts'), 'install'], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', HOME: home } })
    expect(r.status).toBe(0)
    expect(readFileSync(join(home, '.codex/prompts/pace.md'), 'utf8')).toContain('/pace $ARGUMENTS')
    const skill = readFileSync(join(home, '.codex/skills/pace/SKILL.md'), 'utf8')
    expect(skill).toContain('name: pace')
    expect(skill).toContain(`node ${join(root, 'adapters/codex/open.ts')}`)
    expect(skill).not.toContain('{{')
  })
})
