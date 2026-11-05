// Installs pace's Codex commands into ~/.codex: the custom prompt `/prompts:pace` (adapters/codex/pace.md) and the
// pace skill `$pace` (adapters/codex/skill/SKILL.md), the skill pointed at this repo's opener. The hooks they rely
// on are in ~/.codex/config.toml, which this never writes: the README has the lines to add.
//
//   node scripts/codex.ts install

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..')

function install(): void {
  const codex = join(homedir(), '.codex')
  mkdirSync(join(codex, 'prompts'), { recursive: true })
  mkdirSync(join(codex, 'skills', 'pace'), { recursive: true })
  writeFileSync(join(codex, 'prompts', 'pace.md'), readFileSync(join(root, 'adapters/codex/pace.md'), 'utf8'))
  const skill = readFileSync(join(root, 'adapters/codex/skill/SKILL.md'), 'utf8').replaceAll('{{PACE_ROOT}}', root)
  writeFileSync(join(codex, 'skills', 'pace', 'SKILL.md'), skill)
  process.stdout.write(`✔ /prompts:pace and $pace installed in ${codex}\n`)
}

if (process.argv[2] === 'install') {
  install()
} else {
  process.stderr.write('usage: node scripts/codex.ts install\n')
  process.exitCode = 2
}
