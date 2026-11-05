// The Hermes installer, in a scratch home with a fake `hermes` on the PATH. Run by Node.

import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from '../testing/node.ts'

const SCRIPT = join(import.meta.dirname, 'hermes.ts')

function home() {
  const dir = mkdtempSync(join(tmpdir(), 'pace-hermes-install-'))
  mkdirSync(join(dir, 'bin'))
  writeFileSync(join(dir, 'bin', 'hermes'), `#!/bin/sh\necho "$*" >> "${dir}/hermes.log"\n`)
  chmodSync(join(dir, 'bin', 'hermes'), 0o755)
  return dir
}

const install = (dir: string) => spawnSync(process.execPath, [SCRIPT, 'install'], { env: { ...process.env, HOME: dir, PATH: `${join(dir, 'bin')}:${process.env.PATH}` }, encoding: 'utf8' })

describe('installing pace in Hermes', () => {
  test('puts the plugin in ~/.hermes/plugins/pace, pointed at this repo\'s bridge with the node that installed it, and enables it', () => {
    const dir = home()
    const r = install(dir)
    expect(r.status).toBe(0)
    const plugin = join(dir, '.hermes/plugins/pace')
    expect(existsSync(join(plugin, '__init__.py'))).toBe(true)
    expect(existsSync(join(plugin, 'plugin.yaml'))).toBe(true)
    expect(JSON.parse(readFileSync(join(plugin, 'pace.json'), 'utf8'))).toEqual({ node: process.execPath, bridge: join(import.meta.dirname, '../bin/pace-hermes.ts') })
    expect(readFileSync(join(dir, 'hermes.log'), 'utf8').trim()).toBe('plugins enable pace')
  })

  test('installs again over itself', () => {
    const dir = home()
    install(dir)
    expect(install(dir).status).toBe(0)
  })
})
