// The Antigravity installer end to end, in a scratch home: `node --test scripts/antigravity.node-test.ts`.

import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from '../testing/node.ts'

const SCRIPT = join(import.meta.dirname, 'antigravity.ts')
const ROOT = join(import.meta.dirname, '..')

delete process.env.HC_TERMINAL_ID
delete process.env.TMUX

const install = (home: string) => execFileSync(process.execPath, [SCRIPT, 'install'], { env: { ...process.env, HOME: home }, encoding: 'utf8' })

describe('installing pace in Antigravity', () => {
  test('writes a plugin whose hooks run this repo\'s hook on PreInvocation and Stop, with the node that installed it', () => {
    const home = mkdtempSync(join(tmpdir(), 'pace-agy-install-'))
    expect(install(home)).toContain('pace installed in Antigravity')
    const plugin = join(home, '.gemini/config/plugins/pace')
    expect(JSON.parse(readFileSync(join(plugin, 'plugin.json'), 'utf8'))).toEqual({ name: 'pace' })
    const hook = (event: string) => [{ type: 'command', command: `'${process.execPath}' '${join(ROOT, 'adapters/antigravity/hook.ts')}' ${event}`, timeout: 10 }]
    expect(JSON.parse(readFileSync(join(plugin, 'hooks.json'), 'utf8'))).toEqual({ pace: { PreInvocation: hook('PreInvocation'), Stop: hook('Stop') } })
  })

  test('ships a /pace skill, so agy knows /pace as a command and never completes it to another skill', () => {
    const home = mkdtempSync(join(tmpdir(), 'pace-agy-install-'))
    install(home)
    const skill = readFileSync(join(home, '.gemini/config/plugins/pace/skills/pace/SKILL.md'), 'utf8')
    expect(skill).toContain('name: pace')
    expect(skill).toContain('description:')
  })

  test('leaves the user\'s own hooks and other plugins alone, and installs again over itself', () => {
    const home = mkdtempSync(join(tmpdir(), 'pace-agy-install-'))
    mkdirSync(join(home, '.gemini/config/plugins/other'), { recursive: true })
    writeFileSync(join(home, '.gemini/config/hooks.json'), '{"mine":{}}')
    writeFileSync(join(home, '.gemini/config/plugins/other/plugin.json'), '{"name":"other"}')
    install(home)
    install(home)
    expect(readFileSync(join(home, '.gemini/config/hooks.json'), 'utf8')).toBe('{"mine":{}}')
    expect(readFileSync(join(home, '.gemini/config/plugins/other/plugin.json'), 'utf8')).toBe('{"name":"other"}')
  })

  test('says how to use it without install', () => {
    const r = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' })
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('usage: node scripts/antigravity.ts install')
  })
})
