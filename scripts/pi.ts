// Installs pace's pi extension: ~/.pi/agent/extensions/pace.ts, one line that loads adapters/pi/extension.ts from
// this repo, so pulling the repo updates it. pi picks it up on its next start, or on /reload.
//
//   node scripts/pi.ts install

import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..')

function install(): void {
  const dir = join(homedir(), '.pi', 'agent', 'extensions')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'pace.ts'), `// pace: the band and the quotas in pi. Installed by node scripts/pi.ts install.\nexport { default } from '${join(root, 'adapters/pi/extension.ts')}'\n`)
  process.stdout.write(`✔ pace installed in ${dir}: restart pi, or /reload\n`)
}

if (process.argv[2] === 'install') {
  install()
} else {
  process.stderr.write('usage: node scripts/pi.ts install\n')
  process.exitCode = 2
}
