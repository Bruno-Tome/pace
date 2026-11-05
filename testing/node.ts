// claude-code/testing's describe, test and expect on node:test, for the core suite. testing/register.ts maps the
// module name here, so the tests run unchanged: `node --import ./testing/register.ts --test tests/*.test.ts`.

import * as nodeTest from 'node:test'

export { expect } from './expect.ts'

/** A group of tests: its name leads the title of each test inside */
export function describe(name: string, body: () => void): void {
  nodeTest.describe(name, body)
}

/** One test: it passes when its body returns or resolves */
export function test(name: string, body: () => unknown): void {
  nodeTest.test(name, async () => {
    await body()
  })
}
