// Maps 'claude-code/testing' to testing/node.ts, so the core suite runs on Node unchanged:
// `node --import ./testing/register.ts --test tests/*.test.ts`.

import { registerHooks } from 'node:module'

const shim = new URL('./node.ts', import.meta.url).href

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'claude-code/testing') return nextResolve(shim, context)
    return nextResolve(specifier, context)
  },
})
