// Installs pace in Hermes Agent: `node scripts/hermes.ts install`. Copies the plugin (adapters/hermes/plugin) to
// ~/.hermes/plugins/pace, points it at this repo's bridge (bin/pace-hermes.ts) and the node that ran this, and enables
// it with `hermes plugins enable pace`. The plugin runs in `hermes chat` and in the messaging gateway alike.

import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..')

function install(): void {
  const dir = join(homedir(), '.hermes/plugins/pace')
  mkdirSync(dir, { recursive: true })
  cpSync(join(root, 'adapters/hermes/plugin'), dir, { recursive: true })
  writeFileSync(join(dir, 'pace.json'), JSON.stringify({ node: process.execPath, bridge: join(root, 'bin/pace-hermes.ts') }))
  try {
    execFileSync('hermes', ['plugins', 'enable', 'pace'], { stdio: 'ignore', timeout: 30_000 })
    console.log(`✔ pace installed in Hermes: ${dir}, enabled`)
  } catch {
    console.log(`✔ pace installed in Hermes: ${dir}. Enable it with: hermes plugins enable pace`)
  }
  console.log('  Bot mode: auto mode sends its prompts into the chat once plugins.entries.pace.allow_gateway_injection is true in ~/.hermes/config.yaml')
}

if (process.argv[2] === 'install') install()
else console.log('Use: node scripts/hermes.ts install')
