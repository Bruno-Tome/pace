// Installs pace in Antigravity: a plugin, ~/.gemini/config/plugins/pace/, whose hooks.json runs this repo's
// adapters/antigravity/hook.ts on PreInvocation and Stop, so pulling the repo updates it. The hooks run with the node
// that installed them: Antigravity's language server may not have node on its PATH. The user's own hooks.json and
// other plugins are left alone. Antigravity picks the plugin up on its next conversation.
//
//   node scripts/antigravity.ts install

import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..')

/** How long Antigravity lets a hook run, in seconds; the hook keeps well under it */
const TIMEOUT = 10

const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

const PACE_SKILL = `---
name: pace
description: pace's commands - its quota charts, the band, the fleet. Use only when the user invokes /pace, alone or with arguments.
---

# pace

pace's hook answers \`/pace\` before you see it. If you are reading this, the hook did not run (the pace plugin's
hooks are not enabled). Reply with one line: "pace's hook did not answer: check that the pace plugin is enabled with
\`agy plugin enable pace\`", and do nothing else.
`

function install(): void {
  const dir = join(homedir(), '.gemini', 'config', 'plugins', 'pace')
  const hook = (event: string) => [{ type: 'command', command: `${shellQuote(process.execPath)} ${shellQuote(join(root, 'adapters/antigravity/hook.ts'))} ${event}`, timeout: TIMEOUT }]
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'plugin.json'), `${JSON.stringify({ name: 'pace' }, null, 2)}\n`)
  // A /pace skill: agy completes an unknown slash command to the nearest skill it knows, so /pace has to be one. The
  // hook answers it before the model; the skill only speaks when the hook did not
  mkdirSync(join(dir, 'skills/pace'), { recursive: true })
  writeFileSync(join(dir, 'skills/pace/SKILL.md'), PACE_SKILL)
  writeFileSync(join(dir, 'hooks.json'), `${JSON.stringify({ pace: { PreInvocation: hook('PreInvocation'), Stop: hook('Stop') } }, null, 2)}\n`)
  process.stdout.write(`✔ pace installed in Antigravity: ${dir}\n`)
}

if (process.argv[2] === 'install') {
  install()
} else {
  process.stderr.write('usage: node scripts/antigravity.ts install\n')
  process.exitCode = 2
}
